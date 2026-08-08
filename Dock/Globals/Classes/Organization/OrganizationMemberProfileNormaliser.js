/**
 * OrganizationMemberProfileNormaliser
 *
 * The single decision about how an imported spreadsheet row becomes stored
 * member fields. Both the import endpoint and the query engine go through it,
 * so what is written and what is searched can never drift apart.
 *
 * Four values come out of one row:
 *
 *   attributes            the values as typed, because these are shown back to
 *                         the administrator and to the member; "B.Tech CSE"
 *                         must not become "b.tech cse" on screen
 *   attributesNormalised  a lowercased copy, because the text range filters
 *                         compare with Mongo's byte ordering, in which every
 *                         uppercase letter sorts before every lowercase one —
 *                         so a case-sensitive range over hand-typed data would
 *                         put "arjun" outside [A, M] entirely
 *   attributesComparable  a typed copy — a Number for a numeric value, an ISO
 *                         string for a date — so a numeric or date range
 *                         compares like with like. Comparing a stored "2024"
 *                         against `$gte: 2024` matches nothing in Mongo, which
 *                         is a silent empty result rather than an error
 *   tags                  lowercased and de-duplicated, because a tag is an
 *                         identity used for targeting credits, permissions and
 *                         decks; "Final-Year" and "final-year" naming the same
 *                         cohort would silently split it in two
 *
 * Keys are camelCased from the sheet's header row, so "Roll Number" and
 * "roll_number" land on the same attribute rather than creating two.
 */
class OrganizationMemberProfileNormaliser
{
    // A tag or attribute value longer than this is almost certainly a pasted
    // paragraph rather than a label, and would bloat every member document.
    static MAXIMUM_VALUE_LENGTH = 256;
    static MAXIMUM_TAG_COUNT = 32;
    static MAXIMUM_ATTRIBUTE_COUNT = 32;

    /**
     * Converts a sheet header into the attribute key it is stored under.
     * "Roll Number" / "roll_number" / "roll-number" all become "rollNumber".
     *
     * IDEMPOTENT: feeding a key back through returns the same key. That matters
     * because stored keys are re-normalised on every edit, and a version of this
     * that lowercased first turned "joinYear" into "joinyear" — a DIFFERENT
     * attribute. Editing a member then wrote the corrected value to a new column
     * beside the original, leaving every filter and rule reading the old one.
     * Splitting on the camelCase boundary before lowercasing is what makes the
     * second pass a no-op.
     *
     * @param {string} rawHeader
     * @returns {string} a camelCase key, or "" when the header carries nothing
     */
    static toAttributeKey(rawHeader)
    {
        if (typeof rawHeader !== "string")
        {
            return "";
        }

        const words = rawHeader
            .trim()
            // "joinYear" -> "join Year" so the existing word boundary survives
            // the lowercasing below. A header written as separate words is
            // unaffected, so both spellings land on the same key.
            .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(word => word.length > 0);

        if (words.length === 0)
        {
            return "";
        }

        return words
            .map((word, wordIndex) => wordIndex === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1))
            .join("");
    }

    /**
     * Normalises one tag. Returns "" for anything that is not a usable tag.
     */
    static toTag(rawTag)
    {
        if (typeof rawTag !== "string")
        {
            return "";
        }
        return rawTag.trim().toLowerCase().slice(0, OrganizationMemberProfileNormaliser.MAXIMUM_VALUE_LENGTH);
    }

    /**
     * The comparable form of one attribute value: a Number when the whole value
     * is numeric, an ISO string when it reads as a date, and undefined when it
     * is plain text (which ranges over the lowercased copy instead).
     *
     * Numeric is tested first and exclusively, because Date.parse accepts a
     * bare "2024" as a year — so a join-year column would become a date range
     * asking the administrator for a calendar span over what is really a number.
     */
    static toComparableValue(attributeValue)
    {
        const trimmed = String(attributeValue ?? "").trim();
        if (trimmed.length === 0)
        {
            return undefined;
        }

        if (/^-?\d+(\.\d+)?$/.test(trimmed))
        {
            const numericValue = Number(trimmed);
            return Number.isFinite(numericValue) ? numericValue : undefined;
        }

        const parsedMilliseconds = Date.parse(trimmed);
        if (!isNaN(parsedMilliseconds))
        {
            return new Date(parsedMilliseconds).toISOString();
        }

        return undefined;
    }

    /**
     * Builds the stored fields from a submitted profile.
     *
     * @param {object} submittedProfile { attributes?: object, tags?: string[] }
     * @returns {{ attributes: object, attributesNormalised: object, attributesComparable: object, tags: string[] }}
     */
    static normalise(submittedProfile)
    {
        const attributes = {};
        const attributesNormalised = {};
        const attributesComparable = {};

        const submittedAttributes = (submittedProfile && typeof submittedProfile.attributes === "object" && submittedProfile.attributes !== null)
            ? submittedProfile.attributes
            : {};

        let attributeCount = 0;
        for (const [rawKey, rawValue] of Object.entries(submittedAttributes))
        {
            if (attributeCount >= OrganizationMemberProfileNormaliser.MAXIMUM_ATTRIBUTE_COUNT)
            {
                break;
            }

            const attributeKey = OrganizationMemberProfileNormaliser.toAttributeKey(rawKey);
            if (attributeKey.length === 0)
            {
                continue;
            }

            const attributeValue = String(rawValue ?? "").trim().slice(0, OrganizationMemberProfileNormaliser.MAXIMUM_VALUE_LENGTH);
            if (attributeValue.length === 0)
            {
                // An empty cell is an absent value, not a value of "". Storing
                // it would make the attribute look present on a member who
                // never supplied it, and put them inside every range filter.
                continue;
            }

            attributes[attributeKey] = attributeValue;
            attributesNormalised[attributeKey] = attributeValue.toLowerCase();

            const comparableValue = OrganizationMemberProfileNormaliser.toComparableValue(attributeValue);
            if (comparableValue !== undefined)
            {
                attributesComparable[attributeKey] = comparableValue;
            }

            attributeCount = attributeCount + 1;
        }

        const submittedTags = Array.isArray(submittedProfile?.tags) ? submittedProfile.tags : [];
        const tagSet = new Set();
        for (const rawTag of submittedTags)
        {
            const tag = OrganizationMemberProfileNormaliser.toTag(rawTag);
            if (tag.length > 0)
            {
                tagSet.add(tag);
            }
            if (tagSet.size >= OrganizationMemberProfileNormaliser.MAXIMUM_TAG_COUNT)
            {
                break;
            }
        }

        return {
            attributes: attributes,
            attributesNormalised: attributesNormalised,
            attributesComparable: attributesComparable,
            tags: Array.from(tagSet)
        };
    }
}

module.exports = OrganizationMemberProfileNormaliser;
