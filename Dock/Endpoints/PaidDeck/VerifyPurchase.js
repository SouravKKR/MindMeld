const crypto = require("crypto");
const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const PaymentProviderFactory = require("../../Globals/Classes/Payments/PaymentProviderFactory");
const KeyManagementService = require("../../Globals/Classes/Security/KeyManagementService");
const Purchase = require("../../Globals/Model/Purchase");
const { purchaseStatuses } = require("../../Globals/Enumerations/PurchaseStatuses");

async function verifyPurchase(request, response)
{
    const session = request.session;

    if (!session)
    {
        response.sendStatusCode(401);
        return;
    }

    const body = await request.getBody();
    const { providerOrderId, providerPaymentId, signature, paymentProvider, deckIds, region, amountMinor, currency } = body || {};

    if (!providerOrderId || !providerPaymentId || !signature)
    {
        response.statusCode = 400;
        response.sendJson({ error: "MISSING_FIELDS" });
        return;
    }

    const provider = PaymentProviderFactory.getProvider(paymentProvider);
    const verification = await provider.verifyPayment({ providerOrderId, providerPaymentId, signature });

    if (!verification.verified)
    {
        response.statusCode = 400;
        response.sendJson({ error: "PAYMENT_NOT_VERIFIED", reason: verification.reason });
        return;
    }

    const database = await DatabaseConnector.getDatabase();
    const issuedLicenses = [];

    for (const deckId of (deckIds || []))
    {
        const purchase = new Purchase
        ({
            userId: session.getUserId(),
            deckId: deckId,
            paymentProvider: provider.getProviderEnumValue(),
            providerOrderId: providerOrderId,
            providerPaymentId: providerPaymentId,
            amountMinor: amountMinor || 0,
            currency: currency || "INR",
            region: region || "IN",
            purchaseDate: new Date(),
            refundedAt: new Date(0),
            status: purchaseStatuses.COMPLETED,
            additionalData: {}
        });

        await database
            .collection(DatabaseConstants.PURCHASES_COLLECTION)
            .updateOne
            (
                { userId: session.getUserId(), deckId: deckId, providerOrderId: providerOrderId },
                { $set: purchase.toJson() },
                { upsert: true }
            );

        const licenseResult = await KeyManagementService.issueLicenseForDeck(session.getUserId(), deckId);

        if (licenseResult.success)
        {
            issuedLicenses.push(licenseResult.license.toJson());
        }
    }

    response.statusCode = 200;
    response.sendJson
    ({
        success: true,
        licenses: issuedLicenses
    });
}

module.exports = { verifyPurchase };
