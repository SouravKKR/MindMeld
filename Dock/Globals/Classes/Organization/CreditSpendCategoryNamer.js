const { creditTransactionTypes } = require("../../Enumerations/CreditTransactionTypes");
const { taskTypes } = require("../../Enumerations/TaskTypes");

/**
 * CreditSpendCategoryNamer — the one place a credit charge is turned into a
 * human feature name.
 *
 * Extracted from OrganizationSpendReportBuilder when the engagement report
 * started counting the same charges the spend report prices. Two copies of this
 * mapping would eventually disagree, and the disagreement would be invisible:
 * both reports would render, both would look right, and the same charge would
 * appear under "Ask AI" in one table and "Other AI usage" in the other, in the
 * same document.
 *
 * Anything unrecognised is named rather than dropped. A feature added later
 * must not silently vanish from a total — a column that quietly stops summing
 * is worse than one labelled "Other AI usage".
 */
class CreditSpendCategoryNamer
{
    static CATEGORY_STORAGE = "Storage";
    static CATEGORY_ASK_AI = "Ask AI";
    static CATEGORY_OTHER_AI_USAGE = "Other AI usage";
    static CATEGORY_OTHER = "Other";

    /**
     * @param {object} transactionDocument a creditTransactions row
     * @return {string}
     */
    static describe(transactionDocument)
    {
        if (transactionDocument.type === creditTransactionTypes.STORAGE_CHARGE)
        {
            return CreditSpendCategoryNamer.CATEGORY_STORAGE;
        }

        if (transactionDocument.type === creditTransactionTypes.TASK_CHARGE)
        {
            if (transactionDocument.metadata?.source === "AskAi")
            {
                return CreditSpendCategoryNamer.CATEGORY_ASK_AI;
            }

            const taskTypeValue = transactionDocument.metadata?.taskType;

            for (const [taskTypeName, candidateValue] of Object.entries(taskTypes))
            {
                if (candidateValue === taskTypeValue)
                {
                    return CreditSpendCategoryNamer.humaniseName(taskTypeName);
                }
            }

            return CreditSpendCategoryNamer.CATEGORY_OTHER_AI_USAGE;
        }

        return CreditSpendCategoryNamer.CATEGORY_OTHER;
    }

    /**
     * True when a category represents an AI feature the member invoked, as
     * opposed to a background cost.
     *
     * Storage is the case this exists for: it is a real charge and belongs in
     * the spend table, but it is billed periodically rather than triggered, so
     * counting it as "uses" would report a number of billing ticks as though it
     * were a number of things the student did.
     */
    static isInvokedAiFeature(categoryName)
    {
        return categoryName !== CreditSpendCategoryNamer.CATEGORY_STORAGE
            && categoryName !== CreditSpendCategoryNamer.CATEGORY_OTHER;
    }

    static humaniseName(enumName)
    {
        return String(enumName)
            .toLowerCase()
            .split("_")
            .filter(word => word.length > 0)
            .map((word, wordIndex) => wordIndex === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word)
            .join(" ");
    }
}

module.exports = CreditSpendCategoryNamer;
