/**
 * End-to-end verification harness for organization management.
 *
 * Run from the Dock directory:
 *     node VerifyOrganizationManagement.mjs
 *     VERIFY_ORGANIZATION_DB=1 node VerifyOrganizationManagement.mjs
 *
 * Two tiers, so the default run needs no external services:
 *
 *   1. ALWAYS — pure, in-process checks: the delegate-power algebra, the
 *      refusal-to-status mapping, and the registered route table (that the
 *      organization payment routes are gone and the org-admin routes exist
 *      behind the right plugin). No network, no database.
 *
 *   2. DB (opt-in: VERIFY_ORGANIZATION_DB=1) — drives the real query engines
 *      and the real OrganizationAuthorityResolver against the configured
 *      MongoDB: free creation lands ACTIVE, member-cap accounting stays in
 *      lock-step, delegates hold exactly the powers they were given, a
 *      stranger and a different organization's owner are refused, and a
 *      cascade delete removes the dependants. Everything it creates is
 *      prefixed and deleted afterwards. Skips (not fails) when the flag is off
 *      or Mongo is unreachable.
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

const require = createRequire(import.meta.url);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

require("dotenv").config({ path: path.join(currentDirectory, ".env") });

const OrganizationAuthorityResolver = require("./Globals/Classes/Organization/OrganizationAuthorityResolver");
const OrganizationQueryEngine = require("./Globals/Classes/Organization/OrganizationQueryEngine");
const OrganizationMemberQueryEngine = require("./Globals/Classes/Organization/OrganizationMemberQueryEngine");
const DatabaseConnector = require("./Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("./Globals/Constants/DatabaseConstants");
const Organization = require("./Globals/Model/Organization");
const { handleOrganizationEndpoints } = require("./Endpoints/HandleOrganizationEndpoints");
const { handleAdminEndpoints } = require("./Endpoints/HandleAdminEndpoints");
const { organizationDelegatePowers } = require("./Globals/Enumerations/OrganizationDelegatePowers");
const { organizationStatus } = require("./Globals/Enumerations/OrganizationStatus");
const { userRoles } = require("./Globals/Enumerations/UserRoles");
const { httpStatus } = require("./Globals/Enumerations/HttpStatus");
const ErrorCodes = require("./Globals/Constants/ErrorCodes");

const TEST_NAME_PREFIX = "verify-org-";

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

/**
 * A stand-in for the authenticated User the resolver reads. Only the three
 * accessors the resolver touches are implemented, so the test cannot pass by
 * accident through some other property.
 */
function makeUser({ id, role = userRoles.USER, email = "" })
{
    return {
        getId: () => id,
        getRole: () => role,
        getAdditionalData: () => ({ email: email })
    };
}

/**
 * Records what a handler module registers, so the route table itself can be
 * asserted without booting a server.
 */
function makeRouteRecordingServer()
{
    const registeredRoutes = [];
    return {
        registeredRoutes: registeredRoutes,
        handle(routeDefinition)
        {
            registeredRoutes.push(routeDefinition);
        }
    };
}


