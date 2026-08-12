/**
 * Merges every account sharing one email into its most-established survivor,
 * via the same AccountMergeService the live login path uses. Defaults to a
 * dry run — it reports what each account holds and does not write anything.
 * Pass --apply to actually perform the merge.
 *
 * Usage (run from the Dock directory):
 *   node Scripts/MergeDuplicateAccount.mjs --email=someone@example.com            (dry run)
 *   node Scripts/MergeDuplicateAccount.mjs --email=someone@example.com --apply    (real merge)
 *
 * Run Scripts/FindDuplicateAccountsByEmail.mjs first to find which emails
 * need this.
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

const require = createRequire(import.meta.url);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

require("dotenv").config({ path: path.join(currentDirectory, "..", ".env") });

const DatabaseConnector = require("../Globals/Classes/Database/DatabaseConnector");
const AuthenticationQueryEngine = require("../Globals/Classes/Database/AuthenticationQueryEngine");
const AccountIdentityResolver = require("../Globals/Classes/Authentication/AccountIdentityResolver");
const AccountMergeService = require("../Globals/Classes/Authentication/AccountMergeService");
const AccountMergeCollectionPlan = require("../Globals/Classes/Authentication/AccountMergeCollectionPlan");

function parseArguments(argv)
{
    const parsed = { email: "", bApply: false };

    for (const argument of argv)
    {
        if (argument.startsWith("--email="))
        {
            parsed.email = argument.slice("--email=".length).trim().toLowerCase();
        }
        else if (argument === "--apply")
        {
            parsed.bApply = true;
        }
    }

    return parsed;
}

async function reportAccountContents(database, userId, label)
{
    console.log(`  ${label} (${userId}):`);
    let bAnyContent = false;

    for (const entry of AccountMergeCollectionPlan.PLAN)
    {
        const count = await database.collection(entry.collectionName).countDocuments({ userId: userId });
        if (count > 0)
        {
            console.log(`    ${entry.collectionName}: ${count}`);
            bAnyContent = true;
        }
    }

    const escapedUserId = userId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const dailyActivityCount = await database.collection(AccountMergeCollectionPlan.DAILY_ACTIVITY_COLLECTION_NAME)
        .countDocuments({ scopeKey: { $regex: `^${escapedUserId}(::org:.*)?$` } });
    if (dailyActivityCount > 0)
    {
        console.log(`    ${AccountMergeCollectionPlan.DAILY_ACTIVITY_COLLECTION_NAME}: ${dailyActivityCount}`);
        bAnyContent = true;
    }

    if (!bAnyContent)
    {
        console.log("    (no content)");
    }
}

async function main()
{
    const { email, bApply } = parseArguments(process.argv.slice(2));

    if (!email)
    {
        console.error("Usage: node Scripts/MergeDuplicateAccount.mjs --email=someone@example.com [--apply]");
        process.exit(1);
    }

    console.log(`CogniumLearn — account merge for "${email}" ${bApply ? "(APPLYING)" : "(DRY RUN — pass --apply to actually merge)"}\n`);

    const database = await DatabaseConnector.getDatabase();
    if (!database)
    {
        console.error("MongoDB is not reachable (MONGODB_URL not set / server down).");
        process.exit(1);
    }

    const matchingAccounts = await AuthenticationQueryEngine.getUsersByEmail(email);

    if (matchingAccounts.length === 0)
    {
        console.log("No accounts found for this email.");
        process.exit(0);
    }

    if (matchingAccounts.length === 1)
    {
        console.log(`Only one account found (${matchingAccounts[0].getId()}) — nothing to merge.`);
        process.exit(0);
    }

    const survivorAccount = AccountIdentityResolver.pickMostEstablishedAccount(matchingAccounts);
    console.log(`Found ${matchingAccounts.length} accounts sharing this email. Survivor (oldest joinDate): ${survivorAccount.getId()}\n`);

    for (const account of matchingAccounts)
    {
        await reportAccountContents(database, account.getId(), account.getId() === survivorAccount.getId() ? "SURVIVOR" : "will be merged away");
    }

    if (!bApply)
    {
        console.log("\nDry run only — no changes made. Re-run with --apply to perform the merge.");
        try { await DatabaseConnector.getMongoClient()?.close(); } catch (closeError) { }
        return;
    }

    console.log("\nApplying merge...");

    let currentSurvivor = survivorAccount;
    for (const account of matchingAccounts)
    {
        if (account.getId() === currentSurvivor.getId())
        {
            continue;
        }

        const mergedUser = await AccountMergeService.mergeAccounts(currentSurvivor, account, { triggerContext: "OPERATOR_SCRIPT" });
        if (!mergedUser)
        {
            console.error(`Merge of ${account.getId()} into ${currentSurvivor.getId()} was skipped or failed — check the Dock logs for details, then re-run this script (merges are idempotent and safe to retry).`);
            process.exitCode = 1;
            break;
        }
        currentSurvivor = mergedUser;
    }

    console.log(`\nMerge complete. Canonical account: ${currentSurvivor.getId()}`);

    try { await DatabaseConnector.getMongoClient()?.close(); } catch (closeError) { }
}

main().catch((fatalError) =>
{
    console.error("\nFATAL:");
    console.error(fatalError);
    process.exit(1);
});
