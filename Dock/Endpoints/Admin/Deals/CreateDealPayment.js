const CreditDealPaymentQueryEngine = require("../../../Globals/Classes/Credits/CreditDealPaymentQueryEngine");
const PeriodicAssignmentQueryEngine = require("../../../Globals/Classes/Credits/PeriodicAssignmentQueryEngine");
const PaymentProviderFactory = require("../../../Globals/Classes/Payments/PaymentProviderFactory");
const CreditDealPayment = require("../../../Globals/Model/CreditDealPayment");
const { creditDealTargetTypes } = require("../../../Globals/Enumerations/CreditDealTargetTypes");
const { creditDealPaymentModes } = require("../../../Globals/Enumerations/CreditDealPaymentModes");
const { creditDealPaymentStatuses } = require("../../../Globals/Enumerations/CreditDealPaymentStatuses");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");

/**
 * POST /Admin/Credits/Deals/Create
 *
 * Records the money behind a deal — attachable to a periodic assignment OR a
 * one-time fixed grant. This is bookkeeping only and NEVER gates the
 * assignment / grant. Two modes:
 *
 *   INDEPENDENT       — an offline payment; status RECORDED immediately. An
 *                       invoice file can be uploaded now or later.
 *   ON_SPOT_RAZORPAY  — opens an in-page Razorpay order; status PENDING until
 *                       captured (client verify or webhook). Returns the
 *                       checkout context for window.Razorpay.
 *
 * Body: { targetType, targetId, label?, mode, amountMinor?, currency? }
 */
async function createDealPayment(request, response)
{
    const body = await request.getBody();
    if (!body || typeof body !== "object")
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_BODY });
        return;
    }

    const targetType = body.targetType;
    const targetId = typeof body.targetId === "string" ? body.targetId : "";
    if ((targetType !== creditDealTargetTypes.PERIODIC_ASSIGNMENT && targetType !== creditDealTargetTypes.FIXED_GRANT) || targetId.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_REQUEST });
        return;
    }

    // For periodic targets, confirm the assignment exists (fixed-grant targets
    // are keyed by grantKey, which has no standalone record to check).
    if (targetType === creditDealTargetTypes.PERIODIC_ASSIGNMENT)
    {
        const assignment = await PeriodicAssignmentQueryEngine.getById(targetId);
        if (!assignment)
        {
            response.statusCode = httpStatus.NOT_FOUND;
            response.sendJson({ error: ErrorCodes.ASSIGNMENT_NOT_FOUND });
            return;
        }
    }

    const mode = body.mode;
    if (!Object.values(creditDealPaymentModes).includes(mode))
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.UNSUPPORTED_MODE });
        return;
    }

    const label = typeof body.label === "string" ? body.label.trim().slice(0, 256) : "";
    const currency = typeof body.currency === "string" && body.currency.trim().length > 0 ? body.currency.trim().toUpperCase() : "INR";
    const amountMinor = Number.isInteger(body.amountMinor) ? body.amountMinor : Math.round(parseFloat(body.amountMinor) || 0);

    const deal = new CreditDealPayment
    ({
        targetType: targetType,
        targetId: targetId,
        label: label,
        mode: mode,
        currency: currency,
        amountMinor: amountMinor >= 0 ? amountMinor : 0,
        createdByUserId: request.user ? request.user.getId() : "",
        createdAt: new Date()
    });

    let checkoutContext = null;
    let onSpotProviderEnum = null;

    if (mode === creditDealPaymentModes.ON_SPOT_RAZORPAY)
    {
        if (!(amountMinor > 0))
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ error: ErrorCodes.INVALID_AMOUNT });
            return;
        }

        // Provider-agnostic: the on-spot order is created with the configured
        // default provider (Razorpay today). The provider that actually created
        // the order is persisted on the deal so VerifyPayment + the webhook
        // verify against the SAME provider, and returned to the client so it
        // opens the matching checkout widget.
        const provider = PaymentProviderFactory.getDefaultProvider();
        if (!provider.isConfigured())
        {
            response.statusCode = httpStatus.SERVICE_UNAVAILABLE;
            response.sendJson({ error: ErrorCodes.PAYMENT_PROVIDER_NOT_CONFIGURED });
            return;
        }

        let order;
        try
        {
            order = await provider.initiateOrder(amountMinor, currency, { receiptId: `deal_${deal.getId()}`, description: label || "CogniumLearn credit deal", notes: { dealId: deal.getId(), targetType: String(targetType), targetId: targetId } });
        }
        catch (orderError)
        {
            console.error(`[CreateDealPayment] On-spot order creation failed: ${orderError?.message || orderError}`);
            response.statusCode = httpStatus.BAD_GATEWAY;
            response.sendJson({ error: ErrorCodes.PAYMENT_NOT_VERIFIED, reason: orderError?.message });
            return;
        }

        deal.setPaymentProvider(provider.getProviderEnumValue());
        deal.setProviderOrderId(order.providerOrderId);
        deal.setStatus(creditDealPaymentStatuses.PENDING);
        checkoutContext = order.checkoutContext;
        onSpotProviderEnum = provider.getProviderEnumValue();
    }
    else if (mode === creditDealPaymentModes.INDEPENDENT)
    {
        deal.setStatus(creditDealPaymentStatuses.RECORDED);
    }
    else
    {
        deal.setStatus(creditDealPaymentStatuses.NONE);
    }

    await CreditDealPaymentQueryEngine.createDeal(deal);

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, deal: deal.toJson(), checkoutContext: checkoutContext, provider: onSpotProviderEnum });
}

module.exports = { createDealPayment };
