/**
 * PurgeInformationSourceStore
 *
 * One-off migration: removes every uploaded document and everything derived
 * from it, so the platform stops holding the shared, cross-user copies the old
 * content-addressed store accumulated.
 *
 * Why a purge rather than a migration. The previous scheme stored ONE copy of a
 * document and served it to every user who uploaded the same bytes. Migrating
 * those blobs to per-user paths would have preserved the accumulated third-party
 * material — the exact thing the change exists to stop holding. Deleting is both
 * the cleaner engineering step and the correct one: the platform's exposure
 * comes from what it stores, so the migration is to stop storing it.
 *
 * What it removes:
 *   - every informationSources row
 *   - every textEmbeddings chunk (verbatim extracted page text)
 *   - every figures document (extracted images)
 *   - every object under the information-source storage prefix
 *   - every object under the figure storage prefix (the cropped page images
 *     themselves, which the figures documents only point at)
 *
 * What it does NOT touch: decks, cards, study materials, mock tests, progress,
 * users, sessions, purchases, paid decks. Everything a learner actually studies
 * from survives. A user only notices if they try to generate MORE from a
 * document they uploaded before the change — then they re-upload it.
 *
 * Usage (dry run first — it reports counts and changes nothing):
 *     node Common/Scripts/PurgeInformationSourceStore.js
 *     node Common/Scripts/PurgeInformationSourceStore.js --confirm
 *
 * Reads Dock's environment, so it targets whichever environment Dock is
 * configured for. Run it once per environment.
 */

const path = require("path");

const dockDirectory = path.join(__dirname, "..", "..", "Dock");
require(path.join(dockDirectory, "node_modules", "dotenv")).config({ path: path.join(dockDirectory, ".env") });

const DatabaseConnector = require(path.join(dockDirectory, "Globals", "Classes", "Database", "DatabaseConnector"));
const DatabaseConstants = require(path.join(dockDirectory, "Globals", "Constants", "DatabaseConstants"));
const PersistenceConstants = require(path.join(dockDirectory, "Globals", "Constants", "PersistenceConstants"));
const Persistence = require(path.join(dockDirectory, "Globals", "Classes", "Persistence"));
const { storageTargets } = require(path.join(dockDirectory, "Globals", "Enumerations", "StorageTargets"));

const bConfirmed = process.argv.includes("--confirm");

async function purgeInformationSourceStore()
{
    const database = await DatabaseConnector.getDatabase();
    if (database === null)
    {
        console.error("[Purge] No database connection — check MONGODB_URL. Nothing was changed.");
        process.exitCode = 1;
        return;
    }

    const collectionsToEmpty =
    [
        DatabaseConstants.INFORMATION_SOURCES_COLLECTION,
        DatabaseConstants.TEXT_EMBEDDINGS_COLLECTION,
        DatabaseConstants.FIGURES_COLLECTION
    ];

    console.log(`[Purge] Database: ${database.databaseName}`);
    console.log(`[Purge] Mode: ${bConfirmed ? "EXECUTE" : "DRY RUN (pass --confirm to apply)"}`);
    console.log("");

    for (const collectionName of collectionsToEmpty)
    {
        const documentCount = await database.collection(collectionName).countDocuments({});
        console.log(`[Purge] ${collectionName}: ${documentCount} document(s)`);

        if (bConfirmed && documentCount > 0)
        {
            const deleteResult = await database.collection(collectionName).deleteMany({});
            console.log(`[Purge]   -> removed ${deleteResult.deletedCount}`);
        }
    }

    // Object storage. Listing the prefixes is what makes this exhaustive: it
    // catches objects whose row was already gone, which the row-driven purge
    // paths by definition cannot reach.
    //
    // The figure prefix is listed alongside the source prefix because the two
    // are separate object trees. Emptying the `figures` collection above removes
    // the only record of where each cropped page image lives, so a run that
    // skipped this prefix would leave those images permanently unreachable AND
    // permanently stored — the worse of both outcomes.
    const storagePrefixes =
    [
        PersistenceConstants.INFORMATION_SOURCE_DIRECTORY,
        PersistenceConstants.FIGURE_DIRECTORY
    ];

    for (const storagePrefix of storagePrefixes)
    {
        let storedObjectPaths = [];
        try
        {
            storedObjectPaths = await Persistence.list(storagePrefix, storageTargets.LINODE_OBJECT_STORAGE);
        }
        catch (listError)
        {
            console.error(`[Purge] Could not list '${storagePrefix}': ${listError?.message || listError}`);
        }

        console.log("");
        console.log(`[Purge] object storage '${storagePrefix}': ${storedObjectPaths.length} object(s)`);

        if (!bConfirmed)
        {
            continue;
        }

        let removedCount = 0;
        let failedCount = 0;

        for (const storedObjectPath of storedObjectPaths)
        {
            try
            {
                await Persistence.delete(storedObjectPath, storageTargets.LINODE_OBJECT_STORAGE);
                removedCount++;
            }
            catch (deleteError)
            {
                failedCount++;
                console.warn(`[Purge]   failed: ${storedObjectPath} — ${deleteError?.message || deleteError}`);
            }
        }

        console.log(`[Purge]   -> removed ${removedCount}, failed ${failedCount}`);
    }

    console.log("");
    console.log(bConfirmed
        ? "[Purge] Complete. Generated content (decks, cards, study materials, mock tests) was not touched."
        : "[Purge] Dry run only — nothing was changed. Re-run with --confirm to apply.");
}

purgeInformationSourceStore()
    .catch(purgeError =>
    {
        console.error("[Purge] Failed:", purgeError);
        process.exitCode = 1;
    })
    .finally(() => process.exit(process.exitCode || 0));
