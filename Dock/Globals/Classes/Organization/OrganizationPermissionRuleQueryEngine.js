const crypto = require("crypto");
const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const OrganizationPermissionRule = require("../../Model/OrganizationPermissionRule");
const { planFeatures } = require("../../Enumerations/PlanFeatures");
const { tagMatchModes } = require("../../Enumerations/TagMatchModes");
const ErrorCodes = require("../../Constants/ErrorCodes");


/**
 * OrganizationPermissionRuleQueryEngine
 *
 * The rules that decide which AI features an organization's members get inside
 * its view, and how much extra storage they are granted.
 *
 * Each rule names a set of tags and what holding them earns. A member matching
 * several rules receives the union of their features and the largest of their
 * storage grants — never the last rule to be evaluated, and never an
 * intersection, because two rules granting different things are two grants, not
 * a contradiction.
 */
class OrganizationPermissionRuleQueryEngine
{
    static #COLLECTION_NAME = DatabaseConstants.ORGANIZATION_PERMISSION_RULES_COLLECTION;

    // A rule set an administrator cannot read at a glance is a rule set nobody
    // audits. Well past what any real organization needs.
    static MAXIMUM_RULES_PER_ORGANIZATION = 50;

    static async #getCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return null;
        }
        return database.collection(OrganizationPermissionRuleQueryEngine.#COLLECTION_NAME);
    }

    /**
     * Validates one submitted rule. Pure — no database access — so the endpoint
     * can reject a whole malformed set before writing any of it.
     *
     * @param {object} ruleInput
     * @returns {{ valid: boolean, reason?: string }}
     */
    static validateRule(ruleInput)
    {
        if (!ruleInput || typeof ruleInput !== "object")
        {
            return { valid: false, reason: ErrorCodes.INVALID_SHAPE };
        }

        const name = typeof ruleInput.name === "string" ? ruleInput.name.trim() : "";
        if (name.length === 0 || name.length > 256)
        {
            return { valid: false, reason: ErrorCodes.INVALID_NAME };
        }

        if (!Object.values(tagMatchModes).includes(ruleInput.matchMode))
        {
            return { valid: false, reason: ErrorCodes.INVALID_REQUEST };
        }

        if (!Array.isArray(ruleInput.allowedFeatures))
        {
            return { valid: false, reason: ErrorCodes.INVALID_REQUEST };
        }

        const knownFeatureValues = Object.values(planFeatures);
        for (const featureValue of ruleInput.allowedFeatures)
        {
            if (!knownFeatureValues.includes(featureValue))
            {
                return { valid: false, reason: ErrorCodes.INVALID_REQUEST };
            }
        }

        if (!Number.isInteger(ruleInput.storageGrantBytes) || ruleInput.storageGrantBytes < 0)
        {
            return { valid: false, reason: ErrorCodes.INVALID_REQUEST };
        }

        return { valid: true };
    }

    static async listRulesForOrganization(organizationId)
    {
        const collection = await OrganizationPermissionRuleQueryEngine.#getCollection();
        if (!collection || typeof organizationId !== "string" || organizationId.length === 0)
        {
            return [];
        }

        const documents = await collection
            .find({ organizationId: organizationId }, { projection: { _id: 0 } })
            .sort({ createdAt: 1 })
            .toArray();

        return documents.map(document => OrganizationPermissionRule.fromJson(document));
    }

    /**
     * Replaces this organization's whole rule set.
     *
     * Replacement rather than per-rule editing because the set is evaluated as
     * a whole: what a member gets depends on every rule at once, so saving the
     * set the administrator was looking at is the only way the result matches
     * what they saw.
     *
     * @param {string} organizationId
     * @param {Array<object>} ruleInputs
     * @param {number[]} grantableFeatureValues the super-admin allow-list
     * @param {number} maximumStorageGrantBytes the super-admin per-member ceiling
     * @returns {Promise<{ replaced: number }>}
     */
    static async replaceRules(organizationId, ruleInputs, grantableFeatureValues, maximumStorageGrantBytes)
    {
        const collection = await OrganizationPermissionRuleQueryEngine.#getCollection();
        if (!collection)
        {
            throw new Error("Database unavailable");
        }

        const safeInputs = Array.isArray(ruleInputs) ? ruleInputs.slice(0, OrganizationPermissionRuleQueryEngine.MAXIMUM_RULES_PER_ORGANIZATION) : [];

        for (const ruleInput of safeInputs)
        {
            const validation = OrganizationPermissionRuleQueryEngine.validateRule(ruleInput);
            if (!validation.valid)
            {
                throw new Error(`Invalid rule: ${validation.reason}`);
            }
        }

        const allowedFeatureSet = new Set(Array.isArray(grantableFeatureValues) ? grantableFeatureValues : []);
        const storageCeiling = Number.isInteger(maximumStorageGrantBytes) && maximumStorageGrantBytes > 0 ? maximumStorageGrantBytes : 0;

        const documents = safeInputs.map(ruleInput => (
        {
            id: typeof ruleInput.id === "string" && ruleInput.id.length > 0 ? ruleInput.id : crypto.randomUUID(),
            organizationId: organizationId,
            name: ruleInput.name.trim().slice(0, 256),
            tagFilter: (Array.isArray(ruleInput.tagFilter) ? ruleInput.tagFilter : [])
                .map(tag => String(tag).trim().toLowerCase())
                .filter(tag => tag.length > 0),
            matchMode: ruleInput.matchMode,
            // Clamped to what this organization was actually sold. An
            // organization can never grant a feature above its allow-list, so a
            // crafted request cannot buy capability the agreement did not
            // include — and the clamp happens on write as well as on read, so a
            // stored rule can never contain something unenforceable.
            allowedFeatures: ruleInput.allowedFeatures.filter(featureValue => allowedFeatureSet.has(featureValue)),
            storageGrantBytes: storageCeiling > 0 ? Math.min(ruleInput.storageGrantBytes, storageCeiling) : 0,
            // Preserved when the caller already has one. The rule list is
            // ordered by this, and re-clamping an existing set — which is what a
            // super-admin lowering a ceiling does — would otherwise restamp
            // every rule to "now", losing when each was written and shuffling
            // the order an administrator had grown used to.
            createdAt: typeof ruleInput.createdAt === "string" && ruleInput.createdAt.length > 0
                ? ruleInput.createdAt
                : new Date().toISOString()
        }));

        await collection.deleteMany({ organizationId: organizationId });
        if (documents.length > 0)
        {
            await collection.insertMany(documents, { ordered: false });
        }

        return { replaced: documents.length };
    }

    static async deleteRulesForOrganization(organizationId)
    {
        const collection = await OrganizationPermissionRuleQueryEngine.#getCollection();
        if (!collection)
        {
            return { removed: 0 };
        }

        const deleteResult = await collection.deleteMany({ organizationId: organizationId });
        return { removed: deleteResult.deletedCount };
    }
}

module.exports = OrganizationPermissionRuleQueryEngine;
