const crypto = require("crypto");
const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const PaymentProviderFactory = require("../../Globals/Classes/Payments/PaymentProviderFactory");
const KeyManagementService = require("../../Globals/Classes/Security/KeyManagementService");
const PaidDeckPricingEngine = require("../../Globals/Classes/Pricing/PaidDeckPricingEngine");
const PaidDeckUserContentCloner = require("../../Globals/Classes/PaidDeck/PaidDeckUserContentCloner");
const Purchase = require("../../Globals/Model/Purchase");
const { getUser } = require("../Helpers/GetUser");
const { purchaseStatuses } = require("../../Globals/Enumerations/PurchaseStatuses");
const { deckLicenseStatuses } = require("../../Globals/Enumerations/DeckLicenseStatuses");

const MILLISECONDS_PER_DAY = 86_400_000;

async function verifyPurchase(request, response)
{
    const session = request.session;

    if (!session)
    {
        response.sendStatusCode(401);
        return;
    }

    const body = await request.getBody();
    const { providerOrderId, providerPaymentId, signature, paymentProvider, deckIds, region, amountMinor, currency } = body || {};

    if (!providerOrderId || !providerPaymentId || !signature)
    {
        response.statusCode = 400;
        response.sendJson({ error: "MISSING_FIELDS" });
        return;
    }

    const provider = PaymentProviderFactory.getProvider(paymentProvider);
    const verification = await provider.verifyPayment({ providerOrderId, providerPaymentId, signature });

    if (!verification.verified)
    {
        response.statusCode = 400;
        response.sendJson({ error: "PAYMENT_NOT_VERIFIED", reason: verification.reason });
        return;
    }

    // Re-evaluate pricing server-side. The client's amountMinor field
    // is informational only — we trust the engine's per-deck breakdown
    // for the actual amounts on each Purchase row AND for the perk
    // metadata (durationDays) that drives license expiresAt.
    const user = await getUser(request);
    const safeDeckIds = Array.isArray(deckIds) ? deckIds : [];
    const safeRegion = (region || "IN").toUpperCase();
    const serverPricing = await PaidDeckPricingEngine.computeFinalPrice
    (
        session.getUserId(),
        safeDeckIds,
        safeRegion,
        user
    );
    const perkLookupByDeckId = new Map();
    for (const breakdownEntry of (serverPricing.breakdown || []))
    {
        if (breakdownEntry.reason === "ORG_PERK")
        {
            perkLookupByDeckId.set(breakdownEntry.deckId, breakdownEntry);
        }
    }

    const database = await DatabaseConnector.getDatabase();
    const issuedLicenses = [];

    for (const deckId of safeDeckIds)
    {
        const perkBreakdown = perkLookupByDeckId.get(deckId);
        const orgPerkActive = perkBreakdown !== undefined;
        const purchaseAdditionalData = orgPerkActive
            ? { organizationId: perkBreakdown.organizationId, perkType: "ORG_PERK", durationDays: perkBreakdown.durationDays }
            : {};
        const recordedAmountMinor = orgPerkActive
            ? perkBreakdown.finalPriceMinor
            : (amountMinor || 0);

        const purchase = new Purchase
        ({
            userId: session.getUserId(),
            deckId: deckId,
            paymentProvider: provider.getProviderEnumValue(),
            providerOrderId: providerOrderId,
            providerPaymentId: providerPaymentId,
            amountMinor: recordedAmountMinor,
            currency: currency || "INR",
            region: region || "IN",
            purchaseDate: new Date(),
            refundedAt: new Date(0),
            status: purchaseStatuses.COMPLETED,
            additionalData: purchaseAdditionalData
        });

        await database
            .collection(DatabaseConstants.PURCHASES_COLLECTION)
            .updateOne
            (
                { userId: session.getUserId(), deckId: deckId, providerOrderId: providerOrderId },
                { $set: purchase.toJson() },
                { upsert: true }
            );

        // License expiry: finite for org-perk grants (now + durationDays),
        // FOREVER sentinel for everything else.
        const licenseOptions = orgPerkActive && Number.isInteger(perkBreakdown.durationDays) && perkBreakdown.durationDays > 0
            ? { expiresAt: new Date(Date.now() + perkBreakdown.durationDays * MILLISECONDS_PER_DAY), grantSource: "ORG_DISCOUNTED_PURCHASE" }
            : { expiresAt: new Date(0), grantSource: orgPerkActive ? "ORG_DISCOUNTED_PURCHASE" : "PURCHASE" };

        const licenseResult = await KeyManagementService.issueLicenseForDeck(session.getUserId(), deckId, licenseOptions);

        if (licenseResult.success)
        {
            const seedResult = await seedProtectedContentForLicense(database, session.getUserId(), deckId, licenseResult.license);
            if (seedResult.success)
            {
                issuedLicenses.push(licenseResult.license.toJson());
            }
            else
            {
                console.error(`[VerifyPurchase] Failed to seed protected content for user ${session.getUserId()} deck ${deckId}: ${seedResult.reason}`);
            }
        }
    }

    const hasExistingPaidDeckPassword = await checkUserHasPaidDeckPassword(database, session.getUserId());

    response.statusCode = 200;
    response.sendJson
    ({
        success: true,
        licenses: issuedLicenses,
        requiresPasswordSetup: !hasExistingPaidDeckPassword
    });
}

