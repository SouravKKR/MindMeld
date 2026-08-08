const MongoQueryFragmentEvaluator = require("./MongoQueryFragmentEvaluator");
const MemberConditionFilterFactory = require("./MemberConditionFilterFactory");
const { tagMatchModes } = require("../../Enumerations/TagMatchModes");


/**
 * MemberAudienceMatcher
 *
 * Who an organization means when it describes a group of its members.
 *
 * An audience is tags plus conditions over the institute's own columns —
 * "final-year scholarship students admitted between 2022 and 2024" — and exactly
 * one class answers it, because three separate things ask: which members a
 * permission rule grants features to, who a one-off credit distribution reaches,
 * and who a recurring assignment tops up each month. Before this, all three
 * asked about tags alone and shared a single predicate for that reason. Widening
 * the language without keeping them together would have let a rule and a credit
 * grant disagree about the same sentence.
 *
 * The same audience can be answered two ways, and both live here so they cannot
 * drift: `matchesMember` decides one already-loaded member with no database
 * access, which is what the per-request feature gate needs, and
 * `buildAudienceQuery` produces the Mongo fragment for the screens that need the
 * whole set. Both run off the same conditions through the same filter objects.
 *
 * Tags stay a separate field rather than becoming another condition. ANY and ALL
 * over a list are semantics the range filters cannot express, and keeping tags
 * where they are means every rule written before columns existed goes on meaning
 * precisely what it meant.
 */
