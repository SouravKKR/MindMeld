/**
 * End-to-end verification harness for retiring and deleting a paid deck.
 *
 * Run from the Dock directory:
 *     node VerifyPaidDeckRetirement.mjs
 *     VERIFY_ORGANIZATION_DB=1 node VerifyPaidDeckRetirement.mjs
 *
 *   1. ALWAYS — the acquisition gate's decisions, and that every path which can
 *      mint a licence actually consults it.
 *
 *   2. DB (opt-in) — retires and deletes real decks. The properties that matter
 *      are the ones a buyer would feel: a retired deck cannot be acquired by
 *      any route, an existing holder is NOT touched, a held deck cannot be
 *      destroyed, and a retired deck can never come back.
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const require = createRequire(import.meta.url);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

require("dotenv").config({ path: path.join(currentDirectory, ".env") });

// The key service does not initialise itself — Dock/index.js does it at boot —
// so a standalone harness has to, exactly as the server would. Without it
// publish refuses at the key check and never reaches the retirement check this
// harness exists to prove, and the assertion fails for an environment reason
// that teaches nobody anything.
//
// A throwaway key stands in when the environment has none. It never leaves this
// process and encrypts nothing that outlives the run.
if (!process.env.PAID_DECK_MASTER_KEY_BASE64)
{
    process.env.PAID_DECK_MASTER_KEY_BASE64 = require("crypto").randomBytes(32).toString("base64");
}
require("./Globals/Classes/Security/KeyManagementService").initialize();

const PaidDeckAcquisitionGate = require("./Globals/Classes/PaidDeck/PaidDeckAcquisitionGate");
const PaidDeckRetirementService = require("./Globals/Classes/PaidDeck/PaidDeckRetirementService");
const PaidDeckPublishService = require("./Globals/Classes/PaidDeck/PaidDeckPublishService");
const DatabaseConnector = require("./Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("./Globals/Constants/DatabaseConstants");
const PaidDeck = require("./Globals/Model/PaidDeck");
const { handleAdminEndpoints } = require("./Endpoints/HandleAdminEndpoints");
const { deckLicenseStatuses } = require("./Globals/Enumerations/DeckLicenseStatuses");
const ErrorCodes = require("./Globals/Constants/ErrorCodes");

const TEST_NAME_PREFIX = "verify-retire-";

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
    section("Tier 1 — the acquisition gate and its call sites");

    const onSaleDeck = { id: "a", isPublished: true, retiredAt: new Date(0).toISOString() };
    const draftDeck = { id: "b", isPublished: false, retiredAt: new Date(0).toISOString() };
    const retiredDeck = { id: "c", isPublished: false, retiredAt: new Date("2026-01-01").toISOString() };

    assert(PaidDeckAcquisitionGate.isRetired(retiredDeck) === true, "A stamped deck reads as retired");
    assert(PaidDeckAcquisitionGate.isRetired(onSaleDeck) === false, "The epoch sentinel is not a retirement date");
    assert(PaidDeckAcquisitionGate.isRetired({ id: "d", isPublished: true }) === false, "A deck predating the field reads as on sale, not retired");
    assert(PaidDeckAcquisitionGate.isRetired(null) === false, "A missing deck does not throw");

    assert(PaidDeckAcquisitionGate.evaluate(onSaleDeck).allowed === true, "A published deck may be acquired");
    assert(PaidDeckAcquisitionGate.evaluate(draftDeck).reason === ErrorCodes.PAID_DECK_NOT_ON_SALE, "A draft may not — the hole that let a draft be bought by id");
    assert(PaidDeckAcquisitionGate.evaluate(retiredDeck).reason === ErrorCodes.PAID_DECK_RETIRED, "A retired deck may not, and says why rather than reading as merely unpublished");
    assert(PaidDeckAcquisitionGate.evaluate(null).reason === ErrorCodes.PAID_DECK_NOT_FOUND, "A missing deck may not");

    // Every route that can mint a licence has to consult the gate. Asserted by
    // name because a new grant path that forgets it fails silently — the deck
    // is simply handed out again.
    const grantPaths =
    [
        { file: "Endpoints/PaidDeck/InitiatePurchase.js", label: "checkout" },
        { file: "Globals/Classes/Coupons/CouponGrantService.js", label: "a coupon grant" },
        { file: "Globals/Classes/Organization/OrganizationAutoAssigner.js", label: "an organisation's auto-assign perk" }
    ];

    for (const grantPath of grantPaths)
    {
        const source = fs.readFileSync(path.join(currentDirectory, grantPath.file), "utf8");
        assert(source.includes("PaidDeckAcquisitionGate"), `The gate is consulted by ${grantPath.label}`);
    }

    const purchaseSource = fs.readFileSync(path.join(currentDirectory, "Endpoints/PaidDeck/InitiatePurchase.js"), "utf8");
    const gateIndex = purchaseSource.indexOf("PaidDeckAcquisitionGate.evaluateMany");
    const couponIndex = purchaseSource.indexOf("CouponCheckoutService");
    assert(gateIndex > 0 && (couponIndex < 0 || gateIndex < couponIndex), "Checkout consults it before reserving a coupon, so a refusal costs nothing");

    const assignerSource = fs.readFileSync(path.join(currentDirectory, "Globals/Classes/Organization/OrganizationAutoAssigner.js"), "utf8");
    const assignerGateIndex = assignerSource.indexOf("PaidDeckAcquisitionGate.evaluateById");
    const purchaseRowIndex = assignerSource.indexOf("PURCHASES_COLLECTION");
    assert(assignerGateIndex > 0 && assignerGateIndex < purchaseRowIndex, "…and the auto-assigner before it writes a purchase row, so a refusal cannot leave one with no licence behind it");

    const publishSource = fs.readFileSync(path.join(currentDirectory, "Globals/Classes/PaidDeck/PaidDeckPublishService.js"), "utf8");
    assert(publishSource.includes("PaidDeckAcquisitionGate.isRetired"), "Publishing refuses a retired deck, so retirement is one-way");

    const adminRoutes = [];
    handleAdminEndpoints({ handle: (routeDefinition) => adminRoutes.push(routeDefinition) });
    const adminRoutePaths = adminRoutes.map(route => route.routePath);
    assert(adminRoutePaths.includes("/Admin/PaidDecks/Retire"), "Retiring a deck is a super-admin route");
    assert(adminRoutePaths.includes("/Admin/PaidDecks/Delete"), "Deleting one is too");

    const panelSource = fs.readFileSync(path.join(currentDirectory, "..", "Main", "Pages", "AdminPanel", "AdminPanelPage.js"), "utf8");
    assert(panelSource.includes('actionKey: "retire"'), "The decks list offers a Retire action");
    assert(panelSource.includes('actionKey: "deletePermanently"'), "…and a permanent delete");
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

    const paidDecksCollection = database.collection(DatabaseConstants.PAID_DECKS_COLLECTION);
    const licensesCollection = database.collection(DatabaseConstants.DECK_LICENSES_COLLECTION);
    const createdDeckIds = [];
    const createdLicenseIds = [];

    try
    {
        const uniqueSuffix = `${Date.now()}`;

        const insertDeck = async (deckId) =>
        {
            await paidDecksCollection.insertOne({ ...new PaidDeck({ title: deckId, isPublished: true }).toJson(), id: deckId });
            createdDeckIds.push(deckId);
        };

        const unheldDeckId = `${TEST_NAME_PREFIX}unheld-${uniqueSuffix}`;
        const heldDeckId = `${TEST_NAME_PREFIX}held-${uniqueSuffix}`;
        await insertDeck(unheldDeckId);
        await insertDeck(heldDeckId);

        const licenseId = `${TEST_NAME_PREFIX}license-${uniqueSuffix}`;
        await licensesCollection.insertOne
        ({
            id: licenseId,
            userId: `${TEST_NAME_PREFIX}buyer-${uniqueSuffix}`,
            deckId: heldDeckId,
            status: deckLicenseStatuses.ACTIVE,
            // A finite licence: it runs to its own expiry and is then swept.
            expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
            rotatedAt: new Date().toISOString()
        });
        createdLicenseIds.push(licenseId);

        // ── Retiring ──────────────────────────────────────────────────────
        section("Retiring");

        assert((await PaidDeckAcquisitionGate.evaluateById(heldDeckId)).allowed === true, "The deck can be acquired before it is retired");

        const retirement = await PaidDeckRetirementService.retire(heldDeckId, "harness-admin");
        assert(retirement.success === true, "Retiring succeeds");
        assert(retirement.holders.activeCount === 1, "…and reports who keeps it");
        assert(retirement.holders.perpetualCount === 0, "…distinguishing finite licences from perpetual ones");

        const retiredDocument = await paidDecksCollection.findOne({ id: heldDeckId });
        assert(retiredDocument.isPublished === false, "The deck is unpublished");
        assert(PaidDeckAcquisitionGate.isRetired(retiredDocument) === true, "…and stamped, which is what makes it permanent rather than a reversible unpublish");

        const afterRetirement = await PaidDeckAcquisitionGate.evaluateById(heldDeckId);
        assert(afterRetirement.allowed === false && afterRetirement.reason === ErrorCodes.PAID_DECK_RETIRED, "Nobody new can acquire it, by any route");

        // The part a buyer would feel.
        const survivingLicense = await licensesCollection.findOne({ id: licenseId });
        assert(survivingLicense.status === deckLicenseStatuses.ACTIVE, "The existing holder's licence is UNTOUCHED — withdrawing from sale does not take back what was paid for");

        const republish = await PaidDeckPublishService.publish
        ({
            metadata: { id: heldDeckId, title: "back from the dead", isPublished: true },
            deckPayload: { manifest: {}, data: [] },
            publisherUserId: "harness-admin",
            audienceOrganizationId: "",
            allowPricing: true
        });
        assert(republish.success === false && republish.error === ErrorCodes.PAID_DECK_RETIRED, "A retired deck cannot be published again — buyers were told it was withdrawn");

        assert((await PaidDeckRetirementService.retire(heldDeckId, "harness-admin")).error === ErrorCodes.PAID_DECK_ALREADY_RETIRED, "Retiring twice is reported rather than silently repeated");

        // ── Deleting ──────────────────────────────────────────────────────
        section("Deleting");

        const blockedDeletion = await PaidDeckRetirementService.deletePermanently(heldDeckId, "harness-admin");
        assert(blockedDeletion.success === false && blockedDeletion.error === ErrorCodes.PAID_DECK_STILL_HELD, "A deck somebody holds cannot be destroyed — their device decrypts against the content this would remove");
        assert(blockedDeletion.holders.activeCount === 1, "…and the refusal says how many hold it");
        assert(await paidDecksCollection.findOne({ id: heldDeckId }) !== null, "…and nothing was removed");

        // Once the licence is gone, the deck becomes deletable.
        await licensesCollection.updateOne({ id: licenseId }, { $set: { status: deckLicenseStatuses.EXPIRED } });
        const nowDeletable = await PaidDeckRetirementService.deletePermanently(heldDeckId, "harness-admin");
        assert(nowDeletable.success === true, "Once no licence is active it can be destroyed");
        assert(await paidDecksCollection.findOne({ id: heldDeckId }) === null, "…and the listing is gone");

        const unheldDeletion = await PaidDeckRetirementService.deletePermanently(unheldDeckId, "harness-admin");
        assert(unheldDeletion.success === true, "A deck nobody ever bought deletes straight away");

        assert((await PaidDeckRetirementService.deletePermanently(`${TEST_NAME_PREFIX}ghost`, "harness-admin")).error === ErrorCodes.PAID_DECK_NOT_FOUND, "Deleting a deck that does not exist is reported, not silently successful");

        // ── A perpetual holder ────────────────────────────────────────────
        section("Perpetual licences");

        const perpetualDeckId = `${TEST_NAME_PREFIX}perpetual-${uniqueSuffix}`;
        await insertDeck(perpetualDeckId);

        const perpetualLicenseId = `${TEST_NAME_PREFIX}license-perpetual-${uniqueSuffix}`;
        await licensesCollection.insertOne
        ({
            id: perpetualLicenseId,
            userId: `${TEST_NAME_PREFIX}buyer2-${uniqueSuffix}`,
            deckId: perpetualDeckId,
            status: deckLicenseStatuses.ACTIVE,
            // The epoch sentinel is "never expires".
            expiresAt: new Date(0).toISOString(),
            rotatedAt: new Date().toISOString()
        });
        createdLicenseIds.push(perpetualLicenseId);

        const perpetualRetirement = await PaidDeckRetirementService.retire(perpetualDeckId, "harness-admin");
        assert(perpetualRetirement.holders.perpetualCount === 1, "A perpetual holder is counted as one, so the operator is told the deck may never become deletable");

        const perpetualDeletion = await PaidDeckRetirementService.deletePermanently(perpetualDeckId, "harness-admin");
        assert(perpetualDeletion.success === false && perpetualDeletion.error === ErrorCodes.PAID_DECK_STILL_HELD, "…and it is refused for deletion for as long as that holder exists");

        // ── The deliberate override ───────────────────────────────────────
        //
        // A perpetual holder means "retire and wait" is not a plan — the deck
        // never becomes deletable on its own. Forcing is the answer to that,
        // and the property that matters is not that it deletes: it is that no
        // holder is left with an active entitlement pointing at content which
        // no longer exists. A licence that survived would be worse than the
        // deletion, because the holder would see a deck they own fail with
        // nothing anywhere to explain why.
        section("Forced deletion");

        const forcedDeletion = await PaidDeckRetirementService.deletePermanently(perpetualDeckId, "harness-admin", true);

        assert(forcedDeletion.success === true, "Forcing deletes a deck that would otherwise never become deletable");
        assert(forcedDeletion.revokedLicenseCount === 1, `…and reports how many licences it revoked (got ${forcedDeletion.revokedLicenseCount})`);
        assert(await paidDecksCollection.findOne({ id: perpetualDeckId }) === null, "…the listing is gone");

        const survivingActiveLicense = await licensesCollection.findOne({ deckId: perpetualDeckId, status: deckLicenseStatuses.ACTIVE });
        assert(survivingActiveLicense === null, "…and NO active licence survives pointing at the deleted deck");

        const revokedLicense = await licensesCollection.findOne({ id: perpetualLicenseId });
        assert(revokedLicense !== null, "The licence row is kept rather than deleted — a refund or dispute later needs the record");
        assert(revokedLicense.status === deckLicenseStatuses.REVOKED, `…marked revoked (got ${revokedLicense?.status})`);
        assert(typeof revokedLicense.revocationReason === "string" && revokedLicense.revocationReason.length > 0, "…and carrying why");

        // The override must not become the default by accident.
        const stillHeldDeckId = `${TEST_NAME_PREFIX}still-held-${uniqueSuffix}`;
        await insertDeck(stillHeldDeckId);

        const stillHeldLicenseId = `${TEST_NAME_PREFIX}license-still-held-${uniqueSuffix}`;
        await licensesCollection.insertOne
        ({
            id: stillHeldLicenseId,
            userId: `${TEST_NAME_PREFIX}buyer3-${uniqueSuffix}`,
            deckId: stillHeldDeckId,
            status: deckLicenseStatuses.ACTIVE,
            expiresAt: new Date(0).toISOString(),
            rotatedAt: new Date().toISOString()
        });
        createdLicenseIds.push(stillHeldLicenseId);

        const unforcedDeletion = await PaidDeckRetirementService.deletePermanently(stillHeldDeckId, "harness-admin", false);
        assert(unforcedDeletion.success === false, "Passing the flag explicitly false still refuses");
        assert(
            (await licensesCollection.findOne({ id: stillHeldLicenseId })).status === deckLicenseStatuses.ACTIVE,
            "…and a refused deletion revokes nothing",
        );
    }
    catch (databaseTierError)
    {
        failedCount = failedCount + 1;
        console.log(`  FAIL  Database tier threw: ${databaseTierError.message}`);
        console.log(databaseTierError.stack);
    }
    finally
    {
        try
        {
            if (createdDeckIds.length > 0)
            {
                await paidDecksCollection.deleteMany({ id: { $in: createdDeckIds } });
            }
            if (createdLicenseIds.length > 0)
            {
                await licensesCollection.deleteMany({ id: { $in: createdLicenseIds } });
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
    console.log("CogniumLearn — paid-deck retirement verification\n");

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
