const OrganizationCreditLedger = require("./OrganizationCreditLedger");

/**
 * OrganizationPoolHistoryView
 *
 * Turns the pool's raw ledger rows into the movements an administrator reads.
 *
 * Two jobs, both of which have to be the server's. It decides which rows are
 * SETTLED — the ledger claims a row before it moves anything, so a pending row
 * is either still in flight or was abandoned, and showing those would have
 * somebody counting the same credits twice or chasing a distribution that never
 * happened. And it decides what each row SAYS, because the stored transaction
 * type is a coarse PURCHASE / DISTRIBUTION / ADJUSTMENT and only the metadata
 * distinguishes a top-up from CogniumLearn from credits handed back after a
 * distribution failed.
 *
 * Both belong here rather than in the browser: the status vocabulary and the
 * metadata shape are the ledger's, and a client comparing strings it cannot
 * import would silently show an empty history the day either changed.
 */
class OrganizationPoolHistoryView
{
    /**
     * @param {Array<object>} transactionDocuments rows from OrganizationCreditLedger.listTransactions
     * @returns {Array<{ createdAt: string, amount: number, balanceAfter: number|null, description: string, note: string }>}
     */
    static buildSettledMovements(transactionDocuments)
    {
        const safeDocuments = Array.isArray(transactionDocuments) ? transactionDocuments : [];

        return safeDocuments
            .filter(document => document && document.status === OrganizationCreditLedger.TRANSACTION_STATUS_APPLIED)
            .map(document => (
            {
                createdAt: document.createdAt,
                amount: document.amount,
                balanceAfter: document.balanceAfter === undefined ? null : document.balanceAfter,
                description: OrganizationPoolHistoryView.#describe(document),
                note: OrganizationPoolHistoryView.#describeNote(document)
            }));
    }

    static #describe(transactionDocument)
    {
        // The stored field is `type`, NOT `transactionType`: the ledger's claim
        // row names it that way. Reading the wrong one is silent — every
        // movement simply falls through to the adjustment branch and a
        // distribution reads as "taken back" — so the field name is taken from
        // the ledger's own accessor rather than guessed at.
        const movementType = OrganizationCreditLedger.readTransactionType(transactionDocument);

        if (movementType === OrganizationCreditLedger.TRANSACTION_TYPE_PURCHASE)
        {
            return "Credits purchased";
        }

        if (movementType === OrganizationCreditLedger.TRANSACTION_TYPE_DISTRIBUTION)
        {
            return "Given out to members";
        }

        const metadata = OrganizationPoolHistoryView.#readMetadata(transactionDocument);
        if (metadata.source === OrganizationCreditLedger.MOVEMENT_SOURCE_ADMIN_GRANT)
        {
            return "Added by CogniumLearn";
        }

        // An adjustment with no recognised source: signed, so it still reads as
        // something rather than as an unexplained number.
        return transactionDocument.amount > 0 ? "Returned to the pool" : "Taken back";
    }

    static #describeNote(transactionDocument)
    {
        const metadata = OrganizationPoolHistoryView.#readMetadata(transactionDocument);

        if (typeof metadata.reason === "string" && metadata.reason.length > 0)
        {
            return metadata.reason;
        }
        if (typeof metadata.grantName === "string" && metadata.grantName.length > 0)
        {
            return metadata.grantName;
        }
        if (Number.isFinite(Number(metadata.recipientCount)))
        {
            const recipientCount = Number(metadata.recipientCount);
            return `${recipientCount} member${recipientCount === 1 ? "" : "s"}`;
        }

        return "—";
    }

    static #readMetadata(transactionDocument)
    {
        const metadata = transactionDocument.metadata;
        return metadata !== null && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};
    }
}

module.exports = OrganizationPoolHistoryView;
