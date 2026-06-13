const PaymentProviderFactory = require("../../Globals/Classes/Payments/PaymentProviderFactory");
const PendingCreditOrderQueryEngine = require("../../Globals/Classes/Database/PendingCreditOrderQueryEngine");
const CreditPurchaseCompletionService = require("../../Globals/Classes/Credits/CreditPurchaseCompletionService");
const CreditLedger = require("../../Globals/Classes/Credits/CreditLedger");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

/**
 * POST /Credits/Purchase/Verify
 *
 * Completes a credit purchase after Razorpay checkout. Only the
 * payment-identifying fields are trusted from the client — the credit
 * quantity and amount come from the server-side pendingCreditOrders row
 * created at initiation. The grant itself is idempotent (referenceKey
 * `creditPurchase:<providerOrderId>`), so replays, double-clicks and races
 * with the webhook all settle on exactly one grant.
 *
 * Body: { providerOrderId, providerPaymentId, signature, paymentProvider }
 */
async function verifyCreditPurchase(request, response)
{
    const session = request.session;

    if (!session)
    {
        response.sendStatusCode(401);
        return;
    }

    const body = await request.getBody();
    const { providerOrderId, providerPaymentId, signature, paymentProvider } = body || {};

    if (!providerOrderId || !providerPaymentId || !signature)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "MISSING_FIELDS" });
        return;
    }

    // Resolve the server's binding for this order and assert it belongs to
    // the authenticated buyer before doing anything else.
    const pendingCreditOrder = await PendingCreditOrderQueryEngine.getByOrderId(providerOrderId);
    if (!pendingCreditOrder)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "ORDER_NOT_FOUND" });
        return;
    }

    if (pendingCreditOrder.userId !== session.getUserId())
    {
        response.statusCode = httpStatus.FORBIDDEN;
        response.sendJson({ error: "ORDER_OWNER_MISMATCH" });
        return;
    }

    const provider = PaymentProviderFactory.getProvider(paymentProvider);
    const verification = await provider.verifyPayment({ providerOrderId, providerPaymentId, signature });

    if (!verification.verified)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "PAYMENT_NOT_VERIFIED", reason: verification.reason });
        return;
    }

    // Replay guard: the webhook (or an earlier verify) may have landed first.
    if (pendingCreditOrder.status === PendingCreditOrderQueryEngine.STATUS_CONSUMED)
    {
        response.statusCode = httpStatus.OK;
        response.sendJson
        ({
            success: true,
            alreadyProcessed: true,
            creditsGranted: pendingCreditOrder.credits,
            balance: await CreditLedger.getBalance(session.getUserId())
        });
        return;
    }

    const completion = await CreditPurchaseCompletionService.complete
    (
        pendingCreditOrder,
        { providerPaymentId: providerPaymentId, source: CreditPurchaseCompletionService.SOURCE_VERIFY }
    );

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        alreadyProcessed: completion.alreadyProcessed,
        creditsGranted: completion.creditsGranted,
        balance: completion.balanceAfter
    });
}

module.exports = { verifyCreditPurchase };
