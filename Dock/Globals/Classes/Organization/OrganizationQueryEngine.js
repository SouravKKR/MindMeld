const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const Organization = require("../../Model/Organization");
const { organizationStatus } = require("../../Enumerations/OrganizationStatus");


/**
 * OrganizationQueryEngine
 *
 * Source of truth for the `organizations` collection. Modelled on
 * [AdminEmailQueryEngine.js] — every method goes through #getCollection
 * for null-safety against an unconfigured Mongo URL, every email goes
 * through #normaliseEmail, and writes return plain JSON objects rather
 * than Mongo driver results.
 *
 * The cap-enforcement gate (tryIncrementMemberCount,
 * tryIncrementMemberCountBy) is the heart of bulk-add safety: it issues
 * a single atomic conditional `$inc` so two concurrent adds against the
 * same cap can never both succeed.
 */
class OrganizationQueryEngine
{
    static #COLLECTION_NAME = DatabaseConstants.ORGANIZATIONS_COLLECTION;
    static #MEMBERS_COLLECTION_NAME = DatabaseConstants.ORGANIZATION_MEMBERS_COLLECTION;
    static #PERKS_COLLECTION_NAME = DatabaseConstants.ORGANIZATION_DECK_PERKS_COLLECTION;
    static #VERIFICATIONS_COLLECTION_NAME = DatabaseConstants.ORG_ADMIN_VERIFICATIONS_COLLECTION;

