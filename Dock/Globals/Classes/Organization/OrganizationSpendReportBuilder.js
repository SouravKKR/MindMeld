const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const OrganizationMemberQueryEngine = require("./OrganizationMemberQueryEngine");
const CreditLedger = require("../Credits/CreditLedger");
const { creditTransactionTypes } = require("../../Enumerations/CreditTransactionTypes");
const { taskTypes } = require("../../Enumerations/TaskTypes");


/**
 * OrganizationSpendReportBuilder
 *
 * What an organization's members were given, what they spent, and on which
 * features.
 *
 * One thing about this report has to be stated wherever it is shown, and is
 * carried on the report itself so it cannot be dropped in rendering: a member
 * has ONE credit balance. Credits an institute grants and credits a member buys
 * for themselves go into the same pot and are spent from it indistinguishably.
 * So the "granted" column is exact — it is what this organization gave — while
 * the "spent" column covers everything that member spent, including credits
 * they paid for. Presenting spend as though it were all institute money would
 * be a lie about someone's private purchase.
 *
 * Everything is read from the credit ledger rather than from counters, because
 * the ledger is the record of what actually happened and a counter can drift
 * from it.
 */
class OrganizationSpendReportBuilder
{
    static DISCLAIMER =
        "Credits granted by this organization and credits a member bought themselves share one balance, "
        + "so the spend figures below include both. Only the granted column is exclusively this organization's.";

    /**
     * Human labels for the transaction types a member's spending falls into.
     * Anything unrecognised is reported as Other rather than dropped — a
     * feature added later must not silently vanish from the totals.
     */
    static #describeSpendCategory(transactionDocument)
    {
        if (transactionDocument.type === creditTransactionTypes.STORAGE_CHARGE)
        {
            return "Storage";
        }

        if (transactionDocument.type === creditTransactionTypes.TASK_CHARGE)
        {
            if (transactionDocument.metadata?.source === "AskAi")
            {
                return "Ask AI";
            }

            const taskTypeValue = transactionDocument.metadata?.taskType;
            for (const [taskTypeName, candidateValue] of Object.entries(taskTypes))
            {
                if (candidateValue === taskTypeValue)
                {
                    return OrganizationSpendReportBuilder.#humaniseName(taskTypeName);
                }
            }

            return "Other AI usage";
        }

        return "Other";
    }

    static #humaniseName(enumName)
    {
        return String(enumName)
            .toLowerCase()
            .split("_")
            .filter(word => word.length > 0)
            .map((word, wordIndex) => wordIndex === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word)
            .join(" ");
    }

    /**
     * Builds the report for one organization.
     *
     * @param {Organization} organization
     * @returns {Promise<{ generatedAt: string, disclaimer: string, categories: string[], rows: object[], totals: object }>}
     */
    static async build(organization)
    {
        const database = await DatabaseConnector.getDatabase();
        const organizationId = organization.getId();

        const members = await OrganizationMemberQueryEngine.listMembers(organizationId);
        const memberByUserId = new Map();
        const memberEmails = [];

        for (const member of members)
        {
            memberEmails.push(member.getEmail());
            if (member.getUserId() && member.getUserId().length > 0)
            {
                memberByUserId.set(member.getUserId(), member);
            }
        }

        // Members who have never signed in have no user id and therefore no
        // ledger rows. They are reported with zeroes rather than omitted, so the
        // report's member count matches the roster.
        const usersCollection = database.collection(DatabaseConstants.USERS_COLLECTION);
        const userDocuments = memberEmails.length > 0
            ? await usersCollection
                .aggregate
                ([
                    { $addFields: { normalisedEmail: { $toLower: "$additionalData.email" } } },
                    { $match: { normalisedEmail: { $in: memberEmails } } },
                    { $project: { _id: 0, id: 1, displayName: 1, "additionalData.email": 1, "additionalData.credits": 1 } }
                ])
                .toArray()
            : [];

        const userDocumentByEmail = new Map();
        for (const userDocument of userDocuments)
        {
            userDocumentByEmail.set(String(userDocument.additionalData?.email || "").toLowerCase(), userDocument);
            if (!memberByUserId.has(userDocument.id))
            {
                const matchingMember = members.find(member => member.getEmail() === String(userDocument.additionalData?.email || "").toLowerCase());
                if (matchingMember)
                {
                    memberByUserId.set(userDocument.id, matchingMember);
                }
            }
        }

        const trackedUserIds = Array.from(memberByUserId.keys());

        const transactions = trackedUserIds.length > 0
            ? await database
                .collection(DatabaseConstants.CREDIT_TRANSACTIONS_COLLECTION)
                .find
                ({
                    userId: { $in: trackedUserIds },
                    status: CreditLedger.TRANSACTION_STATUS_APPLIED
                }, { projection: { _id: 0, userId: 1, amount: 1, type: 1, metadata: 1 } })
                .toArray()
            : [];

        const categoryNames = new Set();
        const spendByUserId = new Map();
        const grantedByUserId = new Map();

        for (const transaction of transactions)
        {
            if (transaction.amount > 0)
            {
                // Only THIS organization's grants count as granted — a member's
                // own purchase or another organization's gift is not ours to
                // report as given.
                if (transaction.metadata?.organizationId === organizationId)
                {
                    grantedByUserId.set(transaction.userId, Math.round(((grantedByUserId.get(transaction.userId) || 0) + transaction.amount) * 10000) / 10000);
                }
                continue;
            }

            const categoryName = OrganizationSpendReportBuilder.#describeSpendCategory(transaction);
            categoryNames.add(categoryName);

            const spendForUser = spendByUserId.get(transaction.userId) || {};
            spendForUser[categoryName] = Math.round(((spendForUser[categoryName] || 0) + Math.abs(transaction.amount)) * 10000) / 10000;
            spendByUserId.set(transaction.userId, spendForUser);
        }

        const sortedCategories = Array.from(categoryNames).sort();
        const rows = [];
        const totals = { granted: 0, spent: 0, remaining: 0 };

        for (const member of members)
        {
            const userDocument = userDocumentByEmail.get(member.getEmail());
            const userId = userDocument ? userDocument.id : "";
            const spendForUser = userId ? (spendByUserId.get(userId) || {}) : {};
            const spentTotal = Object.values(spendForUser).reduce((runningTotal, value) => runningTotal + value, 0);
            const grantedTotal = userId ? (grantedByUserId.get(userId) || 0) : 0;
            const remainingBalance = userDocument ? (Number(userDocument.additionalData?.credits) || 0) : 0;

            rows.push
            ({
                email: member.getEmail(),
                name: userDocument?.displayName || member.getAttributes()?.name || "",
                tags: member.getTags(),
                bHasAccount: userDocument !== undefined,
                grantedByOrganization: grantedTotal,
                spent: Math.round(spentTotal * 10000) / 10000,
                remainingBalance: remainingBalance,
                spendByCategory: spendForUser
            });

            totals.granted = Math.round((totals.granted + grantedTotal) * 10000) / 10000;
            totals.spent = Math.round((totals.spent + spentTotal) * 10000) / 10000;
            totals.remaining = Math.round((totals.remaining + remainingBalance) * 10000) / 10000;
        }

        return {
            generatedAt: new Date().toISOString(),
            organizationName: organization.getName(),
            disclaimer: OrganizationSpendReportBuilder.DISCLAIMER,
            categories: sortedCategories,
            rows: rows,
            totals: totals
        };
    }
}

module.exports = OrganizationSpendReportBuilder;
