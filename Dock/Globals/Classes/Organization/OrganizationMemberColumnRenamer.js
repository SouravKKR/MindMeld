const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const OrganizationMemberColumnQueryEngine = require("./OrganizationMemberColumnQueryEngine");
const OrganizationMemberProfileNormaliser = require("./OrganizationMemberProfileNormaliser");
const { memberColumnRenamePhases } = require("../../Enumerations/MemberColumnRenamePhases");
const ErrorCodes = require("../../Constants/ErrorCodes");


/**
 * OrganizationMemberColumnRenamer
 *
 * Moves one of an institute's columns onto a new stored key, rewriting every
 * member document and every rule that referred to it.
 *
 * This is a real rename rather than a display label, because the label is not
 * where a column's identity lives. Rules, filters and imports all key off the
 * stored name, so an institute that renamed only the caption would still find
 * "joinYear" in its exports, in its rule payloads, and in the header its office
 * has to keep typing.
 *
 * ── Why it is three phases ────────────────────────────────────────────────────
 *
 * There is no replica set behind this deployment (the connection string carries
 * directConnection=true), so multi-document transactions are unavailable and the
 * member documents, the rules and the column row cannot be moved as one atomic
 * act. A naive rename would therefore have a window in which the rules point at
 * a key the members no longer carry — and during that window every rule
 * targeting the column silently matches nobody, quietly withdrawing whatever it
 * granted from everyone it covered.
 *
 * So the values are COPIED to the new key before anything is repointed and only
 * removed from the old key afterwards:
 *
 *   1. COPYING     both keys exist. Rules still read the old one and still match.
 *   2. REPOINTING  rules, assignments and the column row move to the new key.
 *                  Both keys are present at this instant, so matching is
 *                  continuous across the switch.
 *   3. CLEANING    the old key is removed. Nothing refers to it any more.
 *
 * At no point does a member lose an entitlement they were entitled to.
 *
 * Each phase is idempotent, and the phase reached is recorded on the column row,
 * so a process killed halfway can simply be run again: re-running a completed
 * phase changes nothing, and the run picks up where it stopped. The old key is
 * kept as an alias afterwards, which is what lets the office go on sending the
 * spreadsheet it already has.
 */
