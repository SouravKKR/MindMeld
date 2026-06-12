const OrganizationQueryEngine = require("../../Globals/Classes/Organization/OrganizationQueryEngine");
const OrganizationPaymentQueryEngine = require("../../Globals/Classes/Organization/OrganizationPaymentQueryEngine");
const PaymentProviderFactory = require("../../Globals/Classes/Payments/PaymentProviderFactory");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");


async function verifyOrganizationExpansionPayment(request, response)
{
    const body = await request.getBody();
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";
    const providerOrderId = typeof body?.providerOrderId === "string" ? body.providerOrderId : "";
    const providerPaymentId = typeof body?.providerPaymentId === "string" ? body.providerPaymentId : "";
    const signature = typeof body?.signature === "string" ? body.signature : "";

    if (!organizationId || !providerOrderId || !providerPaymentId || !signature)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: "MISSING_FIELDS" });
        return;
    }

    const paymentRow = await OrganizationPaymentQueryEngine.findByOrderId(providerOrderId);
    if (!paymentRow || paymentRow.getOrganizationId() !== organizationId)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: "PAYMENT_ROW_NOT_FOUND" });
        return;
    }

    const provider = PaymentProviderFactory.getProvider(paymentRow.getPaymentProvider());
    const verification = await provider.verifyPayment({ providerOrderId, providerPaymentId, signature });
    if (!verification.verified)
    {
        await OrganizationPaymentQueryEngine.markFailed(providerOrderId);
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: "PAYMENT_NOT_VERIFIED", reason: verification.reason });
        return;
    }

    const captureResult = await OrganizationPaymentQueryEngine.markCaptured(providerOrderId, providerPaymentId);

    if (captureResult.transitioned)
    {
        await OrganizationQueryEngine.extendMaxMembers(organizationId, paymentRow.getAdditionalMembers());
    }

    const organization = await OrganizationQueryEngine.getOrganizationById(organizationId);

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        organizationId: organizationId,
        alreadyCaptured: !captureResult.transitioned,
        newMaxMembers: organization ? organization.getMaxMembers() : null
    });
}

module.exports = { verifyOrganizationExpansionPayment };
