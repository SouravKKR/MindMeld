const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const PendingOrderQueryEngine = require("../../Globals/Classes/Database/PendingOrderQueryEngine");
const AuthenticationQueryEngine = require("../../Globals/Classes/Database/AuthenticationQueryEngine");
const PaidDeckPricingEngine = require("../../Globals/Classes/Pricing/PaidDeckPricingEngine");
const RegionMetadata = require("../../Globals/Classes/Pricing/RegionMetadata");
const LicenseExpiryResolver = require("../../Globals/Classes/Pricing/LicenseExpiryResolver");
const KeyManagementService = require("../../Globals/Classes/Security/KeyManagementService");
const LicenseClientView = require("../../Globals/Classes/Security/LicenseClientView");
const ZohoInvoiceService = require("../../Globals/Classes/Invoicing/ZohoInvoiceService");
const NotificationDispatcher = require("../../Globals/Classes/Notifications/NotificationDispatcher");
const NotificationContent = require("../../Globals/Classes/Notifications/NotificationContent");
const Purchase = require("../../Globals/Model/Purchase");
const GrantSources = require("../../Globals/Constants/GrantSources");
const { seedProtectedContentForLicense } = require("./PaidDeckGrantHelpers");
const { purchaseStatuses } = require("../../Globals/Enumerations/PurchaseStatuses");
const { notificationChannels } = require("../../Globals/Enumerations/NotificationChannels");
const { logCategory } = require("../../Globals/Enumerations/LogCategory");
const Logger = require("../../Globals/Classes/Logger");
const LogTitles = require("../../Globals/Classes/Logging/LogTitles");

/**
 * PaidDeckPurchaseCompletionService
 *
 * The ONE place a verified paid-deck payment turns into licenses. Called by
 * both /PaidDecks/Purchase/Verify (the buyer's browser) and the payment-provider
 * webhook (server to server), so the two paths cannot diverge — whichever
 * arrives first grants, the other becomes an idempotent no-op. Without the
 * webhook path a buyer who paid and then closed the tab before Verify ran was
 * charged with no license issued and no server-side recovery.
 *
 * Nothing here is taken from a client payload. The buyer, the exact decks, the
 * amount, the currency and the region all come from the server-authoritative
 * pending-order row written at InitiatePurchase, so the webhook — which has no
 * session at all — is exactly as trustworthy as the browser leg.
 *
 * Idempotency / concurrency. Granting a deck is a multi-collection operation
 * (purchase row, license, seeded entities) with no single atomic write to key
 * off, so the two paths are serialized by PendingOrderQueryEngine's grant claim:
 * exactly one caller wins, the loser reports alreadyProcessed. That matters
 * because two concurrent seeds of the same copy would delete and re-insert each
 * other's rows. The claim is released on failure and expires if its holder dies,
 * so a paid order is never stranded; the order flips to CONSUMED only after the
 * grants complete.
 */
class PaidDeckPurchaseCompletionService
{
    static SOURCE_VERIFY = "VERIFY";
    static SOURCE_WEBHOOK = "WEBHOOK";

    /**
     * Grants every deck the pending order was created for to its owner, records
     * the purchases, and consumes the order. Safe to call any number of times
     * from any path.
     *
     * @param {object} pendingOrder — row from PendingOrderQueryEngine
     * @param {{providerPaymentId: string, paymentProvider: number, source: string, fallbackRegion?: string|number}} context
     * @returns {Promise<{granted: boolean, alreadyProcessed: boolean, licenses: Array<object>, deckIds: Array<string>}>}
     */
    static async complete(pendingOrder, { providerPaymentId, paymentProvider, source, fallbackRegion } = {})
    {
        const providerOrderId = pendingOrder.providerOrderId;
        const userId = pendingOrder.userId;

        const claim = await PendingOrderQueryEngine.tryClaimForGrant(providerOrderId, userId);
        if (!claim.claimed)
        {
            // Already consumed, or the other settlement path is granting right
            // now. Either way this call must not grant again.
            return { granted: false, alreadyProcessed: true, licenses: [], deckIds: [] };
        }

        try
        {
            const result = await PaidDeckPurchaseCompletionService.#grantOrderedDecks
            (
                pendingOrder,
                { providerPaymentId: providerPaymentId, paymentProvider: paymentProvider, source: source, fallbackRegion: fallbackRegion }
            );

            // Flip to CONSUMED only after the grants complete, so a crash
            // mid-grant leaves the order PENDING and it can safely be retried
            // (every grant write above is an idempotent upsert / re-seed).
            await PendingOrderQueryEngine.markConsumed(providerOrderId, userId);

            return result;
        }
        catch (completionError)
        {
            // Hand the claim back so the other settlement path (or a provider
            // retry) can pick the order up immediately rather than waiting for
            // the claim to go stale.
            await PendingOrderQueryEngine.releaseGrantClaim(providerOrderId, userId);
            throw completionError;
        }
    }

