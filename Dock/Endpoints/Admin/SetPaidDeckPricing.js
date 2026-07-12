const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const PaidDeckPricing = require("../../Globals/Model/PaidDeckPricing");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

async function setPaidDeckPricing(request, response)
{
    const body = await request.getBody();
    const deckId = body?.deckId;
    const pricingEntries = Array.isArray(body?.pricings) ? body.pricings : null;

    if (!deckId || !pricingEntries)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_DECK_ID_OR_PRICINGS });
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
            // Explicit license duration for this (deck, region): durationDays > 0
            // sells a finite rental, isPerpetual sells lifetime access. Neither
            // set means a buyer's grant is refused (LicenseExpiryResolver).
            durationDays: Number.isInteger(entry.durationDays) && entry.durationDays > 0 ? entry.durationDays : 0,
            isPerpetual: entry.isPerpetual === true,
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

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true });
}

module.exports = { setPaidDeckPricing };
