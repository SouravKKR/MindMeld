const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const AuthenticationQueryEngine = require("../Database/AuthenticationQueryEngine");
const OrganizationPerkResolver = require("../Organization/OrganizationPerkResolver");
const RegionMetadata = require("./RegionMetadata");
const CurrencyConverter = require("./CurrencyConverter");
const { deckLicenseStatuses } = require("../../Enumerations/DeckLicenseStatuses");
const ErrorCodes = require("../../Constants/ErrorCodes");

class PaidDeckPricingEngine
{
    static async #getPricingForDeck(deckId, region)
    {
        // PaidDeckPricing.toJson serialises effectiveFrom/effectiveUntil
        // as ISO strings (codegen default), so Mongo stores them as
        // strings. Comparing string-typed fields against `$lte: new Date()`
        // is a cross-type comparison that Mongo never matches — this
        // method used to silently return null for every deck, which is
        // why the regional pricing feature appeared to do nothing.
        //
        // ISO-8601 strings sort lexicographically the same as chronologically,
        // so converting the query value to a string fixes the comparison.
        // SetPaidDeckPricing writes a far-future sentinel for the "no
        // expiry" case (new Date(8640000000000000).toISOString()), so the
        // `effectiveUntil: null` branch of the $or is here for forward
        // compatibility if anyone writes null directly.
        const database = await DatabaseConnector.getDatabase();
        const nowIsoString = new Date().toISOString();

        const matchingRegion = await database
            .collection(DatabaseConstants.PAID_DECK_PRICINGS_COLLECTION)
            .findOne
            ({
                deckId: deckId,
                region: region,
                effectiveFrom: { $lte: nowIsoString },
                $or: [{ effectiveUntil: null }, { effectiveUntil: { $gte: nowIsoString } }]
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
                effectiveFrom: { $lte: nowIsoString },
                $or: [{ effectiveUntil: null }, { effectiveUntil: { $gte: nowIsoString } }]
            });

        return globalPricing;
    }

    static async #getOwnedDeckIds(userId)
    {
        // "Owned" means "currently has a valid license", not "has ever
        // paid". Org-perk-issued licenses have a finite expiresAt — once
        // it elapses, the user should be eligible to buy at the regular
        // price again. Querying deckLicenses (with the expiry filter)
        // rather than purchases gives us that for free.
        //
        // The codegen-generated DeckLicense.toJson serialises dates as
        // ISO strings, so they're stored in Mongo as strings, not BSON
        // Dates. Comparing a stored string against `$gt: new Date()`
        // would never match (cross-type comparison in Mongo). ISO-8601
        // strings ARE lexicographically sortable, so the fix is to do
        // the comparison string-to-string by converting `now` to an ISO
        // string. The FOREVER sentinel (epoch 0) serialises as
        // "1970-01-01T00:00:00.000Z" and is the only value that ever
        // satisfies `$lte: epochIsoString`.
        if (!userId)
        {
            return new Set();
        }

        const database = await DatabaseConnector.getDatabase();
        const nowIsoString = new Date().toISOString();
        const epochIsoString = new Date(0).toISOString();

        const licenses = await database
            .collection(DatabaseConstants.DECK_LICENSES_COLLECTION)
            .find
            ({
                userId: userId,
                status: deckLicenseStatuses.ACTIVE,
                $or:
                [
                    { expiresAt: { $lte: epochIsoString } }, // FOREVER sentinel.
                    { expiresAt: { $gt: nowIsoString } }     // Finite + unexpired.
                ]
            })
            .toArray();

        return new Set(licenses.map(license => license.deckId));
    }

    static async #getBundleDiscounts(bundleDeckId)
    {
        const database = await DatabaseConnector.getDatabase();
        return await database
            .collection(DatabaseConstants.BUNDLE_DISCOUNTS_COLLECTION)
            .find({ bundleDeckId: bundleDeckId })
            .toArray();
    }

