const OrganizationQueryEngine = require("../../Globals/Classes/Organization/OrganizationQueryEngine");
const OrganizationPaymentQueryEngine = require("../../Globals/Classes/Organization/OrganizationPaymentQueryEngine");
const OrganizationPayment = require("../../Globals/Model/OrganizationPayment");
const PaymentProviderFactory = require("../../Globals/Classes/Payments/PaymentProviderFactory");
const { organizationStatus } = require("../../Globals/Enumerations/OrganizationStatus");
const { organizationPaymentKinds } = require("../../Globals/Enumerations/OrganizationPaymentKinds");
const { organizationPaymentStatuses } = require("../../Globals/Enumerations/OrganizationPaymentStatuses");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");


async function initiateOrganizationExpansion(request, response)
{
    const body = await request.getBody();
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";
    const additionalMembers = Number.isInteger(body?.additionalMembers) ? body.additionalMembers : 0;
    const amountMinor = Number.isInteger(body?.amountMinor) ? body.amountMinor : 0;

    if (!organizationId)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: "MISSING_ORGANIZATION_ID" });
        return;
    }
    if (additionalMembers <= 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: "INVALID_ADDITIONAL_MEMBERS" });
        return;
    }
    if (amountMinor < 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: "INVALID_AMOUNT" });
        return;
    }

    const organization = await OrganizationQueryEngine.getOrganizationById(organizationId);
    if (!organization)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ success: false, error: "ORG_NOT_FOUND" });
        return;
    }
    if (organization.getStatus() !== organizationStatus.ACTIVE)
    {
        response.statusCode = httpStatus.CONFLICT;
        response.sendJson({ success: false, error: "ORG_NOT_ACTIVE" });
        return;
    }

    // Free expansion (amount=0) — bump maxMembers in place, no Razorpay.
    if (amountMinor === 0)
    {
        await OrganizationQueryEngine.extendMaxMembers(organizationId, additionalMembers);
        response.statusCode = httpStatus.OK;
        response.sendJson
        ({
            success: true,
            organizationId: organizationId,
            requiresPayment: false,
            newMaxMembers: organization.getMaxMembers() + additionalMembers
        });
        return;
    }

    const provider = PaymentProviderFactory.getDefaultProvider();
    if (!provider.isConfigured())
    {
        response.statusCode = httpStatus.SERVICE_UNAVAILABLE;
        response.sendJson({ success: false, error: "PAYMENT_PROVIDER_NOT_CONFIGURED" });
        return;
    }

    const order = await provider.initiateOrder
    (
        amountMinor,
        organization.getCurrency(),
        {
            receiptId: `org_expand_${organizationId.slice(0, 8)}_${Date.now()}`,
            notes:
            {
                organizationId: organizationId,
                kind: "EXPANSION",
                additionalMembers: String(additionalMembers)
            }
        }
    );

    const paymentRow = new OrganizationPayment
    ({
        organizationId: organizationId,
        kind: organizationPaymentKinds.EXPANSION,
        status: organizationPaymentStatuses.PENDING,
        paymentProvider: provider.getProviderEnumValue(),
        providerOrderId: order.providerOrderId,
        providerPaymentId: "",
        amountMinor: amountMinor,
        currency: organization.getCurrency(),
        additionalMembers: additionalMembers,
        createdAt: new Date(),
        capturedAt: new Date(0),
        additionalData: {}
    });
    await OrganizationPaymentQueryEngine.createPayment(paymentRow);

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        organizationId: organizationId,
        requiresPayment: true,
        provider: provider.getProviderEnumValue(),
        order: order
    });
}

module.exports = { initiateOrganizationExpansion };
