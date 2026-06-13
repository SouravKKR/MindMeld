const CurrencyConverter = require("../Pricing/CurrencyConverter");
const RegionMetadata = require("../Pricing/RegionMetadata");

/**
 * CreditPurchasePricingEngine
 *
 * The single price authority for purchased credits, shared by the buyer
 * Options endpoint, InitiateCreditPurchase, and the admin editor enrichment
 * so a displayed price can never diverge from a charged one.
 *
 * Pricing model: the admin maintains an ORDERED list of per-currency unit
 * prices (CreditConfiguration.creditPricing). The first entry is the base
 * currency; a buyer currency with an explicit entry uses it, every other
 * currency converts the base price through the ECB snapshot at quote time.
 * When the FX rate is unavailable, CurrencyConverter degrades gracefully and
 * the buyer is charged in the base currency instead — a real, payable price
 * rather than a stuck quote.
 *
 * Discounts: a configured pack applies whenever the requested quantity
 * EXACTLY equals the pack size, so clicking a pack button and typing the
 * same number always charge the same amount, and a pack edited mid-checkout
 * can never be claimed through a stale index. Totals are computed once and
 * converted as totals (not per-credit) to avoid compounding rounding.
 */
class CreditPurchasePricingEngine
{
    // Razorpay rejects orders below 1.00 of the currency (100 minor units);
    // every supported display currency carries 2 minor digits.
    static MINIMUM_CHARGE_MINOR_UNITS = 100;

    // Upper bound on the search for the smallest chargeable quantity, purely
    // a runaway guard for absurd configurations (e.g. a 0.0001-per-credit
    // price would need a 10000-credit minimum order).
    static MINIMUM_CHARGE_SEARCH_LIMIT = 100000;

    /**
     * Resolves the per-credit unit price a buyer pays in their currency.
     * Falls back to the base currency when the FX rate is unavailable, so
     * the returned `currency` is always the actual charge currency.
     * @param {CreditConfiguration} configuration
     * @param {string} buyerCurrency
     * @returns {Promise<{ available: boolean, unitPrice?: number, currency?: string, baseCurrency?: string, explicit?: boolean, converted?: boolean }>}
     */
    static async resolveUnitPrice(configuration, buyerCurrency)
    {
        const baseEntry = configuration.getBaseCreditPriceEntry();
        if (!baseEntry)
        {
            return { available: false };
        }

        const normalizedCurrency = typeof buyerCurrency === "string" ? buyerCurrency.trim().toUpperCase() : "";
        const explicitEntry = configuration.getCreditPriceEntryForCurrency(normalizedCurrency);
        if (explicitEntry)
        {
            return {
                available: true,
                unitPrice: explicitEntry.getPricePerCredit(),
                currency: explicitEntry.getCurrency(),
                baseCurrency: baseEntry.getCurrency(),
                explicit: true,
                converted: false,
            };
        }

        const conversion = await CurrencyConverter.convertMinor
        (
            Math.round(baseEntry.getPricePerCredit() * 100),
            baseEntry.getCurrency(),
            normalizedCurrency
        );

        if (conversion.converted)
        {
            return {
                available: true,
                unitPrice: conversion.amountMinor / 100,
                currency: normalizedCurrency,
                baseCurrency: baseEntry.getCurrency(),
                explicit: false,
                converted: true,
            };
        }

        // FX rate unavailable — charge like a base-region buyer.
        return {
            available: true,
            unitPrice: baseEntry.getPricePerCredit(),
            currency: baseEntry.getCurrency(),
            baseCurrency: baseEntry.getCurrency(),
            explicit: true,
            converted: false,
        };
    }

    /**
     * Computes the authoritative charge for an integer credit quantity. The
     * discount of a pack whose size exactly matches `credits` is applied
     * (highest when duplicates exist); any other quantity is undiscounted.
     * @param {CreditConfiguration} configuration
     * @param {string} buyerCurrency
     * @param {number} credits
     * @returns {Promise<{ available: boolean, amountMinor?: number, currency?: string, unitPrice?: number, discountPercent?: number, converted?: boolean, baseCurrency?: string, belowProviderMinimum?: boolean }>}
     */
    static async computeChargeForCredits(configuration, buyerCurrency, credits)
    {
        const baseEntry = configuration.getBaseCreditPriceEntry();
        if (!baseEntry || !Number.isInteger(credits) || credits < 1)
        {
            return { available: false };
        }

        let discountPercent = 0;
        for (const pack of configuration.getCreditPacks())
        {
            if (pack.getCredits() === credits && pack.getDiscountPercent() > discountPercent)
            {
                discountPercent = pack.getDiscountPercent();
            }
        }

        const normalizedCurrency = typeof buyerCurrency === "string" ? buyerCurrency.trim().toUpperCase() : "";
        const explicitEntry = configuration.getCreditPriceEntryForCurrency(normalizedCurrency);

        let amountMinor;
        let chargeCurrency;
        let unitPrice;
        let converted;

        if (explicitEntry)
        {
            unitPrice = explicitEntry.getPricePerCredit();
            amountMinor = Math.round(credits * unitPrice * (1 - discountPercent / 100) * 100);
            chargeCurrency = explicitEntry.getCurrency();
            converted = false;
        }
        else
        {
            const amountMinorBase = Math.round(credits * baseEntry.getPricePerCredit() * (1 - discountPercent / 100) * 100);
            const conversion = await CurrencyConverter.convertMinor(amountMinorBase, baseEntry.getCurrency(), normalizedCurrency);

            if (conversion.converted)
            {
                amountMinor = conversion.amountMinor;
                chargeCurrency = normalizedCurrency;
                converted = true;
                const unitConversion = await CurrencyConverter.convertMinor
                (
                    Math.round(baseEntry.getPricePerCredit() * 100),
                    baseEntry.getCurrency(),
                    normalizedCurrency
                );
                unitPrice = unitConversion.converted ? unitConversion.amountMinor / 100 : baseEntry.getPricePerCredit();
            }
            else
            {
                amountMinor = amountMinorBase;
                chargeCurrency = baseEntry.getCurrency();
                converted = false;
                unitPrice = baseEntry.getPricePerCredit();
            }
        }

        return {
            available: true,
            amountMinor: amountMinor,
            currency: chargeCurrency,
            unitPrice: unitPrice,
            discountPercent: discountPercent,
            converted: converted,
            baseCurrency: baseEntry.getCurrency(),
            belowProviderMinimum: amountMinor < CreditPurchasePricingEngine.MINIMUM_CHARGE_MINOR_UNITS,
        };
    }

