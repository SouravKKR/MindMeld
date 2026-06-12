const PaymentProviderFactory = require("../../Globals/Classes/Payments/PaymentProviderFactory");
const OrganizationQueryEngine = require("../../Globals/Classes/Organization/OrganizationQueryEngine");
const OrganizationPaymentQueryEngine = require("../../Globals/Classes/Organization/OrganizationPaymentQueryEngine");
const OrgAdminVerificationManager = require("../../Globals/Classes/Authentication/OrgAdminVerificationManager");
const { paymentProviders } = require("../../Globals/Enumerations/PaymentProviders");
const { organizationStatus } = require("../../Globals/Enumerations/OrganizationStatus");
const { organizationPaymentKinds } = require("../../Globals/Enumerations/OrganizationPaymentKinds");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");


/**
 * Razorpay webhook handler — UNAUTHED (signed by Razorpay via HMAC of
 * the raw request body). Registered with PLAIN_TEXT_BODY so we can run
 * the HMAC over the exact bytes Razorpay signed instead of a re-
 * serialised JSON.
 *
 * Idempotent on providerOrderId — repeat deliveries (Razorpay retries
 * each event up to ~5 times) match the unique index on
 * organizationPayments.providerOrderId and short-circuit at the
 * "already CAPTURED" check inside OrganizationPaymentQueryEngine.
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
        response.sendJson({ acknowledged: true, reason: "EMPTY_BODY" });
        return;
    }

    const provider = PaymentProviderFactory.getProvider(paymentProviders.RAZORPAY);
    const verification = provider.verifyWebhookSignature(rawBody, signature);
    if (!verification.verified)
    {
        console.warn(`[HandleRazorpayWebhook] Signature verification failed: ${verification.reason}`);
        response.statusCode = httpStatus.OK;
        response.sendJson({ acknowledged: true, reason: "INVALID_SIGNATURE" });
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
        response.sendJson({ acknowledged: true, reason: "INVALID_BODY" });
        return;
    }

    const eventName = typeof payload?.event === "string" ? payload.event : "";

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
        response.sendJson({ acknowledged: true, reason: "MISSING_ORDER_ID" });
        return;
    }

    const paymentRow = await OrganizationPaymentQueryEngine.findByOrderId(providerOrderId);
    if (!paymentRow)
    {
        // The order belongs to a non-org payment flow (e.g. paid-deck
        // purchases) or to an org that was deleted before payment cleared.
        response.statusCode = httpStatus.OK;
        response.sendJson({ acknowledged: true, reason: "PAYMENT_ROW_NOT_FOUND" });
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
