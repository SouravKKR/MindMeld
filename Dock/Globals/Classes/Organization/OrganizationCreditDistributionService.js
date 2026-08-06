const CreditGrantTargetResolver = require("../Credits/CreditGrantTargetResolver");
const CreditGrantExecutor = require("../Credits/CreditGrantExecutor");
const CreditLedger = require("../Credits/CreditLedger");
const OrganizationCreditLedger = require("./OrganizationCreditLedger");
const OrganizationMonthlyCreditCapEnforcer = require("./OrganizationMonthlyCreditCapEnforcer");
const OrganizationMemberQueryEngine = require("./OrganizationMemberQueryEngine");
const NotificationDispatcher = require("../Notifications/NotificationDispatcher");
const NotificationContent = require("../Notifications/NotificationContent");
const { creditGrantTargetTypes } = require("../../Enumerations/CreditGrantTargetTypes");
const { creditTransactionTypes } = require("../../Enumerations/CreditTransactionTypes");
const { creditGrantAmountModes } = require("../../Enumerations/CreditGrantAmountModes");
const { notificationChannels } = require("../../Enumerations/NotificationChannels");
const ErrorCodes = require("../../Constants/ErrorCodes");


/**
 * OrganizationCreditDistributionService
 *
 * Gives an organization's credits to the members a tag selection covers.
 *
 * Preview and apply run through the SAME plan, so the numbers in the
 * confirmation are the numbers that land. A preview computed differently from
 * the grant would make the whole confirmation ceremonial — the one thing it
 * must never be, because credits cannot be taken back once granted.
 *
 * Order of operations on apply, and why:
 *
 *   1. Re-resolve the recipients server-side. The preview is advisory; a
 *      member could have been added or removed in between, and the client's
 *      copy of the list is not evidence.
 *   2. Debit the POOL once, for the exact total. The debit is atomic and
 *      refuses when the pool cannot cover it, so a distribution never credits
 *      half a roster and then stops for want of funds.
 *   3. Grant each member, keyed on `orgGrant:<grantKey>:<userId>` so a retried
 *      request cannot double-credit anyone.
 *   4. Refund the pool for anything that could not be granted — a recipient
 *      whose account vanished between resolution and grant — so the money is
 *      not silently consumed.
 */
class OrganizationCreditDistributionService
{
    /**
     * Works out who gets what, without moving anything.
     *
     * @param {Organization} organization
     * @param {{ tagFilter: string[], tagMatchMode: number, amount: number, amountMode: number }} request
     * @returns {Promise<object>} the plan, including any refusal reason
     */
    static async plan(organization, request)
    {
        const organizationId = organization.getId();

        const resolution = await CreditGrantTargetResolver.resolve
        ({
            targetType: creditGrantTargetTypes.ORGANIZATION_TAGS,
            organizationId: organizationId,
            tagFilter: request.tagFilter,
            tagMatchMode: request.tagMatchMode
        });

        if (resolution.error)
        {
            return { ok: false, reason: resolution.error, recipients: [] };
        }

        const pool = await OrganizationCreditLedger.getPool(organizationId);
        const poolBalanceBefore = pool ? pool.getBalance() : 0;

        const perUserAmount = CreditGrantExecutor.computePerUserAmount
        (
            Number(request.amount) || 0,
            request.amountMode,
            resolution.recipients.length
        );

        // Tags are carried into the plan so the preview sheet can show WHY each
        // person was selected — a recipient list with no reason attached is
        // impossible to sanity-check before spending real credits on it.
        const tagsByEmail = await OrganizationCreditDistributionService.#buildTagsByEmail(organizationId);

        const plannedRecipients = [];
        let totalAmount = 0;

        for (const recipient of resolution.recipients)
        {
            const capResolution = await OrganizationMonthlyCreditCapEnforcer.resolveAllowedAmount(organization, recipient.userId, perUserAmount);
            const grantedAmount = capResolution.allowedAmount;

            plannedRecipients.push
            ({
                userId: recipient.userId,
                email: recipient.email,
                displayName: recipient.displayName || "",
                tags: tagsByEmail.get(String(recipient.email || "").toLowerCase()) || [],
                balanceBefore: recipient.balance,
                granted: grantedAmount,
                balanceAfter: Math.round((recipient.balance + grantedAmount) * 10000) / 10000,
                clampedByMonthlyCap: capResolution.bClamped,
                monthlyCapAmount: capResolution.capAmount,
                alreadyGrantedThisMonth: capResolution.alreadyGranted
            });

            totalAmount = totalAmount + grantedAmount;
        }

        totalAmount = Math.round(totalAmount * 10000) / 10000;

        return {
            ok: true,
            reason: null,
            recipients: plannedRecipients,
            recipientCount: plannedRecipients.length,
            perUserAmount: perUserAmount,
            totalAmount: totalAmount,
            poolBalanceBefore: poolBalanceBefore,
            poolBalanceAfter: Math.round((poolBalanceBefore - totalAmount) * 10000) / 10000,
            poolFrozen: pool ? pool.getFrozen() === true : false,
            unmatchedEmails: resolution.unmatchedEmails
        };
    }

