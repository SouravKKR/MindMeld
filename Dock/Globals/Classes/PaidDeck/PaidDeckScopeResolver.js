const OrganizationScopeResolver = require("../Organization/OrganizationScopeResolver");


/**
 * PaidDeckScopeResolver
 *
 * Which storage scope a licensed deck's seeded rows live in.
 *
 * A license belongs to the PERSON — it is keyed by the personal user id however
 * the deck was acquired, so revocation, expiry and password unlock all keep one
 * subject. The seeded content is a different question: it has to land in the
 * library the buyer will actually look at. A marketplace purchase belongs in
 * their own library; an organization's deck belongs in that organization's view
 * and must be absent from the personal one.
 *
 * DeckLicense.scopeKey records that decision once, at grant time. Everything
 * downstream — the re-seed filter, the per-copy delete, the content update and
 * the lapsed-license reaper — asks here rather than assuming the personal id,
 * which is what made those paths write to the wrong library before.
 *
 * An empty scopeKey means "personal", so every license issued before this
 * existed keeps behaving exactly as it did.
 */
class PaidDeckScopeResolver
{
    /**
     * The scope a license's seeded rows belong to.
     *
     * @param {DeckLicense|object|null} license
     * @param {string} userId the personal user id, used when no scope is recorded
     * @returns {string}
     */
    static resolveForLicense(license, userId)
    {
        if (!license)
        {
            return userId;
        }

        const scopeKey = typeof license.getScopeKey === "function" ? license.getScopeKey() : license.scopeKey;
        if (typeof scopeKey !== "string" || scopeKey.length === 0)
        {
            return userId;
        }

        return scopeKey;
    }

    /**
     * True when this license's content was seeded into an organization's view
     * rather than the buyer's own library.
     */
    static isOrganizationScopedLicense(license)
    {
        const scopeKey = license && typeof license.getScopeKey === "function" ? license.getScopeKey() : license?.scopeKey;
        return OrganizationScopeResolver.isOrganizationScopeKey(scopeKey);
    }

    /**
     * The Mongo condition matching the licenses one view may see.
     *
     * In an organization view a member sees that organization's decks and none
     * of their marketplace purchases — the marketplace is a personal-view
     * surface, and a purchase following someone into an institute's library
     * would put private content in a place their institute administers.
     *
     * `null` is in the personal list on purpose: every license issued before
     * scoping existed has no scopeKey field at all, and `$in: [null]` is the
     * only form that matches a MISSING field. Without it this filter would hide
     * every pre-existing purchase from its own buyer.
     *
     * @param {string} scopeKey the resolved scope of the current request
     * @param {string} userId
     * @returns {object} a Mongo condition for the scopeKey field
     */
    static buildVisibleScopeCondition(scopeKey, userId)
    {
        if (scopeKey === userId)
        {
            return { $in: ["", null, userId] };
        }

        return { $in: [scopeKey] };
    }
}

module.exports = PaidDeckScopeResolver;
