const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const PaidDeckPricing = require("../../Globals/Model/PaidDeckPricing");

async function setPaidDeckPricing(request, response)
{
    const body = await request.getBody();
    const deckId = body?.deckId;
    const pricingEntries = Array.isArray(body?.pricings) ? body.pricings : null;

    if (!deckId || !pricingEntries)
    {
        response.statusCode = 400;
        response.sendJson({ error: "MISSING_DECK_ID_OR_PRICINGS" });
        return;
    }

    const database = await DatabaseConnector.getDatabase();
    const collection = database.collection(DatabaseConstants.PAID_DECK_PRICINGS_COLLECTION);

    for (const entry of pricingEntries)
    {
        const pricing = PaidDeckPricing.fromJson
        ({
            id: entry.id,
            deckId: deckId,
            region: (entry.region || "GLOBAL").toUpperCase(),
            priceMinor: entry.priceMinor || 0,
            currency: entry.currency || "INR",
            discountPercent: entry.discountPercent || 0,
            effectiveFrom: entry.effectiveFrom ? new Date(entry.effectiveFrom).toISOString() : new Date().toISOString(),
            effectiveUntil: entry.effectiveUntil ? new Date(entry.effectiveUntil).toISOString() : new Date(8640000000000000).toISOString(),
            additionalData: entry.additionalData || {}
        });

        await collection.updateOne
        (
            { deckId: deckId, region: pricing.getRegion(), effectiveFrom: pricing.getEffectiveFrom() },
            { $set: pricing.toJson() },
            { upsert: true }
        );
    }

    response.statusCode = 200;
    response.sendJson({ success: true });
}

module.exports = { setPaidDeckPricing };