class MemberAudienceMatcher
{
    /**
     * Whether one member falls inside an audience.
     *
     * @param {OrganizationMember|object} member a model instance or a plain document
     * @param {{tagFilter?: string[], matchMode?: number, attributeConditions?: Array<object>}} audience
     * @returns {boolean}
     */
    static matchesMember(member, audience)
    {
        const memberDocument = MemberAudienceMatcher.#toPlainDocument(member);
        if (memberDocument === null)
        {
            return false;
        }

        if (!MemberAudienceMatcher.#matchesTags(memberDocument, audience))
        {
            return false;
        }

        for (const condition of MemberAudienceMatcher.#safeConditions(audience))
        {
            const filter = MemberConditionFilterFactory.create(condition);
            if (filter === null)
            {
                // A condition that cannot be rebuilt selects nobody. Skipping it
                // would hand the rule to everyone it was written to exclude.
                return false;
            }

            const queryFragment = filter.toMongoQuery(condition.value);
            if (queryFragment === null || queryFragment === undefined)
            {
                // An unfilled condition narrows nothing, exactly as it does on
                // the roster screen.
                continue;
            }

            if (!MongoQueryFragmentEvaluator.matches(memberDocument, queryFragment))
            {
                return false;
            }
        }

        return true;
    }

    /**
     * The members of a loaded list that fall inside an audience.
     *
     * @param {Array<OrganizationMember|object>} members
     * @param {object} audience
     * @returns {Array<OrganizationMember|object>}
     */
    static filterMembers(members, audience)
    {
        const safeMembers = Array.isArray(members) ? members : [];
        return safeMembers.filter(member => MemberAudienceMatcher.matchesMember(member, audience));
    }

    /**
     * The Mongo fragment selecting an audience, for the callers that need the
     * whole set rather than a verdict on one member. NOT scoped to an
     * organization — the caller adds that, the same way the member list does, so
     * the scope can never come from a client payload.
     *
     * @param {object} audience
     * @returns {object} a Mongo query fragment
     */
    static buildAudienceQuery(audience)
    {
        const queryParts = [];

        const normalisedTags = MemberAudienceMatcher.#normalisedTagFilter(audience);
        const matchMode = MemberAudienceMatcher.#resolvedMatchMode(audience);

        if (matchMode !== tagMatchModes.EVERYONE && normalisedTags.length > 0)
        {
            queryParts.push(matchMode === tagMatchModes.ALL
                ? { tags: { $all: normalisedTags } }
                : { tags: { $in: normalisedTags } });
        }

        for (const condition of MemberAudienceMatcher.#safeConditions(audience))
        {
            const filter = MemberConditionFilterFactory.create(condition);
            if (filter === null)
            {
                // Matches nobody, said out loud rather than by omission — the
                // same answer matchesMember gives for the same condition.
                queryParts.push({ _unresolvableCondition: { $exists: true } });
                continue;
            }

            const queryFragment = filter.toMongoQuery(condition.value);
            if (queryFragment !== null && queryFragment !== undefined)
            {
                queryParts.push(queryFragment);
            }
        }

        if (queryParts.length === 0)
        {
            return {};
        }

        return { $and: queryParts };
    }

    /**
     * True when an audience narrows nothing and therefore means every member.
     *
     * @param {object} audience
     * @returns {boolean}
     */
    static isEveryone(audience)
    {
        return Object.keys(MemberAudienceMatcher.buildAudienceQuery(audience)).length === 0;
    }

    static #matchesTags(memberDocument, audience)
    {
        const normalisedTags = MemberAudienceMatcher.#normalisedTagFilter(audience);
        const matchMode = MemberAudienceMatcher.#resolvedMatchMode(audience);

        // An empty tag list can never select nobody: "everyone" and "everyone
        // who happens to carry no tags at all" are different sentences, and the
        // second is not one an administrator would have meant to write.
        if (matchMode === tagMatchModes.EVERYONE || normalisedTags.length === 0)
        {
            return true;
        }

        const memberTags = Array.isArray(memberDocument.tags) ? memberDocument.tags : [];

        if (matchMode === tagMatchModes.ALL)
        {
            return normalisedTags.every(tag => memberTags.includes(tag));
        }

        return normalisedTags.some(tag => memberTags.includes(tag));
    }

    static #normalisedTagFilter(audience)
    {
        return (Array.isArray(audience?.tagFilter) ? audience.tagFilter : [])
            .map(tag => String(tag ?? "").trim().toLowerCase())
            .filter(tag => tag.length > 0);
    }

    static #resolvedMatchMode(audience)
    {
        const matchMode = audience?.matchMode;
        return Object.values(tagMatchModes).includes(matchMode) ? matchMode : tagMatchModes.EVERYONE;
    }

    static #safeConditions(audience)
    {
        return Array.isArray(audience?.attributeConditions) ? audience.attributeConditions : [];
    }

    /**
     * Accepts either an OrganizationMember model or the raw document, because
     * the feature gate holds a model and the bulk paths hold documents, and
     * neither should have to convert before asking a question.
     *
     * Every accessor is read defensively rather than assumed. A tags-only stub
     * is a legitimate caller — plenty of code holds just enough of a member to
     * ask a tag question — and demanding a fully-formed model would turn a
     * question this class can answer into a crash.
     */
    static #toPlainDocument(member)
    {
        if (!member || typeof member !== "object")
        {
            return null;
        }

        if (typeof member.getTags !== "function")
        {
            return member;
        }

        return {
            tags: MemberAudienceMatcher.#readAccessor(member, "getTags", []),
            attributes: MemberAudienceMatcher.#readAccessor(member, "getAttributes", {}),
            attributesNormalised: MemberAudienceMatcher.#readAccessor(member, "getAttributesNormalised", {}),
            attributesComparable: MemberAudienceMatcher.#readAccessor(member, "getAttributesComparable", {}),
            email: MemberAudienceMatcher.#readAccessor(member, "getEmail", ""),
            addedAt: MemberAudienceMatcher.#readAccessor(member, "getAddedAt", undefined)
        };
    }

    static #readAccessor(member, accessorName, fallbackValue)
    {
        if (typeof member[accessorName] !== "function")
        {
            return fallbackValue;
        }

        const readValue = member[accessorName]();
        return (readValue === null || readValue === undefined) ? fallbackValue : readValue;
    }
}

module.exports = MemberAudienceMatcher;
