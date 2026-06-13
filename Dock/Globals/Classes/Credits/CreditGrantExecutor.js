const CreditLedger = require('./CreditLedger');
const { creditTransactionTypes } = require('../../Enumerations/CreditTransactionTypes');
const { creditGrantAmountModes } = require('../../Enumerations/CreditGrantAmountModes');

/**
 * CreditGrantExecutor
 *
 * Applies an admin credit grant to a resolved recipient list. All balance
 * mutation goes through CreditLedger.grant with type ADMIN_ADJUSTMENT, so
 * every grant lands in the creditTransactions audit trail and is idempotent:
 * the per-user referenceKey embeds the client-supplied grantKey, so retrying
 * a partially-failed apply (same grantKey) tops up only the users that were
 * missed and reports alreadyApplied for the rest.
 */
class CreditGrantExecutor
{
    static MAXIMUM_REASON_LENGTH = 512;

    /**
     * PER_USER grants the amount to each recipient as-is; TOTAL_SPLIT divides
     * one pot equally. The split floors at the ledger's 4-decimal precision
     * so the sum of grants can never exceed the pot.
     *
     * @param {number} amount
     * @param {number} amountMode — CreditGrantAmountModes value
     * @param {number} recipientCount
     * @returns {number}
     */
    static computePerUserAmount(amount, amountMode, recipientCount)
    {
        if (!(recipientCount > 0))
        {
            return 0;
        }
        if (amountMode === creditGrantAmountModes.TOTAL_SPLIT)
        {
            return Math.floor((amount / recipientCount) * 10000) / 10000;
        }
        return Math.round(amount * 10000) / 10000;
    }

    /**
     * @param {{
     *   recipients: Array<{userId: string, email: string}>,
     *   perUserAmount: number,
     *   grantKey: string,
     *   reason: string,
     *   grantedByUserId: string,
     *   targetType: number,
     *   organizationId?: string
     * }} grantRequest
     * @returns {Promise<Array<{userId: string, email: string, applied: boolean, alreadyApplied: boolean, balanceAfter: number|null}>>}
     */
    static async execute(grantRequest)
    {
        const trimmedReason = typeof grantRequest.reason === "string"
            ? grantRequest.reason.trim().slice(0, CreditGrantExecutor.MAXIMUM_REASON_LENGTH)
            : "";

        const results = [];

        for (const recipient of grantRequest.recipients)
        {
            const referenceKey = `adminGrant:${grantRequest.grantKey}:${recipient.userId}`;
            const metadata =
            {
                reason: trimmedReason,
                grantedBy: grantRequest.grantedByUserId,
                grantKey: grantRequest.grantKey,
                targetType: grantRequest.targetType,
            };
            if (grantRequest.organizationId)
            {
                metadata.organizationId = grantRequest.organizationId;
            }

            const outcome = await CreditLedger.grant
            (
                recipient.userId,
                grantRequest.perUserAmount,
                creditTransactionTypes.ADMIN_ADJUSTMENT,
                referenceKey,
                metadata
            );

            results.push
            ({
                userId: recipient.userId,
                email: recipient.email,
                applied: outcome.applied === true,
                alreadyApplied: outcome.alreadyApplied === true,
                balanceAfter: typeof outcome.balanceAfter === "number" ? outcome.balanceAfter : null
            });
        }

        return results;
    }
}

module.exports = CreditGrantExecutor;