/**
 * Seeds the per-user editable copy in paidDeckUserContent (by cloning
 * the decrypted master payload) AND fills in the new license's
 * server-wrapped content key. The password-wrap is left empty here —
 * the first /PaidDecks/UnlockSession lazily fills it using the
 * password the buyer types into the unlock prompt. To make that
 * lazy-fill path work even for the SECOND-and-onwards purchase (when
 * the buyer is past their password-setup step), we copy any existing
 * passwordHash + passwordSalt from a prior license onto this one — so
 * the unlock challenge has something to verify against. PasswordWrap
 * itself can't be copied (different content key per deck) and is
 * intentionally left for the lazy refill on first unlock.
 *
 * Returns { success, reason? } so the caller can drop a failed license
 * from the issuedLicenses array instead of returning a stale success.
 */
async function seedProtectedContentForLicense(database, userId, deckId, license)
{
    const paidDeckDocument = await database
        .collection(DatabaseConstants.PAID_DECKS_COLLECTION)
        .findOne({ id: deckId });

    if (!paidDeckDocument)
    {
        return { success: false, reason: "PAID_DECK_NOT_FOUND" };
    }

    const decryptedMasterPayload = await KeyManagementService.decryptPaidDeckMasterPayload(deckId, paidDeckDocument.keyVersion);
    if (!decryptedMasterPayload)
    {
        return { success: false, reason: "MASTER_DECRYPT_FAILED" };
    }

    const cloned = PaidDeckUserContentCloner.clone(decryptedMasterPayload);
    try
    {
        await database
            .collection(DatabaseConstants.PAID_DECK_USER_CONTENT_COLLECTION)
            .updateOne
            (
                { userId: userId, deckId: deckId },
                {
                    $set:
                    {
                        userId: userId,
                        deckId: deckId,
                        manifest: cloned.manifest,
                        contentByEntityId: cloned.contentByEntityId,
                        updatedAt: new Date()
                    },
                    $setOnInsert:
                    {
                        createdAt: new Date()
                    }
                },
                { upsert: true }
            );
    }
    catch (writeError)
    {
        return { success: false, reason: "USER_CONTENT_WRITE_FAILED" };
    }

    const newContentKeyBytes = KeyManagementService.generatePaidDeckContentKey();
    try
    {
        const serverWrap = KeyManagementService.wrapPaidDeckContentKeyWithServerKek(newContentKeyBytes, deckId);
        license.setServerWrappedIvBase64(serverWrap.ivBase64);
        license.setServerWrappedContentKeyBase64(serverWrap.ciphertextBase64);
        license.setContentKeyVersion(1);
        license.setRotatedAt(new Date());

        const existingPasswordedLicense = await database
            .collection(DatabaseConstants.DECK_LICENSES_COLLECTION)
            .findOne
            ({
                userId: userId,
                deckId: { $ne: deckId },
                status: deckLicenseStatuses.ACTIVE,
                passwordHash: { $exists: true, $ne: "" }
            });

        if (existingPasswordedLicense)
        {
            license.setPasswordHash(existingPasswordedLicense.passwordHash);
            license.setPasswordSalt(existingPasswordedLicense.passwordSalt);
            // passwordWrappedContentKey is intentionally left empty
            // (unlock's lazy-fill path picks it up using the same
            // password the buyer already set).
        }

        await KeyManagementService.persistLicense(license);
    }
    catch (persistError)
    {
        return { success: false, reason: "LICENSE_PERSIST_FAILED" };
    }
    finally
    {
        newContentKeyBytes.fill(0);
    }

    return { success: true };
}

async function checkUserHasPaidDeckPassword(database, userId)
{
    const existingDocumentWithPassword = await database
        .collection(DatabaseConstants.DECK_LICENSES_COLLECTION)
        .findOne
        ({
            userId: userId,
            status: deckLicenseStatuses.ACTIVE,
            passwordHash: { $exists: true, $ne: "" }
        });
    return existingDocumentWithPassword !== null;
}

module.exports = { verifyPurchase };
