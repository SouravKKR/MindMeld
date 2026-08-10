/**
 * End-to-end verification harness for embedded-figure erasure — the removal of
 * figures that were cropped from an uploaded document and pasted, as base64,
 * into the study material and cards generated from it.
 *
 * Run from the Dock directory:
 *     node VerifyEmbeddedFigureErasure.mjs
 *     VERIFY_EMBEDDED_FIGURE_DB=1 node VerifyEmbeddedFigureErasure.mjs
 *
 * The defect this covers:
 *
 *   R-03  A takedown deleted the information-source row, the stored blob, the
 *         embedding chunks, the figure rows and the figure PNGs — and left the
 *         picture itself in place, because by then it lived as a data URL inside
 *         a study material body and a card face. Those entities are separate
 *         documents that nothing in the cascade touched, and they had already
 *         synced to every device. The register recorded the notice as honoured
 *         while the artwork was still on screen.
 *
 * Two tiers, each self-gating so the default run needs no external services:
 *
 *   1. ALWAYS — the stripper's algebra, driven directly: which figures it
 *      removes and which it must leave, nesting, the unbalanced-markup refusal,
 *      and the source-attribution rules the Agent side is expected to honour.
 *
 *   2. DB (opt-in: VERIFY_EMBEDDED_FIGURE_DB=1) — drives the real
 *      EmbeddedFigurePurger against the configured MongoDB using throwaway
 *      entities under a *.invalid user id, and asserts the two sync fields are
 *      both advanced so the removal can actually reach a device. Everything it
 *      creates is removed afterwards. Skips if the flag is off or Mongo is
 *      unreachable.
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

const require = createRequire(import.meta.url);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

require("dotenv").config({ path: path.join(currentDirectory, ".env") });

const EmbeddedFigureStripper = require("./Globals/Classes/Content/EmbeddedFigureStripper");

let passedCount = 0;
let failedCount = 0;
let skippedCount = 0;

function assertThat(condition, description)
{
    if (condition)
    {
        passedCount++;
        console.log(`  PASS  ${description}`);
        return;
    }

    failedCount++;
    console.error(`  FAIL  ${description}`);
}

function skip(description)
{
    skippedCount++;
    console.log(`  SKIP  ${description}`);
}

const NOTICED_HASH = "a".repeat(128);
const OTHER_HASH = "b".repeat(128);

function buildExtractedFigure(sourceHash, label)
{
    const sourceAttribute = sourceHash === null ? "" : ` data-source-hash="${sourceHash}"`;
    return `<figure class="extracted-figure" data-visual-id="v-${label}"${sourceAttribute} style="margin: 1em 0;">`
        + `<img src="data:image/jpeg;base64,PAYLOAD-${label}" alt="Figure">`
        + `<figcaption>Fig. ${label}</figcaption>`
        + `</figure>`;
}

console.log("\n[1] Stripper algebra (always runs)\n");

{
    const html = `<p>Before</p>\n${buildExtractedFigure(NOTICED_HASH, "1")}\n<p>After</p>`;
    const result = EmbeddedFigureStripper.strip(html, NOTICED_HASH);

    assertThat(result.removedCount === 1, "removes a figure carrying the noticed hash");
    assertThat(!result.html.includes("PAYLOAD-1"), "the base64 payload is gone, not merely the wrapper");
    assertThat(result.html.includes("<p>Before</p>") && result.html.includes("<p>After</p>"), "surrounding prose survives");
    assertThat(result.bUnbalancedMarkup === false, "well-formed markup is not reported as unbalanced");
}

{
    const html = `${buildExtractedFigure(OTHER_HASH, "keep")}${buildExtractedFigure(NOTICED_HASH, "drop")}`;
    const result = EmbeddedFigureStripper.strip(html, NOTICED_HASH);

    assertThat(result.removedCount === 1, "removes only the noticed source's figure");
    assertThat(result.html.includes("PAYLOAD-keep"), "another document's figure in the same material is left alone");
    assertThat(!result.html.includes("PAYLOAD-drop"), "the noticed figure is removed from a mixed material");
}

{
    // A generated diagram carries no source attribution at all. A notice
    // against the uploaded document must not reach it — it is our own
    // expression, and deleting it would remove content the rightsholder has no
    // claim over.
    const html = `<figure class="generated-figure" data-visual-id="gen"><svg>OURS</svg><figcaption>Fig. 1</figcaption></figure>`;
    const result = EmbeddedFigureStripper.strip(html, NOTICED_HASH);

    assertThat(result.removedCount === 0, "an unattributed generated figure is never stripped");
    assertThat(result.html === html, "content with nothing to remove is returned byte-identical");
}

{
    // The needle must be matched against the opening TAG, not the document.
    // Otherwise the first figure gets removed because a LATER figure mentions
    // the hash somewhere further down the same body.
    const html = `${buildExtractedFigure(OTHER_HASH, "first")}<p>text</p>${buildExtractedFigure(NOTICED_HASH, "second")}`;
    const result = EmbeddedFigureStripper.strip(html, NOTICED_HASH);

    assertThat(result.removedCount === 1, "a later match does not drag an earlier unrelated figure with it");
    assertThat(result.html.includes("PAYLOAD-first"), "the earlier figure is intact");
}

{
    const html = `${buildExtractedFigure(NOTICED_HASH, "1")}<p>a</p>${buildExtractedFigure(NOTICED_HASH, "2")}<p>b</p>${buildExtractedFigure(NOTICED_HASH, "3")}`;
    const result = EmbeddedFigureStripper.strip(html, NOTICED_HASH);

    assertThat(result.removedCount === 3, "removes every figure from the noticed source, not just the first");
    assertThat(!/PAYLOAD-[123]/.test(result.html), "no payload from the noticed source survives");
}

{
    // figcaption starts with "<figc", which a naive nesting counter reads as a
    // nested <figure and then never closes.
    const html = buildExtractedFigure(NOTICED_HASH, "cap");
    const result = EmbeddedFigureStripper.strip(html, NOTICED_HASH);

    assertThat(result.removedCount === 1, "figcaption is not mistaken for a nested figure");
    assertThat(result.html.trim() === "", "the whole element is consumed");
}

{
    const nestedHtml = `<figure class="extracted-figure" data-source-hash="${NOTICED_HASH}">`
        + `<figure class="inner"><img src="data:image/jpeg;base64,INNER"></figure>`
        + `<figcaption>Outer</figcaption></figure><p>tail</p>`;
    const result = EmbeddedFigureStripper.strip(nestedHtml, NOTICED_HASH);

    assertThat(result.removedCount === 1, "a nested figure does not close the outer element early");
    assertThat(!result.html.includes("INNER"), "the nested child is removed with its parent");
    assertThat(result.html.includes("<p>tail</p>"), "content after the nested element survives");
}

{
    const unbalancedHtml = `<p>a</p><figure class="extracted-figure" data-source-hash="${NOTICED_HASH}"><img src="x"><p>rest of the document</p>`;
    const result = EmbeddedFigureStripper.strip(unbalancedHtml, NOTICED_HASH);

    assertThat(result.removedCount === 0, "an unclosed figure is not removed");
    assertThat(result.bUnbalancedMarkup === true, "an unclosed figure is reported as unstrippable");
    assertThat(result.html.includes("rest of the document"), "the rest of the document is NOT truncated to honour the notice");
}

{
    assertThat(EmbeddedFigureStripper.strip(null, NOTICED_HASH).removedCount === 0, "null content is handled");
    assertThat(EmbeddedFigureStripper.strip("<p>x</p>", "").removedCount === 0, "an empty hash removes nothing");
    assertThat(EmbeddedFigureStripper.strip("<p>x</p>", null).removedCount === 0, "a null hash removes nothing");
    assertThat(EmbeddedFigureStripper.containsSourceHash(`<figure data-source-hash="${NOTICED_HASH}">`, NOTICED_HASH) === true, "containsSourceHash detects a present hash");
    assertThat(EmbeddedFigureStripper.containsSourceHash("<figure>", NOTICED_HASH) === false, "containsSourceHash rejects absent hash");
}

{
    // The prefilter and the stripper must agree. A document the query selects
    // but the stripper declines to clean would be rewritten unchanged with a
    // bumped timestamp, pushing a no-op update to every device.
    const html = buildExtractedFigure(NOTICED_HASH, "agree");
    const bSelected = EmbeddedFigureStripper.containsSourceHash(html, NOTICED_HASH);
    const bStripped = EmbeddedFigureStripper.strip(html, NOTICED_HASH).removedCount > 0;

    assertThat(bSelected === bStripped, "the selection test and the strip agree on the same content");
}

console.log("\n[2] Agent-side attribution contract (always runs)\n");

{
    // Read as source rather than executed: this harness is Node, the injector is
    // Python. What is being pinned is that the marker the stripper looks for is
    // the marker the injector writes, and that the two exclusions hold.
    const fs = require("fs");
    const injectorPath = path.join(currentDirectory, "..", "Agent", "Workflows", "PrepareImages", "HtmlInjector.py");

    if (!fs.existsSync(injectorPath))
    {
        skip("HtmlInjector.py not present — attribution contract not checked");
    }
    else
    {
        const injectorSource = fs.readFileSync(injectorPath, "utf8");

        assertThat(injectorSource.includes('data-source-hash="'), "the injector writes the attribute the stripper searches for");
        assertThat(
            /def build_source_hash_attribute/.test(injectorSource),
            "the attribute is produced by a named helper rather than inlined per call site",
        );
        assertThat(
            injectorSource.includes("WEB_SOURCE_HASH_MARKER"),
            "the web-figure marker is excluded from provenance stamping",
        );

        const markupFigureSection = injectorSource.slice(
            injectorSource.indexOf("def build_markup_figure_html"),
            injectorSource.indexOf("def build_figure_html"),
        );
        assertThat(
            markupFigureSection.length > 0 && !markupFigureSection.includes("build_source_hash_attribute"),
            "generated symbolic visuals are NOT stamped with a source hash",
        );
    }
}

console.log("\n[3] Purger against MongoDB (opt-in)\n");

if ((process.env.VERIFY_EMBEDDED_FIGURE_DB || "") !== "1")
{
    skip("VERIFY_EMBEDDED_FIGURE_DB is not 1 — database tier not run");
}
else
{
    const DatabaseConnector = require("./Globals/Classes/Database/DatabaseConnector");
    const DatabaseConstants = require("./Globals/Constants/DatabaseConstants");
    const EmbeddedFigurePurger = require("./Globals/Classes/Content/EmbeddedFigurePurger");

    const fixtureUserId = "verify-embedded-figure@example.invalid";
    const otherUserId = "verify-embedded-figure-other@example.invalid";
    let database = null;

    try
    {
        database = await DatabaseConnector.getDatabase();
    }
    catch (connectionError)
    {
        skip(`MongoDB unreachable (${connectionError.message}) — database tier not run`);
    }

    if (database !== null)
    {
        const studyMaterials = database.collection(DatabaseConstants.STUDY_MATERIALS_COLLECTION);
        const cards = database.collection(DatabaseConstants.CARDS_COLLECTION);

        const staleTimestamp = new Date(Date.now() - 60 * 60 * 1000);

        try
        {
            await studyMaterials.insertOne({
                userId: fixtureUserId,
                serverUpdatedAt: staleTimestamp,
                data:
                {
                    id: "verify-sm-1",
                    deckId: "verify-deck-1",
                    // Labels must not prefix one another: an "includes" assertion
                    // on "PAYLOAD-sm" would match "PAYLOAD-smkeep" and never fail.
                    content: `<p>Lesson</p>${buildExtractedFigure(NOTICED_HASH, "smdrop")}${buildExtractedFigure(OTHER_HASH, "smkeep")}`,
                    lifecycle: { creationDate: staleTimestamp.toISOString(), lastModified: staleTimestamp.toISOString() }
                }
            });

            await cards.insertOne({
                userId: fixtureUserId,
                serverUpdatedAt: staleTimestamp,
                data:
                {
                    id: "verify-card-1",
                    deckId: "verify-deck-1",
                    question: `<p>Q</p>${buildExtractedFigure(NOTICED_HASH, "cardq")}`,
                    answer: `<p>A</p>${buildExtractedFigure(NOTICED_HASH, "carda")}`,
                    lifecycle: { creationDate: staleTimestamp.toISOString(), lastModified: staleTimestamp.toISOString() }
                }
            });

            // A second tenant holding the same document. A notice is about the
            // work, so this copy must go too.
            await studyMaterials.insertOne({
                userId: otherUserId,
                serverUpdatedAt: staleTimestamp,
                data:
                {
                    id: "verify-sm-2",
                    deckId: "verify-deck-2",
                    content: buildExtractedFigure(NOTICED_HASH, "tenant2"),
                    lifecycle: { creationDate: staleTimestamp.toISOString(), lastModified: staleTimestamp.toISOString() }
                }
            });

            const dryRunCounts = await EmbeddedFigurePurger.countEmbeddedFigures(NOTICED_HASH);
            assertThat(dryRunCounts.figures >= 4, `dry-run count sees every embedded copy (saw ${dryRunCounts.figures})`);
            assertThat(dryRunCounts.studyMaterials >= 2, "dry-run count spans both tenants' study materials");

            const unchangedAfterCount = await studyMaterials.countDocuments({ userId: fixtureUserId, serverUpdatedAt: staleTimestamp });
            assertThat(unchangedAfterCount === 1, "the dry-run count changed nothing");

            const scopedResult = await EmbeddedFigurePurger.purgeForUserAndContentHash(fixtureUserId, NOTICED_HASH);
            assertThat(scopedResult.studyMaterialsUpdated === 1, "per-user purge rewrites the owner's study material");
            assertThat(scopedResult.cardsUpdated === 1, "per-user purge rewrites the owner's card");
            assertThat(scopedResult.figuresStripped === 3, `per-user purge strips every embedded copy it owns (stripped ${scopedResult.figuresStripped})`);

            const otherTenantDocument = await studyMaterials.findOne({ userId: otherUserId });
            assertThat(
                otherTenantDocument.data.content.includes("PAYLOAD-tenant2"),
                "a per-user purge does NOT cross the tenant boundary",
            );

            const rewrittenMaterial = await studyMaterials.findOne({ userId: fixtureUserId });
            assertThat(!rewrittenMaterial.data.content.includes("PAYLOAD-smdrop"), "the noticed figure is gone from stored content");
            assertThat(rewrittenMaterial.data.content.includes("PAYLOAD-smkeep"), "the unrelated figure survives in stored content");
            assertThat(rewrittenMaterial.data.content.includes("<p>Lesson</p>"), "the lesson prose survives");

            // Both sync fields must advance together. serverUpdatedAt is what
            // the pull filters on; lifecycle.lastModified is what the client
            // compares before accepting. One without the other means the strip
            // never lands on a device.
            assertThat(
                rewrittenMaterial.serverUpdatedAt.getTime() > staleTimestamp.getTime(),
                "serverUpdatedAt advanced, so the next pull will fetch it",
            );
            assertThat(
                new Date(rewrittenMaterial.data.lifecycle.lastModified).getTime() > staleTimestamp.getTime(),
                "lifecycle.lastModified advanced, so the client will accept it over its local copy",
            );

            const rewrittenCard = await cards.findOne({ userId: fixtureUserId });
            assertThat(!rewrittenCard.data.question.includes("PAYLOAD-cardq"), "the card question face is stripped");
            assertThat(!rewrittenCard.data.answer.includes("PAYLOAD-carda"), "the card answer face is stripped");
            assertThat(
                new Date(rewrittenCard.data.lifecycle.lastModified).getTime() > staleTimestamp.getTime(),
                "the card's lifecycle timestamp advanced too",
            );

            const takedownResult = await EmbeddedFigurePurger.purgeByContentHash(NOTICED_HASH);
            assertThat(takedownResult.figuresStripped === 1, "the cross-tenant purge reaches the remaining holder");

            const sweptDocument = await studyMaterials.findOne({ userId: otherUserId });
            assertThat(!sweptDocument.data.content.includes("PAYLOAD-tenant2"), "the second tenant's embedded copy is gone");

            const idempotentResult = await EmbeddedFigurePurger.purgeByContentHash(NOTICED_HASH);
            assertThat(idempotentResult.figuresStripped === 0, "re-running the purge is a no-op rather than a second rewrite");
        }
        finally
        {
            await studyMaterials.deleteMany({ userId: { $in: [fixtureUserId, otherUserId] } });
            await cards.deleteMany({ userId: { $in: [fixtureUserId, otherUserId] } });
            console.log("  ....  fixtures removed");
        }
    }
}

console.log("\n[4] Re-infection guard on the sync push path (always runs)\n");

{
    // R-04: the takedown removes the copies that exist when it is actioned. A
    // device that was OFFLINE at the time still holds the figure and pushes it
    // back with a newer lifecycle.lastModified, which last-write-wins accepts —
    // restoring content the register says was removed. The guard is what makes
    // the removal stick.
    const TakenDownFigureGuard = require("./Globals/Classes/Content/TakenDownFigureGuard");
    const ContentTakedownNoticeQueryEngine = require("./Globals/Classes/Database/ContentTakedownNoticeQueryEngine");

    const originalGetAllContentHashes = ContentTakedownNoticeQueryEngine.getAllContentHashes;

    try
    {
        ContentTakedownNoticeQueryEngine.getAllContentHashes = async () => [NOTICED_HASH];
        TakenDownFigureGuard.invalidateCache();

        const incomingStudyMaterials =
        [
            { id: "sm-a", content: `<p>Notes</p>${buildExtractedFigure(NOTICED_HASH, "reinfect")}${buildExtractedFigure(OTHER_HASH, "innocent")}` }
        ];
        const incomingCards =
        [
            { id: "card-a", question: `<p>Q</p>${buildExtractedFigure(NOTICED_HASH, "cardreinfect")}`, answer: "<p>A</p>" }
        ];

        const materialOutcome = await TakenDownFigureGuard.sanitizeStudyMaterials(incomingStudyMaterials);
        const cardOutcome = await TakenDownFigureGuard.sanitizeCards(incomingCards);

        assertThat(materialOutcome.figuresStripped === 1, "an offline device's re-pushed study material is sanitized on ingress");
        assertThat(!incomingStudyMaterials[0].content.includes("PAYLOAD-reinfect"), "the taken-down figure never reaches the write");
        assertThat(incomingStudyMaterials[0].content.includes("PAYLOAD-innocent"), "an unrelated figure in the same push is untouched");
        assertThat(cardOutcome.figuresStripped === 1, "a re-pushed card face is sanitized on ingress");
        assertThat(!incomingCards[0].question.includes("PAYLOAD-cardreinfect"), "the taken-down figure never reaches the card write");

        // The common case: no notices actioned anywhere. The guard must be a
        // no-op, not a per-entity scan.
        ContentTakedownNoticeQueryEngine.getAllContentHashes = async () => [];
        TakenDownFigureGuard.invalidateCache();

        const untouchedMaterials = [{ id: "sm-b", content: buildExtractedFigure(NOTICED_HASH, "nonotices") }];
        const emptyRegisterOutcome = await TakenDownFigureGuard.sanitizeStudyMaterials(untouchedMaterials);

        assertThat(emptyRegisterOutcome.figuresStripped === 0, "with an empty register the guard strips nothing");
        assertThat(untouchedMaterials[0].content.includes("PAYLOAD-nonotices"), "with an empty register content passes through unchanged");

        // An unreadable register must not fail the push. Refusing every sync
        // because a collection read failed trades a narrow window for an outage.
        ContentTakedownNoticeQueryEngine.getAllContentHashes = async () => { throw new Error("register unavailable"); };
        TakenDownFigureGuard.invalidateCache();

        const duringOutage = [{ id: "sm-c", content: buildExtractedFigure(NOTICED_HASH, "outage") }];
        let bThrew = false;
        try
        {
            await TakenDownFigureGuard.sanitizeStudyMaterials(duringOutage);
        }
        catch (guardError)
        {
            bThrew = true;
        }

        assertThat(bThrew === false, "an unreadable register fails open rather than throwing");
        assertThat(duringOutage[0].content.includes("PAYLOAD-outage"), "the push is allowed through during a register outage");

        assertThat((await TakenDownFigureGuard.sanitizeStudyMaterials([])).figuresStripped === 0, "an empty batch is handled");
        assertThat((await TakenDownFigureGuard.sanitizeCards(undefined)).figuresStripped === 0, "a missing batch is handled");
    }
    finally
    {
        ContentTakedownNoticeQueryEngine.getAllContentHashes = originalGetAllContentHashes;
        TakenDownFigureGuard.invalidateCache();
    }
}

{
    const syncSource = require("fs").readFileSync(path.join(currentDirectory, "Endpoints", "Sync", "Sync.js"), "utf8");
    const guardIndex = syncSource.indexOf("TakenDownFigureGuard.sanitize");
    // The CALL, not the several comments that discuss bulkUpsert by name and
    // appear earlier in the file.
    const upsertIndex = syncSource.indexOf("SyncQueryEngine.bulkUpsert(userId,");

    assertThat(guardIndex !== -1, "the sync push path actually invokes the guard");
    assertThat(guardIndex !== -1 && guardIndex < upsertIndex, "the guard runs BEFORE the upsert, not after it");
}

console.log(`\n${passedCount} passed, ${failedCount} failed, ${skippedCount} skipped\n`);
process.exit(failedCount === 0 ? 0 : 1);
