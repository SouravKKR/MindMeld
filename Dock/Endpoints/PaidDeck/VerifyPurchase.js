const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const PaymentProviderFactory = require("../../Globals/Classes/Payments/PaymentProviderFactory");
const RegionResolver = require("../../Globals/Classes/Pricing/RegionResolver");
const PendingOrderQueryEngine = require("../../Globals/Classes/Database/PendingOrderQueryEngine");
const PaidDeckPurchaseCompletionService = require("./PaidDeckPurchaseCompletionService");
const { checkUserHasPaidDeckPassword } = require("./PaidDeckGrantHelpers");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

/**
 * POST /PaidDecks/Purchase/Verify
 *
 * The buyer's browser leg of a paid-deck checkout: authenticate the caller,
 * confirm the provider signature, then hand the settlement to
 * PaidDeckPurchaseCompletionService — the same code the provider webhook runs,
 * so a buyer who closes the tab mid-verify still receives their decks.
 */
async function verifyPurchase(request, response)
{
    const session = request.session;

    if (!session)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    const body = await request.getBody();
    // Only the payment-identifying fields are trusted from the client. The
    // decks being granted, their amounts, region and currency are NEVER taken
    // from the body — they come from the server-side pending-order row created
    // at InitiatePurchase. This closes the bypass where a buyer pays for a
    // cheap/free deck then claims licenses for arbitrary expensive decks.
    // paymentProvider is intentionally NOT read from the client — the verifier
    // is resolved from the trusted server-side pending-order row below.
    const { providerOrderId, providerPaymentId, signature } = body || {};

    if (!providerOrderId || !providerPaymentId || !signature)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_FIELDS });
        return;
    }

    // Resolve the server's binding for this order and assert it belongs to the
    // authenticated buyer before doing anything else.
    const pendingOrder = await PendingOrderQueryEngine.getByOrderId(providerOrderId);
    if (!pendingOrder)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.ORDER_NOT_FOUND });
        return;
    }

    if (pendingOrder.userId !== session.getUserId())
    {
        response.statusCode = httpStatus.FORBIDDEN;
        response.sendJson({ error: ErrorCodes.ORDER_OWNER_MISMATCH });
        return;
    }

    // Resolve the provider that actually created this order from the trusted
    // pending row (falls back to the configured default for legacy rows).
    const storedProvider = pendingOrder.paymentProvider;
    const provider = storedProvider !== null && storedProvider !== undefined
        ? PaymentProviderFactory.getProvider(storedProvider)
        : PaymentProviderFactory.getDefaultProvider();
    const verification = await provider.verifyPayment({ providerOrderId, providerPaymentId, signature });

    if (!verification.verified)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.PAYMENT_NOT_VERIFIED, reason: verification.reason });
        return;
    }

    const database = await DatabaseConnector.getDatabase();
    const hasExistingPaidDeckPassword = await checkUserHasPaidDeckPassword(database, session.getUserId());

    // Replay guard: a verified payment grants exactly once. A duplicate /
    // replayed verify (provider retries, double-clicks) short-circuits to an
    // idempotent success rather than re-granting. The completion service holds
    // the same guard atomically — this is only the cheap early exit.
    if (pendingOrder.status === PendingOrderQueryEngine.STATUS_CONSUMED)
    {
        response.statusCode = httpStatus.OK;
        response.sendJson
        ({
            success: true,
            alreadyProcessed: true,
            licenses: [],
            requiresPasswordSetup: !hasExistingPaidDeckPassword
        });
        return;
    }

    // Settle through the shared service. The region fallback preserves the
    // browser leg's behaviour for legacy rows that carry no stored region; the
    // webhook, which has no request to resolve from, falls back to the default.
    const completion = await PaidDeckPurchaseCompletionService.complete
    (
        pendingOrder,
        {
            providerPaymentId: providerPaymentId,
            paymentProvider: provider.getProviderEnumValue(),
            source: PaidDeckPurchaseCompletionService.SOURCE_VERIFY,
            fallbackRegion: RegionResolver.resolveRegion(request, null, null)
        }
    );

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        alreadyProcessed: completion.alreadyProcessed,
        licenses: completion.licenses,
        requiresPasswordSetup: !hasExistingPaidDeckPassword
    });
}

module.exports = { verifyPurchase };
