/**
 * OrganizationContextIdentity
 *
 * Composes and parses the storage identity of an organization view.
 *
 * The app already namespaces every stored path under `Users/<identity>/`, and
 * `Deck` rebuilds itself from scratch whenever the identity changes. Making an
 * organization view a DIFFERENT IDENTITY rather than a filter over the personal
 * one therefore costs nothing and buys everything: the personal decks are not
 * in memory at all while the view is active, so no surface — search, the deck
 * pickers, the storage manager, export — can leak one library into the other by
 * forgetting a predicate.
 *
 *     personal      <userId>
 *     org view      <userId>::org:<organizationId>
 *
 * The separator is byte-identical to the one
 * Dock/Globals/Classes/Organization/OrganizationScopeResolver.js builds server
 * side, because the two must agree on the owner key of every synced row. Change
 * it in one place and every organization library silently orphans, so it is
 * defined here once and never inlined.
 */
class OrganizationContextIdentity
{
    static SEPARATOR = "::org:";

    /**
     * The identity for a view. A blank organization id means the personal view,
     * so a caller can pass whatever it has without branching first.
     *
     * @param {string} userId
     * @param {string} organizationId
     * @returns {string}
     */
    static compose(userId, organizationId)
    {
        if (typeof organizationId !== "string" || organizationId.length === 0)
        {
            return userId;
        }

        return `${userId}${OrganizationContextIdentity.SEPARATOR}${organizationId}`;
    }

    /**
     * The account id inside an identity, whichever view it names.
     *
     * @param {string} identity
     * @returns {string}
     */
    static extractUserId(identity)
    {
        if (typeof identity !== "string")
        {
            return "";
        }

        const separatorIndex = identity.indexOf(OrganizationContextIdentity.SEPARATOR);
        return separatorIndex > 0 ? identity.slice(0, separatorIndex) : identity;
    }

    /**
     * The organization an identity is viewing, or "" for the personal view.
     *
     * @param {string} identity
     * @returns {string}
     */
    static extractOrganizationId(identity)
    {
        if (typeof identity !== "string")
        {
            return "";
        }

        const separatorIndex = identity.indexOf(OrganizationContextIdentity.SEPARATOR);
        return separatorIndex > 0 ? identity.slice(separatorIndex + OrganizationContextIdentity.SEPARATOR.length) : "";
    }

    /**
     * True when this identity names an organization view.
     */
    static isOrganizationIdentity(identity)
    {
        return OrganizationContextIdentity.extractOrganizationId(identity).length > 0;
    }
}

export default OrganizationContextIdentity;
