const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const CreditLedger = require("./CreditLedger");
const PeriodicAssignmentQueryEngine = require("./PeriodicAssignmentQueryEngine");
const PeriodicAssignmentRecipientStore = require("./PeriodicAssignmentRecipientStore");
const CreditDealPaymentQueryEngine = require("./CreditDealPaymentQueryEngine");
const OrganizationQueryEngine = require("../Organization/OrganizationQueryEngine");
const OrganizationMemberQueryEngine = require("../Organization/OrganizationMemberQueryEngine");
const { periodicScopeTypes } = require("../../Enumerations/PeriodicScopeTypes");
const { periodicScheduleTypes } = require("../../Enumerations/PeriodicScheduleTypes");
const { creditDealTargetTypes } = require("../../Enumerations/CreditDealTargetTypes");


/**
 * PeriodicAssignmentReportBuilder
 *
 * Aggregates everything the printable report needs for one assignment:
 * timestamps, scope, validity, period, the full beneficiary table (current +
 * former members, each with cumulative credits), the current org-member roster
 * and admin(s) for org-scoped assignments, the all-time total, and any
 * attached deal/invoice records.
 *
 * The beneficiary cumulative totals come from the recipient store (updated in
 * lock-step with every applied grant); the all-time total is cross-checked
 * against an aggregate over the creditTransactions ledger so a divergence is
 * visible rather than silent.
 */
class PeriodicAssignmentReportBuilder
{
    static #WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

    static #isoOrNull(value)
    {
        return value instanceof Date ? value.toISOString() : (typeof value === "string" ? value : null);
    }

    static #periodLabel(assignment)
    {
        const scheduleType = assignment.getScheduleType();
        if (scheduleType === periodicScheduleTypes.INTERVAL_DAYS)
        {
            const days = assignment.getIntervalDays();
            return days === 1 ? "Every day" : `Every ${days} days`;
        }
        if (scheduleType === periodicScheduleTypes.DAY_OF_WEEK)
        {
            return `Every ${PeriodicAssignmentReportBuilder.#WEEKDAY_NAMES[assignment.getDayOfWeek()] || "week"}`;
        }
        if (scheduleType === periodicScheduleTypes.DAY_OF_MONTH)
        {
            return `Day ${assignment.getDayOfMonth()} of every month`;
        }
        return "Unknown schedule";
    }

    /**
     * Sums the applied periodic credits straight from the ledger for the
     * cross-check figure.
     * @param {string} assignmentId
     * @returns {Promise<number>}
     */
    static async #ledgerTotal(assignmentId)
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return 0;
        }
        const rows = await database
            .collection(DatabaseConstants.CREDIT_TRANSACTIONS_COLLECTION)
            .aggregate([
                { $match: { "metadata.periodicAssignmentId": assignmentId, status: CreditLedger.TRANSACTION_STATUS_APPLIED } },
                { $group: { _id: null, total: { $sum: "$amount" } } }
            ])
            .toArray();
        return rows.length > 0 && typeof rows[0].total === "number" ? rows[0].total : 0;
    }

    /**
     * @param {string} assignmentId
     * @returns {Promise<object|null>} the full report payload, or null if the
     *          assignment does not exist.
     */
    static async build(assignmentId)
    {
        const assignment = await PeriodicAssignmentQueryEngine.getById(assignmentId);
        if (!assignment)
        {
            return null;
        }

        const isOrganizationScope = assignment.getScopeType() === periodicScopeTypes.ORGANIZATION;

        let organization = null;
        let currentOrgMembers = [];
        let currentMemberEmails = new Set();
        const orgAdmins = [];

        if (isOrganizationScope)
        {
            organization = await OrganizationQueryEngine.getOrganizationById(assignment.getOrganizationId());
            const members = await OrganizationMemberQueryEngine.listMembers(assignment.getOrganizationId());
            currentOrgMembers = members.map(member => ({
                email: member.getEmail(),
                userId: member.getUserId(),
                addedAt: PeriodicAssignmentReportBuilder.#isoOrNull(member.getAddedAt())
            }));
            currentMemberEmails = new Set(currentOrgMembers.map(member => (member.email || "").toLowerCase()));

            if (organization && typeof organization.getAdminEmail() === "string" && organization.getAdminEmail().length > 0)
            {
                orgAdmins.push({ email: organization.getAdminEmail(), userId: organization.getAdminUserId() || "" });
            }
        }
        else
        {
            currentMemberEmails = new Set((assignment.getPeopleEmails() || []).map(email => String(email).toLowerCase()));
        }

        const recipientRows = await PeriodicAssignmentRecipientStore.listByAssignment(assignmentId);
        let totalCreditsGivenAllTime = 0;
        const allBeneficiaries = recipientRows.map(row =>
        {
            const cumulativeCredits = typeof row.cumulativeCredits === "number" ? row.cumulativeCredits : 0;
            totalCreditsGivenAllTime += cumulativeCredits;
            const lowerEmail = (row.email || "").toLowerCase();
            return {
                email: row.email || "",
                userId: row.userId || "",
                cumulativeCredits: cumulativeCredits,
                grantCount: typeof row.grantCount === "number" ? row.grantCount : 0,
                onJoinGranted: row.onJoinGranted === true,
                firstGrantedAt: PeriodicAssignmentReportBuilder.#isoOrNull(row.firstGrantedAt),
                lastGrantedAt: PeriodicAssignmentReportBuilder.#isoOrNull(row.lastGrantedAt),
                isCurrentMember: currentMemberEmails.has(lowerEmail)
            };
        });

        // Round to the ledger's 4-decimal precision so the printed total
        // doesn't show float dust.
        totalCreditsGivenAllTime = Math.round(totalCreditsGivenAllTime * 10000) / 10000;
        const ledgerTotal = Math.round((await PeriodicAssignmentReportBuilder.#ledgerTotal(assignmentId)) * 10000) / 10000;

        const deals = (await CreditDealPaymentQueryEngine.listForTarget(creditDealTargetTypes.PERIODIC_ASSIGNMENT, assignmentId))
            .map(deal => deal.toJson());

        return {
            generatedAt: new Date().toISOString(),
            assignment: assignment.toJson(),
            periodLabel: PeriodicAssignmentReportBuilder.#periodLabel(assignment),
            scopeLabel: isOrganizationScope
                ? `Organization: ${organization ? organization.getName() : assignment.getOrganizationId()}`
                : `People set (${(assignment.getPeopleEmails() || []).length} recipients)`,
            validUntilLabel: assignment.getHasValidUntil()
                ? PeriodicAssignmentReportBuilder.#isoOrNull(assignment.getValidUntil())
                : "No end date",
            organization: organization
                ? {
                    id: organization.getId(),
                    name: organization.getName(),
                    adminEmail: organization.getAdminEmail(),
                    adminUserId: organization.getAdminUserId() || "",
                    currentMemberCount: organization.getCurrentMemberCount(),
                    maxMembers: organization.getMaxMembers()
                }
                : null,
            currentOrgMembers: currentOrgMembers,
            orgAdmins: orgAdmins,
            allBeneficiaries: allBeneficiaries,
            totalCreditsGivenAllTime: totalCreditsGivenAllTime,
            ledgerTotalCrossCheck: ledgerTotal,
            deals: deals
        };
    }
}

module.exports = PeriodicAssignmentReportBuilder;
