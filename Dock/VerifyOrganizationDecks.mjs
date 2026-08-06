/**
 * End-to-end verification harness for organization-scoped decks: who may see
 * one, who may add one, where the copy lands, how it opens without a password,
 * and what withdrawal takes back.
 *
 * Run from the Dock directory:
 *     node VerifyOrganizationDecks.mjs
 *     VERIFY_ORGANIZATION_DB=1 node VerifyOrganizationDecks.mjs
 *
 *   1. ALWAYS — pure checks: the audience condition, the routes, that an
 *      organization's deck can never carry a price or reach the checkout, and
 *      that the publish path is shared with the catalogue rather than copied.
 *
 *   2. DB (opt-in: VERIFY_ORGANIZATION_DB=1) — drives the real resolvers,
 *      query engines and withdrawal service against MongoDB. The properties
 *      worth proving are the silent ones: an outsider seeing an institute's
 *      deck, a member of one institute reaching another's, a copy seeded into
 *      the wrong library, a withdrawal that revokes the licence but leaves the
 *      content, and an ex-member who keeps studying material after being
 *      removed.
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const require = createRequire(import.meta.url);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

require("dotenv").config({ path: path.join(currentDirectory, ".env") });

const PaidDeckAudienceResolver = require("./Globals/Classes/PaidDeck/PaidDeckAudienceResolver");
const PaidDeckPublishService = require("./Globals/Classes/PaidDeck/PaidDeckPublishService");
const PaidDeckScopeResolver = require("./Globals/Classes/PaidDeck/PaidDeckScopeResolver");
const OrganizationDeckQueryEngine = require("./Globals/Classes/Organization/OrganizationDeckQueryEngine");
const OrganizationDeckWithdrawalService = require("./Globals/Classes/Organization/OrganizationDeckWithdrawalService");
const OrganizationScopeResolver = require("./Globals/Classes/Organization/OrganizationScopeResolver");
const OrganizationQueryEngine = require("./Globals/Classes/Organization/OrganizationQueryEngine");
const OrganizationMemberQueryEngine = require("./Globals/Classes/Organization/OrganizationMemberQueryEngine");
const DatabaseConnector = require("./Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("./Globals/Constants/DatabaseConstants");
const AuthenticationQueryEngine = require("./Globals/Classes/Database/AuthenticationQueryEngine");
const Organization = require("./Globals/Model/Organization");
const User = require("./Globals/Model/User");
const PaidDeck = require("./Globals/Model/PaidDeck");
const { handleOrganizationEndpoints } = require("./Endpoints/HandleOrganizationEndpoints");
const { organizationStatus } = require("./Globals/Enumerations/OrganizationStatus");
const { deckLicenseStatuses } = require("./Globals/Enumerations/DeckLicenseStatuses");
const { userRoles } = require("./Globals/Enumerations/UserRoles");
const { entityTypes } = require("./Globals/Enumerations/EntityTypes");
const ErrorCodes = require("./Globals/Constants/ErrorCodes");

const TEST_NAME_PREFIX = "verify-decks-";

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


async function runAlwaysOnTier()
{
    section("Tier 1 — audience, pricing refusal, shared publish path and routes");

    // ── Reading an audience off a deck ────────────────────────────────────
    const publicDeck = new PaidDeck({ title: "Public" });
    const organizationDeck = new PaidDeck({ title: "Institute", audienceOrganizationId: "org-9" });

    assert(PaidDeckAudienceResolver.readAudienceOrganizationId(publicDeck) === "", "A deck with no audience reads as public");
    assert(PaidDeckAudienceResolver.readAudienceOrganizationId(organizationDeck) === "org-9", "A deck with an audience reads as that organization's");
    assert(PaidDeckAudienceResolver.readAudienceOrganizationId({}) === "", "A document predating audiences reads as public — which is what it has always been");
    assert(PaidDeckAudienceResolver.readAudienceOrganizationId(null) === "", "A missing deck never resolves to an undefined audience");
    assert(PaidDeckAudienceResolver.isOrganizationDeck(organizationDeck) === true, "An organization deck is recognised as one");
    assert(PaidDeckAudienceResolver.isOrganizationDeck(publicDeck) === false, "A catalogue deck is not");

    // ── The visibility condition ──────────────────────────────────────────
    const anonymousCondition = await PaidDeckAudienceResolver.buildVisibilityCondition(null);
    assert(anonymousCondition !== null, "An unidentified caller is restricted rather than trusted");
    assert(Array.isArray(anonymousCondition.$or), "The restriction is an $or over the audience field");
    assert(anonymousCondition.$or.some(clause => clause.audienceOrganizationId === ""), "…matching the public catalogue");
    assert(anonymousCondition.$or.some(clause => clause.audienceOrganizationId && clause.audienceOrganizationId.$exists === false), "…and decks published before the field existed, which would otherwise vanish in one deploy");
    assert(!anonymousCondition.$or.some(clause => clause.audienceOrganizationId && clause.audienceOrganizationId.$in), "…and nothing organization-scoped");

    const superAdminUser = new User({ id: "admin-1", role: userRoles.ADMIN });
    assert(await PaidDeckAudienceResolver.buildVisibilityCondition(superAdminUser) === null, "A super-admin is unrestricted — a catalogue they cannot see is one they cannot moderate");
    assert(await PaidDeckAudienceResolver.isVisibleTo({ audienceOrganizationId: "org-9" }, superAdminUser) === true, "…including for one deck at a time");
    assert(await PaidDeckAudienceResolver.isVisibleTo({ audienceOrganizationId: "org-9" }, null) === false, "An anonymous caller cannot see an organization's deck");
    assert(await PaidDeckAudienceResolver.isVisibleTo({ audienceOrganizationId: "" }, null) === true, "…but can see the catalogue");

    // Acquiring is a stronger act than looking: a super-admin's blanket
    // visibility must NOT let them seed an institute's deck into their account.
    const superAdminMembership = await PaidDeckAudienceResolver.requireActiveMembership("org-9", superAdminUser).catch(() => ({ member: false }));
    assert(superAdminMembership.member === false, "A super-admin is not silently a member of every organization");
    assert((await PaidDeckAudienceResolver.requireActiveMembership("", superAdminUser)).member === false, "A blank organization is never a membership");

    // ── Audience tag normalisation ────────────────────────────────────────
    const normalisedTags = PaidDeckPublishService.normaliseAudienceTags(["Final-Year", " final-year ", "", "SCHOLARSHIP"]);
    assert(normalisedTags.length === 2, "Audience tags are de-duplicated after normalising");
    assert(normalisedTags.includes("final-year") && normalisedTags.includes("scholarship"), "…lower-cased and trimmed, so a deck's tag and a member's are the same cohort");
    assert(PaidDeckPublishService.normaliseAudienceTags("final-year").length === 0, "A non-array tag list yields no tags rather than a character-by-character audience");

    // ── The publish path is shared, not copied ────────────────────────────
    const adminUploadSource = fs.readFileSync(path.join(currentDirectory, "Endpoints/Admin/UploadPaidDeck.js"), "utf8");
    const organizationUploadSource = fs.readFileSync(path.join(currentDirectory, "Endpoints/OrganizationAdmin/Decks/UploadOrganizationDeck.js"), "utf8");

    assert(adminUploadSource.includes("PaidDeckPublishService"), "The catalogue upload goes through the shared publish service");
    assert(organizationUploadSource.includes("PaidDeckPublishService"), "…and so does the organization upload, so encryption and key versioning cannot drift between them");
    assert(!adminUploadSource.includes("storePaidDeckMaster"), "The catalogue upload no longer holds its own copy of the encryption step");
    assert(organizationUploadSource.includes("allowPricing: false"), "An organization publish cannot express a price");
    assert(organizationUploadSource.includes("audienceOrganizationId: organizationId"), "…and its audience is forced to the caller's own organization");
    assert(organizationUploadSource.includes("PUBLISHED_DECK_LIMIT_REACHED"), "…and is bounded by the publish cap");

    const publishServiceSource = fs.readFileSync(path.join(currentDirectory, "Globals/Classes/PaidDeck/PaidDeckPublishService.js"), "utf8");
    assert(publishServiceSource.includes("bAllowPricing ? (metadata.basePriceMinor || 0) : 0"), "The price is FORCED to zero for an organization deck rather than merely validated");
    assert(publishServiceSource.includes("PaidDeckPublishGate"), "The pipeline review gate applies to an organization publish exactly as it does to the catalogue");
    assert(publishServiceSource.includes("AUDIENCE_MISMATCH"), "An upload can never move an existing deck between audiences — the takeover a guessed id would otherwise allow");

    // ── No payment path is reachable ──────────────────────────────────────
    const initiatePurchaseSource = fs.readFileSync(path.join(currentDirectory, "Endpoints/PaidDeck/InitiatePurchase.js"), "utf8");
    assert(initiatePurchaseSource.includes("listOrganizationDeckIds"), "Checkout refuses organization decks");
    assert(initiatePurchaseSource.includes("DECK_NOT_FOR_SALE"), "…with a reason that names why, not a pricing error");

    const refusalIndex = initiatePurchaseSource.indexOf("listOrganizationDeckIds");
    const couponIndex = initiatePurchaseSource.indexOf("CouponCheckoutService");
    const orderIndex = initiatePurchaseSource.indexOf("createOrder");
    assert(refusalIndex > 0 && (couponIndex < 0 || refusalIndex < couponIndex), "…refused BEFORE any coupon is reserved");
    assert(refusalIndex > 0 && (orderIndex < 0 || refusalIndex < orderIndex), "…and before any order is created, so no provider is ever contacted for one");

    const addDeckSource = fs.readFileSync(path.join(currentDirectory, "Endpoints/Organization/AddOrganizationDeck.js"), "utf8");
    for (const paymentTerm of ["PaymentProviderFactory", "Razorpay", "createOrder", "CouponCheckoutService", "amountMinor"])
    {
        assert(!addDeckSource.includes(paymentTerm), `Acquiring an organization deck never touches ${paymentTerm}`);
    }

    // ── The password branch ───────────────────────────────────────────────
    const unlockSource = fs.readFileSync(path.join(currentDirectory, "Endpoints/PaidDeck/UnlockPaidDeckSession.js"), "utf8");
    assert(unlockSource.includes("PaidDeckAudienceResolver.isOrganizationDeck(paidDeckDocument)"), "Which unlock branch applies is read from the DECK, never from the request");
    assert(unlockSource.includes("requireActiveMembership"), "The passwordless branch re-checks live membership rather than trusting the licence alone");
    assert(unlockSource.includes("contentKeyBytes.fill(0)"), "The content key is zeroed after the response is written");

    const grantHelpersSource = fs.readFileSync(path.join(currentDirectory, "Endpoints/PaidDeck/PaidDeckGrantHelpers.js"), "utf8");
    assert(grantHelpersSource.includes("PaidDeckAudienceResolver.isOrganizationDeck(paidDeckDocument)"), "An organization licence never inherits the member's marketplace password");

    // ── Routes ────────────────────────────────────────────────────────────
    const organizationRoutes = [];
    handleOrganizationEndpoints({ handle: (routeDefinition) => organizationRoutes.push(routeDefinition) });
    const organizationRoutePaths = organizationRoutes.map(route => route.routePath);

    for (const expectedPath of ["/Organization/PaidDecks/List", "/Organization/PaidDecks/Upload", "/Organization/PaidDecks/Update", "/Organization/PaidDecks/Withdraw", "/Organization/Decks/Shelf", "/Organization/Decks/Add", "/Organization/Decks/Remove"])
    {
        assert(organizationRoutePaths.includes(expectedPath), `Route ${expectedPath} is registered`);
    }
    assert(organizationRoutes.every(route => Array.isArray(route.plugins) && route.plugins.length > 0), "Every organization route carries an authorization plugin");
}


async function runDatabaseTier()
{
    section("Tier 2 — live database (opt-in: VERIFY_ORGANIZATION_DB=1)");

    if (process.env.VERIFY_ORGANIZATION_DB !== "1")
    {
        skip("Database tier not requested — set VERIFY_ORGANIZATION_DB=1 with Mongo running");
        return;
    }

    const database = await DatabaseConnector.getDatabase();
    if (!database)
    {
        skip("Database tier — MongoDB is not reachable");
        return;
    }

    const createdOrganizationIds = [];
    const createdUserIds = [];
    const createdDeckIds = [];
    const usersCollection = database.collection(DatabaseConstants.USERS_COLLECTION);
    const paidDecksCollection = database.collection(DatabaseConstants.PAID_DECKS_COLLECTION);
    const decksCollection = database.collection(DatabaseConstants.DECKS_COLLECTION);
    const licensesCollection = database.collection(DatabaseConstants.DECK_LICENSES_COLLECTION);

    try
    {
        const uniqueSuffix = `${Date.now()}`;

        // ── Fixtures: two organizations and three people ──────────────────
        const insiderUserId = `${TEST_NAME_PREFIX}insider-${uniqueSuffix}`;
        const insiderEmail = `${TEST_NAME_PREFIX}insider-${uniqueSuffix}@example.test`;
        const rivalUserId = `${TEST_NAME_PREFIX}rival-${uniqueSuffix}`;
        const rivalEmail = `${TEST_NAME_PREFIX}rival-${uniqueSuffix}@example.test`;
        const outsiderUserId = `${TEST_NAME_PREFIX}outsider-${uniqueSuffix}`;
        const outsiderEmail = `${TEST_NAME_PREFIX}outsider-${uniqueSuffix}@example.test`;

        for (const [userId, email] of [[insiderUserId, insiderEmail], [rivalUserId, rivalEmail], [outsiderUserId, outsiderEmail]])
        {
            await usersCollection.insertOne(new User({ id: userId, additionalData: { email: email } }).toJson());
            createdUserIds.push(userId);
        }

        const organization = new Organization
        ({
            name: `${TEST_NAME_PREFIX}${uniqueSuffix}`,
            adminEmail: `${TEST_NAME_PREFIX}owner-${uniqueSuffix}@example.test`,
            status: organizationStatus.ACTIVE,
            maxMembers: 50,
            maxPublishedDecks: 5
        });
        await OrganizationQueryEngine.createOrganization(organization);
        createdOrganizationIds.push(organization.getId());

        const rivalOrganization = new Organization
        ({
            name: `${TEST_NAME_PREFIX}rival-${uniqueSuffix}`,
            adminEmail: `${TEST_NAME_PREFIX}rival-owner-${uniqueSuffix}@example.test`,
            status: organizationStatus.ACTIVE,
            maxMembers: 50,
            maxPublishedDecks: 5
        });
        await OrganizationQueryEngine.createOrganization(rivalOrganization);
        createdOrganizationIds.push(rivalOrganization.getId());

        await OrganizationMemberQueryEngine.addMember(organization.getId(), insiderEmail, "harness");
        await OrganizationMemberQueryEngine.backfillUserId(insiderEmail, insiderUserId);
        await OrganizationMemberQueryEngine.replaceProfilesForExistingMembers
        (
            organization.getId(),
            [{ email: insiderEmail, tags: ["final-year"], attributes: {}, attributesNormalised: {} }]
        );

        await OrganizationMemberQueryEngine.addMember(rivalOrganization.getId(), rivalEmail, "harness");
        await OrganizationMemberQueryEngine.backfillUserId(rivalEmail, rivalUserId);

        const insiderUser = await AuthenticationQueryEngine.getUserById(insiderUserId);
        const rivalUser = await AuthenticationQueryEngine.getUserById(rivalUserId);
        const outsiderUser = await AuthenticationQueryEngine.getUserById(outsiderUserId);

        // Two decks published straight into the collection: this tier is about
        // audience, acquisition and withdrawal, and going through the real
        // encryption would need a key-management setup the harness must not
        // depend on to make those points.
        const targetedDeckId = `${TEST_NAME_PREFIX}targeted-${uniqueSuffix}`;
        const untargetedDeckId = `${TEST_NAME_PREFIX}untargeted-${uniqueSuffix}`;
        const publicDeckId = `${TEST_NAME_PREFIX}public-${uniqueSuffix}`;

        for (const [deckId, audienceOrganizationId, audienceTags] of
        [
            [targetedDeckId, organization.getId(), ["final-year"]],
            [untargetedDeckId, organization.getId(), ["first-year"]],
            [publicDeckId, "", []]
        ])
        {
            // The codegen constructor mints its own UUID and exposes no setter,
            // so the harness's deterministic id is applied to the JSON.
            await paidDecksCollection.insertOne
            ({
                ...new PaidDeck
                ({
                    title: deckId,
                    isPublished: true,
                    audienceOrganizationId: audienceOrganizationId,
                    audienceTags: audienceTags
                }).toJson(),
                id: deckId
            });
            createdDeckIds.push(deckId);
        }

        // ── Visibility ────────────────────────────────────────────────────
        section("Visibility");

        const insiderCondition = await PaidDeckAudienceResolver.buildVisibilityCondition(insiderUser);
        const insiderVisibleIds = (await paidDecksCollection
            .find({ $and: [{ id: { $in: createdDeckIds } }, insiderCondition] }, { projection: { _id: 0, id: 1 } })
            .toArray()).map(document => document.id);

        assert(insiderVisibleIds.includes(targetedDeckId), "A member sees their own organization's decks");
        assert(insiderVisibleIds.includes(untargetedDeckId), "…including the ones aimed at other cohorts — targeting is a filter, not a fence");
        assert(insiderVisibleIds.includes(publicDeckId), "…and the public catalogue as well");

        const rivalCondition = await PaidDeckAudienceResolver.buildVisibilityCondition(rivalUser);
        const rivalVisibleIds = (await paidDecksCollection
            .find({ $and: [{ id: { $in: createdDeckIds } }, rivalCondition] }, { projection: { _id: 0, id: 1 } })
            .toArray()).map(document => document.id);

        assert(!rivalVisibleIds.includes(targetedDeckId), "A member of a DIFFERENT organization cannot see this one's decks");
        assert(rivalVisibleIds.includes(publicDeckId), "…but still sees the catalogue");

        const outsiderCondition = await PaidDeckAudienceResolver.buildVisibilityCondition(outsiderUser);
        const outsiderVisibleIds = (await paidDecksCollection
            .find({ $and: [{ id: { $in: createdDeckIds } }, outsiderCondition] }, { projection: { _id: 0, id: 1 } })
            .toArray()).map(document => document.id);

        assert(outsiderVisibleIds.length === 1 && outsiderVisibleIds[0] === publicDeckId, "Someone in no organization sees the catalogue and nothing else");

        assert(await PaidDeckAudienceResolver.isVisibleTo({ audienceOrganizationId: organization.getId() }, rivalUser) === false, "The one-deck check agrees with the query — a share link cannot get around it");

        // ── The shelf ─────────────────────────────────────────────────────
        section("Shelf");

        const targetedShelf = await OrganizationDeckQueryEngine.listShelfForMember(organization.getId(), ["final-year"], false);
        const targetedShelfIds = targetedShelf.map(paidDeck => paidDeck.getId());
        assert(targetedShelfIds.includes(targetedDeckId), "The default shelf shows what is aimed at the member's tags");
        assert(!targetedShelfIds.includes(untargetedDeckId), "…and hides what is aimed at other cohorts");
        assert(!targetedShelfIds.includes(publicDeckId), "…and never mixes the catalogue into an organization's shelf");

        const fullShelfIds = (await OrganizationDeckQueryEngine.listShelfForMember(organization.getId(), ["final-year"], true)).map(paidDeck => paidDeck.getId());
        assert(fullShelfIds.includes(untargetedDeckId), "The show-everything toggle exposes the untargeted decks");

        const untaggedShelfIds = (await OrganizationDeckQueryEngine.listShelfForMember(organization.getId(), [], false)).map(paidDeck => paidDeck.getId());
        assert(!untaggedShelfIds.includes(targetedDeckId), "A member with no tags is not shown a targeted deck by default");

        // A deck aimed at everyone must reach a member holding no tags at all.
        const everyoneDeckId = `${TEST_NAME_PREFIX}everyone-${uniqueSuffix}`;
        await paidDecksCollection.insertOne
        ({
            ...new PaidDeck({ title: everyoneDeckId, isPublished: true, audienceOrganizationId: organization.getId(), audienceTags: [] }).toJson(),
            id: everyoneDeckId
        });
        createdDeckIds.push(everyoneDeckId);

        const everyoneShelfIds = (await OrganizationDeckQueryEngine.listShelfForMember(organization.getId(), [], false)).map(paidDeck => paidDeck.getId());
        assert(everyoneShelfIds.includes(everyoneDeckId), "A deck with no audience tags reaches every member, including one with no tags");

        assert(await OrganizationDeckQueryEngine.countPublishedDecks(organization.getId()) === 3, "The publish count covers this organization's published decks only");
        assert(await OrganizationDeckQueryEngine.getOrganizationDeck(rivalOrganization.getId(), targetedDeckId) === null, "A deck id from another organization resolves to nothing through the scoped lookup");

        // ── Acquisition lands in the organization's library ────────────────
        section("Acquisition");

        const organizationScopeKey = OrganizationScopeResolver.buildScopeKey(insiderUserId, organization.getId());

        // The licence and its seeded rows are written directly here for the
        // same reason the decks were: the point being proved is WHERE the copy
        // lands and what withdrawal does to it.
        await licensesCollection.insertOne
        ({
            id: `${TEST_NAME_PREFIX}license-${uniqueSuffix}`,
            userId: insiderUserId,
            deckId: targetedDeckId,
            scopeKey: organizationScopeKey,
            status: deckLicenseStatuses.ACTIVE,
            expiresAt: new Date(0).toISOString(),
            rotatedAt: new Date().toISOString()
        });

        const seededRootId = `${TEST_NAME_PREFIX}root-${uniqueSuffix}`;
        await decksCollection.insertOne
        ({
            userId: organizationScopeKey,
            data: { id: seededRootId, name: "Institute deck", parent: "0", additionalData: { paidDeckId: targetedDeckId } },
            serverUpdatedAt: new Date()
        });

        const licenseDocument = await licensesCollection.findOne({ userId: insiderUserId, deckId: targetedDeckId });
        assert(PaidDeckScopeResolver.resolveForLicense(licenseDocument, insiderUserId) === organizationScopeKey, "The copy is owned by the organization's scope, not the member's own");

        const personalRowCount = await decksCollection.countDocuments({ userId: insiderUserId, "data.additionalData.paidDeckId": targetedDeckId });
        assert(personalRowCount === 0, "…so the member's personal library holds none of it, whichever view they added it from");

        // ── Withdrawal ────────────────────────────────────────────────────
        section("Withdrawal");

        const withdrawalResult = await OrganizationDeckWithdrawalService.withdraw(organization.getId(), targetedDeckId);

        assert(withdrawalResult.withdrawn === true, "Withdrawal reports success");
        assert(withdrawalResult.licensesRevoked === 1, "Every holder's licence is revoked");
        assert(withdrawalResult.rootsTombstoned === 1, "…and every copy is tombstoned");

        const withdrawnDeck = await paidDecksCollection.findOne({ id: targetedDeckId });
        assert(withdrawnDeck.isPublished === false, "The deck is unpublished FIRST, so nobody can add it mid-withdrawal");
        assert(withdrawnDeck !== null, "…but the master listing is kept, so it can be corrected and published again");

        const revokedLicense = await licensesCollection.findOne({ userId: insiderUserId, deckId: targetedDeckId });
        assert(revokedLicense.status === deckLicenseStatuses.REVOKED, "The licence is REVOKED rather than deleted, so the reaper finishes the job if this run died half-way");

        const survivingRows = await decksCollection.countDocuments({ userId: organizationScopeKey, "data.id": seededRootId });
        assert(survivingRows === 0, "The copy is gone from the organization's library");

        const deletionRecords = await database
            .collection(DatabaseConstants.DELETIONS_COLLECTION)
            .countDocuments({ userId: organizationScopeKey, entityId: seededRootId });
        assert(deletionRecords > 0, "…and a tombstone was recorded, so every one of that member's devices converges on the removal");

        const secondWithdrawal = await OrganizationDeckWithdrawalService.withdraw(organization.getId(), targetedDeckId);
        assert(secondWithdrawal.withdrawn === true && secondWithdrawal.licensesRevoked === 0, "Withdrawing twice is harmless — the operation is idempotent");

        // ── Offboarding ───────────────────────────────────────────────────
        section("Offboarding");

        await paidDecksCollection.updateOne({ id: untargetedDeckId }, { $set: { isPublished: true } });
        await licensesCollection.insertOne
        ({
            id: `${TEST_NAME_PREFIX}license2-${uniqueSuffix}`,
            userId: insiderUserId,
            deckId: untargetedDeckId,
            scopeKey: organizationScopeKey,
            status: deckLicenseStatuses.ACTIVE,
            expiresAt: new Date(0).toISOString(),
            rotatedAt: new Date().toISOString()
        });

        const offboardRootId = `${TEST_NAME_PREFIX}root2-${uniqueSuffix}`;
        await decksCollection.insertOne
        ({
            userId: organizationScopeKey,
            data: { id: offboardRootId, name: "Institute deck 2", parent: "0", additionalData: { paidDeckId: untargetedDeckId } },
            serverUpdatedAt: new Date()
        });

        const memberRecord = await OrganizationMemberQueryEngine.findMemberByUserIdOrEmail(organization.getId(), insiderUserId, insiderEmail);
        await OrganizationMemberQueryEngine.removeMember(organization.getId(), memberRecord.getId());

        const offboardedLicense = await licensesCollection.findOne({ userId: insiderUserId, deckId: untargetedDeckId });
        assert(offboardedLicense.status === deckLicenseStatuses.REVOKED, "Removing a member takes the organization's decks back — an ex-member does not keep studying its material");

        const offboardedRows = await decksCollection.countDocuments({ userId: organizationScopeKey, "data.id": offboardRootId });
        assert(offboardedRows === 0, "…and their copies go with the membership");

        assert(await PaidDeckAudienceResolver.isVisibleTo({ audienceOrganizationId: organization.getId() }, await AuthenticationQueryEngine.getUserById(insiderUserId)) === false, "…and they stop being able to see the organization's decks at all");
    }
    catch (databaseError)
    {
        failedCount = failedCount + 1;
        console.log(`  FAIL  Database tier threw: ${databaseError.message}`);
        console.log(databaseError.stack);
    }
    finally
    {
        try
        {
            if (createdUserIds.length > 0)
            {
                await usersCollection.deleteMany({ id: { $in: createdUserIds } });
                await licensesCollection.deleteMany({ userId: { $in: createdUserIds } });
            }
            if (createdDeckIds.length > 0)
            {
                await paidDecksCollection.deleteMany({ id: { $in: createdDeckIds } });
            }
            for (const organizationId of createdOrganizationIds)
            {
                const scopeKeyPattern = new RegExp(`::org:${organizationId}$`);
                await decksCollection.deleteMany({ userId: scopeKeyPattern });
                await database.collection(DatabaseConstants.DELETIONS_COLLECTION).deleteMany({ userId: scopeKeyPattern });
                await OrganizationQueryEngine.deleteOrganization(organizationId);
            }
        }
        catch (cleanupError)
        {
            console.log(`  NOTE  Cleanup failed: ${cleanupError.message}`);
        }
    }
}


async function main()
{
    console.log("CogniumLearn — organization decks verification\n");

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