class OrganizationMemberColumnRenamer
{
    /**
     * @param {string} organizationId
     * @param {string} currentKey
     * @param {string} requestedNewKey
     * @param {string} newLabel
     * @returns {Promise<{ok: boolean, reason?: string, newKey?: string, membersCopied?: number, membersCleaned?: number, rulesRepointed?: number}>}
     */
    static async rename(organizationId, currentKey, requestedNewKey, newLabel)
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return { ok: false, reason: ErrorCodes.DATABASE_UNAVAILABLE };
        }

        const newKey = OrganizationMemberProfileNormaliser.toAttributeKey(requestedNewKey);
        if (newKey.length === 0)
        {
            return { ok: false, reason: ErrorCodes.INVALID_REQUEST };
        }

        if (newKey === OrganizationMemberColumnQueryEngine.RESERVED_COLUMN_KEY)
        {
            return { ok: false, reason: ErrorCodes.COLUMN_RESERVED };
        }

        const column = await OrganizationMemberColumnQueryEngine.findColumnByKey(organizationId, currentKey);
        if (!column)
        {
            return { ok: false, reason: ErrorCodes.COLUMN_NOT_FOUND };
        }

        if (newKey === currentKey)
        {
            // A label-only change is a plain edit, not a migration.
            await OrganizationMemberColumnQueryEngine.updateColumns(organizationId,
            [{
                key: currentKey,
                label: typeof newLabel === "string" && newLabel.trim().length > 0 ? newLabel : column.getLabel(),
                valueType: column.getValueType(),
                displayOrder: column.getDisplayOrder()
            }]);
            return { ok: true, newKey: currentKey, membersCopied: 0, membersCleaned: 0, rulesRepointed: 0 };
        }

        if (column.getRenamePhase() !== memberColumnRenamePhases.IDLE)
        {
            // Two renames interleaving on one column would each repoint half the
            // references. Refused rather than queued: the right response is to
            // finish or re-run the first one.
            return { ok: false, reason: ErrorCodes.COLUMN_RENAME_IN_PROGRESS };
        }

        const existingTarget = await OrganizationMemberColumnQueryEngine.findColumnByKey(organizationId, newKey);
        if (existingTarget)
        {
            // Merging two columns is a different decision with a different
            // answer for every conflicting pair, so it is refused rather than
            // guessed at.
            return { ok: false, reason: ErrorCodes.COLUMN_ALREADY_EXISTS };
        }

        return await OrganizationMemberColumnRenamer.#runPhases(database, organizationId, currentKey, newKey, newLabel);
    }

    /**
     * Re-runs an interrupted rename from wherever it stopped. Safe to call on a
     * column that is already IDLE, where it does nothing.
     *
     * @param {string} organizationId
     * @param {string} currentKey
     * @returns {Promise<{ok: boolean, reason?: string, resumed?: boolean}>}
     */
    static async resumeInterruptedRename(organizationId, currentKey)
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return { ok: false, reason: ErrorCodes.DATABASE_UNAVAILABLE };
        }

        const column = await OrganizationMemberColumnQueryEngine.findColumnByKey(organizationId, currentKey);
        if (!column || column.getRenamePhase() === memberColumnRenamePhases.IDLE)
        {
            return { ok: true, resumed: false };
        }

        const pendingKey = column.getPendingRenameToKey();
        if (typeof pendingKey !== "string" || pendingKey.length === 0)
        {
            return { ok: false, reason: ErrorCodes.INVALID_REQUEST };
        }

        const result = await OrganizationMemberColumnRenamer.#runPhases(database, organizationId, column.getKey(), pendingKey, column.getLabel());
        return { ...result, resumed: true };
    }

    static async #runPhases(database, organizationId, currentKey, newKey, newLabel)
    {
        const membersCollection = database.collection(DatabaseConstants.ORGANIZATION_MEMBERS_COLLECTION);

        // ── 1. COPYING ────────────────────────────────────────────────────────
        // Both keys carry the value from here until cleanup, so every rule that
        // still names the old one keeps matching exactly who it matched before.
        await OrganizationMemberColumnQueryEngine.setRenamePhase(organizationId, currentKey, memberColumnRenamePhases.COPYING, newKey);
        const copyResult = await OrganizationMemberColumnRenamer.#copyAttribute(membersCollection, organizationId, currentKey, newKey);

        // ── 2. REPOINTING ─────────────────────────────────────────────────────
        // Rules and assignments move while both keys are present, so there is no
        // instant at which a rule reads a key nobody has.
        await OrganizationMemberColumnQueryEngine.setRenamePhase(organizationId, currentKey, memberColumnRenamePhases.REPOINTING, newKey);
        const repointedCount = await OrganizationMemberColumnRenamer.#repointReferences(database, organizationId, currentKey, newKey);

        // The column row moves last within this phase, because everything above
        // located it by its current key.
        await OrganizationMemberColumnQueryEngine.commitRenamedKey(organizationId, currentKey, newKey, newLabel);

        // ── 3. CLEANING ───────────────────────────────────────────────────────
        await OrganizationMemberColumnQueryEngine.setRenamePhase(organizationId, newKey, memberColumnRenamePhases.CLEANING, newKey);
        const cleanResult = await OrganizationMemberColumnRenamer.#removeAttribute(membersCollection, organizationId, currentKey);

        await OrganizationMemberColumnQueryEngine.setRenamePhase(organizationId, newKey, memberColumnRenamePhases.IDLE, "");

        return {
            ok: true,
            newKey: newKey,
            membersCopied: copyResult.updated,
            membersCleaned: cleanResult.updated,
            rulesRepointed: repointedCount
        };
    }

    /**
     * Copies all three stored copies of one attribute onto a new key, leaving
     * the originals in place.
     *
     * An aggregation-pipeline update so the three maps are rewritten from their
     * own current contents in a single pass over the roster. Members who never
     * had the attribute are matched out rather than gaining an empty one — an
     * absent value is what "this person has no admission year" means, and
     * writing a blank would put them inside every range over the column.
     */
    static async #copyAttribute(membersCollection, organizationId, currentKey, newKey)
    {
        const updateResult = await membersCollection.updateMany
        (
            { organizationId: organizationId, [`attributes.${currentKey}`]: { $exists: true } },
            [
                {
                    $set:
                    {
                        attributes: { $mergeObjects: ["$attributes", { [newKey]: `$attributes.${currentKey}` }] },
                        attributesNormalised: { $mergeObjects: ["$attributesNormalised", { [newKey]: `$attributesNormalised.${currentKey}` }] }
                    }
                },
                {
                    // Kept separate and conditional: the comparable copy exists
                    // only for values that read as a number or a date, so merging
                    // it unconditionally would invent a null for every text
                    // column and make it look present to a range filter.
                    $set:
                    {
                        attributesComparable:
                        {
                            $cond:
                            [
                                { $ne: [{ $type: `$attributesComparable.${currentKey}` }, "missing"] },
                                { $mergeObjects: ["$attributesComparable", { [newKey]: `$attributesComparable.${currentKey}` }] },
                                "$attributesComparable"
                            ]
                        }
                    }
                }
            ]
        );

        return { updated: updateResult.modifiedCount || 0 };
    }

    static async #removeAttribute(membersCollection, organizationId, attributeKey)
    {
        const unsetFields = {};
        unsetFields[`attributes.${attributeKey}`] = "";
        unsetFields[`attributesNormalised.${attributeKey}`] = "";
        unsetFields[`attributesComparable.${attributeKey}`] = "";

        const updateResult = await membersCollection.updateMany
        (
            { organizationId: organizationId },
            { $unset: unsetFields }
        );

        return { updated: updateResult.modifiedCount || 0 };
    }

    /**
     * Rewrites every stored reference to the old key — permission rules and
     * recurring credit assignments alike.
     *
     * Both the condition's key and the field path it reads move together,
     * because a condition is self-describing precisely so that deciding a
     * member's features needs no schema lookup; leaving the field behind would
     * make the rule read a column that no longer exists.
     */
    static async #repointReferences(database, organizationId, currentKey, newKey)
    {
        let repointedCount = 0;

        repointedCount += await OrganizationMemberColumnRenamer.#repointCollection
        (
            database.collection(DatabaseConstants.ORGANIZATION_PERMISSION_RULES_COLLECTION),
            { organizationId: organizationId },
            currentKey,
            newKey
        );

        repointedCount += await OrganizationMemberColumnRenamer.#repointCollection
        (
            database.collection(DatabaseConstants.PERIODIC_CREDIT_ASSIGNMENTS_COLLECTION),
            { organizationId: organizationId },
            currentKey,
            newKey
        );

        return repointedCount;
    }

    static async #repointCollection(collection, baseQuery, currentKey, newKey)
    {
        const documents = await collection.find(baseQuery).toArray();
        let repointedCount = 0;

        for (const document of documents)
        {
            const conditions = Array.isArray(document.attributeConditions) ? document.attributeConditions : [];
            if (conditions.length === 0)
            {
                continue;
            }

            let bChanged = false;
            const rewrittenConditions = conditions.map((condition) =>
            {
                const rewritten = { ...condition };

                if (typeof rewritten.field === "string" && rewritten.field.endsWith(`.${currentKey}`))
                {
                    rewritten.field = `${rewritten.field.slice(0, -currentKey.length)}${newKey}`;
                    bChanged = true;
                }

                if (typeof rewritten.key === "string" && rewritten.key.endsWith(`:${currentKey}`))
                {
                    rewritten.key = `${rewritten.key.slice(0, -currentKey.length)}${newKey}`;
                    bChanged = true;
                }

                return rewritten;
            });

            if (!bChanged)
            {
                continue;
            }

            await collection.updateOne({ id: document.id }, { $set: { attributeConditions: rewrittenConditions } });
            repointedCount = repointedCount + 1;
        }

        return repointedCount;
    }
}

module.exports = OrganizationMemberColumnRenamer;
