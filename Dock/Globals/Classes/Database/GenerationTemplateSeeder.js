const fs = require("fs");
const path = require("path");
const DatabaseConnector = require("./DatabaseConnector");
const GenerationTemplateQueryEngine = require("./GenerationTemplateQueryEngine");


/**
 * GenerationTemplateSeeder
 *
 * Loads `Dock/SeedData/GenerationTemplates.json` on Dock boot and
 * upserts every entry into the `generationTemplates` Mongo collection,
 * keyed by `(userId, key)`. The seed file is the source of truth: any
 * value in the JSON wins, even if the document already exists. This
 * makes the workflow "edit JSON → restart Dock → UI reflects the new
 * values" reliable.
 *
 * Documents carry a `seededAt: Date` stamp refreshed on every reseed,
 * so operators can see from the Mongo shell when a given template was
 * last synced from disk. `_id` is preserved across reseeds via
 * `replaceOne`, so external references that point at a template by
 * `_id` remain stable.
 *
 * Safe to call multiple times. Manual edits to seeded keys via the
 * Mongo shell will be overwritten on the next boot — to persist an
 * admin override, also update the seed file.
 */
class GenerationTemplateSeeder
{
    static SEED_FILE_RELATIVE_PATH = "../../../SeedData/GenerationTemplates.json";

    static async seedNewFromJsonFile()
    {
        const seedFilePath = path.join(__dirname, GenerationTemplateSeeder.SEED_FILE_RELATIVE_PATH);

        if (!fs.existsSync(seedFilePath))
        {
            console.warn(`[GenerationTemplateSeeder] Seed file not found at ${seedFilePath} — skipping.`);
            return;
        }

        let seedData;
        try
        {
            const seedFileContents = fs.readFileSync(seedFilePath, "utf-8");
            seedData = JSON.parse(seedFileContents);
        }
        catch (parseError)
        {
            console.error(`[GenerationTemplateSeeder] Failed to parse seed file: ${parseError.message}`);
            return;
        }

        if (!seedData || typeof seedData !== "object")
        {
            console.warn("[GenerationTemplateSeeder] Seed file did not yield an object — skipping.");
            return;
        }

        // Pre-flight DB liveness check: when Mongo is unreachable we want
        // ONE clear log line, not 20 "Cannot read properties of null"
        // failures from inside the per-template loop below.
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            console.warn("[GenerationTemplateSeeder] Database unavailable — skipping template seeding. Check the Mongo connection (CONNECTION_STRING / network).");
            return;
        }

        let insertedCount = 0;
        let updatedCount = 0;

        for (const templateKey of Object.keys(seedData))
        {
            try
            {
                const seedResult = await GenerationTemplateQueryEngine.upsertFromSeed(templateKey, seedData[templateKey]);
                if (seedResult.inserted)
                {
                    insertedCount++;
                }
                else if (seedResult.updated)
                {
                    updatedCount++;
                }
            }
            catch (seedError)
            {
                console.error(`[GenerationTemplateSeeder] Failed to seed template ${templateKey}: ${seedError.message}`);
            }
        }

        const totalSeedEntries = Object.keys(seedData).length;
        console.log(`[GenerationTemplateSeeder] Inserted ${insertedCount} new template(s); updated ${updatedCount} existing; total seed entries = ${totalSeedEntries}.`);
    }
}

module.exports = GenerationTemplateSeeder;
