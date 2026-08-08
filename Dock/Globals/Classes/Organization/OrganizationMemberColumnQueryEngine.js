const crypto = require("crypto");
const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const OrganizationMemberColumn = require("../../Model/OrganizationMemberColumn");
const OrganizationMemberProfileNormaliser = require("./OrganizationMemberProfileNormaliser");
const { memberAttributeValueTypes } = require("../../Enumerations/MemberAttributeValueTypes");
const { memberColumnRenamePhases } = require("../../Enumerations/MemberColumnRenamePhases");
const ErrorCodes = require("../../Constants/ErrorCodes");


/**
 * OrganizationMemberColumnQueryEngine
 *
 * The columns ONE organization keeps about its members — what each is called,
 * how its values read, and which older names still resolve to it.
 *
 * Every column except the email address belongs to the institute. A school
 * uploading "joinYear" and a coaching centre uploading "batch" and "centre" do
 * not share a schema, and teachers on the same roster may carry none of the
 * columns the students do. So the schema is discovered rather than declared: a
 * row appears the first time an import mentions a header, and the institute can
 * afterwards rename it, relabel it, reorder it or correct how it reads.
 *
 * `valueType` is the part worth explaining. The list builder can infer a type by
 * sampling stored values, but sampling is a guess that a single "N/A" in a
 * column of years quietly turns into a text range for everybody. Storing the
 * type makes the institute's answer the authority and the sample only the
 * starting suggestion.
 *
 * `aliases` is what keeps a rename from breaking the next upload. The office
 * that sends the roster still has "Join Year" in its spreadsheet after the
 * column became "admissionYear", and a header that matched nothing would create
 * a second column beside the first rather than filling it.
 */
class OrganizationMemberColumnQueryEngine
{
    static #COLLECTION_NAME = DatabaseConstants.ORGANIZATION_MEMBER_COLUMNS_COLLECTION;

    // The importer already refuses more than 32 attributes on a single row, so a
    // roster cannot smuggle in more columns than this; the ceiling exists so a
    // crafted schema payload cannot grow the list without bound either.
    static MAXIMUM_COLUMNS_PER_ORGANIZATION = 64;

    static MAXIMUM_ALIASES_PER_COLUMN = 16;

    static MAXIMUM_LABEL_LENGTH = 128;

    // The one column that is not the institute's to name. It is the identity a
    // membership is keyed by, so it can never become an ordinary attribute.
    static RESERVED_COLUMN_KEY = "email";

