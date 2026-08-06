const CreditDealPaymentQueryEngine = require("../../../Globals/Classes/Credits/CreditDealPaymentQueryEngine");
const OrganizationQueryEngine = require("../../../Globals/Classes/Organization/OrganizationQueryEngine");
const OrganizationCreditLedger = require("../../../Globals/Classes/Organization/OrganizationCreditLedger");
const PaymentProviderFactory = require("../../../Globals/Classes/Payments/PaymentProviderFactory");
const PaymentProvider = require("../../../Globals/Classes/Payments/PaymentProvider");
const CheckoutReceiptIdentifier = require("../../../Globals/Classes/Payments/CheckoutReceiptIdentifier");
const CreditDealPayment = require("../../../Globals/Model/CreditDealPayment");
const { creditDealTargetTypes } = require("../../../Globals/Enumerations/CreditDealTargetTypes");
const { creditDealPaymentModes } = require("../../../Globals/Enumerations/CreditDealPaymentModes");
const { creditDealPaymentStatuses } = require("../../../Globals/Enumerations/CreditDealPaymentStatuses");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");


/**
 * POST /Admin/Credits/Deals/CreateForOrganization  (super-admin)
 *
 * Sells an organization a block of credits at a negotiated price, and sets the
 * contract term that block belongs to.
 *
 * The price is OURS to set, which is why this is a super-admin route and not
 * something the organization does for itself: the amount is whatever was agreed
 * commercially, not a published rate. The organization admin then pays it from
 * their own credits screen.
 *
 * Two modes, the same two every credit deal has:
 *
 *   INDEPENDENT       — already paid offline (a bank transfer, a purchase
 *                       order). Recorded as settled, and the credits land in
 *                       the pool immediately.
 *   ON_SPOT_RAZORPAY  — the organization admin pays in-app. Nothing reaches the
 *                       pool until the payment is captured, by their browser or
 *                       by the webhook, whichever arrives first.
 *
 * Body: { organizationId, credits, amountMinor, currency?, mode, termEndsAt?, label? }
 */