    /**
     * The grant itself, run under a held claim. Split out so complete() reads as
     * claim / grant / consume and every early return still releases the claim.
     */
    static async #grantOrderedDecks(pendingOrder, { providerPaymentId, paymentProvider, source, fallbackRegion })
    {
        const providerOrderId = pendingOrder.providerOrderId;
        const userId = pendingOrder.userId;
        const database = await DatabaseConnector.getDatabase();

        // The authoritative deck list is the server's record of what was ordered.
        const authoritativeDeckIds = Array.isArray(pendingOrder.deckIds) ? pendingOrder.deckIds : [];

        // Price against the region captured at initiation (a Regions enum name)
        // so recomputed amounts match what the buyer was actually charged. The
        // fallback only covers legacy rows that predate the stored region.
        const hasStoredRegion = pendingOrder.region !== null && pendingOrder.region !== undefined && pendingOrder.region !== "";
        const safeRegion = hasStoredRegion
            ? pendingOrder.region
            : (fallbackRegion !== undefined && fallbackRegion !== null ? fallbackRegion : RegionMetadata.DEFAULT_REGION);

        // Re-evaluate pricing server-side over the authoritative decks. The
        // engine's per-deck breakdown drives both the recorded Purchase amounts
        // and the perk metadata (durationDays) that sets each license's expiresAt.
        const user = await AuthenticationQueryEngine.getUserById(userId);
        const serverPricing = await PaidDeckPricingEngine.computeFinalPrice
        (
            userId,
            authoritativeDeckIds,
            safeRegion,
            user,
            true
        );

        const breakdownByDeckId = new Map();
        for (const breakdownEntry of (serverPricing.breakdown || []))
        {
            breakdownByDeckId.set(breakdownEntry.deckId, breakdownEntry);
        }

        const issuedLicenses = [];

        for (const deckId of authoritativeDeckIds)
        {
            const perkBreakdown = breakdownByDeckId.get(deckId);
            const orgPerkActive = perkBreakdown !== undefined && perkBreakdown.reason === "ORG_PERK";

            // Explicit-duration gate (defence in depth). InitiatePurchase already
            // refused to create the order for a deck with no finite / perpetual
            // configuration, so this should never fire — but if pricing changed
            // between initiation and settlement, skip the deck rather than mint a
            // forever license. The buyer keeps their paid decks; a misconfigured
            // one is simply not granted and is logged for follow-up.
            const expiryResolution = LicenseExpiryResolver.resolve(perkBreakdown);
            if (expiryResolution.status === LicenseExpiryResolver.STATUS_UNSPECIFIED)
            {
                Logger.warning(logCategory.PURCHASE, LogTitles.PURCHASE_DECK, "Skipped granting a deck with no explicit license duration",
                {
                    accountId: userId,
                    additionalData: { deckId: deckId, providerOrderId: providerOrderId }
                });
                continue;
            }

            const purchaseAdditionalData = orgPerkActive
                ? { organizationId: perkBreakdown.organizationId, perkType: "ORG_PERK", durationDays: perkBreakdown.durationDays }
                : {};
            // Recorded amount comes from the server pricing breakdown, never a
            // client body.
            const recordedAmountMinor = perkBreakdown ? (Number(perkBreakdown.finalPriceMinor) || 0) : 0;
            const recordedCurrency = serverPricing.currency || pendingOrder.currency || "INR";

            const purchase = new Purchase
            ({
                userId: userId,
                deckId: deckId,
                paymentProvider: paymentProvider,
                providerOrderId: providerOrderId,
                providerPaymentId: providerPaymentId || "",
                amountMinor: recordedAmountMinor,
                currency: recordedCurrency,
                region: safeRegion,
                purchaseDate: new Date(),
                refundedAt: new Date(0),
                status: purchaseStatuses.COMPLETED,
                additionalData: purchaseAdditionalData
            });

            await database
                .collection(DatabaseConstants.PURCHASES_COLLECTION)
                .updateOne
                (
                    { userId: userId, deckId: deckId, providerOrderId: providerOrderId },
                    { $set: purchase.toJson() },
                    { upsert: true }
                );

            Logger.info(logCategory.PURCHASE, LogTitles.PURCHASE_DECK, "Paid deck purchased",
            {
                accountId: userId,
                additionalData:
                {
                    deckId: deckId,
                    amountMinor: recordedAmountMinor,
                    currency: recordedCurrency,
                    paymentProvider: paymentProvider,
                    providerOrderId: providerOrderId,
                    providerPaymentId: providerPaymentId || "",
                    source: source || ""
                }
            });

            // License expiry comes from the single resolver: a finite window when
            // durationDays > 0 (org-perk rental or a time-limited sale) or the
            // FOREVER sentinel only when the deck was explicitly sold as perpetual.
            const licenseOptions =
            {
                expiresAt: expiryResolution.expiresAt,
                grantSource: orgPerkActive ? GrantSources.ORG_DISCOUNTED_PURCHASE : GrantSources.PURCHASE
            };

            const licenseResult = await KeyManagementService.issueLicenseForDeck(userId, deckId, licenseOptions);

            if (licenseResult.success)
            {
                const seedResult = await seedProtectedContentForLicense(database, userId, deckId, licenseResult.license);
                if (seedResult.success)
                {
                    issuedLicenses.push(LicenseClientView.sanitize(licenseResult.license.toJson()));
                }
                else
                {
                    console.error(`[PaidDeckPurchaseCompletion] Failed to seed protected content for user ${userId} deck ${deckId}: ${seedResult.reason}`);
                }
            }
        }

        // Purchase settled (only ever reached on the first-time grant — a replay
        // loses the claim above). Tell the buyer their deck(s) are ready, in-app
        // + push. Best-effort; never blocks the grant.
        if (issuedLicenses.length > 0)
        {
            try
            {
                await NotificationDispatcher.dispatch(userId, NotificationContent.deckPurchaseComplete(issuedLicenses.length), notificationChannels.IN_APP | notificationChannels.PUSH);
            }
            catch (notifyError)
            {
                console.warn(`[PaidDeckPurchaseCompletion] Failed to dispatch purchase-complete notification for order ${providerOrderId}: ${notifyError.message}`);
            }
        }

        // Invoice the paid acquisition — best-effort, never blocks the grant.
        // Uses the server-recomputed total, never a client body.
        if (ZohoInvoiceService.isEnabled() && Number(serverPricing.totalMinor) > 0)
        {
            try
            {
                const buyerEmail = user ? (user.getAdditionalData()?.email || "") : "";
                const deckLabel = authoritativeDeckIds.length === 1 ? "CogniumLearn deck" : `CogniumLearn decks (${authoritativeDeckIds.length})`;
                await ZohoInvoiceService.createPaidInvoice
                ({
                    email: buyerEmail,
                    name: user && user.getDisplayName ? user.getDisplayName() : "",
                    amountMinor: serverPricing.totalMinor,
                    currency: serverPricing.currency || pendingOrder.currency || "INR",
                    description: deckLabel,
                    referenceNumber: providerPaymentId || providerOrderId
                });
            }
            catch (invoiceError)
            {
                console.warn(`[PaidDeckPurchaseCompletion] Invoice step failed for order ${providerOrderId} (non-fatal): ${invoiceError?.message || invoiceError}`);
            }
        }

        return { granted: true, alreadyProcessed: false, licenses: issuedLicenses, deckIds: authoritativeDeckIds };
    }
}

module.exports = PaidDeckPurchaseCompletionService;
