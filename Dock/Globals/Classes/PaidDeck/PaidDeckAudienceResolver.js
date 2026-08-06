const OrganizationScopeResolver = require("../Organization/OrganizationScopeResolver");
const OrganizationQueryEngine = require("../Organization/OrganizationQueryEngine");
const OrganizationMemberQueryEngine = require("../Organization/OrganizationMemberQueryEngine");
const { organizationStatus } = require("../../Enumerations/OrganizationStatus");
const { userRoles } = require("../../Enumerations/UserRoles");

/**
 * PaidDeckAudienceResolver
 *
 * Who is allowed to SEE a paid deck.
 *
 * A deck has one audience, recorded on the deck itself:
 *
 *     audienceOrganizationId = ""      the public catalogue
 *     audienceOrganizationId = <id>    that organization's members, and nobody else
 *
 * `audienceTags` narrows who a deck is *suggested to* inside its organization —
 * it is a default filter on the shelf, deliberately NOT an access rule. A
 * student outside the targeted cohort who goes looking may still add the deck;
 * an institute wanting a deck restricted publishes it to a different audience,
 * rather than relying on a filter to keep anybody out. Conflating the two would
 * make the shelf's "show everything" toggle a privilege-escalation button.
 *
 * The condition is composed here once and applied on every read path — browse,
 * search, details, the shelf — because a path that forgot it would expose one
 * institute's material to another's students, and that is not the kind of
 * mistake that announces itself.
 *
 * Super-admins are unrestricted: they administer every organization, and a
 * catalogue they cannot fully see is a catalogue they cannot moderate.
 */
class PaidDeckAudienceResolver
{
    /**
     * The account a public route should judge the audience against.
     *
     * The catalogue routes carry no ensureLogin plugin — a storefront has to be
     * reachable before anyone owns anything — so request.session is not
     * populated on them and the session has to be resolved explicitly. Used for
     * VISIBILITY only; what each route passes to the pricing engine is left
     * exactly as it was, so resolving a caller here can never change what
     * anybody is charged.
     *
     * @param {object} request
     * @returns {Promise<User|null>}
     */
    static async resolveAudienceUser(request)
    {
        // Lazily required: this class is reachable from the model layer, and a
        // top-level require would form a cycle through the session helper.
        const { getSession } = require("../../../Endpoints/Helpers/GetSession");
        const AuthenticationQueryEngine = require("../Database/AuthenticationQueryEngine");

        try
        {
            const session = request?.session || await getSession(request);
            if (!session)
            {
                return null;
            }

            return await AuthenticationQueryEngine.getUserById(session.getUserId());
        }
        catch (resolveError)
        {
            // Failing to identify the caller means treating them as the public,
            // which shows LESS. A visibility check must fail closed.
            console.warn(`[PaidDeckAudienceResolver] Could not resolve the caller: ${resolveError?.message || resolveError}`);
            return null;
        }
    }

    /**
     * Every organization whose decks this account may see. Membership, not
     * administration — an ordinary member has the audience, and an owner has it
     * because they are treated as a member of their own organization.
     *
     * @param {User|null} user
     * @returns {Promise<string[]>}
     */
    static async listAudienceOrganizationIds(user)
    {
        if (!user)
        {
            return [];
        }

        const scope = await OrganizationScopeResolver.listAllScopeKeysForUser(user);
        return scope.organizations.map(organization => organization.getId());
    }

    /**
     * The Mongo condition restricting a query to what this account may see.
     * Returns null for a caller who may see everything, so call sites can skip
     * adding a clause rather than adding a vacuous one.
     *
     * @param {User|null} user
     * @returns {Promise<object|null>}
     */
    static async buildVisibilityCondition(user)
    {
        if (user && typeof user.getRole === "function" && user.getRole() === userRoles.ADMIN)
        {
            return null;
        }

        const audienceOrganizationIds = await PaidDeckAudienceResolver.listAudienceOrganizationIds(user);

        // `$exists: false` is in the list on purpose: every deck published
        // before audiences existed has no field at all, and omitting this would
        // empty the public catalogue in one deploy.
        const publicCondition =
        {
            $or:
            [
                { audienceOrganizationId: "" },
                { audienceOrganizationId: null },
                { audienceOrganizationId: { $exists: false } }
            ]
        };

        if (audienceOrganizationIds.length === 0)
        {
            return publicCondition;
        }

        return { $or: [...publicCondition.$or, { audienceOrganizationId: { $in: audienceOrganizationIds } }] };
    }

