// Browser UI tests for CogniumLearn's PAID-DECK lifecycle, driven by a real
// Chromium via Puppeteer against the BUILT app (Dock/Static).
//
// Paid decks were covered by no browser suite, while carrying the most
// irreversible operations in the product: publishing content people pay for,
// retiring it, and destroying it.
//
//   node Common/Testing/Main/run_paid_deck_ui_tests.js
//
// Env: BASE_URL, TEST_SESSION_COOKIE (REQUIRED), HEADFUL=1, VERBOSE=1.
// Result JSON -> $RESULT_FILE or Common/Reports/.results/paid-deck-ui.json.
//
// THE PAIR THIS SUITE EXISTS FOR. A held deck must refuse deletion by default,
// and must delete under an explicit force that revokes every licence in the
// same operation. Both directions are pinned, because getting either wrong is
// silent: refusing always looks like working, and forcing without revoking
// leaves buyers holding an entitlement to content that no longer exists.
//
// TEARDOWN IS THE HARD PART, and it is asserted rather than assumed. A paid
// deck cannot be deleted while a licence is active — the rule this very suite
// tests — so the fixture would be undeletable if teardown ran in the wrong
// order. Everything goes through FixtureRegistry, teardown runs in a finally in
// reverse creation order, and the last case proves nothing was left behind.

const fs = require("fs");
const path = require("path");

const { FixtureRegistry } = require("./FixtureRegistry");

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:3000";
const SESSION_COOKIE = process.env.TEST_SESSION_COOKIE || process.env.TUTORIAL_TEST_SESSION_COOKIE || "";
const CATEGORY = "Paid deck UI";
const VERBOSE = process.env.VERBOSE === "1";
const HEADFUL = process.env.HEADFUL === "1";

const RESULT_FILE = process.env.RESULT_FILE
    || path.resolve(__dirname, "..", "..", "..", "Common", "Reports", ".results", "paid-deck-ui.json");

const FIXTURE_PREFIX = "ui-test-paid-deck-";

const FIXTURE_COLLECTION_FIELDS =
[
    { collectionName: "paidDecks", fieldName: "id" },
    { collectionName: "deckLicenses", fieldName: "id" },
    { collectionName: "paidDeckMasterEntities", fieldName: "deckId" },
    { collectionName: "paidDeckAssets", fieldName: "deckId" },
    { collectionName: "paidDeckPricings", fieldName: "deckId" },
    { collectionName: "generationProvenance", fieldName: "deckId" },
    { collectionName: "paidDeckVerificationSources", fieldName: "deckId" },
    { collectionName: "sourceLicenceDeclarations", fieldName: "deckId" },
];

let caseNumber = 0;
const cases = [];

function trace(message)
{
    if (VERBOSE)
    {
        console.log(message);
    }
}

function writeResult(payload)
{
    fs.mkdirSync(path.dirname(path.resolve(RESULT_FILE)), { recursive: true });
    fs.writeFileSync(RESULT_FILE, JSON.stringify(payload, null, 2), "utf-8");
}

function skip(note)
{
    writeResult({
        service: "Main", category: CATEGORY, status: "SKIPPED",
        passed: 0, failed: 0, skipped: 0, total: 0,
        coverage: { kind: "flows", label: "Flows exercised", percent: null, detail: note },
        cases: [], notes: note,
    });
    console.log(`Main ${CATEGORY}: SKIPPED - ${note}`);
}

let puppeteer;
try
{
    puppeteer = require("puppeteer");
}
catch (loadError)
{
    skip("puppeteer not installed; run `npm install` in Common/Testing/Main.");
    process.exit(0);
}