    static async #getCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return null;
        }
        return database.collection(OrganizationQueryEngine.#COLLECTION_NAME);
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
     * Inserts a fresh Organization. The codegen-generated constructor
     * already auto-assigns a UUID to `id` (it's a `"id": true` field in
     * the JSON schema), so callers don't need to set one explicitly.
     * @param {Organization} organization
     * @returns {Promise<Organization>}
     */
    static async createOrganization(organization)
    {
        const collection = await OrganizationQueryEngine.#getCollection();
        if (!collection)
        {
            throw new Error("Database unavailable");
        }

        // Normalise the adminEmail on the way in so the back-fill lookup
        // matches the login-time normalisation in UserRoleReconciliator.
        organization.setAdminEmail(OrganizationQueryEngine.#normaliseEmail(organization.getAdminEmail()));

        await collection.insertOne(organization.toJson());
        return organization;
    }

    static async getOrganizationById(organizationId)
    {
        if (typeof organizationId !== "string" || organizationId.length === 0)
        {
            return null;
        }

        const collection = await OrganizationQueryEngine.#getCollection();
        if (!collection)
        {
            return null;
        }

        const document = await collection.findOne({ id: organizationId });
        return document ? Organization.fromJson(document) : null;
    }

    static async listOrganizations()
    {
        const collection = await OrganizationQueryEngine.#getCollection();
        if (!collection)
        {
            return [];
        }

        const cursor = collection.find({}, { projection: { _id: 0 } }).sort({ creationDate: -1 });
        const documents = await cursor.toArray();
        return documents.map(document => Organization.fromJson(document));
    }

    /**
     * Returns ACTIVE organizations whose adminEmail matches. The
     * UserRoleReconciliator calls this on every login to decide whether
     * to promote a USER → ORG_ADMIN. PENDING_PAYMENT orgs intentionally
     * do NOT promote anyone — the brief says org operations are blocked
     * until payment clears.
     * @param {string} email
     * @returns {Promise<Array<Organization>>}
     */
    static async listActiveOrganizationsByAdminEmail(email)
    {
        const normalised = OrganizationQueryEngine.#normaliseEmail(email);
        if (normalised.length === 0)
        {
            return [];
        }

        const collection = await OrganizationQueryEngine.#getCollection();
        if (!collection)
        {
            return [];
        }

        const documents = await collection
            .find({ adminEmail: normalised, status: organizationStatus.ACTIVE })
            .toArray();
        return documents.map(document => Organization.fromJson(document));
    }

    /**
     * Returns ACTIVE organizations whose adminUserId matches. Used by
     * the pricing engine to apply perks to the org-admin's own paid
     * decks (admins get the same perks as members).
     * @param {string} userId
     * @returns {Promise<Array<Organization>>}
     */
    static async listActiveOrganizationsByAdminUserId(userId)
    {
        if (typeof userId !== "string" || userId.length === 0)
        {
            return [];
        }

        const collection = await OrganizationQueryEngine.#getCollection();
        if (!collection)
        {
            return [];
        }

        const documents = await collection
            .find({ adminUserId: userId, status: organizationStatus.ACTIVE })
            .toArray();
        return documents.map(document => Organization.fromJson(document));
    }

    static async setAdminUserId(organizationId, userId)
    {
        const collection = await OrganizationQueryEngine.#getCollection();
        if (!collection)
        {
            return;
        }

        await collection.updateOne
        (
            { id: organizationId },
            { $set: { adminUserId: typeof userId === "string" ? userId : "" } }
        );
    }

    /**
     * Flips an org's status and stamps the activationDate when the
     * status transitions to ACTIVE.
     */
    static async updateStatus(organizationId, newStatus, activationDateOrNull)
    {
        const collection = await OrganizationQueryEngine.#getCollection();
        if (!collection)
        {
            return;
        }

        const updateSet = { status: newStatus };
        if (activationDateOrNull instanceof Date)
        {
            updateSet.activationDate = activationDateOrNull;
        }

        await collection.updateOne({ id: organizationId }, { $set: updateSet });
    }

    /**
     * Atomic cap-enforcement gate for single-member add. Returns true
     * iff the increment landed — the caller then performs the unique
     * member-row insert. The `status === ACTIVE` guard means PENDING
     * orgs can't be filled with members before their payment clears.
     * Wraps `currentMemberCount < maxMembers` as a `$expr` comparison
     * so the check + increment is one round-trip.
     *
     * @param {string} organizationId
     * @returns {Promise<{ ok: boolean, reason: string }>}
     */
    static async tryIncrementMemberCount(organizationId)
    {
        return await OrganizationQueryEngine.tryIncrementMemberCountBy(organizationId, 1);
    }

    /**
     * Atomic cap-enforcement gate for bulk-member add. Same semantics
     * as tryIncrementMemberCount but increments by `count`. Either ALL
     * `count` slots are reserved or NONE — no partial reservations.
     *
     * @param {string} organizationId
     * @param {number} count
     * @returns {Promise<{ ok: boolean, reason: string }>}
     */
    static async tryIncrementMemberCountBy(organizationId, count)
    {
        if (!Number.isInteger(count) || count <= 0)
        {
            return { ok: false, reason: "INVALID_COUNT" };
        }

        const collection = await OrganizationQueryEngine.#getCollection();
        if (!collection)
        {
            return { ok: false, reason: "DATABASE_UNAVAILABLE" };
        }

        const result = await collection.updateOne
        (
            {
                id: organizationId,
                status: organizationStatus.ACTIVE,
                $expr: { $lte: [{ $add: ["$currentMemberCount", count] }, "$maxMembers"] }
            },
            { $inc: { currentMemberCount: count } }
        );

        if (result.matchedCount === 1)
        {
            return { ok: true, reason: "OK" };
        }

        // matchedCount === 0 — either the org doesn't exist, isn't ACTIVE,
        // or filling these slots would exceed maxMembers. The caller
        // doesn't need the distinction (the UI presents either "org
        // not active" or "cap reached"), so a single error suffices.
        return { ok: false, reason: "CAP_OR_STATE_REJECTED" };
    }

    /**
     * Inverse of tryIncrementMemberCountBy — called after a member-row
     * delete to give the slot back. Never goes negative.
     */
    static async decrementMemberCountBy(organizationId, count)
    {
        if (!Number.isInteger(count) || count <= 0)
        {
            return;
        }

        const collection = await OrganizationQueryEngine.#getCollection();
        if (!collection)
        {
            return;
        }

        await collection.updateOne
        (
            { id: organizationId, currentMemberCount: { $gte: count } },
            { $inc: { currentMemberCount: -count } }
        );
    }

    /**
     * Extends maxMembers by additionalMembers. Called from the
     * VerifyExpansionPayment handler after Razorpay confirms. No cap
     * (other than int-32 overflow which is not a realistic concern).
     */
    static async extendMaxMembers(organizationId, additionalMembers)
    {
        if (!Number.isInteger(additionalMembers) || additionalMembers <= 0)
        {
            return;
        }

        const collection = await OrganizationQueryEngine.#getCollection();
        if (!collection)
        {
            return;
        }

        await collection.updateOne
        (
            { id: organizationId },
            { $inc: { maxMembers: additionalMembers } }
        );
    }

    /**
     * Cascade-deletes the org and every dependent row in the four
     * companion collections (members, perks, verifications). Returns
     * the org's adminUserId so the caller can pass it to
     * UserRoleReconciliator.revokeOrgAdminIfNoActiveOrgs.
     *
     * Already-issued deck licenses are deliberately NOT touched — per
     * the brief, members keep their deck access for the full duration
     * regardless of org-lifecycle events on the org's side.
     *
     * @param {string} organizationId
     * @returns {Promise<{ deleted: boolean, adminUserId: string }>}
     */
    static async deleteOrganization(organizationId)
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return { deleted: false, adminUserId: "" };
        }

        const organizationsCollection = database.collection(OrganizationQueryEngine.#COLLECTION_NAME);
        const target = await organizationsCollection.findOne({ id: organizationId });
        if (!target)
        {
            return { deleted: false, adminUserId: "" };
        }

        const adminUserId = typeof target.adminUserId === "string" ? target.adminUserId : "";
        const adminEmail = typeof target.adminEmail === "string" ? target.adminEmail : "";

        await database.collection(OrganizationQueryEngine.#MEMBERS_COLLECTION_NAME).deleteMany({ organizationId: organizationId });
        await database.collection(OrganizationQueryEngine.#PERKS_COLLECTION_NAME).deleteMany({ organizationId: organizationId });
        if (adminEmail.length > 0)
        {
            // The verification token is keyed by email, not orgId — purge
            // any outstanding token tied to this admin so a future re-add
            // doesn't accidentally reuse a verification.
            await database.collection(OrganizationQueryEngine.#VERIFICATIONS_COLLECTION_NAME).deleteOne({ email: adminEmail });
        }
        await organizationsCollection.deleteOne({ id: organizationId });

        return { deleted: true, adminUserId: adminUserId };
    }
}

module.exports = OrganizationQueryEngine;
