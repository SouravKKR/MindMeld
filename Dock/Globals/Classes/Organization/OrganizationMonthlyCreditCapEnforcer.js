const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");


/**
 * OrganizationMonthlyCreditCapEnforcer
 *
 * Bounds how much ONE organization can give ONE member in a calendar month.
 *
 * The ceiling is set per organization by a super-admin as part of what was
 * sold. It exists because a distribution is expressed as a filter and an
 * amount: a mis-typed amount, or a filter that matches one person instead of
 * two hundred, would otherwise put the entire pool onto a single account in one
 * click — and credits, once granted, are the member's.
 *
 * It counts EVERYTHING the organization gives a member that month: recurring
 * installments and discretionary top-ups alike. Exempting recurring grants
 * would mean the ceiling no longer bounds total exposure per member, which is
 * the only thing it is for.
 *
 * The month is the UTC calendar month, matching the `YYYY-MM` period key the
 * periodic-credit system already uses, so a member near a month boundary is
 * treated identically by both.
 */
class OrganizationMonthlyCreditCapEnforcer
{
    /**
     * The period key for a moment — the same `YYYY-MM` form the periodic
     * assignment engine writes, so the two agree on where a month ends.
     */
    static resolvePeriodKey(atDate = new Date())
    {
        const year = atDate.getUTCFullYear();
        const month = String(atDate.getUTCMonth() + 1).padStart(2, "0");
        return `${year}-${month}`;
    }

    /**
     * How much this organization has already granted this member this month,
     * read from the credit ledger rather than a counter — the ledger is the
     * record of what actually landed, and a counter could drift from it.
     *
     * @param {string} organizationId
     * @param {string} userId
     * @param {Date} atDate
     * @returns {Promise<number>}
     */
    static async getGrantedThisMonth(organizationId, userId, atDate = new Date())
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database || !organizationId || !userId)
        {
            return 0;
        }

        const monthStart = new Date(Date.UTC(atDate.getUTCFullYear(), atDate.getUTCMonth(), 1));
        const nextMonthStart = new Date(Date.UTC(atDate.getUTCFullYear(), atDate.getUTCMonth() + 1, 1));

        const aggregation = await database
            .collection(DatabaseConstants.CREDIT_TRANSACTIONS_COLLECTION)
            .aggregate
            ([
                {
                    $match:
                    {
                        userId: userId,
                        status: "applied",
                        amount: { $gt: 0 },
                        "metadata.organizationId": organizationId,
                        createdAt: { $gte: monthStart, $lt: nextMonthStart }
                    }
                },
                { $group: { _id: null, total: { $sum: "$amount" } } }
            ])
            .toArray();

        return aggregation.length > 0 ? Math.round((aggregation[0].total || 0) * 10000) / 10000 : 0;
    }

    /**
     * How much of `requestedAmount` this member may still receive from this
     * organization this month.
     *
     * A cap of 0 means "no ceiling configured", not "grant nothing" — an
     * organization that was never given a limit is unrestricted, which is what
     * every organization created before the field existed expects.
     *
     * @returns {Promise<{ allowedAmount: number, bClamped: boolean, alreadyGranted: number, capAmount: number }>}
     */
    static async resolveAllowedAmount(organization, userId, requestedAmount, atDate = new Date())
    {
        const capAmount = Number(organization?.getMaxCreditsPerMemberPerMonth?.() ?? 0);
        const roundedRequest = Math.round((Number(requestedAmount) || 0) * 10000) / 10000;

        if (!Number.isFinite(capAmount) || capAmount <= 0)
        {
            return { allowedAmount: roundedRequest, bClamped: false, alreadyGranted: 0, capAmount: 0 };
        }

        const alreadyGranted = await OrganizationMonthlyCreditCapEnforcer.getGrantedThisMonth(organization.getId(), userId, atDate);
        const remainingAllowance = Math.max(0, Math.round((capAmount - alreadyGranted) * 10000) / 10000);
        const allowedAmount = Math.min(roundedRequest, remainingAllowance);

        return {
            allowedAmount: allowedAmount,
            bClamped: allowedAmount < roundedRequest,
            alreadyGranted: alreadyGranted,
            capAmount: capAmount
        };
    }
}

module.exports = OrganizationMonthlyCreditCapEnforcer;
