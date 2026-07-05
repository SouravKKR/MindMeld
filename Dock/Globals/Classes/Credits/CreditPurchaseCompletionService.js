const CreditLedger = require("./CreditLedger");
const PendingCreditOrderQueryEngine = require("../Database/PendingCreditOrderQueryEngine");
const AuthenticationQueryEngine = require("../Database/AuthenticationQueryEngine");
const ZohoInvoiceService = require("../Invoicing/ZohoInvoiceService");
const { creditTransactionTypes } = require("../../Enumerations/CreditTransactionTypes");
const Logger = require("../Logger");
const LogTitles = require("../Logging/LogTitles");
const { logCategory } = require("../../Enumerations/LogCategory");

/**
 * CreditPurchaseCompletionService
 *
 * The ONE place a verified credit payment turns into credits. Called by both
 * VerifyCreditPurchase (buyer's browser) and the payment-provider webhook (Zoho
 * today; server to server), so the two paths cannot diverge — whichever arrives
 * first grants;
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

        // Invoice exactly once — only on the FIRST grant for this order (a
        // replay from the other path lands as alreadyApplied and must not
        // re-invoice). Best-effort: ZohoInvoiceService never throws, but the
        // user lookup might, so the whole block is guarded — a failure here
        // never affects the credits that were just granted.
        if (grantResult.applied === true && grantResult.alreadyApplied !== true)
        {
            await CreditPurchaseCompletionService.#generateInvoice(pendingCreditOrder, providerPaymentId);

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

        return {
            granted: grantResult.applied === true,
            alreadyProcessed: grantResult.alreadyApplied === true,
            creditsGranted: pendingCreditOrder.credits,
            balanceAfter: balanceAfter,
        };
    }

    static async #generateInvoice(pendingCreditOrder, providerPaymentId)
    {
        try
        {
            if (!ZohoInvoiceService.isEnabled())
            {
                return;
            }

            const user = await AuthenticationQueryEngine.getUserById(pendingCreditOrder.userId);
            const email = user ? (user.getAdditionalData()?.email || "") : "";
            if (!email)
            {
                return;
            }

            await ZohoInvoiceService.createPaidInvoice
            ({
                email: email,
                name: user.getDisplayName ? user.getDisplayName() : "",
                amountMinor: pendingCreditOrder.amountMinor,
                currency: pendingCreditOrder.currency,
                description: `${pendingCreditOrder.credits} MindMeld credits`,
                referenceNumber: providerPaymentId || pendingCreditOrder.providerOrderId
            });
        }
        catch (invoiceError)
        {
            console.warn(`[CreditPurchaseCompletionService] Invoice step failed for order ${pendingCreditOrder.providerOrderId} (non-fatal): ${invoiceError?.message || invoiceError}`);
        }
    }
}

module.exports = CreditPurchaseCompletionService;
