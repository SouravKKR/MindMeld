const fs = require("fs");
const path = require("path");
const DatabaseConnector = require("./DatabaseConnector");
const LegalDocumentQueryEngine = require("./LegalDocumentQueryEngine");


/**
 * LegalDocumentSeeder
 *
 * Reads `Dock/SeedData/LegalDocuments.json` on Dock boot and reconciles
 * every entry against the `legalDocuments` collection via
 * `LegalDocumentQueryEngine.upsertVersioned`. The reconciliation rules:
 *
 *   - New key in the seed file → inserted verbatim.
 *   - Seed version > stored version → contentHtml / title / version are
 *     overwritten. Every user whose stored agreement is below the new
 *     version will be re-prompted on their next login.
 *   - Seed version <= stored version → stored document is left alone.
 *     This lets an admin hand-edit content directly in Mongo without
 *     losing the change on the next reboot.
 *   - Stored key absent from the seed file → deleted, so retiring a
 *     document (e.g. dropping the old EULA) propagates to Mongo on
 *     the next boot instead of lingering forever.
 *
 * Safe to call multiple times. Idempotent across reboots that don't
 * bump versions in the seed file.
 */
class LegalDocumentSeeder
{
    static SEED_FILE_RELATIVE_PATH = "../../../SeedData/LegalDocuments.json";

    static async seedFromJsonFile()
    {
        const seedFilePath = path.join(__dirname, LegalDocumentSeeder.SEED_FILE_RELATIVE_PATH);

        if (!fs.existsSync(seedFilePath))
        {
            console.warn(`[LegalDocumentSeeder] Seed file not found at ${seedFilePath} — skipping.`);
            return;
        }

        let seedDocuments;
        try
        {
            const seedFileContents = fs.readFileSync(seedFilePath, "utf-8");
            seedDocuments = JSON.parse(seedFileContents);
        }
        catch (parseError)
        {
            console.error(`[LegalDocumentSeeder] Failed to parse seed file: ${parseError.message}`);
            return;
        }

        if (!Array.isArray(seedDocuments))
        {
            console.warn("[LegalDocumentSeeder] Seed file did not yield a JSON array — skipping.");
            return;
        }

        // Pre-flight DB liveness check so one connection failure produces
        // one clear log line rather than N copies of the same error.
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            console.warn("[LegalDocumentSeeder] Database unavailable — skipping legal-document seeding.");
            return;
        }

        let insertedCount = 0;
        let upgradedCount = 0;
        let unchangedCount = 0;

        for (let documentIndex = 0; documentIndex < seedDocuments.length; documentIndex++)
        {
            const seedDocument = seedDocuments[documentIndex];

            if (!LegalDocumentSeeder.#validate(seedDocument))
            {
                console.warn(`[LegalDocumentSeeder] Skipping malformed entry at index ${documentIndex}.`);
                continue;
            }

            try
            {
                const result = await LegalDocumentQueryEngine.upsertVersioned(seedDocument);
                if (result.inserted)
                {
                    insertedCount++;
                }
                else if (result.upgraded)
                {
                    upgradedCount++;
                }
                else
                {
                    unchangedCount++;
                }
            }
            catch (upsertError)
            {
                console.error(`[LegalDocumentSeeder] Failed to upsert "${seedDocument.key}": ${upsertError.message}`);
            }
        }

        const seededKeys = seedDocuments
            .filter(seedDocument => LegalDocumentSeeder.#validate(seedDocument))
            .map(seedDocument => seedDocument.key);

        let prunedCount = 0;
        try
        {
            prunedCount = await LegalDocumentQueryEngine.pruneKeysNotIn(seededKeys);
        }
        catch (pruneError)
        {
            console.error(`[LegalDocumentSeeder] Prune failed: ${pruneError.message}`);
        }

        console.log(`[LegalDocumentSeeder] Inserted ${insertedCount}, upgraded ${upgradedCount}, unchanged ${unchangedCount}, pruned ${prunedCount}.`);
    }

    static #validate(seedDocument)
    {
        if (!seedDocument || typeof seedDocument !== "object")
        {
            return false;
        }
        if (typeof seedDocument.key !== "string" || seedDocument.key.length === 0)
        {
            return false;
        }
        if (typeof seedDocument.title !== "string" || seedDocument.title.length === 0)
        {
            return false;
        }
        if (typeof seedDocument.contentHtml !== "string" || seedDocument.contentHtml.length === 0)
        {
            return false;
        }
        const numericVersion = Number(seedDocument.version);
        if (!Number.isFinite(numericVersion) || numericVersion < 1)
        {
            return false;
        }
        return true;
    }
}

module.exports = LegalDocumentSeeder;
