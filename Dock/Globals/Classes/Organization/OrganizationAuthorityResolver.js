const OrganizationQueryEngine = require("./OrganizationQueryEngine");
const OrganizationMemberQueryEngine = require("./OrganizationMemberQueryEngine");
const { userRoles } = require("../../Enumerations/UserRoles");
const { organizationDelegatePowers } = require("../../Enumerations/OrganizationDelegatePowers");
const { httpStatus } = require("../../Enumerations/HttpStatus");
const ErrorCodes = require("../../Constants/ErrorCodes");


/**
 * OrganizationAuthorityResolver
 *
 * The single answer to "may this user do X to this organization".
 *
 * Three kinds of caller are authorised, in descending order:
 *
 *   1. A super-admin, who may do anything to any organization.
 *   2. The organization's OWNER (Organization.adminUserId), who holds every
 *      power over their own organization and no power over any other.
 *   3. A DELEGATE — an ordinary member the owner has handed specific powers to,
 *      stored as a bitwise flag set on their membership row. A delegate holds
 *      exactly the powers that were ticked and nothing else; in particular a
 *      delegate can never appoint another delegate, because that is an owner
 *      action rather than a delegate power.
 *
 * Ownership used to be re-derived inline in every handler as
 * `role !== ADMIN && organization.getAdminUserId() !== user.getId()`. Four
 * copies of that expression existed, several handlers had none at all, and
 * there was nowhere to add delegates without touching all of them. Every
 * organization handler now asks this class instead, so a new power or a new
 * caller class is one change here.
 *
 * The resolver reads the STORED organization and the STORED membership row —
 * never anything the client sent — so a forged organizationId or a stale
 * client-side role can never widen what a caller may do.
 */
class OrganizationAuthorityResolver
{
    /**
     * Resolves what `user` may do to `organizationId`.
     *
     * @param {User|null} user the authenticated user, as loaded server-side
     * @param {string} organizationId the organization being acted on
     * @returns {Promise<{
     *   allowed: boolean,
     *   reason: string|null,
     *   organization: Organization|null,
     *   isSuperAdmin: boolean,
     *   isOwner: boolean,
     *   delegatePowers: number
     * }>} `allowed` means only "this caller has some standing here" — the caller
     *   must still check a specific power with hasPower(). `organization` is
     *   returned so the handler does not load it a second time.
     */
    static async resolve(user, organizationId)
    {
        if (!user || typeof user.getId !== "function")
        {
            return OrganizationAuthorityResolver.#deny(ErrorCodes.NOT_ORG_ADMIN, null);
        }

        if (typeof organizationId !== "string" || organizationId.length === 0)
        {
            return OrganizationAuthorityResolver.#deny(ErrorCodes.MISSING_ORGANIZATION_ID, null);
        }

        const organization = await OrganizationQueryEngine.getOrganizationById(organizationId);
        if (!organization)
        {
            return OrganizationAuthorityResolver.#deny(ErrorCodes.ORG_NOT_FOUND, null);
        }

        if (user.getRole() === userRoles.ADMIN)
        {
            return {
                allowed: true,
                reason: null,
                organization: organization,
                isSuperAdmin: true,
                isOwner: false,
                delegatePowers: OrganizationAuthorityResolver.ALL_POWERS
            };
        }

        if (organization.getAdminUserId() && organization.getAdminUserId() === user.getId())
        {
            return {
                allowed: true,
                reason: null,
                organization: organization,
                isSuperAdmin: false,
                isOwner: true,
                delegatePowers: OrganizationAuthorityResolver.ALL_POWERS
            };
        }

        const delegatePowers = await OrganizationAuthorityResolver.#resolveDelegatePowers(user, organizationId);
        if (delegatePowers !== organizationDelegatePowers.NONE)
        {
            return {
                allowed: true,
                reason: null,
                organization: organization,
                isSuperAdmin: false,
                isOwner: false,
                delegatePowers: delegatePowers
            };
        }

        return OrganizationAuthorityResolver.#deny(ErrorCodes.NOT_ORG_ADMIN, organization);
    }

    /**
     * Every power a super-admin or owner implicitly holds. Derived from the
     * enumeration rather than hard-coded, so adding a power grants it to owners
     * automatically and cannot be forgotten here.
     */
    static get ALL_POWERS()
    {
        let combinedPowers = organizationDelegatePowers.NONE;
        for (const powerValue of Object.values(organizationDelegatePowers))
        {
            combinedPowers = combinedPowers | powerValue;
        }
        return combinedPowers;
    }

    /**
     * True when a resolution carries a specific power.
     * @param {object} authority the value returned by resolve()
     * @param {number} requiredPower an OrganizationDelegatePowers flag
     * @returns {boolean}
     */
    static hasPower(authority, requiredPower)
    {
        if (!authority || authority.allowed !== true)
        {
            return false;
        }
        return (authority.delegatePowers & requiredPower) === requiredPower;
    }

