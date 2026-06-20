const Organization = require("../../Globals/Model/Organization");
const OrganizationPayment = require("../../Globals/Model/OrganizationPayment");
const OrganizationQueryEngine = require("../../Globals/Classes/Organization/OrganizationQueryEngine");
const OrganizationDeckPerkQueryEngine = require("../../Globals/Classes/Organization/OrganizationDeckPerkQueryEngine");
const OrganizationPaymentQueryEngine = require("../../Globals/Classes/Organization/OrganizationPaymentQueryEngine");
const OrgAdminVerificationManager = require("../../Globals/Classes/Authentication/OrgAdminVerificationManager");
const PaymentProviderFactory = require("../../Globals/Classes/Payments/PaymentProviderFactory");
const { organizationStatus } = require("../../Globals/Enumerations/OrganizationStatus");
const { organizationPaymentKinds } = require("../../Globals/Enumerations/OrganizationPaymentKinds");
const { organizationPaymentStatuses } = require("../../Globals/Enumerations/OrganizationPaymentStatuses");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");


async function createOrganization(request, response)
{
    const body = await request.getBody();
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const adminEmail = typeof body?.adminEmail === "string" ? body.adminEmail.trim().toLowerCase() : "";
    const verificationToken = typeof body?.verificationToken === "string" ? body.verificationToken : "";
    const currency = typeof body?.currency === "string" && body.currency.length > 0 ? body.currency.toUpperCase() : "INR";
    const amountMinor = Number.isInteger(body?.amountMinor) ? body.amountMinor : 0;
    const maxMembers = Number.isInteger(body?.maxMembers) ? body.maxMembers : 0;
    const deckPerks = Array.isArray(body?.deckPerks) ? body.deckPerks : [];

    if (name.length === 0 || name.length > 256)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.INVALID_NAME });
        return;
    }
    if (!adminEmail || adminEmail.indexOf("@") < 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.INVALID_ADMIN_EMAIL });
        return;
    }
    if (amountMinor < 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.INVALID_AMOUNT });
        return;
    }
    if (maxMembers <= 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.INVALID_MAX_MEMBERS });
        return;
    }

    const tokenValid = await OrgAdminVerificationManager.isTokenValid(adminEmail, verificationToken);
    if (!tokenValid)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.INVALID_VERIFICATION_TOKEN });
        return;
    }

    // Validate every perk shape up front so we never persist a half-
    // written set. Throws as a 400 if any single perk is malformed.
    for (const perkInput of deckPerks)
    {
        const validation = OrganizationDeckPerkQueryEngine.validatePerk(perkInput);
        if (!validation.valid)
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ success: false, error: ErrorCodes.INVALID_PERK, reason: validation.reason, deckId: perkInput?.deckId });
            return;
        }
    }

    const now = new Date();
    const isFree = amountMinor === 0;
    const status = isFree ? organizationStatus.ACTIVE : organizationStatus.PENDING_PAYMENT;

    const organization = new Organization
    ({
        name: name.slice(0, 256),
        adminEmail: adminEmail,
        adminUserId: "",
        status: status,
        currency: currency,
        creationAmountMinor: amountMinor,
        maxMembers: maxMembers,
        currentMemberCount: 0,
        creationDate: now,
        activationDate: isFree ? now : new Date(0),
        additionalData: {}
    });

    const created = await OrganizationQueryEngine.createOrganization(organization);

    // Perks are written eagerly even for PENDING orgs — they're inert
    // while status != ACTIVE (the pricing engine filters perks by org
    // status), and writing them now means a single Razorpay webhook
    // can flip the org to ACTIVE without needing a perks payload.
    if (deckPerks.length > 0)
    {
        await OrganizationDeckPerkQueryEngine.replacePerks(created.getId(), deckPerks);
    }

    if (isFree)
    {
        // Consume the verification token now — for free orgs there's no
        // downstream payment-verify hook that would otherwise consume it.
        await OrgAdminVerificationManager.consumeToken(adminEmail, verificationToken);
        response.statusCode = httpStatus.OK;
        response.sendJson
        ({
            success: true,
            organizationId: created.getId(),
            status: organizationStatus.ACTIVE,
            requiresPayment: false
        });
        return;
    }

    // Paid path — initiate a Razorpay order, log the payment row at
    // PENDING. The webhook OR the explicit VerifyCreationPayment call
    // will flip everything to CAPTURED + ACTIVE.
    const provider = PaymentProviderFactory.getDefaultProvider();
    if (!provider.isConfigured())
    {
        // Roll back the org we just created so we don't strand a
        // PENDING row with no order behind it.
        await OrganizationQueryEngine.deleteOrganization(created.getId());
        response.statusCode = httpStatus.SERVICE_UNAVAILABLE;
        response.sendJson({ success: false, error: ErrorCodes.PAYMENT_PROVIDER_NOT_CONFIGURED });
        return;
    }

    const order = await provider.initiateOrder
    (
        amountMinor,
        currency,
        {
            receiptId: `org_create_${created.getId().slice(0, 8)}_${Date.now()}`,
            notes:
            {
                organizationId: created.getId(),
                kind: "CREATION",
                adminEmail: adminEmail
            }
        }
    );

    const paymentRow = new OrganizationPayment
    ({
        organizationId: created.getId(),
        kind: organizationPaymentKinds.CREATION,
        status: organizationPaymentStatuses.PENDING,
        paymentProvider: provider.getProviderEnumValue(),
        providerOrderId: order.providerOrderId,
        providerPaymentId: "",
        amountMinor: amountMinor,
        currency: currency,
        additionalMembers: 0,
        createdAt: new Date(),
        capturedAt: new Date(0),
        additionalData: { verificationToken: verificationToken }
    });
    await OrganizationPaymentQueryEngine.createPayment(paymentRow);

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        organizationId: created.getId(),
        status: organizationStatus.PENDING_PAYMENT,
        requiresPayment: true,
        provider: provider.getProviderEnumValue(),
        order: order
    });
}

module.exports = { createOrganization };