    /**
     * @param {boolean} bConvertToDisplayCurrency When true, every breakdown
     *   amount is converted into the region's display currency for SHOWING to
     *   the buyer (storefront / browse). Purchase + verification paths leave
     *   this false so the actual charge stays in the deck's canonical /
     *   override currency — converting the charged amount would change what
     *   the payment provider is asked to capture.
     */
    static async computeFinalPrice(userId, deckIds, region, preloadedUser, bConvertToDisplayCurrency = false)
    {
        const database = await DatabaseConnector.getDatabase();
        const ownedDeckIds = await PaidDeckPricingEngine.#getOwnedDeckIds(userId);
        const breakdown = [];
        let totalMinor = 0;
        let currency = null;

        // Resolve the user's email once up front — every org-perk lookup
        // inside the per-deck loop needs it. The membership query in
        // OrganizationPerkResolver is indexed on email so this stays
        // O(deckCount) round-trips, not O(deckCount²).
        const userEmail = await PaidDeckPricingEngine.#resolveUserEmail(userId, preloadedUser);

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
                    currency: null,
                    reason: ErrorCodes.ALREADY_OWNED
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
                        currency: null,
                        reason: ErrorCodes.DECK_NOT_FOUND
                    });
                    continue;
                }

                const fallbackPrice = deckDocument.basePriceMinor || 0;
                const fallbackCurrency = deckDocument.currency || "INR";
                currency = currency || fallbackCurrency;

                // Even when no PaidDeckPricing row exists, org members
                // should still get their perk pricing. Otherwise an admin
                // who forgot to set a regional pricing row would silently
                // charge org members the catalog price.
                const fallbackPerkResult = await OrganizationPerkResolver.resolveBestPerk
                (
                    userEmail,
                    userId,
                    deckId,
                    fallbackPrice,
                    fallbackCurrency
                );

                if (fallbackPerkResult.applied)
                {
                    totalMinor += fallbackPerkResult.finalPriceMinor;
                    breakdown.push
                    ({
                        deckId: deckId,
                        basePriceMinor: fallbackPrice,
                        discountMinor: fallbackPrice - fallbackPerkResult.finalPriceMinor,
                        finalPriceMinor: fallbackPerkResult.finalPriceMinor,
                        currency: fallbackCurrency,
                        reason: "ORG_PERK",
                        organizationId: fallbackPerkResult.organizationId,
                        perkType: fallbackPerkResult.perkType,
                        durationDays: fallbackPerkResult.durationDays,
                        // An org perk with no finite window is a perpetual grant
                        // (the historical org-perk semantics); a positive
                        // durationDays makes it a finite rental instead.
                        isPerpetual: !(Number.isInteger(fallbackPerkResult.durationDays) && fallbackPerkResult.durationDays > 0)
                    });
                    continue;
                }

                totalMinor += fallbackPrice;
                breakdown.push
                ({
                    deckId: deckId,
                    basePriceMinor: fallbackPrice,
                    discountMinor: 0,
                    finalPriceMinor: fallbackPrice,
                    currency: fallbackCurrency,
                    reason: "BASE_PRICE",
                    // No regional pricing row exists — the deck document carries
                    // the duration configuration for the base price.
                    durationDays: Number.isInteger(deckDocument.durationDays) ? deckDocument.durationDays : 0,
                    isPerpetual: deckDocument.isPerpetual === true
                });
                continue;
            }

            const baseMinor = pricing.priceMinor || 0;
            const deckCurrency = pricing.currency || "INR";
            currency = currency || deckCurrency;

            // Try the org perk first — if the user is in an active org
            // with a perk for this deck and is still inside the claim
            // window, the perk replaces both regional + bundle pricing
            // entirely (the deal price is the deal price).
            const perkResult = await OrganizationPerkResolver.resolveBestPerk
            (
                userEmail,
                userId,
                deckId,
                baseMinor,
                deckCurrency
            );

            if (perkResult.applied)
            {
                totalMinor += perkResult.finalPriceMinor;
                breakdown.push
                ({
                    deckId: deckId,
                    basePriceMinor: baseMinor,
                    discountMinor: baseMinor - perkResult.finalPriceMinor,
                    finalPriceMinor: perkResult.finalPriceMinor,
                    currency: deckCurrency,
                    reason: "ORG_PERK",
                    organizationId: perkResult.organizationId,
                    perkType: perkResult.perkType,
                    durationDays: perkResult.durationDays,
                    // An org perk with no finite window is a perpetual grant; a
                    // positive durationDays makes it a finite rental instead.
                    isPerpetual: !(Number.isInteger(perkResult.durationDays) && perkResult.durationDays > 0)
                });
                continue;
            }

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
                currency: deckCurrency,
                reason: discountMinor > 0 ? "DISCOUNTED" : "BASE_PRICE",
                // The active regional pricing row carries the duration
                // configuration for this (deck, region). Absent / zero
                // durationDays with isPerpetual false is a misconfiguration the
                // grant paths refuse (see LicenseExpiryResolver).
                durationDays: Number.isInteger(pricing.durationDays) ? pricing.durationDays : 0,
                isPerpetual: pricing.isPerpetual === true
            });
        }

        // Purchase / verification paths charge in the canonical currency —
        // return the natively-computed amounts unchanged.
        if (!bConvertToDisplayCurrency)
        {
            return {
                totalMinor: totalMinor,
                currency: currency || "INR",
                region: region || "GLOBAL",
                breakdown: breakdown
            };
        }

        // Display-layer normalization: every price shown to a buyer is
        // converted into their region's display currency. Explicit overrides
        // priced in that currency convert as a no-op; regions without an
        // override (priced in the deck's default currency) get auto-converted
        // via the cached ECB rates. Conversion failures degrade gracefully —
        // the entry keeps its native currency (CurrencyConverter alerts once).
        const displayCurrency = RegionMetadata.getDisplayCurrency(region);
        let normalizedTotalMinor = 0;

        for (const entry of breakdown)
        {
            const nativeCurrency = entry.currency || displayCurrency;

            if (entry.finalPriceMinor === 0 && entry.basePriceMinor === 0)
            {
                // Owned / not-found / free — nothing to convert.
                entry.currency = displayCurrency;
                continue;
            }

            const convertedBase = await CurrencyConverter.convertMinor(entry.basePriceMinor, nativeCurrency, displayCurrency);
            const convertedFinal = await CurrencyConverter.convertMinor(entry.finalPriceMinor, nativeCurrency, displayCurrency);

            entry.basePriceMinor = convertedBase.amountMinor;
            entry.finalPriceMinor = convertedFinal.amountMinor;
            entry.discountMinor = Math.max(0, entry.basePriceMinor - entry.finalPriceMinor);
            // Both conversions share a currency; if conversion was unavailable
            // they both fall back to the same native currency.
            entry.currency = convertedFinal.currency;

            normalizedTotalMinor += entry.finalPriceMinor;
        }

        return {
            totalMinor: normalizedTotalMinor,
            currency: displayCurrency,
            region: region || "GLOBAL",
            breakdown: breakdown
        };
    }

    static async #resolveUserEmail(userId, preloadedUser)
    {
        if (preloadedUser)
        {
            return (preloadedUser.getAdditionalData()?.email || "").toLowerCase();
        }
        if (!userId)
        {
            return "";
        }
        const user = await AuthenticationQueryEngine.getUserById(userId);
        if (!user)
        {
            return "";
        }
        return (user.getAdditionalData()?.email || "").toLowerCase();
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
