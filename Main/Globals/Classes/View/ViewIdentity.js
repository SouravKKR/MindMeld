import PlanMetadataConstants from "../../Constants/PlanMetadataConstants.js";

/**
 * ViewIdentity
 *
 * The grammar of a storage identity — the single parser for every kind of view.
 *
 *     personal     <userId>
 *     org view     <userId>::org:<organizationId>
 *     plan view    <userId>::plan:<PLAN_TIER_NAME>
 *
 * A view is a DIFFERENT IDENTITY rather than a filter over the personal one,
 * because Persistence namespaces every path under `Users/<identity>/` and Deck
 * rebuilds itself from scratch whenever the identity changes. The other
 * library's decks are therefore absent from memory rather than hidden, so no
 * surface — search, the deck pickers, the storage manager, export — can leak one
 * library into another by forgetting a predicate.
 *
 * This class owns BOTH separators rather than leaving each kind of view its own
 * codec. extractUserId has to be right for EVERY kind, and a per-kind codec
 * would force each caller to chain parsers and would leave "which separator wins
 * in a malformed identity" answered in two files that can drift apart. One
 * grammar, one parser; the classes above it only decide policy.
 *
 * The separators are byte-identical to the ones the server builds
 * (Dock/Globals/Classes/Organization/OrganizationScopeResolver.js and
 * Dock/Globals/Classes/View/PlanViewScopeKey.js), because the two sides must
 * agree on the owner key of every synced row. Change one and every library of
 * that kind silently orphans.
 */
class ViewIdentity
{
    static ORGANIZATION_SEPARATOR = "::org:";
    static PLAN_SEPARATOR = "::plan:";

    static #ALL_SEPARATORS = [ViewIdentity.ORGANIZATION_SEPARATOR, ViewIdentity.PLAN_SEPARATOR];

    /**
     * The identity of an organization view. A blank organization id means the
     * personal view, so a caller can pass whatever it has without branching.
     *
     * @param {string} userId
     * @param {string} organizationId
     * @returns {string}
     */
    static composeOrganization(userId, organizationId)
    {
        if (typeof organizationId !== "string" || organizationId.length === 0)
        {
            return userId;
        }

        return `${userId}${ViewIdentity.ORGANIZATION_SEPARATOR}${organizationId}`;
    }

    /**
     * The identity of a simulated plan sandbox.
     *
     * The tier NAME is used rather than its enum ordinal so a scope key reads as
     * itself in the database and in a log line, and so renumbering the enum can
     * never silently repoint an existing sandbox at a different tier's data.
     *
     * @param {string} userId
     * @param {string} planTierName
     * @returns {string}
     */
    static composePlan(userId, planTierName)
    {
        if (!ViewIdentity.isKnownPlanTierName(planTierName))
        {
            return userId;
        }

        return `${userId}${ViewIdentity.PLAN_SEPARATOR}${planTierName}`;
    }

    /**
     * The account id inside an identity, whichever view it names. Anything that
     * identifies the PERSON — their plan, their credit balance, their profile —
     * must use this rather than the identity, which names a library.
     *
     * Cuts at the EARLIEST separator, so an identity that somehow carries more
     * than one marker degrades to the account rather than to a namespace nothing
     * will ever sync.
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

        let earliestSeparatorIndex = -1;

        for (const separator of ViewIdentity.#ALL_SEPARATORS)
        {
            const separatorIndex = identity.indexOf(separator);

            if (separatorIndex > 0 && (earliestSeparatorIndex === -1 || separatorIndex < earliestSeparatorIndex))
            {
                earliestSeparatorIndex = separatorIndex;
            }
        }

        return earliestSeparatorIndex > 0 ? identity.slice(0, earliestSeparatorIndex) : identity;
    }

    /**
     * The organization an identity is viewing, or "" for anything else.
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

        const separatorIndex = identity.indexOf(ViewIdentity.ORGANIZATION_SEPARATOR);

        if (separatorIndex <= 0)
        {
            return "";
        }

        return identity.slice(separatorIndex + ViewIdentity.ORGANIZATION_SEPARATOR.length);
    }

    /**
     * The simulated tier an identity is viewing, or "" for anything else.
     *
     * Validated against PlanMetadataConstants here rather than by the caller, so
     * a hand-edited IndexedDB value collapses to the personal view by
     * construction on the client — exactly as a forged header collapses to it on
     * the server.
     *
     * @param {string} identity
     * @returns {string}
     */
    static extractPlanTierName(identity)
    {
        if (typeof identity !== "string")
        {
            return "";
        }

        const separatorIndex = identity.indexOf(ViewIdentity.PLAN_SEPARATOR);

        if (separatorIndex <= 0)
        {
            return "";
        }

        const planTierName = identity.slice(separatorIndex + ViewIdentity.PLAN_SEPARATOR.length);

        return ViewIdentity.isKnownPlanTierName(planTierName) ? planTierName : "";
    }

    static isKnownPlanTierName(planTierName)
    {
        return typeof planTierName === "string" && PlanMetadataConstants.ORDER.includes(planTierName);
    }

    static isOrganizationIdentity(identity)
    {
        return ViewIdentity.extractOrganizationId(identity).length > 0;
    }

    static isPlanIdentity(identity)
    {
        return ViewIdentity.extractPlanTierName(identity).length > 0;
    }

    static isPersonalIdentity(identity)
    {
        return !ViewIdentity.isOrganizationIdentity(identity) && !ViewIdentity.isPlanIdentity(identity);
    }
}

export default ViewIdentity;
