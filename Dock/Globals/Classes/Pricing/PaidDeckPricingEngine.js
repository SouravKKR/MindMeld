const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const { purchaseStatuses } = require("../../Enumerations/PurchaseStatuses");

class PaidDeckPricingEngine
{
    static async #getPricingForDeck(deckId, region)
    {
        const database = await DatabaseConnector.getDatabase();
        const now = new Date();

        const matchingRegion = await database
            .collection(DatabaseConstants.PAID_DECK_PRICINGS_COLLECTION)
            .findOne
            ({
                deckId: deckId,
                region: region,
                effectiveFrom: { $lte: now },
                $or: [{ effectiveUntil: null }, { effectiveUntil: { $gte: now } }]
            });

        if (matchingRegion)
        {
            return matchingRegion;
        }

        const globalPricing = await database
            .collection(DatabaseConstants.PAID_DECK_PRICINGS_COLLECTION)
            .findOne
            ({
                deckId: deckId,
                region: "GLOBAL",
                effectiveFrom: { $lte: now },
                $or: [{ effectiveUntil: null }, { effectiveUntil: { $gte: now } }]
            });

        return globalPricing;
    }

    static async #getOwnedDeckIds(userId)
    {
        if (!userId)
        {
            return new Set();
        }

        const database = await DatabaseConnector.getDatabase();
        const purchases = await database
            .collection(DatabaseConstants.PURCHASES_COLLECTION)
            .find
            ({
                userId: userId,
                status: purchaseStatuses.COMPLETED
            })
            .toArray();

        return new Set(purchases.map(purchase => purchase.deckId));
    }

    static async #getBundleDiscounts(bundleDeckId)
    {
        const database = await DatabaseConnector.getDatabase();
        return await database
            .collection(DatabaseConstants.BUNDLE_DISCOUNTS_COLLECTION)
            .find({ bundleDeckId: bundleDeckId })
            .toArray();
    }

    static async computeFinalPrice(userId, deckIds, region)
    {
        const database = await DatabaseConnector.getDatabase();
        const ownedDeckIds = await PaidDeckPricingEngine.#getOwnedDeckIds(userId);
        const breakdown = [];
        let totalMinor = 0;
        let currency = null;

        for (const deckId of deckIds)
        {
            if (ownedDeckIds.has(deckId))
            {
                breakdown.push
                ({
                    deckId: deckId,
                    basePriceMinor: 0,
                    discountMinor: 0,
                    finalPriceMinor: 0,
                    reason: "ALREADY_OWNED"
                });
                continue;
            }

            const pricing = await PaidDeckPricingEngine.#getPricingForDeck(deckId, region);

            if (!pricing)
            {
                const deckDocument = await database
                    .collection(DatabaseConstants.PAID_DECKS_COLLECTION)
                    .findOne({ id: deckId });

                if (!deckDocument)
                {
                    breakdown.push
                    ({
                        deckId: deckId,
                        basePriceMinor: 0,
                        discountMinor: 0,
                        finalPriceMinor: 0,
                        reason: "DECK_NOT_FOUND"
                    });
                    continue;
                }

                const fallbackPrice = deckDocument.basePriceMinor || 0;
                totalMinor += fallbackPrice;
                currency = currency || deckDocument.currency || "INR";

                breakdown.push
                ({
                    deckId: deckId,
                    basePriceMinor: fallbackPrice,
                    discountMinor: 0,
                    finalPriceMinor: fallbackPrice,
                    reason: "BASE_PRICE"
                });
                continue;
            }

            const baseMinor = pricing.priceMinor || 0;
            currency = currency || pricing.currency || "INR";

            let discountMinor = 0;

            if (pricing.discountPercent && pricing.discountPercent > 0)
            {
                discountMinor += Math.floor(baseMinor * pricing.discountPercent / 100);
            }

            const bundleDiscounts = await PaidDeckPricingEngine.#getBundleDiscounts(deckId);

            for (const bundleDiscount of bundleDiscounts)
            {
                if (ownedDeckIds.has(bundleDiscount.includedDeckId))
                {
                    const includedPricing = await PaidDeckPricingEngine.#getPricingForDeck(bundleDiscount.includedDeckId, region);
                    const includedBasePrice = includedPricing?.priceMinor || 0;
                    const creditMinor = Math.floor(includedBasePrice * (bundleDiscount.discountPercentWhenIncluded || 100) / 100);
                    discountMinor += creditMinor;
                }
            }

            const finalMinor = Math.max(0, baseMinor - discountMinor);
            totalMinor += finalMinor;

            breakdown.push
            ({
                deckId: deckId,
                basePriceMinor: baseMinor,
                discountMinor: discountMinor,
                finalPriceMinor: finalMinor,
                reason: discountMinor > 0 ? "DISCOUNTED" : "BASE_PRICE"
            });
        }

        return {
            totalMinor: totalMinor,
            currency: currency || "INR",
            region: region || "GLOBAL",
            breakdown: breakdown
        };
    }
}

// Future-extension note for the demand-supply optimizer.
// A separate Python module (Agent/Globals/Classes/Pricing/PricingOptimizer.py)
// will aggregate revenue, cost, and demand inputs per region and
// periodically rewrite the PAID_DECK_PRICINGS_COLLECTION rows that this
// engine reads. computeFinalPrice() stays read-only and unaware of the
// optimizer — it just consumes whatever pricing rows are currently
// effective. The admin panel also writes to the same collection, so the
// optimizer's outputs and manual overrides coexist via effectiveFrom /
// effectiveUntil windows.

module.exports = PaidDeckPricingEngine;
