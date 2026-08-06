const OrganizationQueryEngine = require("./OrganizationQueryEngine");
const OrganizationMemberQueryEngine = require("./OrganizationMemberQueryEngine");
const { organizationStatus } = require("../../Enumerations/OrganizationStatus");


/**
 * OrganizationScopeResolver
 *
 * Turns "which view is this request in" into the storage scope its data belongs
 * to — and re-authorises the claim before believing it.
 *
 * A user's own library and an organization's are separate NAMESPACES rather
 * than one library filtered two ways. Filtering would mean every surface that
 * reads decks — search, the deck pickers, the storage manager, export — had to
 * apply the same predicate, and any one that forgot would leak personal decks
 * into an institute's view or the reverse. Separate scopes make that
 * structurally impossible: the other view's rows are simply not in the result.
 *
 * The scope key is the value every per-user collection is keyed by:
 *
 *     personal      <userId>
 *     org view      <userId>::org:<organizationId>
 *
 * SyncQueryEngine and the rest treat that value as an opaque owner string, so
 * they needed no changes — which is exactly why this shape was chosen.
 *
 * The context arrives in a request HEADER, and a header is a client claim. It
 * is therefore checked against stored membership on every request: a caller who
 * is not an active member of that organization silently falls back to their
 * personal scope. Silently, because the honest case for a stale header is a
 * membership that ended while a device still had the view open — that user
 * should land back in their own library, not see an error.
 */
class OrganizationScopeResolver
{
    static CONTEXT_HEADER_NAME = "x-organization-context";

    static #SCOPE_SEPARATOR = "::org:";

    /**
     * Composes a scope key. Kept here rather than inline at each call site so
     * the format has one definition on the server, matching the one the client
     * has for its storage prefix.
     */
    static buildScopeKey(userId, organizationId)
    {
        if (typeof organizationId !== "string" || organizationId.length === 0)
        {
            return userId;
        }
        return `${userId}${OrganizationScopeResolver.#SCOPE_SEPARATOR}${organizationId}`;
    }

    /**
     * True when a scope key is an organization scope rather than a personal one.
     */
    static isOrganizationScopeKey(scopeKey)
    {
        return typeof scopeKey === "string" && scopeKey.indexOf(OrganizationScopeResolver.#SCOPE_SEPARATOR) > 0;
    }

    /**
     * The organization context a request claims, before any authorisation.
     */
    static readClaimedContext(request)
    {
        const headerValue = request?.headers ? request.headers[OrganizationScopeResolver.CONTEXT_HEADER_NAME] : "";
        return typeof headerValue === "string" ? headerValue.trim() : "";
    }

    /**
     * Resolves the scope a request should read and write in.
     *
     * @param {object} request
     * @param {string} userId the authenticated user
     * @returns {Promise<{ scopeKey: string, organizationId: string|null, organization: Organization|null }>}
     */
    static async resolve(request, userId)
    {
        const claimedOrganizationId = OrganizationScopeResolver.readClaimedContext(request);

        if (claimedOrganizationId.length === 0)
        {
            return { scopeKey: userId, organizationId: null, organization: null };
        }

        const authorisation = await OrganizationScopeResolver.authoriseContext(userId, claimedOrganizationId, request?.user);
        if (!authorisation.permitted)
        {
            // Fall back rather than refuse: a stale context means a membership
            // ended, and that user belongs in their own library.
            return { scopeKey: userId, organizationId: null, organization: null };
        }

        return {
            scopeKey: OrganizationScopeResolver.buildScopeKey(userId, claimedOrganizationId),
            organizationId: claimedOrganizationId,
            organization: authorisation.organization
        };
    }

    /**
     * Whether this account may act inside this organization's view.
     *
     * Membership is the test, not administration: an ordinary member has a view
     * and an owner is not automatically one unless they are also a member. The
     * owner is treated as a member of their own organization, because otherwise
     * the person running an institute could not see what their people see.
     *
     * @param {string} userId
     * @param {string} organizationId
     * @param {User|null} user the loaded user, when the caller already has it
     * @returns {Promise<{ permitted: boolean, organization: Organization|null }>}
     */
    static async authoriseContext(userId, organizationId, user)
    {
        const organization = await OrganizationQueryEngine.getOrganizationById(organizationId);
        if (!organization || organization.getStatus() !== organizationStatus.ACTIVE)
        {
            return { permitted: false, organization: null };
        }

        if (organization.getAdminUserId() && organization.getAdminUserId() === userId)
        {
            return { permitted: true, organization: organization };
        }

        const email = user && typeof user.getAdditionalData === "function"
            ? (user.getAdditionalData()?.email || "")
            : "";

        const member = await OrganizationMemberQueryEngine.findMemberByUserIdOrEmail(organizationId, userId, email);
        return { permitted: member !== null, organization: member !== null ? organization : null };
    }

    /**
     * Every scope key this account owns — their personal one plus one per
     * organization they belong to.
     *
     * Storage accounting needs this: the plan cap is the USER's, so it has to
     * be measured against everything they hold, wherever it lives.
     *
     * @param {User} user
     * @returns {Promise<{ scopeKeys: string[], organizations: Array<Organization> }>}
     */
    static async listAllScopeKeysForUser(user)
    {
        const userId = user.getId();
        const scopeKeys = [userId];
        const organizations = [];

        const email = (user.getAdditionalData()?.email || "").toLowerCase();
        if (email.length > 0)
        {
            const memberships = await OrganizationMemberQueryEngine.findActiveMembershipsByEmail(email);
            for (const membership of memberships)
            {
                const organization = await OrganizationQueryEngine.getOrganizationById(membership.organizationId);
                if (organization && organization.getStatus() === organizationStatus.ACTIVE)
                {
                    scopeKeys.push(OrganizationScopeResolver.buildScopeKey(userId, organization.getId()));
                    organizations.push(organization);
                }
            }
        }

        const ownedOrganizations = await OrganizationQueryEngine.listActiveOrganizationsByAdminUserId(userId);
        for (const organization of ownedOrganizations)
        {
            const scopeKey = OrganizationScopeResolver.buildScopeKey(userId, organization.getId());
            if (!scopeKeys.includes(scopeKey))
            {
                scopeKeys.push(scopeKey);
                organizations.push(organization);
            }
        }

        return { scopeKeys: scopeKeys, organizations: organizations };
    }
}

module.exports = OrganizationScopeResolver;
