const DatabaseConstants = require("../../Constants/DatabaseConstants");
const OrganizationMemberProfileNormaliser = require("./OrganizationMemberProfileNormaliser");
const { memberAttributeValueTypes } = require("../../Enumerations/MemberAttributeValueTypes");


/**
 * MemberAttributeTypeInferrer
 *
 * Decides how each of an organization's columns reads — as a number, a date or
 * plain text — from a bounded sample of the values it actually holds.
 *
 * This is only ever a SUGGESTION. It seeds the column schema the first time a
 * header appears and offers a starting point in the editor; once an institute
 * has stated a column's type, that answer wins. Sampling has to be overridable
 * because it is a guess with a sharp failure mode: one "N/A" in a column of
 * admission years is enough to make every value read as text, which turns a
 * year range into an alphabetical one for the whole roster.
 *
 * Extracted from OrganizationMemberListBuilder so the list, the schema editor
 * and the backfill all infer a type the same way rather than each keeping their
 * own copy of the rule.
 */
class MemberAttributeTypeInferrer
{
    // How many members to look at. The whole roster is unnecessary — a
    // consistent column shows its type in the first handful of rows, and an
    // inconsistent one falls back to text, which always works.
    static SAMPLE_SIZE = 50;

    /**
     * @param {object} database
     * @param {string} organizationId
     * @param {string[]} attributeKeys
     * @returns {Promise<object>} value type keyed by attribute key
     */
    static async inferTypes(database, organizationId, attributeKeys)
    {
        const attributeTypesByKey = {};
        if (!database || !Array.isArray(attributeKeys) || attributeKeys.length === 0)
        {
            return attributeTypesByKey;
        }

        const sampleDocuments = await database
            .collection(DatabaseConstants.ORGANIZATION_MEMBERS_COLLECTION)
            .find({ organizationId: organizationId }, { projection: { _id: 0, attributes: 1 } })
            .limit(MemberAttributeTypeInferrer.SAMPLE_SIZE)
            .toArray();

        for (const attributeKey of attributeKeys)
        {
            attributeTypesByKey[attributeKey] = MemberAttributeTypeInferrer.inferTypeFromValues
            (
                sampleDocuments.map(sampleDocument => sampleDocument?.attributes?.[attributeKey])
            );
        }

        return attributeTypesByKey;
    }

    /**
     * The type a set of raw values reads as. A column counts as numeric or as a
     * date only when EVERY value it holds agrees; anything mixed is text,
     * because a range over a column that is half years and half words has no
     * meaning the person writing it would predict.
     *
     * @param {Array<*>} rawValues
     * @returns {number} a MemberAttributeValueTypes value
     */
    static inferTypeFromValues(rawValues)
    {
        let observedCount = 0;
        let numericCount = 0;
        let dateCount = 0;

        for (const rawValue of (Array.isArray(rawValues) ? rawValues : []))
        {
            if (typeof rawValue !== "string" || rawValue.length === 0)
            {
                continue;
            }

            observedCount = observedCount + 1;

            // Ask the normaliser, so what the filter offers and what was stored
            // can never disagree about whether a value is a number.
            const comparableValue = OrganizationMemberProfileNormaliser.toComparableValue(rawValue);
            if (typeof comparableValue === "number")
            {
                numericCount = numericCount + 1;
            }
            else if (typeof comparableValue === "string")
            {
                dateCount = dateCount + 1;
            }
        }

        if (observedCount > 0 && numericCount === observedCount)
        {
            return memberAttributeValueTypes.NUMBER;
        }

        if (observedCount > 0 && dateCount === observedCount)
        {
            return memberAttributeValueTypes.DATE;
        }

        return memberAttributeValueTypes.STRING;
    }
}

module.exports = MemberAttributeTypeInferrer;