    /**
     * Assembles the full buyer-facing options payload for a resolved region:
     * charge currency, unit price, priced packs, and the minimum quantities.
     * @param {CreditConfiguration} configuration
     * @param {string} region — a Regions enum name
     * @returns {Promise<object>}
     */
    static async computeOptions(configuration, region)
    {
        const buyerCurrency = RegionMetadata.getDisplayCurrency(region);
        const unitResolution = await CreditPurchasePricingEngine.resolveUnitPrice(configuration, buyerCurrency);

        if (!unitResolution.available)
        {
            return { available: false, reason: "CREDIT_PRICING_NOT_CONFIGURED" };
        }

        const minimumPurchaseCredits = configuration.getMinimumPurchaseCredits();
        const minimumCreditsForCharge = await CreditPurchasePricingEngine.#findMinimumCreditsForCharge
        (
            configuration,
            buyerCurrency,
            unitResolution.unitPrice,
            minimumPurchaseCredits
        );

        const packs = [];
        for (const pack of configuration.getCreditPacks())
        {
            const packCharge = await CreditPurchasePricingEngine.computeChargeForCredits(configuration, buyerCurrency, pack.getCredits());
            if (!packCharge.available)
            {
                continue;
            }
            packs.push({
                credits: pack.getCredits(),
                discountPercent: pack.getDiscountPercent(),
                amountMinor: packCharge.amountMinor,
                currency: packCharge.currency,
            });
        }

        return {
            available: true,
            region: region,
            currency: unitResolution.currency,
            baseCurrency: unitResolution.baseCurrency,
            currencyConverted: unitResolution.converted,
            unitPrice: unitResolution.unitPrice,
            minimumPurchaseCredits: minimumPurchaseCredits,
            minimumCreditsForCharge: minimumCreditsForCharge,
            minimumChargeMinorUnits: CreditPurchasePricingEngine.MINIMUM_CHARGE_MINOR_UNITS,
            packs: packs,
        };
    }

    /**
     * The smallest integer quantity, at or above the configured purchase
     * minimum, whose charge clears the provider's minimum order amount. A
     * pack discount can drop a candidate back below the floor, so each
     * candidate is verified with the real charge computation.
     */
    static async #findMinimumCreditsForCharge(configuration, buyerCurrency, unitPrice, minimumPurchaseCredits)
    {
        const estimatedMinimum = unitPrice > 0
            ? Math.ceil(CreditPurchasePricingEngine.MINIMUM_CHARGE_MINOR_UNITS / (unitPrice * 100))
            : 1;
        let candidate = Math.max(minimumPurchaseCredits, estimatedMinimum, 1);

        while (candidate <= CreditPurchasePricingEngine.MINIMUM_CHARGE_SEARCH_LIMIT)
        {
            const charge = await CreditPurchasePricingEngine.computeChargeForCredits(configuration, buyerCurrency, candidate);
            if (charge.available && !charge.belowProviderMinimum)
            {
                return candidate;
            }
            candidate = candidate + 1;
        }

        return candidate;
    }

    /**
     * The admin editor's view: the effective per-credit price in EVERY
     * supported currency, flagged explicit (admin-set) vs converted (derived
     * from the base). `pricePerCredit` is null when no FX rate exists for a
     * currency — those buyers are charged in the base currency.
     * @param {CreditConfiguration} configuration
     * @returns {Promise<{ baseCurrency: string|null, prices: Array<{ currency: string, pricePerCredit: number|null, explicit: boolean, converted: boolean }> }>}
     */
    static async computeEffectivePrices(configuration)
    {
        const baseEntry = configuration.getBaseCreditPriceEntry();
        if (!baseEntry)
        {
            return { baseCurrency: null, prices: [] };
        }

        const prices = [];
        for (const currency of RegionMetadata.getSupportedCurrencies())
        {
            const explicitEntry = configuration.getCreditPriceEntryForCurrency(currency);
            if (explicitEntry)
            {
                prices.push({ currency: currency, pricePerCredit: explicitEntry.getPricePerCredit(), explicit: true, converted: false });
                continue;
            }

            const conversion = await CurrencyConverter.convertMinor
            (
                Math.round(baseEntry.getPricePerCredit() * 100),
                baseEntry.getCurrency(),
                currency
            );

            if (conversion.converted)
            {
                prices.push({ currency: currency, pricePerCredit: conversion.amountMinor / 100, explicit: false, converted: true });
            }
            else
            {
                prices.push({ currency: currency, pricePerCredit: null, explicit: false, converted: false });
            }
        }

        return { baseCurrency: baseEntry.getCurrency(), prices: prices };
    }
}

module.exports = CreditPurchasePricingEngine;
