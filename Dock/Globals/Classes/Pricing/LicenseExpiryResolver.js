const DeckLicense = require("../../Model/DeckLicense");

/**
 * LicenseExpiryResolver
 *
 * Single source of truth for turning a deck's duration configuration
 * (durationDays / isPerpetual, as surfaced on a PaidDeckPricingEngine breakdown
 * entry) into a concrete DeckLicense expiry.
 *
 * The historical behaviour was "forever by default" — every non-org-perk grant
 * silently used the epoch-zero FOREVER sentinel because there was no field to
 * express a finite rental. Perpetual access is now granted ONLY when it was
 * explicitly sold that way:
 *
 *   durationDays > 0        -> FINITE      (expires at now + durationDays)
 *   isPerpetual === true     -> PERPETUAL   (FOREVER sentinel)
 *   neither                  -> UNSPECIFIED (caller must refuse to grant)
 *
 * durationDays takes precedence over isPerpetual so a mistakenly-set pair never
 * silently becomes perpetual — a positive duration always wins. The resolver is
 * pure (no clock read except the finite-expiry offset) so it is unit-testable
 * and identical across every grant path (paid checkout, free grant, org perk).
 */
class LicenseExpiryResolver
{
    static MILLISECONDS_PER_DAY = 86_400_000;

    static STATUS_FINITE = "FINITE";
    static STATUS_PERPETUAL = "PERPETUAL";
    static STATUS_UNSPECIFIED = "UNSPECIFIED";

    /**
     * Resolves a duration configuration into a license expiry decision.
     * @param {object} configuration
     * @param {number} [configuration.durationDays] Positive integer for a finite rental; 0 / absent otherwise.
     * @param {boolean} [configuration.isPerpetual] True when the deck is explicitly sold as lifetime access.
     * @param {Date} [now] Injectable clock for deterministic tests; defaults to the current time.
     * @returns {{ status: string, expiresAt: (Date|null) }}
     *   status is one of STATUS_FINITE / STATUS_PERPETUAL / STATUS_UNSPECIFIED.
     *   expiresAt is a future Date (FINITE), the FOREVER sentinel (PERPETUAL) or null (UNSPECIFIED).
     */
    static resolve(configuration, now = new Date())
    {
        const durationDays = configuration ? configuration.durationDays : undefined;
        const isPerpetual = configuration ? configuration.isPerpetual : undefined;

        if (Number.isInteger(durationDays) && durationDays > 0)
        {
            return {
                status: LicenseExpiryResolver.STATUS_FINITE,
                expiresAt: new Date(now.getTime() + durationDays * LicenseExpiryResolver.MILLISECONDS_PER_DAY)
            };
        }

        if (isPerpetual === true)
        {
            return {
                status: LicenseExpiryResolver.STATUS_PERPETUAL,
                expiresAt: DeckLicense.FOREVER
            };
        }

        return {
            status: LicenseExpiryResolver.STATUS_UNSPECIFIED,
            expiresAt: null
        };
    }

    /**
     * Convenience predicate — true when the configuration is grantable (either
     * an explicit finite duration or an explicit perpetual flag). A grant path
     * uses this to refuse a misconfigured deck before charging / issuing.
     */
    static isGrantable(configuration, now = new Date())
    {
        return LicenseExpiryResolver.resolve(configuration, now).status !== LicenseExpiryResolver.STATUS_UNSPECIFIED;
    }
}

module.exports = LicenseExpiryResolver;
