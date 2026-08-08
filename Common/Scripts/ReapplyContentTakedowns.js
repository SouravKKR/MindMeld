/**
 * ReapplyContentTakedowns
 *
 * Re-runs every takedown already recorded in the content-takedown register.
 *
 * Why this exists. The takedown purge used to derive ONE blob path from the
 * first matching row and delete one object. That was correct while the store was
 * content-addressed and a single copy served everyone; after storage moved to
 * per-user prefixes it meant a notice against content held by ten accounts
 * deleted one copy and left nine — and recorded `contentRemoved: true` in the
 * register as evidence. The purge is fixed, but the copies it already missed are
 * still in the bucket, and no user-facing path will ever reach them: their rows
 * are gone, so nothing points at them any more.
 *
 * The register is insert-only, which is what makes the repair possible — it
 * still holds every hash that was ever actioned. This walks those hashes through
 * the corrected purge, which is idempotent: rows already deleted are simply not
 * found, and an object already gone deletes cleanly.
 *
 * Each repaired notice is APPENDED to the register rather than editing the
 * original entry. The original is the record of what was believed at the time
 * and must not be rewritten; the new entry is the record of what was actually
 * completed, and its noticeReference cites the entry it repairs.
 *
 * Usage (dry run first — it reports what survived and changes nothing):
 *     node Common/Scripts/ReapplyContentTakedowns.js
 *     node Common/Scripts/ReapplyContentTakedowns.js --confirm
 *
 * Reads Dock's environment, so it targets whichever environment Dock is
 * configured for. Run it once per environment, after deploying the fix.
 */

const path = require("path");

const dockDirectory = path.join(__dirname, "..", "..", "Dock");
require(path.join(dockDirectory, "node_modules", "dotenv")).config({ path: path.join(dockDirectory, ".env") });

const DatabaseConnector = require(path.join(dockDirectory, "Globals", "Classes", "Database", "DatabaseConnector"));
const ContentTakedownNoticeQueryEngine = require(path.join(dockDirectory, "Globals", "Classes", "Database", "ContentTakedownNoticeQueryEngine"));
const InformationSourceQueryEngine = require(path.join(dockDirectory, "Globals", "Classes", "Database", "InformationSourceQueryEngine"));
const DerivedContentQueryEngine = require(path.join(dockDirectory, "Globals", "Classes", "Database", "DerivedContentQueryEngine"));
const InformationSourcePurger = require(path.join(dockDirectory, "Globals", "Classes", "Content", "InformationSourcePurger"));

const REGISTER_PAGE_SIZE = 500;
const REPAIR_REFERENCE_PREFIX = "REPAIR-OF";

const bConfirmed = process.argv.includes("--confirm");

async function collectDistinctActionedHashes()
{
    const distinctContentHashes = [];
    let offset = 0;

    for (;;)
    {
        const registerPage = await ContentTakedownNoticeQueryEngine.list(REGISTER_PAGE_SIZE, offset);

        for (const notice of registerPage.notices)
        {
            // Skip entries this script itself appended, so repeated runs do not
            // pile repair-of-repair records into the register.
            if (typeof notice.noticeReference === "string" && notice.noticeReference.startsWith(REPAIR_REFERENCE_PREFIX))
            {
                continue;
            }

            if (typeof notice.contentHash === "string" && notice.contentHash.length > 0 && !distinctContentHashes.includes(notice.contentHash))
            {
                distinctContentHashes.push(notice.contentHash);
            }
        }

        offset = offset + registerPage.notices.length;
        if (registerPage.notices.length === 0 || offset >= registerPage.totalCount)
        {
            return { distinctContentHashes: distinctContentHashes, totalNoticeCount: registerPage.totalCount };
        }
    }
}

