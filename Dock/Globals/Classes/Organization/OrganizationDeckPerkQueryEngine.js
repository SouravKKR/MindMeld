const crypto = require("crypto");
const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const ErrorCodes = require("../../Constants/ErrorCodes");
const OrganizationDeckPerk = require("../../Model/OrganizationDeckPerk");
const { organizationDeckPerkTypes } = require("../../Enumerations/OrganizationDeckPerkTypes");


/**
 * OrganizationDeckPerkQueryEngine
 *
 * One perk row per (orgId, paidDeckId). Validates each perk shape at
 * write time so the pricing engine can trust the values it pulls back.
 */
class OrganizationDeckPerkQueryEngine
{
    static #COLLECTION_NAME = DatabaseConstants.ORGANIZATION_DECK_PERKS_COLLECTION;

    static async #getCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return null;
        }
        return database.collection(OrganizationDeckPerkQueryEngine.#COLLECTION_NAME);
    }

    /**
     * Returns true iff the perk shape is acceptable for write. Pure
     * validator — no DB calls.
     */
    static validatePerk(perkInput)
    {
        if (!perkInput || typeof perkInput !== "object")
        {
            return { valid: false, reason: ErrorCodes.INVALID_SHAPE };
        }
        if (typeof perkInput.deckId !== "string" || perkInput.deckId.length === 0)
        {
            return { valid: false, reason: ErrorCodes.INVALID_DECK_ID };
        }
        const enumValues = Object.values(organizationDeckPerkTypes);
        if (!enumValues.includes(perkInput.perkType))
        {
            return { valid: false, reason: ErrorCodes.INVALID_PERK_TYPE };
        }
        if (!Number.isInteger(perkInput.perkValue) || perkInput.perkValue < 0)
        {
            return { valid: false, reason: ErrorCodes.INVALID_PERK_VALUE };
        }
        if (perkInput.perkType === organizationDeckPerkTypes.PERCENTAGE_DISCOUNT && perkInput.perkValue > 100)
        {
            return { valid: false, reason: ErrorCodes.PERCENTAGE_OUT_OF_RANGE };
        }
        if (!Number.isInteger(perkInput.durationDays) || perkInput.durationDays < 0)
        {
            return { valid: false, reason: ErrorCodes.INVALID_DURATION_DAYS };
        }
        return { valid: true };
    }

    static async listPerksForOrganization(organizationId)
    {
        const collection = await OrganizationDeckPerkQueryEngine.#getCollection();
        if (!collection)
        {
            return [];
        }

        const documents = await collection
            .find({ organizationId: organizationId }, { projection: { _id: 0 } })
            .toArray();
        return documents.map(document => OrganizationDeckPerk.fromJson(document));
    }

    static async findPerkByOrgAndDeck(organizationId, deckId)
    {
        const collection = await OrganizationDeckPerkQueryEngine.#getCollection();
        if (!collection)
        {
            return null;
        }

        const document = await collection.findOne({ organizationId: organizationId, deckId: deckId });
        return document ? OrganizationDeckPerk.fromJson(document) : null;
    }

    /**
     * Atomically replaces this org's perk set. Returns the list of
     * deckIds whose perk transitioned to (or remained) FREE — the
     * caller uses this to fan out auto-assignment.
     *
     * @param {string} organizationId
     * @param {Array<{deckId, perkType, perkValue, durationDays}>} perkInputs
     * @returns {Promise<{ replaced: number, freeDeckIds: Array<{deckId, durationDays}> }>}
     */
    static async replacePerks(organizationId, perkInputs)
    {
        const collection = await OrganizationDeckPerkQueryEngine.#getCollection();
        if (!collection)
        {
            throw new Error("Database unavailable");
        }

        const safeInputs = Array.isArray(perkInputs) ? perkInputs : [];

        for (const perkInput of safeInputs)
        {
            const validation = OrganizationDeckPerkQueryEngine.validatePerk(perkInput);
            if (!validation.valid)
            {
                throw new Error(`Invalid perk: ${validation.reason}`);
            }
        }

        // Replace the set: delete any rows for deckIds NOT in the new
        // input, upsert the rest. Don't blow away rows whose terms are
        // unchanged because the OrganizationAutoAssigner cares about
        // "newly FREE" — preserving createdAt lets us tell apart fresh
        // perks from carryovers.
        const newDeckIds = safeInputs.map(perkInput => perkInput.deckId);
        await collection.deleteMany
        ({
            organizationId: organizationId,
            deckId: { $nin: newDeckIds }
        });

        const freeDeckIds = [];

        for (const perkInput of safeInputs)
        {
            const existing = await collection.findOne
            ({
                organizationId: organizationId,
                deckId: perkInput.deckId
            });

            const wasFreeAlready = existing
                && existing.perkType === organizationDeckPerkTypes.FREE
                && Number.isInteger(existing.durationDays)
                && existing.durationDays === perkInput.durationDays;

            const updateBody =
            {
                $set:
                {
                    perkType: perkInput.perkType,
                    perkValue: perkInput.perkValue,
                    durationDays: perkInput.durationDays
                },
                $setOnInsert:
                {
                    id: crypto.randomUUID(),
                    organizationId: organizationId,
                    deckId: perkInput.deckId,
                    createdAt: new Date()
                }
            };

            await collection.updateOne
            (
                { organizationId: organizationId, deckId: perkInput.deckId },
                updateBody,
                { upsert: true }
            );

            if (perkInput.perkType === organizationDeckPerkTypes.FREE && !wasFreeAlready)
            {
                freeDeckIds.push({ deckId: perkInput.deckId, durationDays: perkInput.durationDays });
            }
        }

        return { replaced: safeInputs.length, freeDeckIds: freeDeckIds };
    }
}

module.exports = OrganizationDeckPerkQueryEngine;
