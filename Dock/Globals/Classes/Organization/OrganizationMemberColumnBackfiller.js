const OrganizationMemberColumnQueryEngine = require("./OrganizationMemberColumnQueryEngine");
const OrganizationMemberQueryEngine = require("./OrganizationMemberQueryEngine");
const MemberAttributeTypeInferrer = require("./MemberAttributeTypeInferrer");


/**
 * OrganizationMemberColumnBackfiller
 *
 * Gives an organization a column schema built from the roster it already has.
 *
 * Two situations need this and they are the same situation. An organization
 * whose members were imported before columns existed has attributes but nothing
 * describing them; and an import that introduces a header nobody has seen before
 * leaves a stored value with no column row either. Both are answered by reading
 * back the attribute keys actually in use and creating a row for anything
 * missing, with a type inferred from the values themselves.
 *
 * It is deliberately safe to run at any time and as often as you like: existing
 * rows are never touched, so an institute's own labels and type corrections
 * survive every subsequent run. That is what lets it be called from the read
 * path rather than being a migration somebody has to remember to run.
 */
class OrganizationMemberColumnBackfiller
{
    /**
     * Ensures every attribute key this organization stores has a column row.
     *
     * @param {object} database
     * @param {string} organizationId
     * @returns {Promise<{ created: number, attributeKeys: string[] }>}
     */
    static async backfillForOrganization(database, organizationId)
    {
        if (!database || typeof organizationId !== "string" || organizationId.length === 0)
        {
            return { created: 0, attributeKeys: [] };
        }

        const vocabulary = await OrganizationMemberQueryEngine.listProfileVocabulary(organizationId);
        if (vocabulary.attributeKeys.length === 0)
        {
            return { created: 0, attributeKeys: [] };
        }

        const attributeTypesByKey = await MemberAttributeTypeInferrer.inferTypes(database, organizationId, vocabulary.attributeKeys);
        const ensureResult = await OrganizationMemberColumnQueryEngine.ensureColumnsForKeys
        (
            organizationId,
            vocabulary.attributeKeys,
            attributeTypesByKey
        );

        return { created: ensureResult.created, attributeKeys: vocabulary.attributeKeys };
    }
}

module.exports = OrganizationMemberColumnBackfiller;
