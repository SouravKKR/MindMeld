const PaymentProviderFactory = require("../../Globals/Classes/Payments/PaymentProviderFactory");
const OrganizationQueryEngine = require("../../Globals/Classes/Organization/OrganizationQueryEngine");
const OrganizationPaymentQueryEngine = require("../../Globals/Classes/Organization/OrganizationPaymentQueryEngine");
const OrgAdminVerificationManager = require("../../Globals/Classes/Authentication/OrgAdminVerificationManager");
const PendingCreditOrderQueryEngine = require("../../Globals/Classes/Database/PendingCreditOrderQueryEngine");
const CreditPurchaseCompletionService = require("../../Globals/Classes/Credits/CreditPurchaseCompletionService");
const CreditDealPaymentQueryEngine = require("../../Globals/Classes/Credits/CreditDealPaymentQueryEngine");
const SubscriptionWebhookProcessor = require("../../Globals/Classes/Plans/SubscriptionWebhookProcessor");
const { paymentProviders } = require("../../Globals/Enumerations/PaymentProviders");
const { organizationStatus } = require("../../Globals/Enumerations/OrganizationStatus");
const { organizationPaymentKinds } = require("../../Globals/Enumerations/OrganizationPaymentKinds");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");


/**
 * Razorpay webhook handler — UNAUTHED (signed by Razorpay via HMAC of
 * the raw request body). Registered with PLAIN_TEXT_BODY so we can run
 * the HMAC over the exact bytes Razorpay signed instead of a re-
 * serialised JSON.
 *
 * Completes two payment flows: organization payments (creation /
 * expansion) and credit purchases. Credit purchases are ALSO completed
 * by /Credits/Purchase/Verify from the buyer's browser — this webhook
 * is the safety net for buyers who pay and then close the tab before
 * Verify runs. Both paths share CreditPurchaseCompletionService, whose
 * referenceKey idempotency guarantees exactly one grant regardless of
 * which arrives first. (Paid-deck purchases remain verify-only by
 * design and fall through to PAYMENT_ROW_NOT_FOUND here.)
 *
 * Idempotent on providerOrderId — repeat deliveries (Razorpay retries
 * each event up to ~5 times) match the unique index on
 * organizationPayments.providerOrderId and short-circuit at the
 * "already CAPTURED" check inside OrganizationPaymentQueryEngine; the
 * credit branch short-circuits on the CONSUMED status / duplicate
 * referenceKey.
 *
 * Acks 200 even on benign errors (signature mismatch, unknown order)
 * — returning a 4xx would cause Razorpay to keep retrying. We log
 * those at the console for the admin to triage.
 */
