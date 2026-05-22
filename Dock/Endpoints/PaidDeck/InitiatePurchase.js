const PaidDeckPricingEngine = require("../../Globals/Classes/Pricing/PaidDeckPricingEngine");
const PaymentProviderFactory = require("../../Globals/Classes/Payments/PaymentProviderFactory");
const { paymentProviders } = require("../../Globals/Enumerations/PaymentProviders");

async function initiatePurchase(request, response)
{
    const session = request.session;

    if (!session)
    {
        response.sendStatusCode(401);
        return;
    }

    const body = await request.getBody();
    const deckIds = Array.isArray(body?.deckIds) ? body.deckIds : [];
    const region = (body?.region || "IN").toUpperCase();
    const providerEnum = typeof body?.paymentProvider === "number"
        ? body.paymentProvider
        : paymentProviders[String(body?.paymentProvider || "").toUpperCase()];

    if (deckIds.length === 0)
    {
        response.statusCode = 400;
        response.sendJson({ error: "MISSING_DECK_IDS" });
        return;
    }

    const pricing = await PaidDeckPricingEngine.computeFinalPrice(session.getUserId(), deckIds, region);

    if (pricing.totalMinor === 0)
    {
        response.statusCode = 200;
        response.sendJson
        ({
            requiresPayment: false,
            pricing: pricing
        });
        return;
    }

    const provider = providerEnum !== undefined
        ? PaymentProviderFactory.getProvider(providerEnum)
        : PaymentProviderFactory.getDefaultProvider();

    if (!provider.isConfigured())
    {
        response.statusCode = 503;
        response.sendJson({ error: "PAYMENT_PROVIDER_NOT_CONFIGURED" });
        return;
    }

    const order = await provider.initiateOrder
    (
        pricing.totalMinor,
        pricing.currency,
        {
            receiptId: `mm_${session.getUserId().slice(0, 8)}_${Date.now()}`,
            notes:
            {
                userId: session.getUserId(),
                deckIds: deckIds.join(",")
            }
        }
    );

    response.statusCode = 200;
    response.sendJson
    ({
        requiresPayment: true,
        provider: provider.getProviderEnumValue(),
        order: order,
        pricing: pricing
    });
}

module.exports = { initiatePurchase };
