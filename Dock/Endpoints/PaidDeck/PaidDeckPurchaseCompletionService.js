const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const PendingOrderQueryEngine = require("../../Globals/Classes/Database/PendingOrderQueryEngine");
const AuthenticationQueryEngine = require("../../Globals/Classes/Database/AuthenticationQueryEngine");
const PaidDeckPricingEngine = require("../../Globals/Classes/Pricing/PaidDeckPricingEngine");
const RegionMetadata = require("../../Globals/Classes/Pricing/RegionMetadata");
const LicenseExpiryResolver = require("../../Globals/Classes/Pricing/LicenseExpiryResolver");
const KeyManagementService = require("../../Globals/Classes/Security/KeyManagementService");
const LicenseClientView = require("../../Globals/Classes/Security/LicenseClientView");
const NotificationDispatcher = require("../../Globals/Classes/Notifications/NotificationDispatcher");
const NotificationContent = require("../../Globals/Classes/Notifications/NotificationContent");
const Purchase = require("../../Globals/Model/Purchase");
const GrantSources = require("../../Globals/Constants/GrantSources");
const { seedProtectedContentForLicense } = require("./PaidDeckGrantHelpers");
const { purchaseStatuses } = require("../../Globals/Enumerations/PurchaseStatuses");
const { notificationChannels } = require("../../Globals/Enumerations/NotificationChannels");
const { logCategory } = require("../../Globals/Enumerations/LogCategory");
const Alerts = require("../../Globals/Classes/Alerts/Alerts");
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

        // Checked BEFORE the grant claim, not after: a refund that arrived
        // before this capture was provisioned found no licences to revoke, so
        // the reversal row is the only thing standing between the buyer and a
        // deck they have already been refunded for. Required lazily to keep the
        // settlement services and the reversal service free of a require cycle.
        const PaymentReversalService = require("../../Globals/Classes/Payments/PaymentReversalService");
        if (await PaymentReversalService.hasReversalForOrder(providerOrderId))
        {
            console.warn(`[PaidDeckPurchaseCompletion] Refusing to grant order ${providerOrderId} — it has already been reversed.`);
            await PendingOrderQueryEngine.markConsumed(providerOrderId, userId);
            return { granted: false, alreadyProcessed: true, refusedAsReversed: true, licenses: [], deckIds: [], skippedDeckIds: [] };
        }

        const claim = await PendingOrderQueryEngine.tryClaimForGrant(providerOrderId, userId);
        if (!claim.claimed)
        {
            // Already consumed, or the other settlement path is granting right
            // now. Either way this call must not grant again.
            return { granted: false, alreadyProcessed: true, licenses: [], deckIds: [], skippedDeckIds: [] };
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
     * The share of the CAPTURED amount to record against one deck.
     *
     * The authority here is `pendingOrder.amountMinor` — the figure the buyer's
     * card was actually charged — not anything recomputed at settlement time.
     * The recomputed breakdown is used only to decide how a multi-deck basket
     * divides, because the order total is a single number and a per-deck
     * purchase row still has to carry a per-deck figure.
     *
     * Three cases, in order:
     *   one deck        the whole order total, exactly. No arithmetic, so no
     *                   rounding error can appear on the commonest purchase.
     *   priced basket   split in proportion to the breakdown, with the LAST
     *                   deck taking the remainder so the rows sum to the
     *                   captured total to the minor unit. Distributing a
     *                   rounding residue anywhere else would leave a basket
     *                   whose parts do not add up to what was charged.
     *   no basis        zero, matching the previous behaviour for a deck the
     *                   pricing engine no longer knows about.
     *
     * Public rather than private: it is a pure function over four values with
     * no state and no side effects, and the arithmetic (a proportional split
     * whose parts must sum exactly to the captured total) is precisely the kind
     * of thing worth asserting directly rather than only through a full
     * settlement.
     *
     * @returns {number} minor units to record for this deck
     */
    static resolveChargedAmountMinor(pendingOrder, authoritativeDeckIds, deckBreakdown, serverPricing)
    {
        const capturedTotalMinor = Number(pendingOrder.amountMinor) || 0;

        if (authoritativeDeckIds.length <= 1)
        {
            return capturedTotalMinor;
        }

        const breakdownTotalMinor = (serverPricing.breakdown || [])
            .reduce((runningTotal, entry) => runningTotal + (Number(entry.finalPriceMinor) || 0), 0);

        if (breakdownTotalMinor <= 0 || !deckBreakdown)
        {
            return 0;
        }

        const deckShareMinor = Number(deckBreakdown.finalPriceMinor) || 0;
        const isLastDeck = authoritativeDeckIds[authoritativeDeckIds.length - 1] === deckBreakdown.deckId;

        if (!isLastDeck)
        {
            return Math.round(capturedTotalMinor * deckShareMinor / breakdownTotalMinor);
        }

        // The last deck absorbs whatever rounding left over, so the per-deck
        // rows always sum to the captured total.
        let allocatedToOthersMinor = 0;
        for (const otherDeckId of authoritativeDeckIds.slice(0, -1))
        {
            const otherEntry = (serverPricing.breakdown || []).find(entry => entry.deckId === otherDeckId);
            const otherShareMinor = otherEntry ? (Number(otherEntry.finalPriceMinor) || 0) : 0;
            allocatedToOthersMinor = allocatedToOthersMinor + Math.round(capturedTotalMinor * otherShareMinor / breakdownTotalMinor);
        }

        return capturedTotalMinor - allocatedToOthersMinor;
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
        const skippedDeckIds = [];

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
                // The buyer HAS PAID for this deck and is not going to receive
                // it. That is a customer-visible failure, not a housekeeping
                // note, so it alerts rather than only writing a warning nobody
                // reads — the order flips to CONSUMED either way, so nothing
                // downstream will raise it later.
                Logger.warning(logCategory.PURCHASE, LogTitles.PURCHASE_DECK, "Skipped granting a deck with no explicit license duration",
                {
                    accountId: userId,
                    additionalData: { deckId: deckId, providerOrderId: providerOrderId }
                });
                await Alerts.raise
                ({
                    severity: Alerts.SEVERITY.ERROR,
                    source: "PAID_DECK_SETTLEMENT",
                    title: "A paid-for deck was withheld at settlement",
                    message: `Deck ${deckId} was paid for on order ${providerOrderId} but has no configured licence duration, so it was NOT granted. The buyer has been charged and is missing this deck. Fix the deck's duration configuration, then re-grant it manually.`,
                    metadata: { accountId: userId, deckId: deckId, providerOrderId: providerOrderId }
                });
                skippedDeckIds.push(deckId);
                continue;
            }

            const purchaseAdditionalData = orgPerkActive
                ? { organizationId: perkBreakdown.organizationId, perkType: "ORG_PERK", durationDays: perkBreakdown.durationDays }
                : {};
            // The recorded amount is what the buyer was actually CHARGED, taken
            // from the pending row written at checkout — not the price
            // recomputed a moment ago.
            //
            // Re-pricing at settlement was subtly wrong: if the catalogue, an
            // exchange rate or a discount moved between checkout and
            // settlement, the Purchase row would state a figure the customer
            // never paid. Every downstream use of that row — the receipt, the
            // revenue report, a dispute response — would then be quoting a
            // number that does not appear on the buyer's card statement.
            //
            // The recomputed breakdown is still used, but only for what it is
            // genuinely authoritative about: licence DURATION and perk
            // metadata, which are properties of the deck rather than of the
            // money. A single-deck order is charged the order total; a
            // multi-deck basket splits by the breakdown's proportions so the
            // per-deck rows still sum to what was captured.
            const recordedAmountMinor = PaidDeckPurchaseCompletionService.resolveChargedAmountMinor
            (
                pendingOrder,
                authoritativeDeckIds,
                perkBreakdown,
                serverPricing
            );
            const recordedCurrency = pendingOrder.currency || serverPricing.currency || "INR";

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

        // No invoice is generated here. Invoicing is handled outside the
        // application and attached manually for the record; the Purchase rows
        // written above are the system's own record of the sale, and
        // /PaidDecks/Purchases/Invoice renders a receipt from them on demand.

        return { granted: true, alreadyProcessed: false, licenses: issuedLicenses, deckIds: authoritativeDeckIds, skippedDeckIds: skippedDeckIds };
    }
}

module.exports = PaidDeckPurchaseCompletionService;
