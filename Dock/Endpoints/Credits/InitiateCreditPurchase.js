const CreditConfigurationStore = require("../../Globals/Classes/Credits/CreditConfigurationStore");
const CreditPurchasePricingEngine = require("../../Globals/Classes/Credits/CreditPurchasePricingEngine");
const PaymentProviderFactory = require("../../Globals/Classes/Payments/PaymentProviderFactory");
const PaymentProvider = require("../../Globals/Classes/Payments/PaymentProvider");
const PendingCreditOrderQueryEngine = require("../../Globals/Classes/Database/PendingCreditOrderQueryEngine");
const RegionResolver = require("../../Globals/Classes/Pricing/RegionResolver");
const RegionMetadata = require("../../Globals/Classes/Pricing/RegionMetadata");
const CouponCheckoutService = require("../../Globals/Classes/Coupons/CouponCheckoutService");
const CouponQueryEngine = require("../../Globals/Classes/Database/CouponQueryEngine");
const CheckoutReceiptIdentifier = require("../../Globals/Classes/Payments/CheckoutReceiptIdentifier");
const { getUser } = require("../Helpers/GetUser");
const { paymentProviders } = require("../../Globals/Enumerations/PaymentProviders");
const { couponBenefitTargets } = require("../../Globals/Enumerations/CouponBenefitTargets");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

// Below this the payment provider will reject the order (100 minor units = the
// smallest chargeable amount). A discount that dips under it can't be taken.
const MINIMUM_CHARGE_MINOR_UNITS = 100;

/**
 * Answers a retried initiation with the order the first attempt already
 * created, rebuilding the browser checkout context from the stored row rather
 * than asking the provider for a second order.
 *
 * The quote is rebuilt from the ROW, not from the freshly computed pricing, so
 * what the buyer is shown is exactly what the existing order will charge. They
 * are equal by construction (the amount is an input to the receipt this row was
 * found by), and taking them from the row keeps that true even if a future
 * change loosens the lookup.
 */