    static async #getCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return null;
        }
        return database.collection(OrganizationMemberColumnQueryEngine.#COLLECTION_NAME);
    }

    /**
     * This organization's columns, in the order the institute arranged them.
     *
     * @param {string} organizationId
     * @returns {Promise<Array<OrganizationMemberColumn>>}
     */
    static async listColumnsForOrganization(organizationId)
    {
        const collection = await OrganizationMemberColumnQueryEngine.#getCollection();
        if (!collection || typeof organizationId !== "string" || organizationId.length === 0)
        {
            return [];
        }

        const documents = await collection
            .find({ organizationId: organizationId }, { projection: { _id: 0 } })
            .sort({ displayOrder: 1, key: 1 })
            .toArray();

        return documents.map(document => OrganizationMemberColumn.fromJson(document));
    }

    /**
     * A label a person would recognise, derived from a stored key. Used as the
     * starting label for a column nobody has named yet — "rollNumber" reads as
     * "Roll Number" rather than as itself.
     *
     * @param {string} attributeKey
     * @returns {string}
     */
    static describeAttributeKey(attributeKey)
    {
        const spacedText = String(attributeKey).replace(/([a-z0-9])([A-Z])/g, "$1 $2");
        return spacedText.charAt(0).toUpperCase() + spacedText.slice(1);
    }

    /**
     * Creates a column row for every attribute key that does not have one yet,
     * so an institute that never opens the schema editor still has a schema.
     *
     * Called after an import and by the backfill. Existing rows are left exactly
     * as they are — the institute's label and type outrank a fresh guess.
     *
     * @param {string} organizationId
     * @param {string[]} attributeKeys
     * @param {object} attributeTypesByKey inferred types, keyed by attribute key
     * @returns {Promise<{ created: number }>}
     */
    static async ensureColumnsForKeys(organizationId, attributeKeys, attributeTypesByKey = {})
    {
        const collection = await OrganizationMemberColumnQueryEngine.#getCollection();
        if (!collection || typeof organizationId !== "string" || organizationId.length === 0)
        {
            return { created: 0 };
        }

        const safeKeys = (Array.isArray(attributeKeys) ? attributeKeys : [])
            .map(attributeKey => String(attributeKey ?? "").trim())
            .filter(attributeKey => attributeKey.length > 0 && attributeKey !== OrganizationMemberColumnQueryEngine.RESERVED_COLUMN_KEY);

        if (safeKeys.length === 0)
        {
            return { created: 0 };
        }

        const existingColumns = await OrganizationMemberColumnQueryEngine.listColumnsForOrganization(organizationId);
        const existingKeys = new Set(existingColumns.map(column => column.getKey()));

        // A key already claimed as somebody's former name is NOT a new column —
        // it is the old name of one that still exists, which is exactly the
        // state the cleanup phase of a rename passes through.
        for (const column of existingColumns)
        {
            for (const alias of column.getAliases() || [])
            {
                existingKeys.add(alias);
            }
        }

        const remainingSlots = OrganizationMemberColumnQueryEngine.MAXIMUM_COLUMNS_PER_ORGANIZATION - existingColumns.length;
        if (remainingSlots <= 0)
        {
            return { created: 0 };
        }

        const missingKeys = safeKeys.filter(attributeKey => !existingKeys.has(attributeKey)).slice(0, remainingSlots);
        if (missingKeys.length === 0)
        {
            return { created: 0 };
        }

        let nextDisplayOrder = existingColumns.length;
        const documents = missingKeys.map((attributeKey) =>
        {
            const valueType = Object.values(memberAttributeValueTypes).includes(attributeTypesByKey[attributeKey])
                ? attributeTypesByKey[attributeKey]
                : memberAttributeValueTypes.STRING;

            const document =
            {
                id: crypto.randomUUID(),
                organizationId: organizationId,
                key: attributeKey,
                label: OrganizationMemberColumnQueryEngine.describeAttributeKey(attributeKey),
                valueType: valueType,
                aliases: [],
                displayOrder: nextDisplayOrder,
                renamePhase: memberColumnRenamePhases.IDLE,
                pendingRenameToKey: "",
                createdAt: new Date().toISOString()
            };

            nextDisplayOrder = nextDisplayOrder + 1;
            return document;
        });

        // Unordered so a racing import that created the same column a moment ago
        // loses only its own duplicate rather than the whole batch. The unique
        // (organizationId, key) index is what makes that race safe.
        try
        {
            await collection.insertMany(documents, { ordered: false });
        }
        catch (insertError)
        {
            if (insertError?.code !== 11000 && !Array.isArray(insertError?.writeErrors))
            {
                throw insertError;
            }
        }

        return { created: documents.length };
    }

    /**
     * The column a spreadsheet header refers to, or null when it names something
     * this organization has never stored.
     *
     * Resolution order is stored key, then the institute's own label, then any
     * former name. That order is what lets a renamed column keep absorbing the
     * sheets the office was already sending.
     *
     * @param {Array<OrganizationMemberColumn>} columns
     * @param {string} rawHeader
     * @returns {OrganizationMemberColumn|null}
     */
    static resolveColumnForHeader(columns, rawHeader)
    {
        const headerKey = OrganizationMemberProfileNormaliser.toAttributeKey(rawHeader);
        if (headerKey.length === 0)
        {
            return null;
        }

        const safeColumns = Array.isArray(columns) ? columns : [];

        for (const column of safeColumns)
        {
            if (column.getKey() === headerKey)
            {
                return column;
            }
        }

        for (const column of safeColumns)
        {
            if (OrganizationMemberProfileNormaliser.toAttributeKey(column.getLabel()) === headerKey)
            {
                return column;
            }
        }

        for (const column of safeColumns)
        {
            const aliases = Array.isArray(column.getAliases()) ? column.getAliases() : [];
            if (aliases.includes(headerKey))
            {
                return column;
            }
        }

        return null;
    }

    /**
     * Validates one submitted column edit. Pure — no database access — so a whole
     * malformed schema can be refused before any of it is written.
     *
     * Note that `key` is deliberately NOT editable here: changing which key a
     * column stores under rewrites every member document and is the rename
     * operation, not an edit.
     *
     * @param {object} columnInput
     * @returns {{ valid: boolean, reason?: string }}
     */
    static validateColumn(columnInput)
    {
        if (!columnInput || typeof columnInput !== "object")
        {
            return { valid: false, reason: ErrorCodes.INVALID_SHAPE };
        }

        const key = typeof columnInput.key === "string" ? columnInput.key.trim() : "";
        if (key.length === 0 || key.length > 64)
        {
            return { valid: false, reason: ErrorCodes.INVALID_REQUEST };
        }

        if (key === OrganizationMemberColumnQueryEngine.RESERVED_COLUMN_KEY)
        {
            return { valid: false, reason: ErrorCodes.COLUMN_RESERVED };
        }

        const label = typeof columnInput.label === "string" ? columnInput.label.trim() : "";
        if (label.length === 0 || label.length > OrganizationMemberColumnQueryEngine.MAXIMUM_LABEL_LENGTH)
        {
            return { valid: false, reason: ErrorCodes.INVALID_NAME };
        }

        if (!Object.values(memberAttributeValueTypes).includes(columnInput.valueType))
        {
            return { valid: false, reason: ErrorCodes.INVALID_REQUEST };
        }

        if (columnInput.displayOrder !== undefined && (!Number.isInteger(columnInput.displayOrder) || columnInput.displayOrder < 0))
        {
            return { valid: false, reason: ErrorCodes.INVALID_REQUEST };
        }

        return { valid: true };
    }

    /**
     * Applies the institute's edits — label, how the values read, and the order
     * the columns appear in. Keys are matched, never changed.
     *
     * A column mid-rename is skipped rather than written: its key is about to
     * move, and an edit landing between the phases would be applied to a row
     * that is no longer the one the administrator was looking at.
     *
     * @param {string} organizationId
     * @param {Array<object>} columnInputs
     * @returns {Promise<{ updated: number }>}
     */
    static async updateColumns(organizationId, columnInputs)
    {
        const collection = await OrganizationMemberColumnQueryEngine.#getCollection();
        if (!collection)
        {
            throw new Error("Database unavailable");
        }

        const safeInputs = Array.isArray(columnInputs)
            ? columnInputs.slice(0, OrganizationMemberColumnQueryEngine.MAXIMUM_COLUMNS_PER_ORGANIZATION)
            : [];

        for (const columnInput of safeInputs)
        {
            const validation = OrganizationMemberColumnQueryEngine.validateColumn(columnInput);
            if (!validation.valid)
            {
                throw new Error(`Invalid column: ${validation.reason}`);
            }
        }

        const writeOperations = safeInputs.map((columnInput, inputIndex) => (
        {
            updateOne:
            {
                filter:
                {
                    organizationId: organizationId,
                    key: columnInput.key.trim(),
                    renamePhase: memberColumnRenamePhases.IDLE
                },
                update:
                {
                    $set:
                    {
                        label: columnInput.label.trim().slice(0, OrganizationMemberColumnQueryEngine.MAXIMUM_LABEL_LENGTH),
                        valueType: columnInput.valueType,
                        displayOrder: Number.isInteger(columnInput.displayOrder) ? columnInput.displayOrder : inputIndex
                    }
                }
            }
        }));

        if (writeOperations.length === 0)
        {
            return { updated: 0 };
        }

        const bulkResult = await collection.bulkWrite(writeOperations, { ordered: false });
        return { updated: bulkResult.modifiedCount || 0 };
    }

    /**
     * Finds one column by its stored key.
     *
     * @param {string} organizationId
     * @param {string} key
     * @returns {Promise<OrganizationMemberColumn|null>}
     */
    static async findColumnByKey(organizationId, key)
    {
        const collection = await OrganizationMemberColumnQueryEngine.#getCollection();
        if (!collection)
        {
            return null;
        }

        const document = await collection.findOne
        (
            { organizationId: organizationId, key: String(key ?? "").trim() },
            { projection: { _id: 0 } }
        );

        return document ? OrganizationMemberColumn.fromJson(document) : null;
    }

    /**
     * Records which phase a rename has reached, so a run interrupted halfway is
     * resumable rather than a schema nobody can reason about.
     *
     * @param {string} organizationId
     * @param {string} key
     * @param {number} renamePhase a MemberColumnRenamePhases value
     * @param {string} pendingRenameToKey
     */
    static async setRenamePhase(organizationId, key, renamePhase, pendingRenameToKey)
    {
        const collection = await OrganizationMemberColumnQueryEngine.#getCollection();
        if (!collection)
        {
            throw new Error("Database unavailable");
        }

        await collection.updateOne
        (
            { organizationId: organizationId, key: String(key ?? "").trim() },
            { $set: { renamePhase: renamePhase, pendingRenameToKey: String(pendingRenameToKey ?? "") } }
        );
    }

    /**
     * Moves the column row itself onto the new key, keeping the old one as a
     * former name so the institute's existing spreadsheets still resolve to it.
     *
     * @param {string} organizationId
     * @param {string} currentKey
     * @param {string} newKey
     * @param {string} newLabel
     */
    static async commitRenamedKey(organizationId, currentKey, newKey, newLabel)
    {
        const collection = await OrganizationMemberColumnQueryEngine.#getCollection();
        if (!collection)
        {
            throw new Error("Database unavailable");
        }

        const updateFields = { key: newKey };
        if (typeof newLabel === "string" && newLabel.trim().length > 0)
        {
            updateFields.label = newLabel.trim().slice(0, OrganizationMemberColumnQueryEngine.MAXIMUM_LABEL_LENGTH);
        }

        await collection.updateOne
        (
            { organizationId: organizationId, key: currentKey },
            {
                $set: updateFields,
                // Capped so a column renamed repeatedly over years does not carry
                // an unbounded history of names into every header lookup.
                $push: { aliases: { $each: [currentKey], $slice: -OrganizationMemberColumnQueryEngine.MAXIMUM_ALIASES_PER_COLUMN } }
            }
        );
    }

    /**
     * Removes a column from the schema. The stored member values are NOT touched
     * here — dropping the description of a column and destroying the data it
     * described are different decisions, and the caller makes the second one
     * explicitly.
     *
     * @param {string} organizationId
     * @param {string} key
     * @returns {Promise<{ removed: number }>}
     */
    static async deleteColumn(organizationId, key)
    {
        const collection = await OrganizationMemberColumnQueryEngine.#getCollection();
        if (!collection)
        {
            return { removed: 0 };
        }

        const deleteResult = await collection.deleteOne
        ({
            organizationId: organizationId,
            key: String(key ?? "").trim()
        });

        return { removed: deleteResult.deletedCount || 0 };
    }

    static async deleteColumnsForOrganization(organizationId)
    {
        const collection = await OrganizationMemberColumnQueryEngine.#getCollection();
        if (!collection)
        {
            return { removed: 0 };
        }

        const deleteResult = await collection.deleteMany({ organizationId: organizationId });
        return { removed: deleteResult.deletedCount || 0 };
    }
}

module.exports = OrganizationMemberColumnQueryEngine;
