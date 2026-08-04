const PaymentProviderFactory = require("../../Globals/Classes/Payments/PaymentProviderFactory");
const OrganizationQueryEngine = require("../../Globals/Classes/Organization/OrganizationQueryEngine");
const OrganizationPaymentQueryEngine = require("../../Globals/Classes/Organization/OrganizationPaymentQueryEngine");
const OrgAdminVerificationManager = require("../../Globals/Classes/Authentication/OrgAdminVerificationManager");
const PendingCreditOrderQueryEngine = require("../../Globals/Classes/Database/PendingCreditOrderQueryEngine");
const CreditPurchaseCompletionService = require("../../Globals/Classes/Credits/CreditPurchaseCompletionService");
const CreditDealPaymentQueryEngine = require("../../Globals/Classes/Credits/CreditDealPaymentQueryEngine");
const { paymentProviders } = require("../../Globals/Enumerations/PaymentProviders");
const { organizationStatus } = require("../../Globals/Enumerations/OrganizationStatus");
const { organizationPaymentKinds } = require("../../Globals/Enumerations/OrganizationPaymentKinds");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");


/**
 * Zoho Payments webhook handler — UNAUTHED (signed by Zoho via HMAC of
 * `<timestamp>.<rawBody>`). Registered with PLAIN_TEXT_BODY so the HMAC runs
 * over the exact bytes Zoho signed, not a re-serialised JSON.
 *
 * The server-authoritative safety net mirroring HandleRazorpayWebhook: it
 * completes three of HandleRazorpayWebhook's four flows — organization payments
 * (creation / expansion), credit purchases, and admin credit-deal payments — for
 * buyers/admins who pay and then close the tab before the in-page verify runs.
 * Paid-deck purchases are NOT yet settled here and fall through to
 * PAYMENT_ROW_NOT_FOUND; the Razorpay handler settles them through
 * PaidDeckPurchaseCompletionService, which is provider-agnostic, so extending
 * this handler is the same branch with paymentProviders.ZOHO.
 *
 * Identity mapping: Zoho's payments_session_id is the providerOrderId every
 * pending row is keyed by; payment_id is the providerPaymentId. Both echo back
 * on the payment object (verified above), so reconciliation needs no extra API
 * call.
 *
 * Idempotency: every downstream transition (markCaptured CAS, the credit
 * order's CONSUMED status + referenceKey grant) absorbs Zoho's at-least-once
 * redelivery exactly like the Razorpay path.
 *
 * Acks 200 even on benign errors (signature mismatch, unknown order) so Zoho
 * stops retrying; those are logged for admin triage.
 */
async function handleZohoWebhook(request, response)
{
    const rawBody = await request.getBody();
    const signature = request.headers["x-zoho-webhook-signature"];

    if (typeof rawBody !== "string" || rawBody.length === 0)
    {
        response.statusCode = httpStatus.OK;
        response.sendJson({ acknowledged: true, reason: ErrorCodes.EMPTY_BODY });
        return;
    }

    const provider = PaymentProviderFactory.getProvider(paymentProviders.ZOHO);
    const verification = provider.verifyWebhookSignature(rawBody, signature);
    if (!verification.verified)
    {
        console.warn(`[HandleZohoWebhook] Signature verification failed: ${verification.reason}`);
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
        console.warn(`[HandleZohoWebhook] Failed to parse JSON body: ${parseError.message}`);
        response.statusCode = httpStatus.OK;
        response.sendJson({ acknowledged: true, reason: ErrorCodes.INVALID_BODY });
        return;
    }

    const eventType = typeof payload?.event_type === "string" ? payload.event_type : "";

    // Only a successful one-time payment advances any flow.
    if (eventType !== "payment.succeeded")
    {
        response.statusCode = httpStatus.OK;
        response.sendJson({ acknowledged: true, reason: "EVENT_IGNORED", event: eventType });
        return;
    }

    // Zoho nests the payment under data.payment; tolerate data being the payment
    // object directly across payload shape revisions.
    const paymentEntity = payload?.data?.payment || payload?.data || {};
    const providerOrderId = paymentEntity?.payments_session_id || paymentEntity?.payment_session_id || "";
    const providerPaymentId = paymentEntity?.payment_id || "";

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
        // giving up. The pending row's own userId drives the grant (no session
        // exists here); the verified webhook signature is the auth.
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

        // Not a credit purchase either — try an admin credit-deal payment. The
        // safety net for an admin who closes the tab before the in-page verify
        // runs. Idempotent on the atomic markCaptured CAS.
        const dealPayment = await CreditDealPaymentQueryEngine.findByOrderId(providerOrderId);
        if (dealPayment)
        {
            const dealCapture = await CreditDealPaymentQueryEngine.markCaptured(providerOrderId, providerPaymentId);
            response.statusCode = httpStatus.OK;
            response.sendJson({ acknowledged: true, dealCaptured: dealCapture.transitioned });
            return;
        }

        // The order belongs to a non-org payment flow (e.g. paid-deck purchases,
        // which are verify-only) or to an org deleted before payment cleared.
        response.statusCode = httpStatus.OK;
        response.sendJson({ acknowledged: true, reason: ErrorCodes.PAYMENT_ROW_NOT_FOUND });
        return;
    }

    const captureResult = await OrganizationPaymentQueryEngine.markCaptured(providerOrderId, providerPaymentId);

    // Drive the side effects only on the first capture transition. Duplicate
    // webhook deliveries land here as transitioned=false.
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

module.exports = { handleZohoWebhook };