function sendReusedOrder(response, provider, pendingCreditOrder, charge)
{
    const checkoutContext = provider.buildCheckoutContext(pendingCreditOrder);
    if (!checkoutContext)
    {
        return false;
    }

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        provider: provider.getProviderEnumValue(),
        order:
        {
            providerOrderId: pendingCreditOrder.providerOrderId,
            amountMinor: pendingCreditOrder.amountMinor,
            currency: pendingCreditOrder.currency,
            checkoutContext: checkoutContext
        },
        quote:
        {
            credits: pendingCreditOrder.credits,
            unitPrice: pendingCreditOrder.unitPrice,
            discountPercent: pendingCreditOrder.discountPercent,
            amountMinor: pendingCreditOrder.amountMinor,
            baseAmountMinor: charge.amountMinor,
            couponDiscountMinor: pendingCreditOrder.couponDiscountMinor,
            currency: pendingCreditOrder.currency,
            region: pendingCreditOrder.region,
            currencyConverted: charge.converted
        },
        reusedExistingOrder: true
    });
    return true;
}

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

    // Pack-only: the quantity must be one the catalogue actually sells. The
    // dialog offers nothing else, so a quantity outside the ladder means a
    // hand-made request — and honouring it would let a buyer pick a size that
    // was never priced or discounted deliberately.
    const bMatchesAConfiguredPack = configuration.getCreditPacks().some(pack => pack.getCredits() === credits);
    if (!bMatchesAConfiguredPack)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson
        ({
            error: ErrorCodes.CREDITS_NOT_A_VALID_PACK,
            availablePacks: configuration.getCreditPacks().map(pack => pack.getCredits())
        });
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

    // Resolved BEFORE the coupon is reserved, so an unconfigured provider is
    // refused without first burning a redemption — and so the retry lookups
    // below can rebuild a checkout context from an existing order.
    const providerEnum = typeof body?.paymentProvider === "number"
        ? body.paymentProvider
        : paymentProviders[String(body?.paymentProvider || "").toUpperCase()];

    const provider = providerEnum !== undefined
        ? PaymentProviderFactory.getProvider(providerEnum)
        : PaymentProviderFactory.getDefaultProvider();

    if (!provider.isConfigured())
    {
        response.statusCode = httpStatus.SERVICE_UNAVAILABLE;
        response.sendJson({ error: ErrorCodes.PAYMENT_PROVIDER_NOT_CONFIGURED });
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
        // A discount is once per user, so a retried checkout would be refused as
        // already-redeemed by its own first attempt — locking the buyer out of
        // the checkout they abandoned seconds earlier. Resolve the coupon
        // read-only first and hand back the existing unpaid order instead. This
        // cannot go through the receipt lookup below: the receipt is derived
        // from the discounted amount, which is not known until the coupon has
        // been resolved.
        const existingCoupon = await CouponQueryEngine.getByCodeString(rawCouponCode);
        if (existingCoupon)
        {
            const couponedOrder = await PendingCreditOrderQueryEngine.findReusableByCoupon(existingCoupon.getId(), session.getUserId());
            if (couponedOrder && sendReusedOrder(response, provider, couponedOrder, charge))
            {
                return;
            }
        }

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

    // Bound the amount before it leaves our control. `credits` is already
    // validated as a positive integer, but an extreme quantity multiplied by a
    // unit price still produces an amount no provider will accept — and the
    // pricing table itself could be misconfigured. Rejecting locally keeps a
    // reserved coupon from being burned on an order that cannot be created.
    if (!PaymentProvider.isChargeableAmount(finalAmountMinor))
    {
        if (appliedCouponId)
        {
            await CouponCheckoutService.release(appliedCouponId, session.getUserId());
        }
        console.warn(`[InitiateCreditPurchase] Refused an order outside the chargeable band for ${session.getUserId()}: ${finalAmountMinor} ${charge.currency}`);
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.AMOUNT_OUT_OF_RANGE });
        return;
    }

    // Derived from the buyer, the quantity, the amount, the currency and the
    // coupon — never from the clock. The old receipt embedded Date.now(), which
    // made two clicks on one purchase look like two unrelated orders.
    const receiptId = CheckoutReceiptIdentifier.forCreditPurchase
    ({
        userId: session.getUserId(),
        credits: credits,
        amountMinor: finalAmountMinor,
        currency: charge.currency,
        couponId: appliedCouponId
    });

    // A retry of an unpaid checkout reuses the order the first attempt created.
    // Safe without re-pricing: the amount and currency are inputs to the
    // receipt, so a row found here is provably for the same credits at the same
    // price. A couponed retry has already been handled above; releasing here is
    // belt-and-braces for a path that should be unreachable, because a coupon
    // that reaches this point would have produced a different receipt.
    const reusableOrder = await PendingCreditOrderQueryEngine.findReusableByReceipt(receiptId, session.getUserId());
    if (reusableOrder)
    {
        if (appliedCouponId && reusableOrder.couponId !== appliedCouponId)
        {
            await CouponCheckoutService.release(appliedCouponId, session.getUserId());
        }
        if (sendReusedOrder(response, provider, reusableOrder, charge))
        {
            return;
        }
    }

    // The local record is written BEFORE the provider is called.
    //
    // The old order was inverted: create the remote order, then write the row.
    // A crash in that window left a real Razorpay order the buyer could pay
    // against with no local record of who it belonged to or what it was for —
    // which surfaces later only as the captured-payment-with-no-local-order
    // alert, after someone has already been charged.
    //
    // Writing first is only possible now that the receipt is deterministic:
    // the row is keyed on the receipt, and the provider's order id is attached
    // once it comes back. A row whose providerOrderId is still blank is an
    // initiation that never completed, which is exactly the state worth being
    // able to see.
    await PendingCreditOrderQueryEngine.createPendingCreditOrder
    ({
        providerOrderId: receiptId,
        userId: session.getUserId(),
        credits: credits,
        amountMinor: finalAmountMinor,
        currency: charge.currency,
        region: region,
        unitPrice: charge.unitPrice,
        discountPercent: charge.discountPercent,
        paymentProvider: provider.getProviderEnumValue(),
        couponId: appliedCouponId,
        couponDiscountMinor: couponDiscountMinor,
        receiptId: receiptId
    });

    let order;
    try
    {
        order = await provider.initiateOrder
        (
            finalAmountMinor,
            charge.currency,
            {
                receiptId: receiptId,
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
        // No remote order exists, so the placeholder row describes nothing and
        // would otherwise be picked up by reconciliation as a stale pending
        // order forever.
        await PendingCreditOrderQueryEngine.deleteUnclaimedOrder(receiptId, session.getUserId());
        console.error(`[InitiateCreditPurchase] Order creation failed for ${session.getUserId()}: ${orderError?.message || orderError}`);
        response.statusCode = httpStatus.BAD_GATEWAY;
        response.sendJson({ error: ErrorCodes.EXCEPTION });
        return;
    }

    // Attach the provider's order id to the row written above. From here the
    // row is the trusted record that Verify and the webhook grant strictly
    // from, so a buyer cannot inflate the quantity after paying. The order
    // notes are advisory only.
    await PendingCreditOrderQueryEngine.attachProviderOrderId(receiptId, session.getUserId(), order.providerOrderId);

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