async function reapplyContentTakedowns()
{
    const database = await DatabaseConnector.getDatabase();
    if (database === null)
    {
        console.error("[ReapplyTakedowns] No database connection — check MONGODB_URL. Nothing was changed.");
        process.exitCode = 1;
        return;
    }

    console.log(`[ReapplyTakedowns] Database: ${database.databaseName}`);
    console.log(`[ReapplyTakedowns] Mode: ${bConfirmed ? "EXECUTE" : "DRY RUN (pass --confirm to apply)"}`);
    console.log("");

    const { distinctContentHashes, totalNoticeCount } = await collectDistinctActionedHashes();
    console.log(`[ReapplyTakedowns] ${totalNoticeCount} register entry(ies), ${distinctContentHashes.length} distinct hash(es).`);
    console.log("");

    let residueHashCount = 0;

    for (const contentHash of distinctContentHashes)
    {
        const survivingSources = await InformationSourceQueryEngine.getInformationSourcesByHash(contentHash);
        const survivingDerivedCounts = await DerivedContentQueryEngine.countByContentHash(contentHash);
        const survivingStoredCopies = InformationSourcePurger.countStoredCopies(survivingSources, contentHash);

        const bHasRowResidue = survivingSources.length > 0 || survivingDerivedCounts.embeddingChunks > 0 || survivingDerivedCounts.figures > 0;

        // A hash with no surviving rows may still have surviving BYTES, because
        // the old purge deleted the rows for every tenant and the object for
        // only one. Those objects cannot be located from here — nothing records
        // their path any more — so they are reclaimed by the reaper's figure and
        // orphan sweeps rather than by this script, which is why a clean report
        // here is not by itself proof the bucket is clean.
        if (!bHasRowResidue)
        {
            console.log(`[ReapplyTakedowns] ${contentHash.slice(0, 16)}… — no surviving rows.`);
            continue;
        }

        residueHashCount++;
        console.log(
            `[ReapplyTakedowns] ${contentHash.slice(0, 16)}… — ${survivingSources.length} surviving row(s), ` +
            `${survivingStoredCopies} stored copy(ies), ${survivingDerivedCounts.embeddingChunks} chunk(s), ` +
            `${survivingDerivedCounts.figures} figure(s).`,
        );

        if (!bConfirmed)
        {
            continue;
        }

        const purgeResult = await InformationSourcePurger.purgeAllSourcesWithContentHash(contentHash);

        await ContentTakedownNoticeQueryEngine.record
        ({
            contentHash: contentHash,
            noticeReference: `${REPAIR_REFERENCE_PREFIX}:${contentHash}`,
            reason: "Automated re-application of a previously recorded takedown, after the purge was corrected to delete one stored copy per holder rather than one in total.",
            actorUserId: null,
            actorEmail: null,
            rowsRemoved: purgeResult.rowsRemoved,
            rowsFailed: purgeResult.rowsFailed,
            affectedUserIds: purgeResult.affectedUserIds,
            storedCopiesFound: purgeResult.storedCopiesFound,
            storedCopiesRemoved: purgeResult.storedCopiesRemoved,
            bContentRemoved: purgeResult.bContentRemoved,
            embeddingChunksRemoved: purgeResult.embeddingChunksRemoved,
            figuresRemoved: purgeResult.figuresRemoved,
            figureObjectsRemoved: purgeResult.figureObjectsRemoved,
            storageError: purgeResult.storageError
        });

        console.log(
            `[ReapplyTakedowns]   -> removed ${purgeResult.rowsRemoved} row(s), ` +
            `${purgeResult.storedCopiesRemoved}/${purgeResult.storedCopiesFound} stored copy(ies), ` +
            `${purgeResult.figureObjectsRemoved} figure object(s).`,
        );
    }

    console.log("");
    console.log(bConfirmed
        ? `[ReapplyTakedowns] Complete. ${residueHashCount} hash(es) had residue and were re-purged.`
        : `[ReapplyTakedowns] Dry run only — ${residueHashCount} hash(es) have residue. Re-run with --confirm to apply.`);
}

reapplyContentTakedowns()
    .catch(reapplyError =>
    {
        console.error("[ReapplyTakedowns] Failed:", reapplyError);
        process.exitCode = 1;
    })
    .finally(() => process.exit(process.exitCode || 0));
