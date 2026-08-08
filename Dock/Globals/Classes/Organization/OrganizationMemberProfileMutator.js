const OrganizationMemberProfileNormaliser = require("./OrganizationMemberProfileNormaliser");
const ErrorCodes = require("../../Constants/ErrorCodes");


/**
 * OrganizationMemberProfileMutator
 *
 * Turns "what the administrator asked to change" into the complete set of stored
 * fields one member should end up with.
 *
 * Three screens write members — editing one person, editing a checked selection,
 * and editing everyone a filter matches — and all three go through here so
 * "add a tag" cannot come to mean three slightly different things.
 *
 * The important discipline is that this class never writes a derived map. It
 * decides only the final `attributes` and `tags`, then hands them to
 * OrganizationMemberProfileNormaliser, which is the one place that produces the
 * lowercased and comparable copies. That is deliberate: the bug this codebase
 * already had was a write path that updated `attributes` and forgot
 * `attributesComparable`, leaving members matched on values a correction had
 * replaced. Deriving all four from one intent makes that class of mistake
 * unavailable rather than merely fixed.
 *
 * Edits are PARTIAL by design — an untouched attribute keeps its value. That is
 * the opposite of the sheet import, which replaces a profile wholesale, and the
 * difference is intended: a spreadsheet states the whole truth about a member,
 * whereas someone correcting one field has said nothing about the others.
 */
class OrganizationMemberProfileMutator
{
    // The one field a member is identified BY, so it can never be edited as
    // though it were an ordinary column. Changing it would either orphan the
    // membership from the account it belongs to or silently merge two people.
    static IMMUTABLE_ATTRIBUTE_KEY = "email";

    /**
     * Validates a submitted mutation without touching the database, so a bad
     * payload is refused before any member is written.
     *
     * @param {object} mutation
     * @returns {{ valid: boolean, reason?: string }}
     */
    static validateMutation(mutation)
    {
        if (!mutation || typeof mutation !== "object")
        {
            return { valid: false, reason: ErrorCodes.INVALID_SHAPE };
        }

        const tagFields = ["addTags", "removeTags", "replaceTags"];
        for (const tagField of tagFields)
        {
            if (mutation[tagField] !== undefined && !Array.isArray(mutation[tagField]))
            {
                return { valid: false, reason: ErrorCodes.INVALID_REQUEST };
            }
        }

        // Replacing the tag set and adjusting it are contradictory instructions,
        // and guessing which the administrator meant is how a bulk edit quietly
        // strips tags it was never asked to touch.
        if (Array.isArray(mutation.replaceTags) && (Array.isArray(mutation.addTags) || Array.isArray(mutation.removeTags)))
        {
            return { valid: false, reason: ErrorCodes.INVALID_REQUEST };
        }

        if (mutation.setAttributes !== undefined)
        {
            if (typeof mutation.setAttributes !== "object" || mutation.setAttributes === null || Array.isArray(mutation.setAttributes))
            {
                return { valid: false, reason: ErrorCodes.INVALID_SHAPE };
            }

            for (const rawKey of Object.keys(mutation.setAttributes))
            {
                const attributeKey = OrganizationMemberProfileNormaliser.toAttributeKey(rawKey);
                if (attributeKey.length === 0)
                {
                    return { valid: false, reason: ErrorCodes.INVALID_REQUEST };
                }
                if (attributeKey === OrganizationMemberProfileMutator.IMMUTABLE_ATTRIBUTE_KEY)
                {
                    return { valid: false, reason: ErrorCodes.COLUMN_RESERVED };
                }
            }
        }

        if (mutation.clearAttributeKeys !== undefined && !Array.isArray(mutation.clearAttributeKeys))
        {
            return { valid: false, reason: ErrorCodes.INVALID_REQUEST };
        }

        return { valid: true };
    }

    /**
     * True when a mutation would change nothing. The bulk endpoints refuse one:
     * "apply no changes to 400 people" is a request that was meant to say
     * something and did not, and reporting 400 members updated would be a lie.
     *
     * @param {object} mutation
     * @returns {boolean}
     */
    static isMutationEmpty(mutation)
    {
        if (!mutation || typeof mutation !== "object")
        {
            return true;
        }

        const hasTagChange = Array.isArray(mutation.replaceTags)
            || (Array.isArray(mutation.addTags) && mutation.addTags.length > 0)
            || (Array.isArray(mutation.removeTags) && mutation.removeTags.length > 0);

        const hasAttributeChange = (mutation.setAttributes && Object.keys(mutation.setAttributes).length > 0)
            || (Array.isArray(mutation.clearAttributeKeys) && mutation.clearAttributeKeys.length > 0);

        return !hasTagChange && !hasAttributeChange;
    }

    /**
     * The complete stored profile one member should end up with.
     *
     * @param {object} memberDocument the member as currently stored
     * @param {object} mutation
     * @returns {{ attributes: object, attributesNormalised: object, attributesComparable: object, tags: string[] }}
     */
    static buildMutatedProfile(memberDocument, mutation)
    {
        const currentAttributes = (memberDocument && typeof memberDocument.attributes === "object" && memberDocument.attributes !== null)
            ? memberDocument.attributes
            : {};
        const currentTags = Array.isArray(memberDocument?.tags) ? memberDocument.tags : [];

        const intendedAttributes = { ...currentAttributes };

        for (const [rawKey, rawValue] of Object.entries(mutation?.setAttributes || {}))
        {
            const attributeKey = OrganizationMemberProfileNormaliser.toAttributeKey(rawKey);
            if (attributeKey.length === 0 || attributeKey === OrganizationMemberProfileMutator.IMMUTABLE_ATTRIBUTE_KEY)
            {
                continue;
            }

            const attributeValue = String(rawValue ?? "").trim();
            if (attributeValue.length === 0)
            {
                // Setting a field to blank is how a person clears it on screen,
                // and an absent attribute is what "no value" means everywhere
                // else — storing "" would leave them inside every range filter
                // over a column they never filled in.
                delete intendedAttributes[attributeKey];
                continue;
            }

            intendedAttributes[attributeKey] = attributeValue;
        }

        for (const rawKey of (mutation?.clearAttributeKeys || []))
        {
            const attributeKey = OrganizationMemberProfileNormaliser.toAttributeKey(rawKey);
            if (attributeKey.length > 0)
            {
                delete intendedAttributes[attributeKey];
            }
        }

        const intendedTags = OrganizationMemberProfileMutator.#buildMutatedTags(currentTags, mutation);

        // One intent in, four consistent maps out. Nothing below this line
        // writes a stored field directly.
        return OrganizationMemberProfileNormaliser.normalise
        ({
            attributes: intendedAttributes,
            tags: intendedTags
        });
    }

    static #buildMutatedTags(currentTags, mutation)
    {
        if (Array.isArray(mutation?.replaceTags))
        {
            return mutation.replaceTags;
        }

        const tagSet = new Set(currentTags.map(tag => OrganizationMemberProfileNormaliser.toTag(tag)).filter(tag => tag.length > 0));

        for (const rawTag of (mutation?.addTags || []))
        {
            const tag = OrganizationMemberProfileNormaliser.toTag(rawTag);
            if (tag.length > 0)
            {
                tagSet.add(tag);
            }
        }

        for (const rawTag of (mutation?.removeTags || []))
        {
            const tag = OrganizationMemberProfileNormaliser.toTag(rawTag);
            if (tag.length > 0)
            {
                tagSet.delete(tag);
            }
        }

        return Array.from(tagSet);
    }
}

module.exports = OrganizationMemberProfileMutator;