    /**
     * Carries out a planned distribution.
     *
     * @param {Organization} organization
     * @param {object} request
     * @param {string} grantKey a stable key so a retry cannot double-grant
     * @param {string} grantedByUserId
     */
    static async apply(organization, request, grantKey, grantedByUserId)
    {
        const organizationId = organization.getId();

        // Re-plan server-side: the client's preview is advisory and may be
        // minutes old.
        const distributionPlan = await OrganizationCreditDistributionService.plan(organization, request);
        if (!distributionPlan.ok)
        {
            return { ok: false, reason: distributionPlan.reason };
        }

        if (distributionPlan.recipientCount === 0)
        {
            return { ok: false, reason: ErrorCodes.NO_RECIPIENTS };
        }

        if (distributionPlan.totalAmount <= 0)
        {
            // Every recipient was already at their monthly ceiling.
            return { ok: false, reason: ErrorCodes.MONTHLY_CAP_EXCEEDED, plan: distributionPlan };
        }

        const poolDebit = await OrganizationCreditLedger.debit
        (
            organizationId,
            distributionPlan.totalAmount,
            OrganizationCreditLedger.TRANSACTION_TYPE_DISTRIBUTION,
            `orgDistribution:${grantKey}`,
            { grantKey: grantKey, recipientCount: distributionPlan.recipientCount, grantedByUserId: grantedByUserId }
        );

        if (!poolDebit.applied && !poolDebit.alreadyApplied)
        {
            return { ok: false, reason: poolDebit.reason || ErrorCodes.ORG_POOL_INSUFFICIENT, plan: distributionPlan };
        }

        let grantedCount = 0;
        let alreadyGrantedCount = 0;
        let failedAmount = 0;
        const results = [];

        for (const plannedRecipient of distributionPlan.recipients)
        {
            if (plannedRecipient.granted <= 0)
            {
                continue;
            }

            const grantResult = await CreditLedger.grant
            (
                plannedRecipient.userId,
                plannedRecipient.granted,
                creditTransactionTypes.ADMIN_ADJUSTMENT,
                `orgGrant:${grantKey}:${plannedRecipient.userId}`,
                {
                    organizationId: organizationId,
                    organizationName: organization.getName(),
                    grantKey: grantKey,
                    kind: "organizationDistribution",
                    grantedByUserId: grantedByUserId
                }
            );

            if (grantResult.applied && !grantResult.alreadyApplied)
            {
                grantedCount = grantedCount + 1;
            }
            else if (grantResult.alreadyApplied)
            {
                alreadyGrantedCount = alreadyGrantedCount + 1;
            }
            else
            {
                // The recipient's account went away between resolution and
                // grant. The pool has already been debited for them, so the
                // money is returned rather than quietly consumed.
                failedAmount = failedAmount + plannedRecipient.granted;
            }

            results.push({ userId: plannedRecipient.userId, email: plannedRecipient.email, granted: grantResult.applied ? plannedRecipient.granted : 0 });
        }

        if (failedAmount > 0)
        {
            await OrganizationCreditLedger.refund
            (
                organizationId,
                failedAmount,
                `orgDistributionRefund:${grantKey}`,
                { grantKey: grantKey, reason: "recipients could not be credited" }
            );
        }

        await OrganizationCreditDistributionService.#notifyRecipients(distributionPlan.recipients);

        const pool = await OrganizationCreditLedger.getPool(organizationId);

        return {
            ok: true,
            grantedCount: grantedCount,
            alreadyGrantedCount: alreadyGrantedCount,
            refundedAmount: failedAmount,
            totalAmount: distributionPlan.totalAmount,
            poolBalanceAfter: pool ? pool.getBalance() : null,
            results: results
        };
    }

    static async #buildTagsByEmail(organizationId)
    {
        const members = await OrganizationMemberQueryEngine.listMembers(organizationId);
        const tagsByEmail = new Map();
        for (const member of members)
        {
            tagsByEmail.set(member.getEmail(), Array.isArray(member.getTags()) ? member.getTags() : []);
        }
        return tagsByEmail;
    }

    /**
     * Tells each recipient their balance went up. Best-effort — a notification
     * failure must never look like a failed grant.
     */
    static async #notifyRecipients(plannedRecipients)
    {
        for (const plannedRecipient of plannedRecipients)
        {
            if (plannedRecipient.granted <= 0)
            {
                continue;
            }

            try
            {
                await NotificationDispatcher.dispatch
                (
                    plannedRecipient.userId,
                    NotificationContent.creditsGrantedByAdmin(plannedRecipient.granted),
                    notificationChannels.IN_APP | notificationChannels.PUSH
                );
            }
            catch (notifyError)
            {
                console.warn(`[OrganizationCreditDistribution] Notification failed for ${plannedRecipient.userId}: ${notifyError.message}`);
            }
        }
    }

    /**
     * The amount modes a distribution accepts, mirrored here so an endpoint can
     * validate without importing the enumeration for one comparison.
     */
    static isValidAmountMode(amountMode)
    {
        return amountMode === creditGrantAmountModes.PER_USER || amountMode === creditGrantAmountModes.TOTAL_SPLIT;
    }
}

module.exports = OrganizationCreditDistributionService;