    /**
     * Whether one already-loaded deck document is visible to this account.
     *
     * Used where a document is fetched by id and the condition cannot be folded
     * into the query — the answer must be identical to buildVisibilityCondition,
     * so both live here.
     *
     * @param {object} paidDeckDocument
     * @param {User|null} user
     * @returns {Promise<boolean>}
     */
    static async isVisibleTo(paidDeckDocument, user)
    {
        const audienceOrganizationId = PaidDeckAudienceResolver.readAudienceOrganizationId(paidDeckDocument);
        if (audienceOrganizationId.length === 0)
        {
            return true;
        }

        if (user && typeof user.getRole === "function" && user.getRole() === userRoles.ADMIN)
        {
            return true;
        }

        const audienceOrganizationIds = await PaidDeckAudienceResolver.listAudienceOrganizationIds(user);
        return audienceOrganizationIds.includes(audienceOrganizationId);
    }

    /**
     * The audience of a deck document or model, normalised to a string. A deck
     * predating audiences reads as public, which is what it has always been.
     */
    static readAudienceOrganizationId(paidDeck)
    {
        if (!paidDeck)
        {
            return "";
        }

        const value = typeof paidDeck.getAudienceOrganizationId === "function"
            ? paidDeck.getAudienceOrganizationId()
            : paidDeck.audienceOrganizationId;

        return typeof value === "string" ? value : "";
    }

    /**
     * True when a deck belongs to an organization rather than the catalogue.
     * These are never for sale — an institute provides them to its members, so
     * no order is ever created for one and no payment path is ever entered.
     */
    static isOrganizationDeck(paidDeck)
    {
        return PaidDeckAudienceResolver.readAudienceOrganizationId(paidDeck).length > 0;
    }

    /**
     * Which of these deck ids belong to an organization rather than the
     * catalogue. Used by the checkout entry point to refuse them outright: an
     * institute's deck is provided, not sold, so no order may exist for one.
     *
     * @param {string[]} deckIds
     * @returns {Promise<string[]>}
     */
    static async listOrganizationDeckIds(deckIds)
    {
        if (!Array.isArray(deckIds) || deckIds.length === 0)
        {
            return [];
        }

        const DatabaseConnector = require("../Database/DatabaseConnector");
        const DatabaseConstants = require("../../Constants/DatabaseConstants");

        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            // Unknown is not the same as public. A checkout that cannot verify
            // the audience must not proceed, so every id is reported as scoped.
            return deckIds.slice();
        }

        const scopedDocuments = await database
            .collection(DatabaseConstants.PAID_DECKS_COLLECTION)
            .find
            ({
                id: { $in: deckIds },
                audienceOrganizationId: { $nin: ["", null] }
            }, { projection: { _id: 0, id: 1 } })
            .toArray();

        return scopedDocuments.map(document => document.id);
    }

    /**
     * Confirms an account is an active member of a deck's audience, loading the
     * organization to check it is still active.
     *
     * Separate from isVisibleTo because acquiring is a stronger act than
     * looking: this is the check the shelf's Add uses, and it deliberately does
     * NOT accept a super-admin's blanket visibility — an operator browsing a
     * catalogue should not accidentally seed an institute's deck into their own
     * account.
     *
     * @param {string} audienceOrganizationId
     * @param {User} user
     * @returns {Promise<{ member: boolean, organization: Organization|null }>}
     */
    static async requireActiveMembership(audienceOrganizationId, user)
    {
        if (typeof audienceOrganizationId !== "string" || audienceOrganizationId.length === 0 || !user)
        {
            return { member: false, organization: null };
        }

        const organization = await OrganizationQueryEngine.getOrganizationById(audienceOrganizationId);
        if (!organization || organization.getStatus() !== organizationStatus.ACTIVE)
        {
            return { member: false, organization: null };
        }

        if (organization.getAdminUserId() && organization.getAdminUserId() === user.getId())
        {
            return { member: true, organization: organization };
        }

        const email = user.getAdditionalData()?.email || "";
        const member = await OrganizationMemberQueryEngine.findMemberByUserIdOrEmail(audienceOrganizationId, user.getId(), email);

        return { member: member !== null, organization: member !== null ? organization : null };
    }
}

module.exports = PaidDeckAudienceResolver;
