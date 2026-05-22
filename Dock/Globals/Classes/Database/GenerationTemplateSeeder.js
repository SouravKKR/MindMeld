const fs = require("fs");
const path = require("path");
const DatabaseConnector = require("./DatabaseConnector");
const GenerationTemplateQueryEngine = require("./GenerationTemplateQueryEngine");


/**
 * GenerationTemplateSeeder
 *
 * Loads `Dock/SeedData/GenerationTemplates.json` on Dock boot and inserts
 * any entries whose `key` is not already in the `generationTemplates`
 * Mongo collection. Existing entries are intentionally left untouched —
 * once a template has been seeded, it is treated as live data and never
 * clobbered by a subsequent boot. This lets the seed file act as a
 * "deliver new templates only" channel rather than a hard sync.
 *
 * Inserted documents carry a `seededAt: Date` stamp so it is easy to see
 * from the Mongo shell which templates came in on which boot. Documents
 * that already exist before this seeder runs (e.g. legacy data, admin
 * additions) keep their existing shape and timestamps.
 *
 * Safe to call multiple times. Each call is idempotent: editing a value
 * in the JSON and rebooting Dock will NOT propagate the change to a key
 * that already exists in Mongo — the operator must drop that key (or
 * edit the doc directly) for the new value to take effect.
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
        let skippedCount = 0;

        for (const templateKey of Object.keys(seedData))
        {
            try
            {
                const bInserted = await GenerationTemplateQueryEngine.insertIfMissing(templateKey, seedData[templateKey]);
                if (bInserted)
                {
                    insertedCount++;
                }
                else
                {
                    skippedCount++;
                }
            }
            catch (insertError)
            {
                console.error(`[GenerationTemplateSeeder] Failed to insert template ${templateKey}: ${insertError.message}`);
            }
        }

        console.log(`[GenerationTemplateSeeder] Inserted ${insertedCount} new template(s); ${skippedCount} already present (left untouched).`);
    }
}

module.exports = GenerationTemplateSeeder;