    /**
     * Convenience for a handler that needs one specific power: resolves and
     * checks in a single call, distinguishing "no standing here" from "standing
     * but not this power" only in so far as both refuse — the caller sends the
     * same 403 either way, because telling a stranger which powers exist on an
     * organization they cannot touch serves no one.
     *
     * @param {User|null} user
     * @param {string} organizationId
     * @param {number} requiredPower an OrganizationDelegatePowers flag
     */
    static async requirePower(user, organizationId, requiredPower)
    {
        const authority = await OrganizationAuthorityResolver.resolve(user, organizationId);
        if (!authority.allowed)
        {
            return authority;
        }
        if (!OrganizationAuthorityResolver.hasPower(authority, requiredPower))
        {
            return {
                ...authority,
                allowed: false,
                reason: ErrorCodes.NOT_ORG_ADMIN
            };
        }
        return authority;
    }

    /**
     * The HTTP status a denied resolution should be answered with, so every
     * organization handler reports the same refusal the same way.
     *
     * @param {object} authority the value returned by resolve() / requirePower()
     * @returns {number} an HttpStatus value
     */
    static statusForDenial(authority)
    {
        if (authority?.reason === ErrorCodes.MISSING_ORGANIZATION_ID)
        {
            return httpStatus.BAD_REQUEST;
        }
        if (authority?.reason === ErrorCodes.ORG_NOT_FOUND)
        {
            return httpStatus.NOT_FOUND;
        }
        return httpStatus.FORBIDDEN;
    }

    /**
     * Every ACTIVE organization this user has standing in, each stamped with
     * the powers they hold there. A super-admin gets every organization; an
     * owner gets the ones they own; a delegate gets the ones they were given
     * powers in. One user can appear in all three roles across different
     * organizations, so the results are merged by id with the strongest
     * standing winning.
     *
     * @param {User|null} user
     * @returns {Promise<Array<{ organization: Organization, isOwner: boolean, delegatePowers: number }>>}
     */
    static async listOrganizationsForUser(user)
    {
        if (!user || typeof user.getId !== "function")
        {
            return [];
        }

        const entriesByOrganizationId = new Map();

        if (user.getRole() === userRoles.ADMIN)
        {
            const allOrganizations = await OrganizationQueryEngine.listOrganizations();
            for (const organization of allOrganizations)
            {
                entriesByOrganizationId.set(organization.getId(),
                {
                    organization: organization,
                    isOwner: false,
                    delegatePowers: OrganizationAuthorityResolver.ALL_POWERS
                });
            }
            return Array.from(entriesByOrganizationId.values());
        }

        const ownedOrganizations = await OrganizationQueryEngine.listActiveOrganizationsByAdminUserId(user.getId());
        for (const organization of ownedOrganizations)
        {
            entriesByOrganizationId.set(organization.getId(),
            {
                organization: organization,
                isOwner: true,
                delegatePowers: OrganizationAuthorityResolver.ALL_POWERS
            });
        }

        const email = (user.getAdditionalData()?.email || "").toLowerCase();
        if (email.length > 0)
        {
            const memberships = await OrganizationMemberQueryEngine.findActiveMembershipsByEmail(email);
            for (const membership of memberships)
            {
                const delegatePowers = Number.isInteger(membership.delegatePowers) ? membership.delegatePowers : organizationDelegatePowers.NONE;
                if (delegatePowers === organizationDelegatePowers.NONE || entriesByOrganizationId.has(membership.organizationId))
                {
                    continue;
                }

                const organization = await OrganizationQueryEngine.getOrganizationById(membership.organizationId);
                if (organization)
                {
                    entriesByOrganizationId.set(organization.getId(),
                    {
                        organization: organization,
                        isOwner: false,
                        delegatePowers: delegatePowers
                    });
                }
            }
        }

        return Array.from(entriesByOrganizationId.values());
    }

    /**
     * The delegate powers this user's membership row carries for this
     * organization, or NONE when they are not a member.
     */
    static async #resolveDelegatePowers(user, organizationId)
    {
        const member = await OrganizationMemberQueryEngine.findMemberByUserIdOrEmail
        (
            organizationId,
            user.getId(),
            user.getAdditionalData()?.email || ""
        );

        if (!member)
        {
            return organizationDelegatePowers.NONE;
        }

        const storedPowers = member.getDelegatePowers();
        return Number.isInteger(storedPowers) ? storedPowers : organizationDelegatePowers.NONE;
    }

    static #deny(reason, organization)
    {
        return {
            allowed: false,
            reason: reason,
            organization: organization,
            isSuperAdmin: false,
            isOwner: false,
            delegatePowers: organizationDelegatePowers.NONE
        };
    }
}

module.exports = OrganizationAuthorityResolver;
