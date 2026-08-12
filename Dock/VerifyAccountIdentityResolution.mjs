/**
 * End-to-end verification harness for AccountIdentityResolver — the shared
 * account-lookup logic that makes Google and Email+OTP login resolve to the
 * same account, and consistently pick one account when a split already
 * exists.
 *
 * Run from the Dock directory:
 *     node VerifyAccountIdentityResolution.mjs
 *
 * Two tiers, each self-gating so the default run needs no external services:
 *
 *   1. ALWAYS — pure, in-process checks of the resolution logic itself
 *      (survivor selection, id/email de-duplication) with
 *      AuthenticationQueryEngine's lookups stubbed. No network, no DB.
 *
 *   2. DB (opt-in: VERIFY_ACCOUNT_IDENTITY_DB=1) — drives the real resolver
 *      against the configured MongoDB: a genuinely new email only ever
 *      produces one account across both login providers, and a pre-existing
 *      split resolves both providers to the same (older) account. Creates
 *      throwaway *.invalid users and cleans them up. Skips (not fails) when
 *      the flag is off or Mongo is down.
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

const require = createRequire(import.meta.url);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

// Load Dock/.env exactly like the server does, so the DB tier sees the same
// configuration. Missing file is fine — the always-on tier needs no env.
require("dotenv").config({ path: path.join(currentDirectory, ".env") });

const AccountIdentityResolver = require("./Globals/Classes/Authentication/AccountIdentityResolver");
const AuthenticationQueryEngine = require("./Globals/Classes/Database/AuthenticationQueryEngine");
const User = require("./Globals/Model/User");
const { authenticationProviders } = require("./Globals/Enumerations/AuthenticationProviders");

let passedCount = 0;
let failedCount = 0;
let skippedCount = 0;

function assert(condition, description)
{
    if (condition)
    {
        passedCount = passedCount + 1;
        console.log(`  PASS  ${description}`);
    }
    else
    {
        failedCount = failedCount + 1;
        console.log(`  FAIL  ${description}`);
    }
}

function skip(description)
{
    skippedCount = skippedCount + 1;
    console.log(`  SKIP  ${description}`);
}

function section(title)
{
    console.log(`\n=== ${title} ===`);
}

function buildFakeUser(id, joinDate, email)
{
    return new User
    ({
        id: id,
        displayName: id,
        provider: authenticationProviders.EMAIL_OTP,
        joinDate: joinDate,
        preferences: {},
        additionalData: { email: email }
    });
}

async function runAlwaysOnTier()
{
    section("Tier 1 — resolution logic (always on)");

    // pickMostEstablishedAccount: earlier joinDate wins, regardless of order.
    const olderAccount = buildFakeUser("older-id", new Date("2020-01-01"), "shared@example.com");
    const newerAccount = buildFakeUser("newer-id", new Date("2024-01-01"), "shared@example.com");
    assert(AccountIdentityResolver.pickMostEstablishedAccount([olderAccount, newerAccount]) === olderAccount, "The earlier-joinDate account wins regardless of array order");
    assert(AccountIdentityResolver.pickMostEstablishedAccount([newerAccount, olderAccount]) === olderAccount, "Order does not affect which account wins");

    // A missing joinDate never wins over a real one.
    const noJoinDateAccount = buildFakeUser("no-join-date-id", null, "shared@example.com");
    assert(AccountIdentityResolver.pickMostEstablishedAccount([noJoinDateAccount, newerAccount]) === newerAccount, "A real joinDate beats a missing one");
    assert(AccountIdentityResolver.pickMostEstablishedAccount([newerAccount, noJoinDateAccount]) === newerAccount, "A real joinDate beats a missing one regardless of order");

    // A single account is returned as-is.
    assert(AccountIdentityResolver.pickMostEstablishedAccount([olderAccount]) === olderAccount, "A single-account array returns that account unchanged");

    // resolveExistingAccountsForLogin de-duplicates by id across the id and
    // email lookups — stub AuthenticationQueryEngine's DB-backed methods so
    // this runs with no database.
    const originalGetUserById = AuthenticationQueryEngine.getUserById;
    const originalGetUsersByEmail = AuthenticationQueryEngine.getUsersByEmail;

    try
    {
        AuthenticationQueryEngine.getUserById = async (id) => (id === "google-sub-123" ? buildFakeUser("google-sub-123", new Date("2023-01-01"), "person@example.com") : null);
        AuthenticationQueryEngine.getUsersByEmail = async (email) =>
        (
            email === "person@example.com"
                ? [buildFakeUser("google-sub-123", new Date("2023-01-01"), "person@example.com"), buildFakeUser("person@example.com", new Date("2022-01-01"), "person@example.com")]
                : []
        );

        const resolvedAccounts = await AccountIdentityResolver.resolveExistingAccountsForLogin("google-sub-123", "person@example.com");
        assert(resolvedAccounts.length === 2, "resolveExistingAccountsForLogin de-duplicates the id match against the email matches, keeping both distinct accounts");
        assert(resolvedAccounts.some((account) => account.getId() === "google-sub-123") && resolvedAccounts.some((account) => account.getId() === "person@example.com"), "Both distinct accounts are present in the result");

        const noMatchAccounts = await AccountIdentityResolver.resolveExistingAccountsForLogin("no-such-id", "nobody@example.com");
        assert(noMatchAccounts.length === 0, "resolveExistingAccountsForLogin returns nothing when neither lookup matches");

        const noMatchResolved = await AccountIdentityResolver.resolveAccountForLogin("no-such-id", "nobody@example.com", authenticationProviders.EMAIL_OTP);
        assert(noMatchResolved === null, "resolveAccountForLogin returns null when nothing matches");

        const splitResolved = await AccountIdentityResolver.resolveAccountForLogin("google-sub-123", "person@example.com", authenticationProviders.GOOGLE);
        assert(splitResolved !== null && splitResolved.getId() === "person@example.com", "resolveAccountForLogin picks the older of two split accounts (the OTP-era row, joined 2022, over the Google row, joined 2023)");

        AuthenticationQueryEngine.getUserById = async () => buildFakeUser("only-id", new Date("2021-01-01"), "solo@example.com");
        AuthenticationQueryEngine.getUsersByEmail = async () => [];
        const soleMatchResolved = await AccountIdentityResolver.resolveAccountForLogin("only-id", "solo@example.com", authenticationProviders.GOOGLE);
        assert(soleMatchResolved !== null && soleMatchResolved.getId() === "only-id", "resolveAccountForLogin returns the single match unchanged when there is no split");
    }
    finally
    {
        AuthenticationQueryEngine.getUserById = originalGetUserById;
        AuthenticationQueryEngine.getUsersByEmail = originalGetUsersByEmail;
    }
}

async function runDatabaseTier()
{
    section("Tier 2 — real login resolution against MongoDB (opt-in: VERIFY_ACCOUNT_IDENTITY_DB=1)");

    if (process.env.VERIFY_ACCOUNT_IDENTITY_DB !== "1")
    {
        skip("DB tier disabled (set VERIFY_ACCOUNT_IDENTITY_DB=1 to run against real MongoDB)");
        return;
    }

    const DatabaseConnector = require("./Globals/Classes/Database/DatabaseConnector");
    const database = await DatabaseConnector.getDatabase();

    if (!database)
    {
        skip("MongoDB is not reachable (MONGODB_URL not set / server down) — DB tier skipped");
        return;
    }

    const DatabaseConstants = require("./Globals/Constants/DatabaseConstants");

    console.log(`  info  Using database "${process.env.MONGODB_DATABASE_NAME}" — creating throwaway *.invalid users`);

    const testEmail = `verify-account-identity-${Date.now()}@cogniumlearn.invalid`;
    const googleSubId = `verify-google-sub-${Date.now()}`;
    const seededUserIds = [];

    try
    {
        // A genuinely new email: neither provider finds anything yet.
        const freshGoogleLookup = await AccountIdentityResolver.resolveAccountForLogin(googleSubId, testEmail, authenticationProviders.GOOGLE);
        assert(freshGoogleLookup === null, "A brand-new email resolves to no existing account on first Google login");

        // Simulate that Google login completing: create the account under the sub id.
        const googleUser = new User
        ({
            id: googleSubId,
            displayName: "Verify Account Identity",
            provider: authenticationProviders.GOOGLE,
            joinDate: new Date(),
            preferences: {},
            additionalData: { email: testEmail }
        });
        await AuthenticationQueryEngine.createUser(googleUser);
        seededUserIds.push(googleSubId);

        // Now Email+OTP login for the SAME email must find that same account,
        // not create a second one — this is the bug the resolver exists to fix.
        const otpLookup = await AccountIdentityResolver.resolveAccountForLogin("", testEmail, authenticationProviders.EMAIL_OTP);
        assert(otpLookup !== null && otpLookup.getId() === googleSubId, "Email+OTP login for an existing Google account's email resolves to that same account, not a new one");

        // A repeat Google login still finds the same single account.
        const repeatGoogleLookup = await AccountIdentityResolver.resolveAccountForLogin(googleSubId, testEmail, authenticationProviders.GOOGLE);
        assert(repeatGoogleLookup !== null && repeatGoogleLookup.getId() === googleSubId, "A repeat Google login resolves to the same account with no split");

        // Now seed a genuine pre-existing split for a second test email: two
        // accounts, different ids, sharing one email, the OTP-style row older.
        const splitEmail = `verify-account-identity-split-${Date.now()}@cogniumlearn.invalid`;
        const splitGoogleSubId = `verify-google-sub-split-${Date.now()}`;

        const olderOtpUser = new User
        ({
            id: splitEmail,
            displayName: "Older OTP Account",
            provider: authenticationProviders.EMAIL_OTP,
            joinDate: new Date(Date.now() - (30 * 24 * 60 * 60 * 1000)),
            preferences: {},
            additionalData: { email: splitEmail }
        });
        const newerGoogleUser = new User
        ({
            id: splitGoogleSubId,
            displayName: "Newer Google Account",
            provider: authenticationProviders.GOOGLE,
            joinDate: new Date(),
            preferences: {},
            additionalData: { email: splitEmail }
        });
        // Seeded via a direct insert, not AuthenticationQueryEngine.createUser
        // — that now derives+writes normalizedEmail, and with the unique
        // index on it active, a second createUser for the same email would
        // correctly fail rather than create the split this test needs. A
        // genuine pre-existing split predates that protection, so it has to
        // be seeded the way old data actually looks.
        await database.collection(DatabaseConstants.USERS_COLLECTION).insertOne(olderOtpUser.toJson());
        await database.collection(DatabaseConstants.USERS_COLLECTION).insertOne(newerGoogleUser.toJson());
        seededUserIds.push(splitEmail, splitGoogleSubId);

        const usersByEmail = await AuthenticationQueryEngine.getUsersByEmail(splitEmail);
        assert(usersByEmail.length === 2, "getUsersByEmail returns both rows sharing the seeded split email");

        const googleSideResolved = await AccountIdentityResolver.resolveAccountForLogin(splitGoogleSubId, splitEmail, authenticationProviders.GOOGLE);
        assert(googleSideResolved !== null && googleSideResolved.getId() === splitEmail, "Google login on a pre-existing split resolves to the older (OTP) account");

        const otpSideResolved = await AccountIdentityResolver.resolveAccountForLogin("", splitEmail, authenticationProviders.EMAIL_OTP);
        assert(otpSideResolved !== null && otpSideResolved.getId() === splitEmail, "Email+OTP login on the same pre-existing split resolves to the same older account");
        assert(googleSideResolved.getId() === otpSideResolved.getId(), "Both providers resolve a pre-existing split to the identical account id");
    }
    finally
    {
        for (const seededUserId of seededUserIds)
        {
            try { await database.collection(DatabaseConstants.USERS_COLLECTION).deleteOne({ id: seededUserId }); } catch (cleanupError) { }
        }
        try { await DatabaseConnector.getMongoClient()?.close(); } catch (closeError) { }
    }
}

async function main()
{
    console.log("CogniumLearn — Account identity resolution verification\n");

    await runAlwaysOnTier();
    await runDatabaseTier();

    console.log(`\n---------------------------------------------`);
    console.log(`Passed: ${passedCount}   Failed: ${failedCount}   Skipped: ${skippedCount}`);

    process.exit(failedCount > 0 ? 1 : 0);
}

main().catch((fatalError) =>
{
    console.error("\nFATAL — verification harness crashed:");
    console.error(fatalError);
    process.exit(1);
});
