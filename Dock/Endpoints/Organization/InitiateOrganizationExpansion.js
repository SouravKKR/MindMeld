const OrganizationQueryEngine = require("../../Globals/Classes/Organization/OrganizationQueryEngine");
const OrganizationPaymentQueryEngine = require("../../Globals/Classes/Organization/OrganizationPaymentQueryEngine");
const OrganizationPayment = require("../../Globals/Model/OrganizationPayment");
const PaymentProviderFactory = require("../../Globals/Classes/Payments/PaymentProviderFactory");
const { organizationStatus } = require("../../Globals/Enumerations/OrganizationStatus");
const { organizationPaymentKinds } = require("../../Globals/Enumerations/OrganizationPaymentKinds");
const { organizationPaymentStatuses } = require("../../Globals/Enumerations/OrganizationPaymentStatuses");


async function initiateOrganizationExpansion(request, response)
{
    const body = await request.getBody();
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";
    const additionalMembers = Number.isInteger(body?.additionalMembers) ? body.additionalMembers : 0;
    const amountMinor = Number.isInteger(body?.amountMinor) ? body.amountMinor : 0;

    if (!organizationId)
    {
        response.statusCode = 400;
        response.sendJson({ success: false, error: "MISSING_ORGANIZATION_ID" });
        return;
    }
    if (additionalMembers <= 0)
    {
        response.statusCode = 400;
        response.sendJson({ success: false, error: "INVALID_ADDITIONAL_MEMBERS" });
        return;
    }
    if (amountMinor < 0)
    {
        response.statusCode = 400;
        response.sendJson({ success: false, error: "INVALID_AMOUNT" });
        return;
    }

    const organization = await OrganizationQueryEngine.getOrganizationById(organizationId);
    if (!organization)
    {
        response.statusCode = 404;
        response.sendJson({ success: false, error: "ORG_NOT_FOUND" });
        return;
    }
    if (organization.getStatus() !== organizationStatus.ACTIVE)
    {
        response.statusCode = 409;
        response.sendJson({ success: false, error: "ORG_NOT_ACTIVE" });
        return;
    }

    // Free expansion (amount=0) — bump maxMembers in place, no Razorpay.
    if (amountMinor === 0)
    {
        await OrganizationQueryEngine.extendMaxMembers(organizationId, additionalMembers);
        response.statusCode = 200;
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
        response.statusCode = 503;
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

    response.statusCode = 200;
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
