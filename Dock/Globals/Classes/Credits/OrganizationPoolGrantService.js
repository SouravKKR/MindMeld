const OrganizationQueryEngine = require("../Organization/OrganizationQueryEngine");
const OrganizationCreditLedger = require("../Organization/OrganizationCreditLedger");
const { organizationStatus } = require("../../Enumerations/OrganizationStatus");
const ErrorCodes = require("../../Constants/ErrorCodes");

/**
 * OrganizationPoolGrantService
 *
 * A super-admin top-up of an organization's credit pool.
 *
 * This is what replaced granting credits to an organization's members one by
 * one. The two are not variations of the same act: an institute buys credits as
 * a block and decides itself who gets them and when, so the platform's job ends
 * at the pool. Granting straight to members would take that decision away and
 * leave the pool balance a lie — the credits would already be spent from the
 * organization's point of view while the pool still claimed to hold them.
 *
 * Deliberately NOT part of the recipient-resolution pipeline the user-facing
 * grants use. There is one recipient here and it is not a user, so a per-user
 * amount, a split across recipients and an unmatched-email list all mean
 * nothing; expressing a pool grant in those terms would need every one of them
 * to carry a special case.
 *
 * Idempotent on the grant key, through the ledger's own reference key: a
 * timed-out apply can be retried and the pool is credited exactly once.
 */
class OrganizationPoolGrantService
{
    // Namespaced so a pool top-up can never collide with the reference key of a
    // deal settlement or a distribution refund, whatever key the caller passes.
    static #REFERENCE_KEY_PREFIX = "adminPoolGrant";

    /**
     * What the grant would do, without doing it.
     *
     * @param {string} organizationId
     * @param {number} amountCredits
     * @returns {Promise<{ success: boolean, error?: string, preview?: object }>}
     */
    static async preview(organizationId, amountCredits)
    {
        const organization = await OrganizationQueryEngine.getOrganizationById(organizationId);
        if (!organization)
        {
            return { success: false, error: ErrorCodes.ORG_NOT_FOUND };
        }

        const pool = await OrganizationCreditLedger.getPool(organizationId);
        const balanceBefore = Number(pool.getBalance()) || 0;
        const roundedAmount = OrganizationPoolGrantService.#roundCredits(amountCredits);

        return {
            success: true,
            preview:
            {
                organizationId: organizationId,
                organizationName: organization.getName(),
                organizationStatus: organization.getStatus(),
                memberCount: organization.getCurrentMemberCount(),
                amount: roundedAmount,
                balanceBefore: balanceBefore,
                balanceAfter: OrganizationPoolGrantService.#roundCredits(balanceBefore + roundedAmount),
                // A frozen pool still ACCEPTS credits — only distributions are
                // paused. Reported so the granting admin knows the organization
                // cannot hand these out until the term is renewed, rather than
                // finding out from a support ticket.
                frozen: pool.getFrozen() === true,
                termEndsAt: organization.getTermEndsAt()
            }
        };
    }

    /**
     * Credits the pool.
     *
     * @param {object} options
     * @param {string} options.organizationId
     * @param {number} options.amountCredits
     * @param {string} options.grantKey the client's idempotency key
     * @param {string} options.reason stored in the audit trail
     * @param {string} options.grantedByUserId
     * @returns {Promise<{ success: boolean, error?: string, applied?: boolean, alreadyApplied?: boolean, balanceAfter?: number }>}
     */
    static async apply(options)
    {
        const organizationId = typeof options?.organizationId === "string" ? options.organizationId : "";
        const grantKey = typeof options?.grantKey === "string" ? options.grantKey.trim() : "";
        const roundedAmount = OrganizationPoolGrantService.#roundCredits(options?.amountCredits);

        if (roundedAmount <= 0)
        {
            return { success: false, error: ErrorCodes.INVALID_AMOUNT };
        }

        const organization = await OrganizationQueryEngine.getOrganizationById(organizationId);
        if (!organization)
        {
            return { success: false, error: ErrorCodes.ORG_NOT_FOUND };
        }

        // A deleted organization is already gone; a pending one has no pool that
        // anybody can reach. Crediting either would strand the credits somewhere
        // nobody can spend them from.
        if (organization.getStatus() !== organizationStatus.ACTIVE)
        {
            return { success: false, error: ErrorCodes.ORG_NOT_ACTIVE };
        }

        const creditResult = await OrganizationCreditLedger.credit
        (
            organizationId,
            roundedAmount,
            OrganizationCreditLedger.TRANSACTION_TYPE_ADJUSTMENT,
            `${OrganizationPoolGrantService.#REFERENCE_KEY_PREFIX}:${grantKey}`,
            {
                source: OrganizationCreditLedger.MOVEMENT_SOURCE_ADMIN_GRANT,
                reason: typeof options?.reason === "string" ? options.reason.slice(0, 512) : "",
                grantedByUserId: typeof options?.grantedByUserId === "string" ? options.grantedByUserId : ""
            }
        );

        return {
            success: creditResult.applied || creditResult.alreadyApplied,
            applied: creditResult.applied,
            alreadyApplied: creditResult.alreadyApplied,
            amount: roundedAmount,
            balanceAfter: creditResult.balanceAfter
        };
    }

    /**
     * Credits carry fractional amounts (an Ask AI call costs 0.1), so a grant is
     * rounded the same way the ledger rounds rather than truncated to an integer.
     */
    static #roundCredits(amountCredits)
    {
        const parsedAmount = Number(amountCredits);
        if (!Number.isFinite(parsedAmount) || parsedAmount <= 0)
        {
            return 0;
        }
        return Math.round(parsedAmount * 10000) / 10000;
    }
}

module.exports = OrganizationPoolGrantService;
