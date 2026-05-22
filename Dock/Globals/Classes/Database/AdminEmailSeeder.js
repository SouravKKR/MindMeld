const fs = require("fs");
const path = require("path");
const DatabaseConnector = require("./DatabaseConnector");
const AdminEmailQueryEngine = require("./AdminEmailQueryEngine");


/**
 * AdminEmailSeeder
 *
 * Reads `Dock/SeedData/AdminEmails.json` on Dock boot and inserts any
 * email not already present in the `adminEmails` collection. The seed
 * file is a *bootstrap* channel — it lets a fresh deployment have a
 * founder admin before the admin panel exists to add others.
 *
 * Rules:
 *   - New email in the seed file → inserted with addedBy left blank.
 *   - Existing row → left strictly alone (addedAt and notes preserved).
 *   - Rows deleted via the admin UI are NEVER re-inserted on the next
 *     boot — removal is sticky. (We achieve this by upsert-on-insert
 *     semantics, not by overwriting.)
 *
 * Safe to call multiple times. Idempotent across reboots.
 */
class AdminEmailSeeder
{
    static SEED_FILE_RELATIVE_PATH = "../../../SeedData/AdminEmails.json";

    static async seedFromJsonFile()
    {
        const seedFilePath = path.join(__dirname, AdminEmailSeeder.SEED_FILE_RELATIVE_PATH);

        if (!fs.existsSync(seedFilePath))
        {
            console.warn(`[AdminEmailSeeder] Seed file not found at ${seedFilePath} — skipping.`);
            return;
        }

        let seedEntries;
        try
        {
            const seedFileContents = fs.readFileSync(seedFilePath, "utf-8");
            seedEntries = JSON.parse(seedFileContents);
        }
        catch (parseError)
        {
            console.error(`[AdminEmailSeeder] Failed to parse seed file: ${parseError.message}`);
            return;
        }

        if (!Array.isArray(seedEntries))
        {
            console.warn("[AdminEmailSeeder] Seed file did not yield a JSON array — skipping.");
            return;
        }

        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            console.warn("[AdminEmailSeeder] Database unavailable — skipping admin-email seeding.");
            return;
        }

        let insertedCount = 0;
        let skippedCount = 0;

        for (let entryIndex = 0; entryIndex < seedEntries.length; entryIndex++)
        {
            const seedEntry = seedEntries[entryIndex];

            if (!AdminEmailSeeder.#validate(seedEntry))
            {
                console.warn(`[AdminEmailSeeder] Skipping malformed entry at index ${entryIndex}.`);
                continue;
            }

            try
            {
                const alreadyExists = await AdminEmailQueryEngine.isAdminEmail(seedEntry.email);
                if (alreadyExists)
                {
                    skippedCount++;
                    continue;
                }

                await AdminEmailQueryEngine.addAdmin(seedEntry.email, null, seedEntry.notes || "");
                insertedCount++;
            }
            catch (upsertError)
            {
                console.error(`[AdminEmailSeeder] Failed to upsert "${seedEntry.email}": ${upsertError.message}`);
            }
        }

        console.log(`[AdminEmailSeeder] Inserted ${insertedCount}, skipped ${skippedCount}.`);
    }

    static #validate(seedEntry)
    {
        if (!seedEntry || typeof seedEntry !== "object")
        {
            return false;
        }
        if (typeof seedEntry.email !== "string" || seedEntry.email.indexOf("@") < 0)
        {
            return false;
        }
        return true;
    }
}

module.exports = AdminEmailSeeder;
