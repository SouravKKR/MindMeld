const OrganizationMemberColumnQueryEngine = require("./OrganizationMemberColumnQueryEngine");
const OrganizationMemberProfileNormaliser = require("./OrganizationMemberProfileNormaliser");


/**
 * MemberSheetHeaderResolver
 *
 * Maps the headers of an uploaded roster onto the columns an organization
 * already keeps.
 *
 * Without this, renaming a column would break the next upload. The office that
 * sends the roster still has "Join Year" at the top of its spreadsheet after the
 * column became "admissionYear", and a header matching nothing creates a NEW
 * column rather than filling the existing one — so the institute would end up
 * with both, half the roster in each, and every rule reading whichever it was
 * written against.
 *
 * A header is resolved in three steps, widest-confidence first: the stored key,
 * then what the institute currently calls the column, then any name it used to
 * have. Anything that matches none of those is genuinely new and keeps the key
 * it normalises to.
 */
class MemberSheetHeaderResolver
{
    /**
     * Rewrites one submitted attributes map so its keys are this organization's
     * canonical column keys.
     *
     * @param {Array<OrganizationMemberColumn>} columns
     * @param {object} submittedAttributes keyed by raw sheet header
     * @returns {object} keyed by canonical column key
     */
    static resolveAttributeKeys(columns, submittedAttributes)
    {
        if (!submittedAttributes || typeof submittedAttributes !== "object")
        {
            return {};
        }

        const safeColumns = Array.isArray(columns) ? columns : [];
        if (safeColumns.length === 0)
        {
            return submittedAttributes;
        }

        const resolvedAttributes = {};

        for (const [rawHeader, rawValue] of Object.entries(submittedAttributes))
        {
            const column = OrganizationMemberColumnQueryEngine.resolveColumnForHeader(safeColumns, rawHeader);
            const resolvedKey = column !== null
                ? column.getKey()
                : OrganizationMemberProfileNormaliser.toAttributeKey(rawHeader);

            if (resolvedKey.length === 0)
            {
                continue;
            }

            // A sheet carrying both the old name and the new one has said the
            // same thing twice. The canonical column keeps the value it already
            // resolved rather than being overwritten by the stale spelling.
            if (resolvedAttributes[resolvedKey] === undefined || String(rawValue ?? "").trim().length > 0)
            {
                resolvedAttributes[resolvedKey] = rawValue;
            }
        }

        return resolvedAttributes;
    }

    /**
     * The same mapping across a whole submitted batch.
     *
     * @param {Array<OrganizationMemberColumn>} columns
     * @param {Array<object>} submittedMembers
     * @returns {Array<object>} the members with their attribute keys resolved
     */
    static resolveBatch(columns, submittedMembers)
    {
        const safeMembers = Array.isArray(submittedMembers) ? submittedMembers : [];

        return safeMembers.map(submittedMember => (
        {
            ...submittedMember,
            attributes: MemberSheetHeaderResolver.resolveAttributeKeys(columns, submittedMember?.attributes)
        }));
    }
}

module.exports = MemberSheetHeaderResolver;
