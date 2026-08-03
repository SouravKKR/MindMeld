/**
 * MigrateAiGeneratedDeckFlag
 *
 * One-off migration: renames the AI-generated deck marker from
 * `additionalData.protected` to `additionalData.aiGenerated` on every stored
 * deck.
 *
 * Why rename. The marker means exactly one thing — this deck node was created
 * by, or generated into by, the automatic generation pipeline. "protected"
 * described the effect (no export) rather than the meaning, and read as though
 * it were about access control, so every identifier built on top of it
 * inherited the wrong word. Anyone reading the raw database saw a key that did
 * not say what it was.
 *
 * What it changes, per matched deck:
 *   - sets   data.additionalData.aiGenerated = true
 *   - unsets data.additionalData.protected
 *   - bumps  data.lifecycle.lastModified and serverUpdatedAt
 *
 * The timestamp bump is not cosmetic. SyncApplier discards any incoming deck
 * whose lastModified is not strictly newer than the local copy, so without it
 * clients would pull the migrated row and throw it away — keeping the legacy
 * key locally forever. The new value is max(now, stored + 1ms) so a deck whose
 * timestamp sits ahead of the server clock still moves forward.
 *
 * Nothing else on the deck is touched: the update uses targeted dotted paths,
 * so syllabusPosition, partialCompletion, paidDeckId, the auto-analysis fields
 * and everything else survive untouched.
 *
 * Safe to run before OR after deploying the new code, and safe to re-run:
 * AiGeneratedDeckFields.isMarked accepts both keys for one release, and this
 * script only matches decks that still carry the legacy one.
 *
 * Usage (dry run first — it reports counts and changes nothing):
 *     node Common/Scripts/MigrateAiGeneratedDeckFlag.js
 *     node Common/Scripts/MigrateAiGeneratedDeckFlag.js --confirm
 *
 * Reads Dock's environment, so it targets whichever environment Dock is
 * configured for. Run it once per environment.
 */

const path = require("path");

const dockDirectory = path.join(__dirname, "..", "..", "Dock");
require(path.join(dockDirectory, "node_modules", "dotenv")).config({ path: path.join(dockDirectory, ".env") });

const DatabaseConnector = require(path.join(dockDirectory, "Globals", "Classes", "Database", "DatabaseConnector"));
const DatabaseConstants = require(path.join(dockDirectory, "Globals", "Constants", "DatabaseConstants"));
const AiGeneratedDeckFields = require(path.join(dockDirectory, "Globals", "Classes", "Security", "AiGeneratedDeckFields"));

const bConfirmed = process.argv.includes("--confirm");

const LEGACY_KEY_PATH = "data.additionalData." + AiGeneratedDeckFields.LEGACY_AI_GENERATED;
const CURRENT_KEY_PATH = "data.additionalData." + AiGeneratedDeckFields.AI_GENERATED;

/**
 * The lastModified value to write for one deck, as the ISO string
 * Lifecycle.toJson emits. Kept strictly ahead of the stored value so the
 * migrated row actually wins on the client.
 */
function resolveMigratedLastModified(storedDeckDocument)
{
    const storedLastModifiedValue = storedDeckDocument?.data?.lifecycle?.lastModified;
    const storedLastModifiedMilliseconds = storedLastModifiedValue ? new Date(storedLastModifiedValue).getTime() : Number.NaN;

    if (Number.isNaN(storedLastModifiedMilliseconds))
    {
        return new Date().toISOString();
    }

    return new Date(Math.max(Date.now(), storedLastModifiedMilliseconds + 1)).toISOString();
}

async function migrateAiGeneratedDeckFlag()
{
    const database = await DatabaseConnector.getDatabase();
    if (database === null)
    {
        console.error("[Migrate] No database connection — check MONGODB_URL. Nothing was changed.");
        process.exitCode = 1;
        return;
    }

    const deckCollection = database.collection(DatabaseConstants.DECKS_COLLECTION);
    const legacyFilter = { [LEGACY_KEY_PATH]: true };

    const legacyDeckCount = await deckCollection.countDocuments(legacyFilter);
    const alreadyMigratedCount = await deckCollection.countDocuments({ [CURRENT_KEY_PATH]: true });

    console.log(`[Migrate] Database: ${database.databaseName}`);
    console.log(`[Migrate] Mode: ${bConfirmed ? "EXECUTE" : "DRY RUN (pass --confirm to apply)"}`);
    console.log(`[Migrate] Decks still carrying the legacy '${AiGeneratedDeckFields.LEGACY_AI_GENERATED}' key: ${legacyDeckCount}`);
    console.log(`[Migrate] Decks already carrying '${AiGeneratedDeckFields.AI_GENERATED}': ${alreadyMigratedCount}`);
    console.log("");

    if (legacyDeckCount === 0)
    {
        console.log("[Migrate] Nothing to migrate.");
        return;
    }

    if (!bConfirmed)
    {
        console.log("[Migrate] Dry run complete — no documents were changed. Re-run with --confirm to apply.");
        return;
    }

    // Per-document rather than one updateMany, because each deck needs its own
    // lastModified computed from its own stored value.
    const legacyDeckCursor = deckCollection.find(legacyFilter, { projection: { _id: 1, "data.lifecycle.lastModified": 1 } });

    let migratedCount = 0;

    while (await legacyDeckCursor.hasNext())
    {
        const storedDeckDocument = await legacyDeckCursor.next();

        await deckCollection.updateOne(
            { _id: storedDeckDocument._id },
            {
                $set:
                {
                    [CURRENT_KEY_PATH]: true,
                    "data.lifecycle.lastModified": resolveMigratedLastModified(storedDeckDocument),
                    serverUpdatedAt: new Date(),
                },
                $unset: { [LEGACY_KEY_PATH]: "" },
            },
        );

        migratedCount++;

        if (migratedCount % 500 === 0)
        {
            console.log(`[Migrate] Migrated ${migratedCount} / ${legacyDeckCount} deck(s)...`);
        }
    }

    const remainingLegacyCount = await deckCollection.countDocuments(legacyFilter);

    console.log("");
    console.log(`[Migrate] Migrated ${migratedCount} deck(s).`);
    console.log(`[Migrate] Decks still carrying the legacy key: ${remainingLegacyCount}`);

    if (remainingLegacyCount > 0)
    {
        console.warn("[Migrate] Some decks were written after the scan started — re-run to pick them up.");
    }
}

migrateAiGeneratedDeckFlag()
    .catch((migrationError) =>
    {
        console.error("[Migrate] Failed:", migrationError);
        process.exitCode = 1;
    })
    .finally(() => process.exit(process.exitCode || 0));
