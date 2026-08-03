const LicenseExpiryResolver = require("./LicenseExpiryResolver");

/**
 * LicenseDurationConfigurationResolver
 *
 * Decides WHICH duration configuration applies to a deck, before
 * LicenseExpiryResolver turns that configuration into a concrete expiry date.
 * The two are deliberately separate: this class knows about the pricing
 * hierarchy (regional row -> deck default -> implicit fallback), while
 * LicenseExpiryResolver stays a pure configuration-to-date function.
 *
 * The resolution order is:
 *
 *   1. The active regional PaidDeckPricing row, when it explicitly configures a
 *      finite rental or perpetual access.
 *   2. The deck document's own duration default. A regional row that leaves both
 *      fields blank inherits the deck-level default rather than making the deck
 *      unpurchasable — this inheritance was always the documented intent of the
 *      admin upload form, but the pricing engine used to read the regional row
 *      alone, so a deck sold as perpetual with a blank regional row was refused
 *      at checkout.
 *   3. Free / fully-discounted decks are implicitly PERPETUAL. There is no
 *      rental term to configure when nothing is being sold, so demanding one is
 *      pure friction: the buyer just wants the deck added to their library.
 *   4. Anything still unconfigured (a priced deck created before the duration
 *      fields existed) falls back to PERPETUAL as well, matching the semantics
 *      every such deck was actually sold under historically — every license
 *      issued before the duration feature landed uses the FOREVER sentinel.
 *      Refusing the sale instead leaves the whole legacy catalogue unbuyable,
 *      which is strictly worse for both buyer and seller. Callers are told the
 *      grant rode this fallback (durationSource) so the misconfiguration can be
 *      logged and corrected.
 *
 * Operators who would rather have step 4 refuse the sale — forcing every priced
 * deck to declare its term explicitly — set
 * PAID_DECK_REQUIRE_EXPLICIT_LICENSE_DURATION=true. That restores the strict
 * gate for priced decks only; step 3 (free decks) is never gated, because a
 * zero-price grant has no term to declare.
 */
class LicenseDurationConfigurationResolver
{
    static SOURCE_REGIONAL_PRICING = "REGIONAL_PRICING";
    static SOURCE_DECK_DEFAULT = "DECK_DEFAULT";
    static SOURCE_FREE_IMPLICIT_PERPETUAL = "FREE_IMPLICIT_PERPETUAL";
    static SOURCE_LEGACY_IMPLICIT_PERPETUAL = "LEGACY_IMPLICIT_PERPETUAL";
    static SOURCE_UNSPECIFIED = "UNSPECIFIED";

    /**
     * Whether a priced deck with no explicit duration anywhere should be refused
     * instead of granted perpetually.
     */
    static requiresExplicitConfiguration()
    {
        return String(process.env.PAID_DECK_REQUIRE_EXPLICIT_LICENSE_DURATION || "").trim().toLowerCase() === "true";
    }

    /**
     * Whether a configuration carrier (a pricing row or a deck document) states
     * a duration at all. Delegated to LicenseExpiryResolver so "explicit" means
     * exactly the same thing here as it does at grant time.
     *
     * @param {object} configurationCarrier a document carrying durationDays / isPerpetual
     *
     * @returns {boolean} true when a finite window or perpetual access is declared
     */
    static isExplicitlyConfigured(configurationCarrier)
    {
        return LicenseExpiryResolver.isGrantable(configurationCarrier);
    }

    /**
     * Whether a resolved configuration came from an implicit fallback rather
     * than from something an admin actually configured. Grant paths use this to
     * log the misconfiguration while still serving the buyer.
     *
     * @param {string} durationSource one of the SOURCE_* constants
     *
     * @returns {boolean} true for the free / legacy implicit fallbacks
     */
    static isImplicitFallback(durationSource)
    {
        return durationSource === LicenseDurationConfigurationResolver.SOURCE_FREE_IMPLICIT_PERPETUAL
            || durationSource === LicenseDurationConfigurationResolver.SOURCE_LEGACY_IMPLICIT_PERPETUAL;
    }

    /**
     * Resolves the effective duration configuration for one deck.
     *
     * @param {object} regionalPricing the active PaidDeckPricing row, or null when none exists
     * @param {object} deckDocument the PaidDeck document, or null when it could not be loaded
     * @param {number} finalPriceMinor the price the buyer would actually pay, in minor units
     *
     * @returns {{ durationDays: number, isPerpetual: boolean, durationSource: string }}
     */
    static resolve(regionalPricing, deckDocument, finalPriceMinor)
    {
        if (LicenseDurationConfigurationResolver.isExplicitlyConfigured(regionalPricing))
        {
            return LicenseDurationConfigurationResolver.#normalize(regionalPricing, LicenseDurationConfigurationResolver.SOURCE_REGIONAL_PRICING);
        }

        if (LicenseDurationConfigurationResolver.isExplicitlyConfigured(deckDocument))
        {
            return LicenseDurationConfigurationResolver.#normalize(deckDocument, LicenseDurationConfigurationResolver.SOURCE_DECK_DEFAULT);
        }

        if (Number(finalPriceMinor) === 0)
        {
            return {
                durationDays: 0,
                isPerpetual: true,
                durationSource: LicenseDurationConfigurationResolver.SOURCE_FREE_IMPLICIT_PERPETUAL
            };
        }

        if (!LicenseDurationConfigurationResolver.requiresExplicitConfiguration())
        {
            return {
                durationDays: 0,
                isPerpetual: true,
                durationSource: LicenseDurationConfigurationResolver.SOURCE_LEGACY_IMPLICIT_PERPETUAL
            };
        }

        return {
            durationDays: 0,
            isPerpetual: false,
            durationSource: LicenseDurationConfigurationResolver.SOURCE_UNSPECIFIED
        };
    }

    /**
     * Copies the duration fields off a carrier document into a canonical,
     * fully-typed configuration. A non-integer or non-positive day count becomes
     * 0 and anything other than boolean true becomes false, so a malformed row
     * can never reach LicenseExpiryResolver as a half-valid window.
     */
    static #normalize(configurationCarrier, durationSource)
    {
        const durationDays = configurationCarrier.durationDays;

        return {
            durationDays: Number.isInteger(durationDays) && durationDays > 0 ? durationDays : 0,
            isPerpetual: configurationCarrier.isPerpetual === true,
            durationSource: durationSource
        };
    }
}

module.exports = LicenseDurationConfigurationResolver;
