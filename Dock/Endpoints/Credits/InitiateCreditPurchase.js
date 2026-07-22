const CreditConfigurationStore = require("../../Globals/Classes/Credits/CreditConfigurationStore");
const CreditPurchasePricingEngine = require("../../Globals/Classes/Credits/CreditPurchasePricingEngine");
const PaymentProviderFactory = require("../../Globals/Classes/Payments/PaymentProviderFactory");
const PendingCreditOrderQueryEngine = require("../../Globals/Classes/Database/PendingCreditOrderQueryEngine");
const RegionResolver = require("../../Globals/Classes/Pricing/RegionResolver");
const RegionMetadata = require("../../Globals/Classes/Pricing/RegionMetadata");
const CouponCheckoutService = require("../../Globals/Classes/Coupons/CouponCheckoutService");
const { getUser } = require("../Helpers/GetUser");
const { paymentProviders } = require("../../Globals/Enumerations/PaymentProviders");
const { couponBenefitTargets } = require("../../Globals/Enumerations/CouponBenefitTargets");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

// Below this the payment provider will reject the order (100 minor units = the
// smallest chargeable amount). A discount that dips under it can't be taken.
const MINIMUM_CHARGE_MINOR_UNITS = 100;

/**
 * POST /Credits/Purchase/Initiate
 *
 * Creates a payment-provider order for an integer credit quantity. The
 * client sends ONLY the quantity (plus optional region hints) — the amount
 * is computed server-side by CreditPurchasePricingEngine and bound to the
 * order in a pendingCreditOrders row, which Verify and the webhook later
 * read back as the sole trusted record of what was bought.
 *
 * Body: { credits, region?, localeRegionHint?, paymentProvider? }
 */
