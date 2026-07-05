const fs = require("fs");
const path = require("path");
const DatabaseConnector = require("./DatabaseConnector");
const AllowedLoginEmailQueryEngine = require("./AllowedLoginEmailQueryEngine");


/**
 * AllowedLoginEmailSeeder
 *
 * Reads `Dock/SeedData/AllowedLoginEmails.json` on Dock boot and inserts
 * any email not already present in the `allowedLoginEmails` collection.
 * The seed file is a *bootstrap* channel — it lets a fresh dev / test
 * deployment have the founder on the login allowlist before the admin
 * panel exists to add others.
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
class AllowedLoginEmailSeeder
{
    static SEED_FILE_RELATIVE_PATH = "../../../SeedData/AllowedLoginEmails.json";

    static async seedFromJsonFile()
    {
        const seedFilePath = path.join(__dirname, AllowedLoginEmailSeeder.SEED_FILE_RELATIVE_PATH);

        if (!fs.existsSync(seedFilePath))
        {
            console.warn(`[AllowedLoginEmailSeeder] Seed file not found at ${seedFilePath} — skipping.`);
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
            console.error(`[AllowedLoginEmailSeeder] Failed to parse seed file: ${parseError.message}`);
            return;
        }

        if (!Array.isArray(seedEntries))
        {
            console.warn("[AllowedLoginEmailSeeder] Seed file did not yield a JSON array — skipping.");
            return;
        }

        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            console.warn("[AllowedLoginEmailSeeder] Database unavailable — skipping allowed-login-email seeding.");
            return;
        }

        let insertedCount = 0;
        let skippedCount = 0;

        for (let entryIndex = 0; entryIndex < seedEntries.length; entryIndex++)
        {
            const seedEntry = seedEntries[entryIndex];

            if (!AllowedLoginEmailSeeder.#validate(seedEntry))
            {
                console.warn(`[AllowedLoginEmailSeeder] Skipping malformed entry at index ${entryIndex}.`);
                continue;
            }

            try
            {
                const alreadyExists = await AllowedLoginEmailQueryEngine.isAllowedEmail(seedEntry.email);
                if (alreadyExists)
                {
                    skippedCount++;
                    continue;
                }

                await AllowedLoginEmailQueryEngine.addAllowed(seedEntry.email, null, seedEntry.notes || "");
                insertedCount++;
            }
            catch (upsertError)
            {
                console.error(`[AllowedLoginEmailSeeder] Failed to upsert "${seedEntry.email}": ${upsertError.message}`);
            }
        }

        console.log(`[AllowedLoginEmailSeeder] Inserted ${insertedCount}, skipped ${skippedCount}.`);
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

module.exports = AllowedLoginEmailSeeder;
