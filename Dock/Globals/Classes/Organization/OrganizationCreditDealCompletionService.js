const CreditDealPaymentQueryEngine = require("../Credits/CreditDealPaymentQueryEngine");
const OrganizationCreditLedger = require("./OrganizationCreditLedger");
const OrganizationQueryEngine = require("./OrganizationQueryEngine");
const NotificationDispatcher = require("../Notifications/NotificationDispatcher");
const NotificationContent = require("../Notifications/NotificationContent");
const { notificationChannels } = require("../../Enumerations/NotificationChannels");
const { creditDealTargetTypes } = require("../../Enumerations/CreditDealTargetTypes");


/**
 * OrganizationCreditDealCompletionService
 *
 * The ONE place a paid credit deal turns into credits in an organization's
 * pool. Called by the organization admin's browser after checkout AND by the
 * payment-provider webhook, so the two cannot diverge: whichever arrives first
 * credits the pool, the other becomes a no-op.
 *
 * Without the webhook leg, an admin who paid and then closed the tab would have
 * been charged with nothing credited and no server-side recovery — the same
 * failure the paid-deck flow already solves this way.
 *
 * Idempotency has two locks, because crediting a pool is a multi-step operation
 * with no single atomic write:
 *
 *   1. CreditDealPaymentQueryEngine.markCaptured is a compare-and-set on the
 *      deal row, so only the FIRST caller sees `transitioned`.
 *   2. The pool credit is keyed on `orgDeal:<dealId>`, so even if step 1 were
 *      somehow reached twice, the ledger's unique referenceKey refuses the
 *      second.
 *
 * Everything credited comes from the STORED deal — never from a request body —
 * so the webhook, which has no session at all, is exactly as trustworthy as the
 * browser leg.
 */
class OrganizationCreditDealCompletionService
{
    static SOURCE_VERIFY = "VERIFY";
    static SOURCE_WEBHOOK = "WEBHOOK";

    /**
     * Settles one captured deal.
     *
     * @param {string} providerOrderId
     * @param {string} providerPaymentId
     * @param {string} source SOURCE_VERIFY or SOURCE_WEBHOOK
     * @returns {Promise<{settled: boolean, alreadyProcessed: boolean, creditsAdded: number, organizationId: string|null}>}
     */
    static async complete(providerOrderId, providerPaymentId, source)
    {
        // A refund that landed before this capture was settled reversed nothing
        // (the pool had not been credited yet), so this row is what stops the
        // institute being credited for money that has already gone back.
        // Required lazily to keep the settlement services and the reversal
        // service free of a require cycle.
        const PaymentReversalService = require("../Payments/PaymentReversalService");
        if (await PaymentReversalService.hasReversalForOrder(providerOrderId))
        {
            console.warn(`[OrganizationCreditDealCompletion] Refusing to settle deal order ${providerOrderId} — it has already been reversed.`);
            return { settled: false, alreadyProcessed: true, refusedAsReversed: true, creditsAdded: 0, organizationId: null };
        }

        const captureResult = await CreditDealPaymentQueryEngine.markCaptured(providerOrderId, providerPaymentId);

        if (!captureResult.transitioned)
        {
            // Already captured by the other path, or no such pending deal.
            return {
                settled: false,
                alreadyProcessed: captureResult.deal !== null,
                creditsAdded: 0,
                organizationId: captureResult.deal ? captureResult.deal.getTargetId() : null
            };
        }

        const deal = captureResult.deal;
        if (!deal || deal.getTargetType() !== creditDealTargetTypes.ORGANIZATION_CREDIT_POOL)
        {
            // A captured deal of another kind — the caller's other branches own
            // it; this service must not credit a pool for it.
            return { settled: false, alreadyProcessed: false, creditsAdded: 0, organizationId: null };
        }

        const organizationId = deal.getTargetId();
        const creditsPurchased = Number(deal.getAdditionalData()?.credits) || 0;
        const termEndsAtValue = deal.getAdditionalData()?.termEndsAt;

        const creditResult = await OrganizationCreditLedger.credit
        (
            organizationId,
            creditsPurchased,
            OrganizationCreditLedger.TRANSACTION_TYPE_PURCHASE,
            `orgDeal:${deal.getId()}`,
            {
                dealId: deal.getId(),
                providerOrderId: providerOrderId,
                providerPaymentId: providerPaymentId || "",
                amountMinor: deal.getAmountMinor(),
                currency: deal.getCurrency(),
                source: source || ""
            }
        );

        // Paying for credits is what renews the contract, so the term moves and
        // the pool unfreezes together with the money arriving. Unfreezing is
        // unconditional: any credits carried over from a lapsed term become
        // spendable again on renewal, which is what carrying them over was for.
        if (typeof termEndsAtValue === "string" && termEndsAtValue.length > 0)
        {
            await OrganizationQueryEngine.setTermEndsAt(organizationId, new Date(termEndsAtValue));
            // The new term must warn as it approaches, so the thresholds the
            // previous term already announced are cleared.
            await OrganizationQueryEngine.clearAnnouncedTermThresholds(organizationId);
        }
        await OrganizationCreditLedger.setFrozen(organizationId, false);

        await OrganizationCreditDealCompletionService.#notifyOwner(organizationId, deal, creditResult.amount);

        return {
            settled: creditResult.applied === true,
            alreadyProcessed: creditResult.alreadyApplied === true,
            creditsAdded: creditResult.applied ? creditResult.amount : 0,
            organizationId: organizationId
        };
    }

    /**
     * Tells the owner their credits arrived.
     *
     * Best-effort by contract: a notification failure must never undo a settled
     * payment, because the credits are already in the pool.
     *
     * No invoice is raised here. Invoicing happens outside the application and
     * is attached to the deal for the record, so settlement's job ends at the
     * ledger entry — which already carries the buyer, the quantity, the amount,
     * the currency and the provider references.
     */
    static async #notifyOwner(organizationId, deal, creditsAdded)
    {
        const organization = await OrganizationQueryEngine.getOrganizationById(organizationId);
        if (!organization)
        {
            return;
        }

        try
        {
            const ownerUserId = organization.getAdminUserId();
            if (ownerUserId && ownerUserId.length > 0 && creditsAdded > 0)
            {
                await NotificationDispatcher.dispatch
                (
                    ownerUserId,
                    NotificationContent.organizationCreditsPurchased(organization.getName(), creditsAdded),
                    notificationChannels.IN_APP | notificationChannels.PUSH
                );
            }
        }
        catch (notifyError)
        {
            console.warn(`[OrganizationCreditDealCompletion] Notification failed for org ${organizationId}: ${notifyError.message}`);
        }

    }
}

module.exports = OrganizationCreditDealCompletionService;