async function initiateCreditPurchase(request, response)
{
    const session = request.session;

    if (!session)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    const body = await request.getBody();
    const credits = body?.credits;

    if (!Number.isInteger(credits) || credits < 1)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_CREDIT_QUANTITY });
        return;
    }

    const configuration = await CreditConfigurationStore.load();

    if (!configuration.getBaseCreditPriceEntry())
    {
        response.statusCode = httpStatus.SERVICE_UNAVAILABLE;
        response.sendJson({ error: ErrorCodes.CREDIT_PRICING_NOT_CONFIGURED });
        return;
    }

    if (credits < configuration.getMinimumPurchaseCredits())
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.BELOW_MINIMUM_PURCHASE, minimumPurchaseCredits: configuration.getMinimumPurchaseCredits() });
        return;
    }

    // Same resolution cascade the storefront uses (manual pick ->
    // CF-IPCountry -> locale hint -> default), so the buyer is charged in
    // exactly the currency the dialog showed.
    const region = RegionResolver.resolveRegion
    (
        request,
        (body?.region || "").toUpperCase() || null,
        (body?.localeRegionHint || "").toUpperCase() || null
    );
    const buyerCurrency = RegionMetadata.getDisplayCurrency(region);

    const charge = await CreditPurchasePricingEngine.computeChargeForCredits(configuration, buyerCurrency, credits);

    if (!charge.available)
    {
        response.statusCode = httpStatus.SERVICE_UNAVAILABLE;
        response.sendJson({ error: ErrorCodes.CREDIT_PRICING_NOT_CONFIGURED });
        return;
    }

    if (charge.belowProviderMinimum)
    {
        const options = await CreditPurchasePricingEngine.computeOptions(configuration, region);
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson
        ({
            error: ErrorCodes.AMOUNT_BELOW_PROVIDER_MINIMUM,
            minimumCreditsForCharge: options.available ? options.minimumCreditsForCharge : configuration.getMinimumPurchaseCredits(),
        });
        return;
    }

    // Optional discount coupon (CREDIT_PURCHASE_DISCOUNT). Reserved with the
    // same three guards as a standalone redemption; released below if the order
    // cannot be created so an unlaunched checkout does not burn the user's use.
    let finalAmountMinor = charge.amountMinor;
    let appliedCouponId = null;
    let couponDiscountMinor = 0;
    const rawCouponCode = typeof body?.couponCode === "string" ? body.couponCode.trim() : "";
    if (rawCouponCode.length > 0)
    {
        const buyer = await getUser(request);
        const buyerEmail = buyer?.getAdditionalData()?.email || "";
        const couponResult = await CouponCheckoutService.resolveAndReserve
        (
            session.getUserId(),
            buyerEmail,
            rawCouponCode,
            charge.amountMinor,
            couponBenefitTargets.CREDIT_PURCHASE_DISCOUNT,
            Date.now()
        );
        if (!couponResult.ok)
        {
            response.statusCode = couponResult.statusCode;
            response.sendJson({ error: couponResult.reason });
            return;
        }
        appliedCouponId = couponResult.coupon.getId();
        couponDiscountMinor = couponResult.discountMinor;
        finalAmountMinor = couponResult.discountedMinor;

        // A discount that drops the charge below the provider minimum cannot be
        // taken as a payment — release the reservation and reject.
        if (finalAmountMinor < MINIMUM_CHARGE_MINOR_UNITS)
        {
            await CouponCheckoutService.release(appliedCouponId, session.getUserId());
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ error: ErrorCodes.AMOUNT_BELOW_PROVIDER_MINIMUM });
            return;
        }
    }

    const providerEnum = typeof body?.paymentProvider === "number"
        ? body.paymentProvider
        : paymentProviders[String(body?.paymentProvider || "").toUpperCase()];

    const provider = providerEnum !== undefined
        ? PaymentProviderFactory.getProvider(providerEnum)
        : PaymentProviderFactory.getDefaultProvider();

    if (!provider.isConfigured())
    {
        if (appliedCouponId)
        {
            await CouponCheckoutService.release(appliedCouponId, session.getUserId());
        }
        response.statusCode = httpStatus.SERVICE_UNAVAILABLE;
        response.sendJson({ error: ErrorCodes.PAYMENT_PROVIDER_NOT_CONFIGURED });
        return;
    }

    let order;
    try
    {
        order = await provider.initiateOrder
        (
            finalAmountMinor,
            charge.currency,
            {
                receiptId: `mm_credits_${session.getUserId().slice(0, 8)}_${Date.now()}`,
                notes:
                {
                    userId: session.getUserId(),
                    purpose: "CREDIT_PURCHASE",
                    credits: String(credits)
                }
            }
        );
    }
    catch (orderError)
    {
        if (appliedCouponId)
        {
            await CouponCheckoutService.release(appliedCouponId, session.getUserId());
        }
        console.error(`[InitiateCreditPurchase] Order creation failed for ${session.getUserId()}: ${orderError?.message || orderError}`);
        response.statusCode = httpStatus.BAD_GATEWAY;
        response.sendJson({ error: ErrorCodes.EXCEPTION });
        return;
    }

    // Bind the provider order to the buyer + the exact quantity + the
    // server-priced (post-discount) amount. Verify and the webhook grant
    // strictly from this row, so a buyer cannot inflate the quantity after
    // paying. The order notes above are advisory only — this row is trusted.
    await PendingCreditOrderQueryEngine.createPendingCreditOrder
    ({
        providerOrderId: order.providerOrderId,
        userId: session.getUserId(),
        credits: credits,
        amountMinor: finalAmountMinor,
        currency: charge.currency,
        region: region,
        unitPrice: charge.unitPrice,
        discountPercent: charge.discountPercent,
        paymentProvider: provider.getProviderEnumValue(),
        couponId: appliedCouponId,
        couponDiscountMinor: couponDiscountMinor
    });

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        provider: provider.getProviderEnumValue(),
        order: order,
        quote:
        {
            credits: credits,
            unitPrice: charge.unitPrice,
            discountPercent: charge.discountPercent,
            amountMinor: finalAmountMinor,
            baseAmountMinor: charge.amountMinor,
            couponDiscountMinor: couponDiscountMinor,
            currency: charge.currency,
            region: region,
            currencyConverted: charge.converted
        }
    });
}

module.exports = { initiateCreditPurchase };