async function createOrganizationCreditDeal(request, response)
{
    const body = await request.getBody();
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";
    const credits = Number(body?.credits);
    const amountMinor = Number.isInteger(body?.amountMinor) ? body.amountMinor : -1;
    const currency = typeof body?.currency === "string" && body.currency.length > 0 ? body.currency.toUpperCase() : "INR";
    const mode = body?.mode;
    const termEndsAtValue = typeof body?.termEndsAt === "string" ? body.termEndsAt : "";

    const organization = await OrganizationQueryEngine.getOrganizationById(organizationId);
    if (!organization)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ success: false, error: ErrorCodes.ORG_NOT_FOUND });
        return;
    }

    if (!Number.isFinite(credits) || credits <= 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.INVALID_AMOUNT });
        return;
    }

    // An offline deal may legitimately record any non-negative figure — it is
    // bookkeeping for money that has already moved elsewhere. An on-spot one is
    // about to become a real provider order, so it must clear the same
    // chargeable band every buyer-facing endpoint enforces; that check lives
    // below, once the mode is known.
    if (amountMinor < 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.INVALID_AMOUNT });
        return;
    }

    if (mode !== creditDealPaymentModes.INDEPENDENT && mode !== creditDealPaymentModes.ON_SPOT_RAZORPAY)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.INVALID_REQUEST });
        return;
    }

    const termEndsAt = termEndsAtValue.length > 0 ? new Date(termEndsAtValue) : null;
    if (termEndsAt !== null && isNaN(termEndsAt.getTime()))
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.INVALID_REQUEST });
        return;
    }

    const bIsOnSpot = mode === creditDealPaymentModes.ON_SPOT_RAZORPAY;
    const termEndsAtIsoString = termEndsAt !== null ? termEndsAt.toISOString() : "";

    let provider = null;
    let receiptId = "";

    if (bIsOnSpot)
    {
        // The same band every buyer-facing endpoint enforces. Without it a zero
        // or sub-minimum amount left this server and was refused remotely, which
        // costs the ability to report the reason cleanly and leaves a deal row
        // behind describing an order that does not exist.
        if (!PaymentProvider.isChargeableAmount(amountMinor))
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ success: false, error: ErrorCodes.AMOUNT_OUT_OF_RANGE });
            return;
        }

        provider = PaymentProviderFactory.getDefaultProvider();
        if (!provider.isConfigured())
        {
            response.statusCode = httpStatus.SERVICE_UNAVAILABLE;
            response.sendJson({ success: false, error: ErrorCodes.PAYMENT_PROVIDER_NOT_CONFIGURED });
            return;
        }

        // Derived from the organization, the block, the price, the currency and
        // the contract term — never from the clock. The receipt used to embed
        // Date.now(), so two submissions of one negotiated deal produced two
        // unrelated Razorpay orders with nothing to say they were the same
        // intent: the institute sees one agreement and the dashboard shows two.
        receiptId = CheckoutReceiptIdentifier.forOrganizationCreditDeal
        ({
            organizationId: organizationId,
            credits: credits,
            amountMinor: amountMinor,
            currency: currency,
            termEndsAt: termEndsAtIsoString
        });

        // A resubmission of the same deal is handed the order the first attempt
        // already created. Safe without re-checking anything: the price and the
        // term are inputs to the receipt, so a row found here is provably the
        // same agreement — and if either moved, the receipt moved with it and
        // this misses.
        const reusableDeal = await CreditDealPaymentQueryEngine.findReusableByReceipt(receiptId);
        if (reusableDeal)
        {
            const reusedCheckoutContext = provider.buildCheckoutContext
            ({
                providerOrderId: reusableDeal.getProviderOrderId(),
                amountMinor: reusableDeal.getAmountMinor(),
                currency: reusableDeal.getCurrency()
            });

            if (reusedCheckoutContext)
            {
                response.statusCode = httpStatus.OK;
                response.sendJson
                ({
                    success: true,
                    dealId: reusableDeal.getId(),
                    requiresPayment: true,
                    provider: reusableDeal.getPaymentProvider(),
                    order:
                    {
                        providerOrderId: reusableDeal.getProviderOrderId(),
                        amountMinor: reusableDeal.getAmountMinor(),
                        currency: reusableDeal.getCurrency(),
                        checkoutContext: reusedCheckoutContext
                    },
                    reusedExistingOrder: true
                });
                return;
            }
        }
    }

    const deal = new CreditDealPayment
    ({
        targetType: creditDealTargetTypes.ORGANIZATION_CREDIT_POOL,
        targetId: organizationId,
        label: typeof body?.label === "string" && body.label.length > 0 ? body.label.slice(0, 256) : `${credits} credits for ${organization.getName()}`,
        mode: mode,
        status: bIsOnSpot ? creditDealPaymentStatuses.PENDING : creditDealPaymentStatuses.RECORDED,
        amountMinor: amountMinor,
        currency: currency,
        // An offline deal has no provider; the model's default stands rather
        // than naming one that was never involved.
        paymentProvider: bIsOnSpot ? provider.getProviderEnumValue() : undefined,
        // The receipt stands in for the order id until the remote order exists —
        // see the note below on why the row is written first.
        providerOrderId: bIsOnSpot ? receiptId : "",
        providerPaymentId: "",
        createdByUserId: request.user?.getId() || "",
        createdAt: new Date(),
        additionalData:
        {
            credits: credits,
            termEndsAt: termEndsAtIsoString,
            receiptId: receiptId
        }
    });

    // The local record is written BEFORE the provider is called.
    //
    // The old order was inverted: create the remote order, then write the deal.
    // A crash in that window left a real Razorpay order an organization admin
    // could pay against, with no local record of who it belonged to or what it
    // bought — surfacing only as the captured-payment-with-no-local-order alert,
    // after the institute had already been charged. This mirrors what the credit
    // and paid-deck initiation endpoints already do, and is only possible now
    // that the receipt is deterministic enough to key the row by.
    await CreditDealPaymentQueryEngine.createDeal(deal);

    let order = null;
    if (bIsOnSpot)
    {
        try
        {
            order = await provider.initiateOrder
            (
                amountMinor,
                currency,
                {
                    receiptId: receiptId,
                    notes: { organizationId: organizationId, credits: String(credits) }
                }
            );
        }
        catch (orderError)
        {
            // No remote order exists, so the row above describes nothing and
            // would otherwise be swept by reconciliation forever.
            await CreditDealPaymentQueryEngine.deleteUnclaimedDeal(receiptId);
            // The provider's own error text stays server-side. An administrator
            // is a trusted audience, but provider internals crossing the
            // boundary is still provider internals crossing the boundary — and
            // every other initiation endpoint already does this correctly, so
            // the inconsistency was the defect.
            console.error(`[CreateOrganizationCreditDeal] Order creation failed for organization ${organizationId}: ${orderError?.message || orderError}`);
            response.statusCode = httpStatus.BAD_GATEWAY;
            response.sendJson({ success: false, error: ErrorCodes.EXCEPTION });
            return;
        }

        // Attach the provider's order id to the row written above. From here the
        // row is the trusted record that the verify leg, the webhook and the
        // reconciler all settle strictly from.
        await CreditDealPaymentQueryEngine.attachProviderOrderId(receiptId, order.providerOrderId);
        deal.setProviderOrderId(order.providerOrderId);
    }

    // An offline payment has already happened, so the credits are available at
    // once. An in-app one waits for capture — nothing reaches the pool on the
    // strength of an order being created.
    if (!bIsOnSpot)
    {
        await OrganizationCreditLedger.credit
        (
            organizationId,
            credits,
            OrganizationCreditLedger.TRANSACTION_TYPE_PURCHASE,
            `orgDeal:${deal.getId()}`,
            { dealId: deal.getId(), mode: "INDEPENDENT", amountMinor: amountMinor, currency: currency }
        );

        if (termEndsAt !== null)
        {
            await OrganizationQueryEngine.setTermEndsAt(organizationId, termEndsAt);
            await OrganizationQueryEngine.clearAnnouncedTermThresholds(organizationId);
        }
        await OrganizationCreditLedger.setFrozen(organizationId, false);
    }

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        dealId: deal.getId(),
        requiresPayment: bIsOnSpot,
        provider: bIsOnSpot ? provider.getProviderEnumValue() : null,
        order: order
    });
}

module.exports = { createOrganizationCreditDeal };