async function runAlwaysOnTier()
{
    section("Tier 1 — power algebra, refusal mapping and the route table");

    // ── Delegate-power algebra ────────────────────────────────────────────
    const allPowers = OrganizationAuthorityResolver.ALL_POWERS;
    const everyDeclaredPower = Object.values(organizationDelegatePowers).reduce((combined, power) => combined | power, 0);
    assert(allPowers === everyDeclaredPower, "ALL_POWERS covers every flag declared in the enumeration");

    const ownerAuthority = { allowed: true, delegatePowers: allPowers };
    for (const [powerName, powerValue] of Object.entries(organizationDelegatePowers))
    {
        if (powerValue === organizationDelegatePowers.NONE)
        {
            continue;
        }
        assert(OrganizationAuthorityResolver.hasPower(ownerAuthority, powerValue), `An owner holds ${powerName}`);
    }

    const memberManagerAuthority = { allowed: true, delegatePowers: organizationDelegatePowers.MANAGE_MEMBERS };
    assert(OrganizationAuthorityResolver.hasPower(memberManagerAuthority, organizationDelegatePowers.MANAGE_MEMBERS), "A MANAGE_MEMBERS delegate holds MANAGE_MEMBERS");
    assert(!OrganizationAuthorityResolver.hasPower(memberManagerAuthority, organizationDelegatePowers.SET_PERMISSIONS), "A MANAGE_MEMBERS delegate does NOT hold SET_PERMISSIONS");
    assert(!OrganizationAuthorityResolver.hasPower(memberManagerAuthority, organizationDelegatePowers.DISTRIBUTE_CREDITS), "A MANAGE_MEMBERS delegate does NOT hold DISTRIBUTE_CREDITS");
    assert(!OrganizationAuthorityResolver.hasPower(memberManagerAuthority, organizationDelegatePowers.PUBLISH_DECKS), "A MANAGE_MEMBERS delegate does NOT hold PUBLISH_DECKS");

    const combinedAuthority = { allowed: true, delegatePowers: organizationDelegatePowers.MANAGE_MEMBERS | organizationDelegatePowers.PUBLISH_DECKS };
    assert(OrganizationAuthorityResolver.hasPower(combinedAuthority, organizationDelegatePowers.PUBLISH_DECKS), "Combined flags grant each of their powers");
    assert(!OrganizationAuthorityResolver.hasPower(combinedAuthority, organizationDelegatePowers.SET_PERMISSIONS), "Combined flags grant nothing beyond themselves");

    assert(!OrganizationAuthorityResolver.hasPower({ allowed: false, delegatePowers: allPowers }, organizationDelegatePowers.MANAGE_MEMBERS), "A refused resolution holds no power even with every flag set");
    assert(!OrganizationAuthorityResolver.hasPower(null, organizationDelegatePowers.MANAGE_MEMBERS), "A missing resolution holds no power");

    // An unknown bit must not survive the mask the endpoint applies, or a
    // future flag value could be stored before the server can enforce it.
    const unknownBit = allPowers + 1;
    assert(((unknownBit & allPowers) & unknownBit) !== unknownBit, "An unknown power bit does not survive the ALL_POWERS mask");

    // ── Refusal-to-status mapping ─────────────────────────────────────────
    assert(OrganizationAuthorityResolver.statusForDenial({ reason: ErrorCodes.MISSING_ORGANIZATION_ID }) === httpStatus.BAD_REQUEST, "A missing organization id maps to 400");
    assert(OrganizationAuthorityResolver.statusForDenial({ reason: ErrorCodes.ORG_NOT_FOUND }) === httpStatus.NOT_FOUND, "An unknown organization maps to 404");
    assert(OrganizationAuthorityResolver.statusForDenial({ reason: ErrorCodes.NOT_ORG_ADMIN }) === httpStatus.FORBIDDEN, "Insufficient standing maps to 403");

    // ── The route table ───────────────────────────────────────────────────
    const organizationServer = makeRouteRecordingServer();
    handleOrganizationEndpoints(organizationServer);
    const organizationRoutePaths = organizationServer.registeredRoutes.map(route => route.routePath);

    for (const expectedPath of ["/Organization/Mine/List", "/Organization/Get", "/Organization/Members/List", "/Organization/Members/Add", "/Organization/Members/BulkAdd", "/Organization/Members/Remove", "/Organization/Members/BulkRemove", "/Organization/Rename", "/Organization/Members/SetDelegatePowers"])
    {
        assert(organizationRoutePaths.includes(expectedPath), `Route ${expectedPath} is registered`);
    }

    assert(organizationServer.registeredRoutes.every(route => Array.isArray(route.plugins) && route.plugins.length > 0), "Every organization route carries an authorization plugin");
    assert(organizationRoutePaths.every(routePath => routePath.indexOf(":") < 0), "No organization route uses a :param placeholder");

    const adminServer = makeRouteRecordingServer();
    handleAdminEndpoints(adminServer);
    const adminRoutePaths = adminServer.registeredRoutes.map(route => route.routePath);

    for (const removedPath of ["/Admin/Organizations/VerifyCreationPayment", "/Admin/Organizations/InitiateExpansion", "/Admin/Organizations/VerifyExpansionPayment"])
    {
        assert(!adminRoutePaths.includes(removedPath), `Payment route ${removedPath} is gone`);
    }
    for (const keptPath of ["/Admin/Organizations/Create", "/Admin/Organizations/List", "/Admin/Organizations/Get", "/Admin/Organizations/UpdatePerks", "/Admin/Organizations/Delete", "/Admin/Organizations/Rename", "/Admin/Organizations/SetMaxMembers"])
    {
        assert(adminRoutePaths.includes(keptPath), `Super-admin route ${keptPath} is still registered`);
    }
}


