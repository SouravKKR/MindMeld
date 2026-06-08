const OrganizationMemberQueryEngine = require("./OrganizationMemberQueryEngine");
const OrganizationQueryEngine = require("./OrganizationQueryEngine");
const OrganizationDeckPerkQueryEngine = require("./OrganizationDeckPerkQueryEngine");
const { organizationDeckPerkTypes } = require("../../Enumerations/OrganizationDeckPerkTypes");


/**
 * OrganizationPerkResolver
 *
 * Standalone resolver called by PaidDeckPricingEngine inside the
 * per-deck loop. Kept out of the pricing engine itself so the engine
 * stays single-purpose (CLAUDE.md §3).
 *
 * Returns the BEST applicable perk (lowest price) the user is currently
 * eligible to CLAIM. "Eligible to claim" is the claim-window check
 * anchored at when the user joined the org (or the org's activation
 * date for the admin themselves). After the claim window passes, the
 * user no longer sees the perk price even though their already-issued
 * licenses keep working until the license's own expiresAt.
 */
class OrganizationPerkResolver
{
    static #MILLISECONDS_PER_DAY = 86_400_000;

    /**
     * @param {string} userEmail (already lowercased; empty string means no email)
     * @param {string} userId
     * @param {string} deckId
     * @param {number} basePriceMinor — the regional / catalog price we'd
     *        otherwise charge. The resolver never returns a value above
     *        this (the perk should make the price lower or stay the same,
     *        never raise it).
     * @param {string} deckCurrency
     * @returns {Promise<{ applied: boolean, finalPriceMinor: number, organizationId: string, perkType: number, durationDays: number }>}
     */
    static async resolveBestPerk(userEmail, userId, deckId, basePriceMinor, deckCurrency)
    {
        const candidates = [];

        // Members-by-email path.
        if (typeof userEmail === "string" && userEmail.length > 0)
        {
            const memberships = await OrganizationMemberQueryEngine.findActiveMembershipsByEmail(userEmail);
            for (const membership of memberships)
            {
                await OrganizationPerkResolver.#considerOrg
                (
                    candidates,
                    membership.organizationId,
                    membership.addedAt,
                    deckId,
                    basePriceMinor,
                    deckCurrency,
                    membership.organization
                );
            }
        }

        // Admin-by-userId path. The admin is treated as a virtual member
        // joined at the org's activationDate.
        if (typeof userId === "string" && userId.length > 0)
        {
            const adminedOrgs = await OrganizationQueryEngine.listActiveOrganizationsByAdminUserId(userId);
            for (const organization of adminedOrgs)
            {
                await OrganizationPerkResolver.#considerOrg
                (
                    candidates,
                    organization.getId(),
                    organization.getActivationDate(),
                    deckId,
                    basePriceMinor,
                    deckCurrency,
                    null
                );
            }
        }

        if (candidates.length === 0)
        {
            return { applied: false };
        }

        let best = candidates[0];
        for (let candidateIndex = 1; candidateIndex < candidates.length; candidateIndex++)
        {
            if (candidates[candidateIndex].finalPriceMinor < best.finalPriceMinor)
            {
                best = candidates[candidateIndex];
            }
        }
        return { applied: true, ...best };
    }

    static async #considerOrg(candidates, organizationId, memberSinceDate, deckId, basePriceMinor, deckCurrency, prefetchedOrgDocument)
    {
        const perk = await OrganizationDeckPerkQueryEngine.findPerkByOrgAndDeck(organizationId, deckId);
        if (!perk)
        {
            return;
        }

        // Currency-match guard: org perks (INR-only in v1) shouldn't
        // accidentally apply to a USD-priced deck.
        const orgCurrency = prefetchedOrgDocument
            ? prefetchedOrgDocument.currency
            : await OrganizationPerkResolver.#getOrgCurrency(organizationId);
        if (typeof deckCurrency === "string" && deckCurrency.length > 0 && orgCurrency && orgCurrency !== deckCurrency)
        {
            return;
        }

        if (!OrganizationPerkResolver.#isWithinClaimWindow(memberSinceDate, perk.getDurationDays()))
        {
            return;
        }

        const finalPriceMinor = OrganizationPerkResolver.#computeFinalPrice
        (
            perk.getPerkType(),
            perk.getPerkValue(),
            basePriceMinor
        );

        if (finalPriceMinor > basePriceMinor)
        {
            // Defensive: a FIXED_OVERRIDE perkValue larger than the base
            // price would otherwise upsell the user — that's not the
            // intent of an org perk. Skip in that case.
            return;
        }

        candidates.push
        ({
            finalPriceMinor: finalPriceMinor,
            organizationId: organizationId,
            perkType: perk.getPerkType(),
            durationDays: perk.getDurationDays()
        });
    }

    static async #getOrgCurrency(organizationId)
    {
        const organization = await OrganizationQueryEngine.getOrganizationById(organizationId);
        return organization ? organization.getCurrency() : null;
    }

    static #isWithinClaimWindow(memberSinceDate, durationDays)
    {
        if (!Number.isInteger(durationDays) || durationDays <= 0)
        {
            return true; // FOREVER claim window.
        }
        if (!(memberSinceDate instanceof Date))
        {
            return false;
        }
        const elapsedMilliseconds = Date.now() - memberSinceDate.getTime();
        const windowMilliseconds = durationDays * OrganizationPerkResolver.#MILLISECONDS_PER_DAY;
        return elapsedMilliseconds <= windowMilliseconds;
    }

    static #computeFinalPrice(perkType, perkValue, basePriceMinor)
    {
        if (perkType === organizationDeckPerkTypes.FREE)
        {
            return 0;
        }
        if (perkType === organizationDeckPerkTypes.FIXED_OVERRIDE)
        {
            return Math.max(0, perkValue);
        }
        if (perkType === organizationDeckPerkTypes.PERCENTAGE_DISCOUNT)
        {
            const clampedPercent = Math.max(0, Math.min(100, perkValue));
            const discountMinor = Math.floor(basePriceMinor * clampedPercent / 100);
            return Math.max(0, basePriceMinor - discountMinor);
        }
        return basePriceMinor;
    }
}

module.exports = OrganizationPerkResolver;
