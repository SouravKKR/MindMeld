/**
 * Read-only report: finds every set of user accounts that share one email
 * address (case-insensitively) under different ids — the account-identity
 * split that AccountIdentityResolver
 * (Dock/Globals/Classes/Authentication/AccountIdentityResolver.js) prevents
 * from forming going forward, but cannot undo for accounts that already
 * split before it existed.
 *
 * Makes no writes. Run from the Dock directory:
 *     node Scripts/FindDuplicateAccountsByEmail.mjs
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

const require = createRequire(import.meta.url);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

// Load Dock/.env exactly like the server does.
require("dotenv").config({ path: path.join(currentDirectory, "..", ".env") });

const DatabaseConnector = require("../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../Globals/Constants/DatabaseConstants");

async function main()
{
    console.log("CogniumLearn — duplicate-account-by-email report (read-only)\n");

    const database = await DatabaseConnector.getDatabase();
    if (!database)
    {
        console.error("MongoDB is not reachable (MONGODB_URL not set / server down).");
        process.exitCode = 1;
        return;
    }

    const duplicateGroups = await database.collection(DatabaseConstants.USERS_COLLECTION).aggregate
    ([
        { $addFields: { normalizedEmailForReport: { $toLower: { $trim: { input: { $ifNull: ["$additionalData.email", ""] } } } } } },
        { $match: { normalizedEmailForReport: { $ne: "" } } },
        { $group: { _id: "$normalizedEmailForReport", accountIds: { $push: "$id" }, providers: { $push: "$provider" }, joinDates: { $push: "$joinDate" }, count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
        { $sort: { count: -1 } }
    ]).toArray();

    if (duplicateGroups.length === 0)
    {
        console.log("No duplicate-email account groups found.");
    }
    else
    {
        console.log(`Found ${duplicateGroups.length} email(s) with more than one account:\n`);
        for (const duplicateGroup of duplicateGroups)
        {
            console.log(`  ${duplicateGroup._id}  (${duplicateGroup.count} accounts)`);
            for (let accountIndex = 0; accountIndex < duplicateGroup.accountIds.length; accountIndex++)
            {
                console.log(`    - id=${duplicateGroup.accountIds[accountIndex]}  provider=${duplicateGroup.providers[accountIndex]}  joinDate=${duplicateGroup.joinDates[accountIndex]}`);
            }
        }
    }

    try { await DatabaseConnector.getMongoClient()?.close(); } catch (closeError) { }
}

main().catch((fatalError) =>
{
    console.error("\nFATAL — report script crashed:");
    console.error(fatalError);
    process.exit(1);
});