function sleep(milliseconds)
{
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function main()
{
    if (!SESSION_COOKIE)
    {
        skip("Set TEST_SESSION_COOKIE to a seeded (terms-accepted) session; the paid-deck flows need an authenticated admin.");
        return;
    }

    const registry = new FixtureRegistry(FIXTURE_PREFIX);
    let database = null;

    try
    {
        database = await registry.connect();
    }
    catch (connectionError)
    {
        skip(`Could not reach MongoDB, which the fixtures and their teardown both need: ${connectionError.message}`);
        return;
    }

    const sweptCount = await registry.sweepPreviousRuns(FIXTURE_COLLECTION_FIELDS);
    if (sweptCount > 0)
    {
        trace(`  swept ${sweptCount} leftover fixture row(s) from an earlier run`);
    }

    const browser = await puppeteer.launch
    ({
        headless: HEADFUL ? false : "new",
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
        slowMo: HEADFUL ? Number(process.env.SLOW_MO_MS || 60) : 0,
    });

    const page = await browser.newPage();

    const runCase = async (name, caseFunction) =>
    {
        caseNumber += 1;
        const label = `${String(caseNumber).padStart(2, "0")}. ${name}`;

        try
        {
            const detail = await caseFunction();
            cases.push({ name: label, status: "PASS", detail: detail || "" });
            trace(`  PASS ${label}${detail ? " — " + detail : ""}`);
        }
        catch (caseError)
        {
            cases.push({ name: label, status: "FAIL", detail: caseError.message });
            trace(`  FAIL ${label} — ${caseError.message}`);
        }
    };

    const uniqueSuffix = Date.now();
    const heldDeckId = `${FIXTURE_PREFIX}held-${uniqueSuffix}`;
    const unheldDeckId = `${FIXTURE_PREFIX}unheld-${uniqueSuffix}`;
    const licenseId = `${FIXTURE_PREFIX}license-${uniqueSuffix}`;

    const postDelete = async (deckId, bForce) => await page.evaluate(async (request) =>
    {
        const response = await fetch("/Admin/PaidDecks/Delete",
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ deckId: request.deckId, bForceDeleteWithActiveHolders: request.bForce }),
        });

        return { status: response.status, body: await response.json().catch(() => ({})) };
    }, { deckId: deckId, bForce: bForce });

    try
    {
        await page.setViewport({ width: 1440, height: 900 });
        await page.setCookie({ name: "sessionId", value: SESSION_COOKIE, url: BASE_URL });
        await page.goto(`${BASE_URL}/index.html`, { waitUntil: "networkidle2", timeout: 60000 });
        await sleep(3000);

        await page.evaluate(() =>
        {
            document.querySelectorAll("tutorial-overlay, initialization-overlay, sync-blocking-overlay")
                .forEach(overlay => overlay.remove());
        });

        await runCase("The app boots to an authenticated session", async () =>
        {
            if (!await page.evaluate(() => Boolean(window["user"])))
            {
                throw new Error("No authenticated user — the session cookie did not take.");
            }

            return "signed in";
        });

        await runCase("The account is raised to admin for the paid-deck routes, and will be restored", async () =>
        {
            const testAccountUserId = await page.evaluate(() => window["user"].getId());

            const userDocument = await database.collection("users").findOne({ id: testAccountUserId }, { projection: { _id: 0, role: 1 } });
            const originalRole = userDocument ? userDocument.role : undefined;

            // A reversion, not a deletion — this account is not the suite's to
            // destroy, and leaving it elevated would silently widen what the
            // next person's session can do.
            registry.registerRestore(`users.role for ${testAccountUserId}`, async () =>
            {
                if (originalRole === undefined)
                {
                    await database.collection("users").updateOne({ id: testAccountUserId }, { $unset: { role: "" } });
                }
                else
                {
                    await database.collection("users").updateOne({ id: testAccountUserId }, { $set: { role: originalRole } });
                }
            });

            // 2 = ADMIN.
            await database.collection("users").updateOne({ id: testAccountUserId }, { $set: { role: 2 } });

            return `raised from ${originalRole}`;
        });

        await runCase("Two paid decks are created — one held by a buyer, one not", async () =>
        {
            const retiredAt = new Date().toISOString();

            await database.collection("paidDecks").insertMany
            ([
                { id: heldDeckId, title: "UI test held deck", isPublished: false, retiredAt: retiredAt, keyVersion: 1, audienceOrganizationId: "" },
                { id: unheldDeckId, title: "UI test unheld deck", isPublished: false, retiredAt: retiredAt, keyVersion: 1, audienceOrganizationId: "" },
            ]);
            registry.register("paidDecks", { id: { $in: [heldDeckId, unheldDeckId] } });

            // Registered BEFORE the licence that will block its deletion, so
            // teardown removes the licence first — reverse order is what makes
            // the fixture removable at all.
            await database.collection("deckLicenses").insertOne
            ({
                id: licenseId,
                userId: `${FIXTURE_PREFIX}buyer-${uniqueSuffix}`,
                deckId: heldDeckId,
                status: 1,
                expiresAt: new Date(0).toISOString(),
            });
            registry.register("deckLicenses", { id: licenseId });

            return "2 decks, 1 active licence";
        });

        await runCase("A deck nobody holds deletes straight away", async () =>
        {
            const result = await postDelete(unheldDeckId, false);

            if (result.status !== 200 || result.body.success !== true)
            {
                throw new Error(`Expected a clean delete, got ${result.status}: ${JSON.stringify(result.body)}`);
            }

            if (await database.collection("paidDecks").findOne({ id: unheldDeckId }) !== null)
            {
                throw new Error("The endpoint reported success but the listing is still there.");
            }

            return "deleted";
        });

        await runCase("A deck somebody holds is REFUSED by default", async () =>
        {
            const result = await postDelete(heldDeckId, false);

            if (result.status !== 409 || result.body.error !== "PAID_DECK_STILL_HELD")
            {
                throw new Error(`Expected a 409 PAID_DECK_STILL_HELD, got ${result.status}: ${JSON.stringify(result.body)}`);
            }

            if (Number(result.body.holders?.activeCount) !== 1)
            {
                throw new Error(`The refusal should name the holder count; got ${JSON.stringify(result.body.holders)}`);
            }

            if (await database.collection("paidDecks").findOne({ id: heldDeckId }) === null)
            {
                throw new Error("The deck was deleted despite the refusal.");
            }

            return "refused, 1 holder named, nothing removed";
        });

        await runCase("A refused deletion revokes nothing", async () =>
        {
            const licenseDocument = await database.collection("deckLicenses").findOne({ id: licenseId });

            if (licenseDocument.status !== 1)
            {
                throw new Error(`The licence was touched by a refused deletion (status ${licenseDocument.status}).`);
            }

            return "licence still active";
        });

        await runCase("Forcing deletes it AND revokes every active licence in the same operation", async () =>
        {
            const result = await postDelete(heldDeckId, true);

            if (result.status !== 200 || result.body.success !== true)
            {
                throw new Error(`Expected the forced delete to succeed, got ${result.status}: ${JSON.stringify(result.body)}`);
            }

            if (Number(result.body.revokedLicenseCount) !== 1)
            {
                throw new Error(`Expected 1 revoked licence reported, got ${result.body.revokedLicenseCount}.`);
            }

            if (await database.collection("paidDecks").findOne({ id: heldDeckId }) !== null)
            {
                throw new Error("The listing survived a successful forced delete.");
            }

            // The property that matters. A surviving active licence would leave
            // a buyer holding an entitlement to content that no longer exists,
            // and they would see a deck they own simply fail to open.
            const survivingActive = await database.collection("deckLicenses").findOne({ deckId: heldDeckId, status: 1 });

            if (survivingActive !== null)
            {
                throw new Error("An ACTIVE licence survived, pointing at a deck that no longer exists.");
            }

            const revoked = await database.collection("deckLicenses").findOne({ id: licenseId });

            if (revoked === null)
            {
                throw new Error("The licence row was deleted — a refund or dispute later needs that record.");
            }

            if (revoked.status !== 3)
            {
                throw new Error(`Expected the licence to be REVOKED (3), got ${revoked.status}.`);
            }

            return "deleted, 1 licence revoked and recorded";
        });

        await runCase("Deleting a deck that does not exist is reported, not silently successful", async () =>
        {
            const result = await postDelete(`${FIXTURE_PREFIX}ghost-${uniqueSuffix}`, false);

            if (result.status !== 404)
            {
                throw new Error(`Expected 404, got ${result.status}.`);
            }

            return "404";
        });

        // ── Verification sources ──────────────────────────────────────────────
        //
        // The documents a deck's generated content is CHECKED AGAINST. Driven
        // through the real endpoints, because the licence rule is the point and
        // it has to hold for a caller that never opened the dialog — the
        // refinement path's equivalent check lives only in the browser, and this
        // one deliberately does not.

        const sourceDeckId = `${FIXTURE_PREFIX}sources-${uniqueSuffix}`;
        const sourceRunId = `${FIXTURE_PREFIX}sources-run-${uniqueSuffix}`;

        const postVerificationSources = async (routeSuffix, body) => await page.evaluate(async (request) =>
        {
            const response = await fetch(`/Admin/PaidDecks/VerificationSources/${request.routeSuffix}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(request.body),
            });

            return { status: response.status, body: await response.json().catch(() => ({})) };
        }, { routeSuffix: routeSuffix, body: body });

        await runCase("A generated deck with a verification record is created to attach sources to", async () =>
        {
            await database.collection("paidDecks").insertOne
            ({
                id: sourceDeckId,
                title: "UI test verification-sources deck",
                isPublished: false,
                keyVersion: 1,
                audienceOrganizationId: "",
                provenanceDeckId: sourceDeckId,
            });
            registry.register("paidDecks", { id: sourceDeckId });

            await database.collection("generationProvenance").insertOne
            ({
                id: `${FIXTURE_PREFIX}prov-${uniqueSuffix}`,
                mainTaskId: sourceRunId,
                deckId: sourceDeckId,
                deckName: "UI test verification-sources deck",
                generatedByUserId: await page.evaluate(() => window["user"].getId()),
                verification: { flags: [], blockingFlagCount: 0, advisoryFlagCount: 0, verifiedEntityCount: 3 },
                flagResolutions: [],
                recordedAt: Date.now(),
            });
            registry.register("generationProvenance", { deckId: sourceDeckId });

            return "deck + provenance record";
        });

        await runCase("A source with no declared licence is REFUSED by the server", async () =>
        {
            const result = await postVerificationSources("Attach",
            {
                deckId: sourceDeckId,
                sourceUrl: "https://example.org/reference",
                licenceType: 0,
            });

            if (result.status !== 400 || result.body.error !== "VERIFICATION_SOURCE_LICENCE_REQUIRED")
            {
                throw new Error(`Expected 400 VERIFICATION_SOURCE_LICENCE_REQUIRED, got ${result.status}: ${JSON.stringify(result.body)}`);
            }

            return "refused";
        });

        await runCase("CC BY with no attribution is refused; the response names the rule", async () =>
        {
            // 3 = CC_BY, sent with neither a note nor a URL to attribute to.
            const result = await postVerificationSources("Attach", { deckId: sourceDeckId, name: "Chapter", licenceType: 3 });

            if (result.body.error !== "VERIFICATION_SOURCE_ATTRIBUTION_REQUIRED" && result.body.error !== "MISSING_FIELDS")
            {
                throw new Error(`Expected the attribution rule to refuse it, got ${result.status}: ${JSON.stringify(result.body)}`);
            }

            return result.body.error;
        });

        await runCase("A CC0 URL source attaches and writes a permanent declaration", async () =>
        {
            // 1 = CC0.
            const result = await postVerificationSources("Attach",
            {
                deckId: sourceDeckId,
                sourceUrl: "https://example.org/reference",
                name: "Reference page",
                licenceType: 1,
            });

            if (result.status !== 200)
            {
                throw new Error(`Expected 200, got ${result.status}: ${JSON.stringify(result.body)}`);
            }

            registry.register("paidDeckVerificationSources", { deckId: sourceDeckId });
            registry.register("sourceLicenceDeclarations", { deckId: sourceDeckId });

            const declarations = await database.collection("sourceLicenceDeclarations").find({ deckId: sourceDeckId }).toArray();

            if (declarations.length !== 1 || declarations[0].event !== "ATTACHED")
            {
                throw new Error(`Expected one ATTACHED declaration, got ${JSON.stringify(declarations)}`);
            }

            if (!declarations[0].declaredByUserId)
            {
                throw new Error("The declaration does not name who made it.");
            }

            return "attached + declared";
        });

        await runCase("Attaching the same source twice is refused", async () =>
        {
            const result = await postVerificationSources("Attach",
            {
                deckId: sourceDeckId,
                sourceUrl: "https://example.org/reference",
                name: "Reference page",
                licenceType: 1,
            });

            if (result.status !== 409)
            {
                throw new Error(`Expected 409, got ${result.status}: ${JSON.stringify(result.body)}`);
            }

            return "409";
        });

        await runCase("Listing returns the working set and the declaration history separately", async () =>
        {
            const result = await postVerificationSources("List", { deckId: sourceDeckId });

            if (result.status !== 200)
            {
                throw new Error(`Expected 200, got ${result.status}.`);
            }

            if (!Array.isArray(result.body.sources) || result.body.sources.length !== 1)
            {
                throw new Error(`Expected one attached source, got ${JSON.stringify(result.body.sources)}`);
            }

            if (!Array.isArray(result.body.declarations) || result.body.declarations.length !== 1)
            {
                throw new Error(`Expected one declaration, got ${JSON.stringify(result.body.declarations)}`);
            }

            return "1 source, 1 declaration";
        });

        await runCase("Detaching leaves the deck unchecked but the declaration standing", async () =>
        {
            const listResult = await postVerificationSources("List", { deckId: sourceDeckId });
            const verificationSourceId = listResult.body.sources[0].id;

            const detachResult = await postVerificationSources("Detach", { verificationSourceId: verificationSourceId });

            if (detachResult.status !== 200)
            {
                throw new Error(`Expected 200, got ${detachResult.status}: ${JSON.stringify(detachResult.body)}`);
            }

            const afterDetach = await postVerificationSources("List", { deckId: sourceDeckId });

            if (afterDetach.body.sources.length !== 0)
            {
                throw new Error("The detached source is still in the working set.");
            }

            // The property this feature exists for: removing a source must not
            // remove the record of what a past check was carried out against.
            if (afterDetach.body.declarations.length !== 2)
            {
                throw new Error(`Expected two declarations after a detach, got ${afterDetach.body.declarations.length}.`);
            }

            if (afterDetach.body.declarations[1].event !== "DETACHED")
            {
                throw new Error("The removal was not recorded as its own event.");
            }

            return "0 attached, 2 declarations";
        });

        await runCase("Running a check with nothing attached is refused, not reported as clean", async () =>
        {
            const result = await postVerificationSources("Run", { deckId: sourceDeckId, mainTaskId: sourceRunId });

            if (result.status !== 400 || result.body.error !== "VERIFICATION_SOURCES_ABSENT")
            {
                throw new Error(`Expected 400 VERIFICATION_SOURCES_ABSENT, got ${result.status}: ${JSON.stringify(result.body)}`);
            }

            return "refused";
        });

        // ── The dialog's layout, at both viewports ────────────────────────────
        //
        // Mounted markup rather than the live component, matching how
        // run_refinement_ui_checks drives the same kind of surface: no
        // context-menu action navigates under Puppeteer. The class names are
        // asserted against the component source below so this cannot drift into
        // measuring markup nothing emits.

        const mountSourcesDialog = async () => await page.evaluate(() =>
        {
            const host = document.createElement("div");
            host.id = "verification-sources-probe";
            host.innerHTML = `
                <div class="paid-deck-verification-sources-dialog">
                    <div class="title-section">Verification sources — probe</div>
                    <div class="verification-sources-explainer">Checked against, never generated from.</div>
                    <div class="verification-sources-tabs">
                        <button type="button" class="verification-sources-tab verification-sources-tab-active">Attached</button>
                        <button type="button" class="verification-sources-tab">Declaration history</button>
                    </div>
                    <div class="verification-sources-error">A refusal that must stay on screen.</div>
                    <div class="verification-source-list">
                        <div class="verification-source-card">
                            <div class="verification-source-name">A-reference-document-with-a-very-long-unbroken-name-that-cannot-wrap.pdf</div>
                            <div class="verification-source-row">
                                <span class="verification-source-label">Content hash</span>
                                <span class="verification-source-value-wrap">e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855</span>
                            </div>
                            <div class="verification-source-card-actions">
                                <button type="button" class="verification-source-detach">Detach</button>
                            </div>
                        </div>
                    </div>
                    <div class="verification-declaration-scroller">
                        <table class="verification-declaration-table">
                            <thead><tr><th>When</th><th>Event</th><th>Source</th><th>Declared licence</th><th>Declared by</th></tr></thead>
                            <tbody><tr>
                                <td>2026-08-08</td>
                                <td><span class="verification-declaration-event verification-declaration-event-attached">ATTACHED</span></td>
                                <td class="verification-source-value-wrap">https://example.org/a/very/long/url/that/will/not/wrap/anywhere/at/all/reference</td>
                                <td class="verification-source-value-wrap">CC0</td>
                                <td class="verification-source-value-wrap">administrator@example.test</td>
                            </tr></tbody>
                        </table>
                    </div>
                    <div class="verification-sources-actions">
                        <button type="button" class="verification-sources-secondary">Attach a document</button>
                        <button type="button" class="verification-sources-secondary">Attach a URL</button>
                        <button type="button" class="verification-sources-run">Run verification against sources</button>
                    </div>
                </div>
            `;
            document.body.appendChild(host);
        });

        const measureSourcesDialog = async () => await page.evaluate(() =>
        {
            const dialog = document.querySelector(".paid-deck-verification-sources-dialog");
            const scroller = document.querySelector(".verification-declaration-scroller");
            const actionButtons = Array.from(document.querySelectorAll(".verification-sources-actions button"));
            const errorBanner = document.querySelector(".verification-sources-error");

            return {
                pageScrollWidth: document.documentElement.scrollWidth,
                viewportWidth: window.innerWidth,
                dialogWidth: Math.round(dialog.getBoundingClientRect().width),
                // The table must scroll INSIDE its own box rather than widening
                // the page — a page that scrolls sideways carries the dialog's
                // close button off screen.
                scrollerOverflows: scroller.scrollWidth > scroller.clientWidth,
                scrollerFits: Math.round(scroller.getBoundingClientRect().width) <= window.innerWidth,
                actionsFit: actionButtons.every(button => Math.round(button.getBoundingClientRect().right) <= window.innerWidth + 1),
                actionWidths: actionButtons.map(button => Math.round(button.getBoundingClientRect().width)),
                shortestActionHeight: Math.min(...actionButtons.map(button => Math.round(button.getBoundingClientRect().height))),
                errorVisible: errorBanner.getBoundingClientRect().width > 0,
            };
        });

        await runCase("The verification-sources dialog holds together at 1280x800", async () =>
        {
            await page.setViewport({ width: 1280, height: 800 });
            await mountSourcesDialog();
            await sleep(300);

            const layout = await measureSourcesDialog();

            if (layout.pageScrollWidth > layout.viewportWidth + 1)
            {
                throw new Error(`The page scrolls sideways (${layout.pageScrollWidth} > ${layout.viewportWidth}).`);
            }

            if (!layout.actionsFit)
            {
                throw new Error("An action button is outside the viewport.");
            }

            if (!layout.errorVisible)
            {
                throw new Error("The error banner is not rendered.");
            }

            return `dialog ${layout.dialogWidth}px, no page overflow`;
        });

        await runCase("The verification-sources dialog holds together at 390x844 (phone)", async () =>
        {
            await page.setViewport({ width: 390, height: 844 });
            await sleep(400);

            const layout = await measureSourcesDialog();

            if (layout.pageScrollWidth > layout.viewportWidth + 1)
            {
                throw new Error(`The page scrolls sideways at 390px (${layout.pageScrollWidth} > ${layout.viewportWidth}).`);
            }

            if (!layout.scrollerFits)
            {
                throw new Error("The declaration table widened past the viewport instead of scrolling inside its box.");
            }

            if (!layout.actionsFit)
            {
                throw new Error("An action button is outside the viewport at 390px.");
            }

            // Full-width actions at this breakpoint: three buttons side by side
            // on a 390px screen are neither readable nor comfortably tappable.
            const narrowActions = layout.actionWidths.filter(width => width < 240);

            if (narrowActions.length > 0)
            {
                throw new Error(`Action buttons did not go full width at 390px (${layout.actionWidths.join(", ")}).`);
            }

            if (layout.shortestActionHeight < 40)
            {
                throw new Error(`An action button is under a comfortable tap target (${layout.shortestActionHeight}px).`);
            }

            return `actions ${layout.actionWidths.join("/")}px, table scrolls in place`;
        });

        await runCase("The measured classes are the ones the components actually emit", async () =>
        {
            const componentSources =
            [
                {
                    filePath: path.resolve(__dirname, "..", "..", "..", "Main", "Pages", "AdminPanel", "Components", "PaidDeckVerificationSourcesDialog.js"),
                    classNames: ["paid-deck-verification-sources-dialog", "verification-sources-explainer", "verification-sources-tabs",
                        "verification-sources-tab", "verification-sources-error", "verification-source-list", "verification-source-card",
                        "verification-source-name", "verification-source-row", "verification-source-label", "verification-source-value-wrap",
                        "verification-source-card-actions", "verification-source-detach", "verification-declaration-scroller",
                        "verification-declaration-table", "verification-declaration-event", "verification-sources-actions",
                        "verification-sources-secondary", "verification-sources-run"],
                },
                {
                    filePath: path.resolve(__dirname, "..", "..", "..", "Main", "Pages", "AdminPanel", "Components", "PaidDeckVerificationDialog.js"),
                    classNames: ["verification-flag-citation", "verification-flag-citation-source"],
                },
            ];

            for (const componentSource of componentSources)
            {
                const sourceText = fs.readFileSync(componentSource.filePath, "utf8");
                const missing = componentSource.classNames.filter(className => !sourceText.includes(className));

                if (missing.length > 0)
                {
                    throw new Error(`${path.basename(componentSource.filePath)} does not emit: ${missing.join(", ")}`);
                }
            }

            // And that every one of them has a rule, so a measured class cannot
            // be one the stylesheet never styles.
            const stylesheetText = fs.readFileSync(
                path.resolve(__dirname, "..", "..", "..", "Main", "Pages", "AdminPanel", "Styles", "AdminPanelPage.css"), "utf8");

            const unstyled = componentSources
                .flatMap(componentSource => componentSource.classNames)
                .filter(className => !stylesheetText.includes(`.${className}`));

            if (unstyled.length > 0)
            {
                throw new Error(`Emitted but unstyled: ${unstyled.join(", ")}`);
            }

            return "markup, styles and measurements agree";
        });

        await page.evaluate(() =>
        {
            const probe = document.getElementById("verification-sources-probe");
            if (probe)
            {
                probe.remove();
            }
        });

        await page.setViewport({ width: 1440, height: 900 });
    }
    finally
    {
        await browser.close();

        const teardownFailures = await registry.teardown();

        caseNumber += 1;
        const leaks = await registry.verifyNothingLeaked(FIXTURE_COLLECTION_FIELDS);

        if (teardownFailures.length === 0 && leaks.length === 0)
        {
            cases.push({ name: `${String(caseNumber).padStart(2, "0")}. Every fixture this suite created was removed`, status: "PASS", detail: "nothing left under the prefix" });
        }
        else
        {
            cases.push
            ({
                name: `${String(caseNumber).padStart(2, "0")}. Every fixture this suite created was removed`,
                status: "FAIL",
                detail: `teardown errors: [${teardownFailures.join("; ")}] leaked: [${leaks.join("; ")}]`,
            });
        }

        await registry.close();
    }

    const passedCount = cases.filter(caseResult => caseResult.status === "PASS").length;
    const failedCount = cases.filter(caseResult => caseResult.status === "FAIL").length;
    const skippedCount = cases.filter(caseResult => caseResult.status === "SKIPPED").length;

    writeResult
    ({
        service: "Main",
        category: CATEGORY,
        status: failedCount > 0 ? "FAIL" : (skippedCount > 0 || passedCount === 0 ? "SKIPPED" : "PASS"),
        passed: passedCount, failed: failedCount, skipped: skippedCount, total: cases.length,
        coverage:
        {
            kind: "flows",
            label: "Flows exercised",
            percent: cases.length > 0 ? Math.round((passedCount / cases.length) * 100) : 0,
            detail: `${passedCount}/${cases.length} paid-deck flows`,
        },
        cases: cases,
        notes: "",
    });

    console.log(`Main ${CATEGORY}: ${passedCount} passed, ${failedCount} failed, ${skippedCount} skipped`);

    for (const caseResult of cases)
    {
        if (caseResult.status !== "PASS")
        {
            console.log(`  ${caseResult.status}  ${caseResult.name} — ${caseResult.detail}`);
        }
    }

    process.exit(failedCount > 0 ? 1 : 0);
}

main().catch((fatalError) =>
{
    console.error("FATAL", fatalError);
    process.exit(1);
});