async function handleRazorpayWebhook(request, response)
{
    const rawBody = await request.getBody();
    const signature = request.headers["x-razorpay-signature"];

    if (typeof rawBody !== "string" || rawBody.length === 0)
    {
        response.statusCode = httpStatus.OK;
        response.sendJson({ acknowledged: true, reason: ErrorCodes.EMPTY_BODY });
        return;
    }

    const provider = PaymentProviderFactory.getProvider(paymentProviders.RAZORPAY);
    const verification = provider.verifyWebhookSignature(rawBody, signature);
    if (!verification.verified)
    {
        console.warn(`[HandleRazorpayWebhook] Signature verification failed: ${verification.reason}`);
        response.statusCode = httpStatus.OK;
        response.sendJson({ acknowledged: true, reason: ErrorCodes.INVALID_SIGNATURE });
        return;
    }

    let payload = null;
    try
    {
        payload = JSON.parse(rawBody);
    }
    catch (parseError)
    {
        console.warn(`[HandleRazorpayWebhook] Failed to parse JSON body: ${parseError.message}`);
        response.statusCode = httpStatus.OK;
        response.sendJson({ acknowledged: true, reason: ErrorCodes.INVALID_BODY });
        return;
    }

    const eventName = typeof payload?.event === "string" ? payload.event : "";

    // Subscription lifecycle events (auto-debit recurring plans). Delegated to
    // the processor, which drives credit grants + entitlement via
    // PlanSubscriptionService. Ack 200 regardless so Razorpay stops retrying.
    if (SubscriptionWebhookProcessor.isSubscriptionEvent(eventName))
    {
        try
        {
            const subscriptionResult = await SubscriptionWebhookProcessor.process(eventName, payload);
            response.statusCode = httpStatus.OK;
            response.sendJson({ acknowledged: true, event: eventName, ...subscriptionResult });
        }
        catch (subscriptionError)
        {
            console.error(`[HandleRazorpayWebhook] Subscription event ${eventName} failed: ${subscriptionError?.message || subscriptionError}`);
            response.statusCode = httpStatus.OK;
            response.sendJson({ acknowledged: true, event: eventName, reason: ErrorCodes.EXCEPTION });
        }
        return;
    }

    // We care about two events that both indicate "payment is good":
    //   payment.captured — instant captures (most common)
    //   order.paid       — fired alongside payment.captured for orders
    if (eventName !== "payment.captured" && eventName !== "order.paid")
    {
        response.statusCode = httpStatus.OK;
        response.sendJson({ acknowledged: true, reason: "EVENT_IGNORED", event: eventName });
        return;
    }

    const paymentEntity = payload?.payload?.payment?.entity;
    const orderEntity = payload?.payload?.order?.entity;
    const providerOrderId = paymentEntity?.order_id || orderEntity?.id || "";
    const providerPaymentId = paymentEntity?.id || "";

    if (!providerOrderId)
    {
        response.statusCode = httpStatus.OK;
        response.sendJson({ acknowledged: true, reason: ErrorCodes.MISSING_ORDER_ID });
        return;
    }

    const paymentRow = await OrganizationPaymentQueryEngine.findByOrderId(providerOrderId);
    if (!paymentRow)
    {
        // Not an organization payment — try the credit-purchase flow before
        // giving up. The pending row's own userId drives the grant (no
        // session exists here); the verified HMAC signature is the auth.
        const pendingCreditOrder = await PendingCreditOrderQueryEngine.getByOrderId(providerOrderId);

        if (pendingCreditOrder)
        {
            if (pendingCreditOrder.status === PendingCreditOrderQueryEngine.STATUS_CONSUMED)
            {
                response.statusCode = httpStatus.OK;
                response.sendJson({ acknowledged: true, reason: ErrorCodes.CREDIT_ORDER_ALREADY_PROCESSED });
                return;
            }

            const completion = await CreditPurchaseCompletionService.complete
            (
                pendingCreditOrder,
                { providerPaymentId: providerPaymentId, source: CreditPurchaseCompletionService.SOURCE_WEBHOOK }
            );

            response.statusCode = httpStatus.OK;
            response.sendJson
            ({
                acknowledged: true,
                creditOrderCompleted: completion.granted,
                alreadyProcessed: completion.alreadyProcessed
            });
            return;
        }

        // Not a credit purchase either — try an admin credit-deal payment
        // (on-spot Razorpay for a periodic assignment / fixed grant). This is
        // the safety net for an admin who closes the tab before the in-page
        // verify runs. Idempotent on the atomic markCaptured CAS.
        const dealPayment = await CreditDealPaymentQueryEngine.findByOrderId(providerOrderId);
        if (dealPayment)
        {
            const dealCapture = await CreditDealPaymentQueryEngine.markCaptured(providerOrderId, providerPaymentId);
            response.statusCode = httpStatus.OK;
            response.sendJson({ acknowledged: true, dealCaptured: dealCapture.transitioned });
            return;
        }

        // The order belongs to a non-org payment flow (e.g. paid-deck
        // purchases) or to an org that was deleted before payment cleared.
        response.statusCode = httpStatus.OK;
        response.sendJson({ acknowledged: true, reason: ErrorCodes.PAYMENT_ROW_NOT_FOUND });
        return;
    }

    const captureResult = await OrganizationPaymentQueryEngine.markCaptured(providerOrderId, providerPaymentId);

    // Drive the side effects only on the first capture transition.
    // Duplicate webhook deliveries land here as transitioned=false.
    if (captureResult.transitioned)
    {
        const kind = paymentRow.getKind();
        if (kind === organizationPaymentKinds.CREATION)
        {
            await OrganizationQueryEngine.updateStatus
            (
                paymentRow.getOrganizationId(),
                organizationStatus.ACTIVE,
                new Date()
            );
            const organization = await OrganizationQueryEngine.getOrganizationById(paymentRow.getOrganizationId());
            const verificationToken = paymentRow.getAdditionalData()?.verificationToken;
            if (organization && typeof verificationToken === "string" && verificationToken.length > 0)
            {
                await OrgAdminVerificationManager.consumeToken(organization.getAdminEmail(), verificationToken);
            }
        }
        else if (kind === organizationPaymentKinds.EXPANSION)
        {
            await OrganizationQueryEngine.extendMaxMembers
            (
                paymentRow.getOrganizationId(),
                paymentRow.getAdditionalMembers()
            );
        }
    }

    response.statusCode = httpStatus.OK;
    response.sendJson({ acknowledged: true, transitioned: captureResult.transitioned });
}

module.exports = { handleRazorpayWebhook };
