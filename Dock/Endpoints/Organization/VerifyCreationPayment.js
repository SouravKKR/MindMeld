const OrganizationQueryEngine = require("../../Globals/Classes/Organization/OrganizationQueryEngine");
const OrganizationPaymentQueryEngine = require("../../Globals/Classes/Organization/OrganizationPaymentQueryEngine");
const OrgAdminVerificationManager = require("../../Globals/Classes/Authentication/OrgAdminVerificationManager");
const PaymentProviderFactory = require("../../Globals/Classes/Payments/PaymentProviderFactory");
const { organizationStatus } = require("../../Globals/Enumerations/OrganizationStatus");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");


/**
 * Client-initiated Razorpay verification. The webhook handler at
 * /Webhooks/Razorpay does the same work server-authoritatively and is
 * the safety-net for users who close the browser between checkout and
 * this call — both paths converge on
 * OrganizationPaymentQueryEngine.markCaptured which is idempotent on
 * providerOrderId.
 */
async function verifyCreationPayment(request, response)
{
    const body = await request.getBody();
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";
    const providerOrderId = typeof body?.providerOrderId === "string" ? body.providerOrderId : "";
    const providerPaymentId = typeof body?.providerPaymentId === "string" ? body.providerPaymentId : "";
    const signature = typeof body?.signature === "string" ? body.signature : "";

    if (!organizationId || !providerOrderId || !providerPaymentId || !signature)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.MISSING_FIELDS });
        return;
    }

    const organization = await OrganizationQueryEngine.getOrganizationById(organizationId);
    if (!organization)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ success: false, error: ErrorCodes.ORG_NOT_FOUND });
        return;
    }
    if (organization.getStatus() === organizationStatus.ACTIVE)
    {
        response.statusCode = httpStatus.OK;
        response.sendJson({ success: true, organizationId: organizationId, alreadyActive: true });
        return;
    }

    const paymentRow = await OrganizationPaymentQueryEngine.findByOrderId(providerOrderId);
    if (!paymentRow || paymentRow.getOrganizationId() !== organizationId)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.PAYMENT_ROW_NOT_FOUND });
        return;
    }

    const provider = PaymentProviderFactory.getProvider(paymentRow.getPaymentProvider());
    const verification = await provider.verifyPayment({ providerOrderId, providerPaymentId, signature });
    if (!verification.verified)
    {
        await OrganizationPaymentQueryEngine.markFailed(providerOrderId);
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.PAYMENT_NOT_VERIFIED, reason: verification.reason });
        return;
    }

    const captureResult = await OrganizationPaymentQueryEngine.markCaptured(providerOrderId, providerPaymentId);

    // Flip the org to ACTIVE only if the payment row actually transitioned
    // (covers the case where a duplicate verify call comes in after the
    // webhook already activated the org).
    if (captureResult.transitioned)
    {
        await OrganizationQueryEngine.updateStatus(organizationId, organizationStatus.ACTIVE, new Date());
        // Consume the verification token. The token was stamped into
        // payment.additionalData at Create time.
        const verificationToken = paymentRow.getAdditionalData()?.verificationToken;
        if (typeof verificationToken === "string" && verificationToken.length > 0)
        {
            await OrgAdminVerificationManager.consumeToken(organization.getAdminEmail(), verificationToken);
        }
    }

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, organizationId: organizationId, alreadyActive: !captureResult.transitioned });
}

module.exports = { verifyCreationPayment };
