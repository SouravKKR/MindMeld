const CreditLedger = require("./CreditLedger");
const PendingCreditOrderQueryEngine = require("../Database/PendingCreditOrderQueryEngine");
const { creditTransactionTypes } = require("../../Enumerations/CreditTransactionTypes");
const Logger = require("../Logger");
const LogTitles = require("../Logging/LogTitles");
const { logCategory } = require("../../Enumerations/LogCategory");
const NotificationDispatcher = require("../Notifications/NotificationDispatcher");
const NotificationContent = require("../Notifications/NotificationContent");
const { notificationChannels } = require("../../Enumerations/NotificationChannels");

/**
 * CreditPurchaseCompletionService
 *
 * The ONE place a verified credit payment turns into credits. Called by both
 * VerifyCreditPurchase (buyer's browser) and the Razorpay webhook (server to
 * server), so the two paths cannot diverge — whichever arrives first grants and
 * the other becomes an idempotent no-op.
 *
 * Idempotency layers, in order:
 *   1. CreditLedger.grant keyed on `creditPurchase:<providerOrderId>` — the
 *      unique referenceKey index in creditTransactions absorbs duplicates
 *      atomically (the balance is never touched twice).
 *   2. The pending order's atomic PENDING -> CONSUMED transition, which lets
 *      callers short-circuit replays before even attempting a grant.
 * Grant-then-consume ordering is safe because layer 1 is itself atomic; a
 * crash between the two steps leaves a CONSUMED-pending row behind, which the
 * next caller resolves through layer 1's alreadyApplied path.
 */
class CreditPurchaseCompletionService
{
    static REFERENCE_KEY_PREFIX = "creditPurchase:";

    static SOURCE_VERIFY = "VERIFY";
    static SOURCE_WEBHOOK = "WEBHOOK";

    static buildReferenceKey(providerOrderId)
    {
        return `${CreditPurchaseCompletionService.REFERENCE_KEY_PREFIX}${providerOrderId}`;
    }

    /**
     * Grants the pending order's credits to its owner and consumes the order.
     * Safe to call any number of times from any path.
     * @param {object} pendingCreditOrder — row from PendingCreditOrderQueryEngine
     * @param {{ providerPaymentId: string, source: string }} context
     * @returns {Promise<{ granted: boolean, alreadyProcessed: boolean, creditsGranted: number, balanceAfter: number|null }>}
     */
    static async complete(pendingCreditOrder, { providerPaymentId, source } = {})
    {
        const referenceKey = CreditPurchaseCompletionService.buildReferenceKey(pendingCreditOrder.providerOrderId);

        // The money for this order may already have gone back. A refund and a
        // capture are independent provider events, so "refunded before we
        // provisioned it" is an ordinary ordering rather than a pathological
        // one, and granting anyway would leave the buyer paid, refunded and
        // holding the credits. Required lazily to keep the settlement services
        // and the reversal service free of a require cycle.
        const PaymentReversalService = require("../Payments/PaymentReversalService");
        if (await PaymentReversalService.hasReversalForOrder(pendingCreditOrder.providerOrderId))
        {
            console.warn(`[CreditPurchaseCompletionService] Refusing to grant order ${pendingCreditOrder.providerOrderId} — it has already been reversed.`);
            await PendingCreditOrderQueryEngine.markConsumed(pendingCreditOrder.providerOrderId, pendingCreditOrder.userId);
            return { granted: false, alreadyProcessed: true, refusedAsReversed: true, creditsGranted: 0, balanceAfter: null };
        }

        const grantResult = await CreditLedger.grant
        (
            pendingCreditOrder.userId,
            pendingCreditOrder.credits,
            creditTransactionTypes.PURCHASE_GRANT,
            referenceKey,
            {
                providerOrderId: pendingCreditOrder.providerOrderId,
                providerPaymentId: providerPaymentId || "",
                amountMinor: pendingCreditOrder.amountMinor,
                currency: pendingCreditOrder.currency,
                region: pendingCreditOrder.region,
                unitPrice: pendingCreditOrder.unitPrice,
                discountPercent: pendingCreditOrder.discountPercent,
                source: source || "",
            }
        );

        if (grantResult.applied && grantResult.balanceAfter === null)
        {
            // The ledger inserted the transaction but found no user document
            // to credit (deleted account). Record it for triage; the payment
            // is still acked so the provider stops retrying.
            console.warn(`[CreditPurchaseCompletionService] Granted order ${pendingCreditOrder.providerOrderId} but user ${pendingCreditOrder.userId} was not found.`);
        }

        await PendingCreditOrderQueryEngine.markConsumed(pendingCreditOrder.providerOrderId, pendingCreditOrder.userId);

        // Log exactly once — only on the FIRST grant for this order (a replay
        // from the other path lands as alreadyApplied and must not re-log).
        //
        // No invoice is generated here. Invoicing is handled outside the
        // application and attached manually for the record, so settlement's job
        // ends at the ledger entry and the structured purchase log below, which
        // together carry everything an invoice would need: buyer, quantity,
        // amount, currency, provider references and timestamp.
        if (grantResult.applied === true && grantResult.alreadyApplied !== true)
        {
            Logger.info(logCategory.PURCHASE, LogTitles.PURCHASE_CREDITS, "Credits purchased",
            {
                accountId: pendingCreditOrder.userId,
                additionalData:
                {
                    credits: pendingCreditOrder.credits,
                    amountMinor: pendingCreditOrder.amountMinor,
                    currency: pendingCreditOrder.currency,
                    providerOrderId: pendingCreditOrder.providerOrderId,
                    providerPaymentId: providerPaymentId || "",
                    source: source || ""
                }
            });
        }

        const balanceAfter = grantResult.balanceAfter !== undefined && grantResult.balanceAfter !== null
            ? grantResult.balanceAfter
            : await CreditLedger.getBalance(pendingCreditOrder.userId);

        // Notify the buyer their credits landed — only on the FIRST grant for
        // this order (a replay lands as alreadyApplied). In-app + push; a
        // failure here never affects the credits just granted or the response.
        if (grantResult.applied === true && grantResult.alreadyApplied !== true)
        {
            try
            {
                await NotificationDispatcher.dispatch(pendingCreditOrder.userId, NotificationContent.creditTopUpComplete(pendingCreditOrder.credits, balanceAfter), notificationChannels.IN_APP | notificationChannels.PUSH);
            }
            catch (notifyError)
            {
                console.warn(`[CreditPurchaseCompletionService] Failed to dispatch top-up notification for ${pendingCreditOrder.userId}: ${notifyError.message}`);
            }
        }

        return {
            granted: grantResult.applied === true,
            alreadyProcessed: grantResult.alreadyApplied === true,
            creditsGranted: pendingCreditOrder.credits,
            balanceAfter: balanceAfter,
        };
    }

}

module.exports = CreditPurchaseCompletionService;
