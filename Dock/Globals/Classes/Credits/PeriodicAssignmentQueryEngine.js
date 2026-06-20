const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const PeriodicCreditAssignment = require("../../Model/PeriodicCreditAssignment");
const { periodicAssignmentStatuses } = require("../../Enumerations/PeriodicAssignmentStatuses");
const { periodicScopeTypes } = require("../../Enumerations/PeriodicScopeTypes");


/**
 * PeriodicAssignmentQueryEngine
 *
 * Source of truth for the `periodicCreditAssignments` collection — the
 * first-class recurring-grant definitions an admin creates. Modelled on
 * [OrganizationQueryEngine.js]: every method goes through #getCollection for
 * null-safety against an unconfigured Mongo URL, and reads return model
 * objects rather than raw driver documents.
 *
 * The lazy reconciler reads ACTIVE assignments two ways — by an org the
 * acting user currently belongs to, and by an explicit people-set that names
 * the user's email — so both query paths get a dedicated finder here.
 */
class PeriodicAssignmentQueryEngine
{
    static #COLLECTION_NAME = DatabaseConstants.PERIODIC_CREDIT_ASSIGNMENTS_COLLECTION;

    static async #getCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return null;
        }
        return database.collection(PeriodicAssignmentQueryEngine.#COLLECTION_NAME);
    }

    static #normaliseEmail(email)
    {
        if (typeof email !== "string")
        {
            return "";
        }
        return email.trim().toLowerCase();
    }

    /**
     * Inserts a fresh assignment. The codegen constructor auto-assigns the
     * UUID id, so callers don't set one.
     * @param {PeriodicCreditAssignment} assignment
     * @returns {Promise<PeriodicCreditAssignment>}
     */
    static async createAssignment(assignment)
    {
        const collection = await PeriodicAssignmentQueryEngine.#getCollection();
        if (!collection)
        {
            throw new Error("Database unavailable");
        }

        await collection.insertOne(assignment.toJson());
        return assignment;
    }

    static async getById(assignmentId)
    {
        if (typeof assignmentId !== "string" || assignmentId.length === 0)
        {
            return null;
        }

        const collection = await PeriodicAssignmentQueryEngine.#getCollection();
        if (!collection)
        {
            return null;
        }

        const document = await collection.findOne({ id: assignmentId });
        return document ? PeriodicCreditAssignment.fromJson(document) : null;
    }

    static async listAll()
    {
        const collection = await PeriodicAssignmentQueryEngine.#getCollection();
        if (!collection)
        {
            return [];
        }

        const documents = await collection
            .find({}, { projection: { _id: 0 } })
            .sort({ createdAt: -1 })
            .toArray();
        return documents.map(document => PeriodicCreditAssignment.fromJson(document));
    }

    /**
     * Every ACTIVE assignment scoped to a specific organization. Used by the
     * lazy reconciler once it knows the acting user's current ACTIVE orgs.
     * @param {string} organizationId
     * @returns {Promise<Array<PeriodicCreditAssignment>>}
     */
    static async listActiveByOrganizationId(organizationId)
    {
        if (typeof organizationId !== "string" || organizationId.length === 0)
        {
            return [];
        }

        const collection = await PeriodicAssignmentQueryEngine.#getCollection();
        if (!collection)
        {
            return [];
        }

        const documents = await collection
            .find({
                status: periodicAssignmentStatuses.ACTIVE,
                scopeType: periodicScopeTypes.ORGANIZATION,
                organizationId: organizationId
            })
            .toArray();
        return documents.map(document => PeriodicCreditAssignment.fromJson(document));
    }

    /**
     * Every ACTIVE people-set assignment whose recipient list names this
     * email. The multikey peopleEmails index turns this into an index lookup.
     * @param {string} rawEmail
     * @returns {Promise<Array<PeriodicCreditAssignment>>}
     */
    static async listActiveNamingEmail(rawEmail)
    {
        const email = PeriodicAssignmentQueryEngine.#normaliseEmail(rawEmail);
        if (email.length === 0)
        {
            return [];
        }

        const collection = await PeriodicAssignmentQueryEngine.#getCollection();
        if (!collection)
        {
            return [];
        }

        const documents = await collection
            .find({
                status: periodicAssignmentStatuses.ACTIVE,
                scopeType: periodicScopeTypes.PEOPLE_SET,
                peopleEmails: email
            })
            .toArray();
        return documents.map(document => PeriodicCreditAssignment.fromJson(document));
    }

    /**
     * Atomically flips an ACTIVE assignment to TERMINATED. The
     * `status: ACTIVE` guard makes the transition idempotent — a second
     * terminate (or a race) matches nothing and reports transitioned=false.
     * @param {string} assignmentId
     * @param {Date} now
     * @returns {Promise<{ transitioned: boolean }>}
     */
    static async terminate(assignmentId, now)
    {
        const collection = await PeriodicAssignmentQueryEngine.#getCollection();
        if (!collection)
        {
            return { transitioned: false };
        }

        const result = await collection.updateOne
        (
            { id: assignmentId, status: periodicAssignmentStatuses.ACTIVE },
            { $set: { status: periodicAssignmentStatuses.TERMINATED, terminatedAt: (now instanceof Date ? now : new Date()) } }
        );

        return { transitioned: result.modifiedCount === 1 };
    }

    /**
     * Bulk-terminate every ACTIVE assignment scoped to an organization.
     * Called when an org is deleted so its recurring cycles stop cleanly.
     * @param {string} organizationId
     * @param {Date} now
     * @returns {Promise<{ terminatedCount: number }>}
     */
    static async terminateForOrganization(organizationId, now)
    {
        if (typeof organizationId !== "string" || organizationId.length === 0)
        {
            return { terminatedCount: 0 };
        }

        const collection = await PeriodicAssignmentQueryEngine.#getCollection();
        if (!collection)
        {
            return { terminatedCount: 0 };
        }

        const result = await collection.updateMany
        (
            {
                status: periodicAssignmentStatuses.ACTIVE,
                scopeType: periodicScopeTypes.ORGANIZATION,
                organizationId: organizationId
            },
            { $set: { status: periodicAssignmentStatuses.TERMINATED, terminatedAt: (now instanceof Date ? now : new Date()) } }
        );

        return { terminatedCount: result.modifiedCount };
    }
}

module.exports = PeriodicAssignmentQueryEngine;