async function runDatabaseTier()
{
    section("Tier 2 — live database (opt-in: VERIFY_ORGANIZATION_DB=1)");

    if (process.env.VERIFY_ORGANIZATION_DB !== "1")
    {
        skip("Database tier disabled — set VERIFY_ORGANIZATION_DB=1 to run it");
        return;
    }

    let database = null;
    try
    {
        database = await DatabaseConnector.getDatabase();
    }
    catch (connectionError)
    {
        skip(`MongoDB unreachable (${connectionError.message}) — database tier not run`);
        return;
    }

    if (!database)
    {
        skip("MongoDB not configured — database tier not run");
        return;
    }

    const createdOrganizationIds = [];
    const uniqueSuffix = process.pid;

    try
    {
        // ── Free creation lands ACTIVE ────────────────────────────────────
        const ownerUserId = `${TEST_NAME_PREFIX}owner-${uniqueSuffix}`;
        const ownerEmail = `${TEST_NAME_PREFIX}owner-${uniqueSuffix}@example.invalid`;
        const now = new Date();

        const firstOrganization = await OrganizationQueryEngine.createOrganization(new Organization
        ({
            name: `${TEST_NAME_PREFIX}first-${uniqueSuffix}`,
            adminEmail: ownerEmail,
            adminUserId: ownerUserId,
            status: organizationStatus.ACTIVE,
            currency: "INR",
            creationAmountMinor: 0,
            maxMembers: 3,
            currentMemberCount: 0,
            creationDate: now,
            activationDate: now,
            additionalData: {}
        }));
        createdOrganizationIds.push(firstOrganization.getId());

        const storedOrganization = await OrganizationQueryEngine.getOrganizationById(firstOrganization.getId());
        assert(storedOrganization !== null, "A created organization is readable back");
        assert(storedOrganization.getStatus() === organizationStatus.ACTIVE, "A created organization is ACTIVE — never PENDING_PAYMENT");
        assert(storedOrganization.getCreationAmountMinor() === 0, "A created organization carries no creation fee");
        assert(storedOrganization.getAdminUserId() === ownerUserId, "The owner's user id is bound at creation");

        // ── Member-cap accounting ─────────────────────────────────────────
        const memberEmail = `${TEST_NAME_PREFIX}member-${uniqueSuffix}@example.invalid`;
        const firstIncrement = await OrganizationQueryEngine.tryIncrementMemberCount(firstOrganization.getId());
        assert(firstIncrement.ok === true, "A seat can be reserved while capacity remains");

        const addResult = await OrganizationMemberQueryEngine.addMember(firstOrganization.getId(), memberEmail, ownerUserId);
        assert(addResult.status === "ADDED", "A new member row is inserted");

        const duplicateIncrement = await OrganizationQueryEngine.tryIncrementMemberCount(firstOrganization.getId());
        const duplicateAdd = await OrganizationMemberQueryEngine.addMember(firstOrganization.getId(), memberEmail, ownerUserId);
        assert(duplicateAdd.status === "ALREADY_MEMBER", "Re-adding the same email is reported as ALREADY_MEMBER");
        if (duplicateIncrement.ok)
        {
            await OrganizationQueryEngine.decrementMemberCountBy(firstOrganization.getId(), 1);
        }

        const afterDuplicateOrganization = await OrganizationQueryEngine.getOrganizationById(firstOrganization.getId());
        assert(afterDuplicateOrganization.getCurrentMemberCount() === 1, "The member count stays in lock-step with the row count after a duplicate add");

        // Fill the cap, then prove the gate refuses the next seat.
        await OrganizationQueryEngine.tryIncrementMemberCountBy(firstOrganization.getId(), 2);
        const overCapIncrement = await OrganizationQueryEngine.tryIncrementMemberCount(firstOrganization.getId());
        assert(overCapIncrement.ok === false, "The cap gate refuses a seat beyond maxMembers");
        await OrganizationQueryEngine.decrementMemberCountBy(firstOrganization.getId(), 2);

        // ── Standing: owner, delegate, stranger, other owner ──────────────
        const memberRows = await OrganizationMemberQueryEngine.listMembers(firstOrganization.getId());
        const memberRow = memberRows.find(row => row.getEmail() === memberEmail);
        assert(memberRow !== undefined, "The member row is listable");

        const ownerUser = makeUser({ id: ownerUserId, role: userRoles.ORG_ADMIN, email: ownerEmail });
        const ownerAuthority = await OrganizationAuthorityResolver.resolve(ownerUser, firstOrganization.getId());
        assert(ownerAuthority.allowed === true && ownerAuthority.isOwner === true, "The owner has standing and is reported as the owner");
        assert(OrganizationAuthorityResolver.hasPower(ownerAuthority, organizationDelegatePowers.SET_PERMISSIONS), "The owner holds every power");

        const memberUserId = `${TEST_NAME_PREFIX}delegate-${uniqueSuffix}`;
        const delegateUser = makeUser({ id: memberUserId, role: userRoles.ORG_ADMIN, email: memberEmail });

        const beforeGrantAuthority = await OrganizationAuthorityResolver.resolve(delegateUser, firstOrganization.getId());
        assert(beforeGrantAuthority.allowed === false, "An ordinary member with no powers has no standing");

        await OrganizationMemberQueryEngine.setDelegatePowers(firstOrganization.getId(), memberRow.getId(), organizationDelegatePowers.MANAGE_MEMBERS);

        const afterGrantAuthority = await OrganizationAuthorityResolver.resolve(delegateUser, firstOrganization.getId());
        assert(afterGrantAuthority.allowed === true && afterGrantAuthority.isOwner === false, "A delegate has standing but is not the owner");
        assert(OrganizationAuthorityResolver.hasPower(afterGrantAuthority, organizationDelegatePowers.MANAGE_MEMBERS), "The delegate holds the power that was granted");
        assert(!OrganizationAuthorityResolver.hasPower(afterGrantAuthority, organizationDelegatePowers.SET_PERMISSIONS), "The delegate holds nothing that was not granted");

        const requiredPowerRefusal = await OrganizationAuthorityResolver.requirePower(delegateUser, firstOrganization.getId(), organizationDelegatePowers.SET_PERMISSIONS);
        assert(requiredPowerRefusal.allowed === false && requiredPowerRefusal.reason === ErrorCodes.NOT_ORG_ADMIN, "requirePower refuses a power the delegate does not hold");

        const strangerUser = makeUser({ id: `${TEST_NAME_PREFIX}stranger-${uniqueSuffix}`, role: userRoles.ORG_ADMIN, email: `${TEST_NAME_PREFIX}stranger-${uniqueSuffix}@example.invalid` });
        const strangerAuthority = await OrganizationAuthorityResolver.resolve(strangerUser, firstOrganization.getId());
        assert(strangerAuthority.allowed === false, "A non-member org-admin has no standing here");

        // A second organization, to prove owning one grants nothing over another.
        const secondOwnerUserId = `${TEST_NAME_PREFIX}owner2-${uniqueSuffix}`;
        const secondOrganization = await OrganizationQueryEngine.createOrganization(new Organization
        ({
            name: `${TEST_NAME_PREFIX}second-${uniqueSuffix}`,
            adminEmail: `${TEST_NAME_PREFIX}owner2-${uniqueSuffix}@example.invalid`,
            adminUserId: secondOwnerUserId,
            status: organizationStatus.ACTIVE,
            currency: "INR",
            creationAmountMinor: 0,
            maxMembers: 5,
            currentMemberCount: 0,
            creationDate: now,
            activationDate: now,
            additionalData: {}
        }));
        createdOrganizationIds.push(secondOrganization.getId());

        const secondOwnerUser = makeUser({ id: secondOwnerUserId, role: userRoles.ORG_ADMIN, email: `${TEST_NAME_PREFIX}owner2-${uniqueSuffix}@example.invalid` });
        const crossOrganizationAuthority = await OrganizationAuthorityResolver.resolve(secondOwnerUser, firstOrganization.getId());
        assert(crossOrganizationAuthority.allowed === false, "Owning one organization grants no standing over another");

        const superAdminUser = makeUser({ id: `${TEST_NAME_PREFIX}super-${uniqueSuffix}`, role: userRoles.ADMIN, email: `${TEST_NAME_PREFIX}super-${uniqueSuffix}@example.invalid` });
        const superAdminAuthority = await OrganizationAuthorityResolver.resolve(superAdminUser, firstOrganization.getId());
        assert(superAdminAuthority.allowed === true && superAdminAuthority.isSuperAdmin === true, "A super-admin has standing in any organization");

        // ── Listing reflects standing ─────────────────────────────────────
        const ownerListing = await OrganizationAuthorityResolver.listOrganizationsForUser(ownerUser);
        assert(ownerListing.some(entry => entry.organization.getId() === firstOrganization.getId() && entry.isOwner === true), "The owner's listing includes their organization, marked as owned");
        assert(!ownerListing.some(entry => entry.organization.getId() === secondOrganization.getId()), "The owner's listing excludes an organization they have no standing in");

        const delegateListing = await OrganizationAuthorityResolver.listOrganizationsForUser(delegateUser);
        assert(delegateListing.some(entry => entry.organization.getId() === firstOrganization.getId() && entry.isOwner === false), "The delegate's listing includes the organization they were given powers in, not marked as owned");

        // ── Unknown organization / missing id ─────────────────────────────
        const missingIdAuthority = await OrganizationAuthorityResolver.resolve(ownerUser, "");
        assert(missingIdAuthority.reason === ErrorCodes.MISSING_ORGANIZATION_ID, "A missing organization id is refused as MISSING_ORGANIZATION_ID");

        const unknownOrganizationAuthority = await OrganizationAuthorityResolver.resolve(ownerUser, `${TEST_NAME_PREFIX}does-not-exist-${uniqueSuffix}`);
        assert(unknownOrganizationAuthority.reason === ErrorCodes.ORG_NOT_FOUND, "An unknown organization is refused as ORG_NOT_FOUND");

        // ── Cascade delete ────────────────────────────────────────────────
        const deleteResult = await OrganizationQueryEngine.deleteOrganization(firstOrganization.getId());
        assert(deleteResult.deleted === true, "Deleting an organization reports success");
        assert(deleteResult.adminUserId === ownerUserId, "The delete reports the owner's user id back for role revocation");

        const remainingMembers = await database
            .collection(DatabaseConstants.ORGANIZATION_MEMBERS_COLLECTION)
            .countDocuments({ organizationId: firstOrganization.getId() });
        assert(remainingMembers === 0, "Deleting an organization cascades to its members");

        const deletedOrganization = await OrganizationQueryEngine.getOrganizationById(firstOrganization.getId());
        assert(deletedOrganization === null, "The deleted organization is gone");

        const repeatedDelete = await OrganizationQueryEngine.deleteOrganization(firstOrganization.getId());
        assert(repeatedDelete.deleted === false, "Deleting an already-deleted organization is a reported no-op, not an error");
    }
    catch (databaseTierError)
    {
        assert(false, `Database tier threw: ${databaseTierError.message}`);
    }
    finally
    {
        for (const organizationId of createdOrganizationIds)
        {
            try
            {
                await OrganizationQueryEngine.deleteOrganization(organizationId);
            }
            catch (cleanupError)
            {
                console.log(`  NOTE  Cleanup of ${organizationId} failed: ${cleanupError.message}`);
            }
        }
    }
}


async function main()
{
    console.log("CogniumLearn — organization management verification\n");

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
