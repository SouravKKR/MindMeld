const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const ErrorCodes = require("../../Constants/ErrorCodes");
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
            return { ok: false, reason: ErrorCodes.INVALID_COUNT };
        }

        const collection = await OrganizationQueryEngine.#getCollection();
        if (!collection)
        {
            return { ok: false, reason: ErrorCodes.DATABASE_UNAVAILABLE };
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
        return { ok: false, reason: ErrorCodes.CAP_OR_STATE_REJECTED };
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
     * Extends maxMembers by additionalMembers. Raising the cap is free, so
     * this is a plain super-admin action with no cap (other than int-32
     * overflow, which is not a realistic concern).
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
     * The ceilings a super-admin sells an organization, in one write.
     *
     * The first four are the platform's side of the agreement — the most
     * storage it may grant each member, the most credits any member may receive
     * in a month, how many decks it may publish, and which AI features its rules
     * are allowed to reach. Everything the organization then configures for
     * itself is clamped to them, on write and again on read, so lowering a
     * ceiling takes effect immediately without needing a migration over stored
     * rules. The fifth, adminAllowedFeatures, is a grant rather than a ceiling:
     * it is what the organization's owner holds inside its view.
     *
     * Written together because they are agreed together: a partial application
     * would leave an organization sold a feature it has no storage to use, and
     * whoever set it would have no way to tell which half landed.
     *
     * Absent fields are left alone, so a caller may adjust one ceiling without
     * having to restate the rest and risk clearing them by omission.
     *
     * @param {string} organizationId
     * @param {object} limits
     * @returns {Promise<{ updated: boolean, applied: object }>}
     */
    static async setEntitlementLimits(organizationId, limits)
    {
        const collection = await OrganizationQueryEngine.#getCollection();
        if (!collection || typeof organizationId !== "string" || organizationId.length === 0)
        {
            return { updated: false, applied: {} };
        }

        const updates = {};

        if (Number.isInteger(limits?.maxStorageGrantBytesPerMember) && limits.maxStorageGrantBytesPerMember >= 0)
        {
            updates.maxStorageGrantBytesPerMember = limits.maxStorageGrantBytesPerMember;
        }
        if (Number.isFinite(limits?.maxCreditsPerMemberPerMonth) && limits.maxCreditsPerMemberPerMonth >= 0)
        {
            updates.maxCreditsPerMemberPerMonth = limits.maxCreditsPerMemberPerMonth;
        }
        if (Number.isInteger(limits?.maxPublishedDecks) && limits.maxPublishedDecks >= 0)
        {
            updates.maxPublishedDecks = limits.maxPublishedDecks;
        }
        if (Array.isArray(limits?.grantableFeatures))
        {
            updates.grantableFeatures = limits.grantableFeatures;
        }
        // Not a ceiling like the others — what the organization's OWNER holds
        // inside its view. Written through the same call because a super-admin
        // agrees it in the same conversation, and because splitting it out would
        // mean two writes that can disagree.
        if (Array.isArray(limits?.adminAllowedFeatures))
        {
            updates.adminAllowedFeatures = limits.adminAllowedFeatures;
        }

        if (Object.keys(updates).length === 0)
        {
            return { updated: false, applied: {} };
        }

        const result = await collection.updateOne({ id: organizationId }, { $set: updates });
        return { updated: result.matchedCount === 1, applied: updates };
    }

    /**
     * Moves the contract term's end date. Set when a credit deal is created and
     * again when one is paid, so the term and the money move together — a
     * renewal is a purchase, not a separate administrative act.
     *
     * @param {string} organizationId
     * @param {Date} termEndsAt
     */
    static async setTermEndsAt(organizationId, termEndsAt)
    {
        const collection = await OrganizationQueryEngine.#getCollection();
        if (!collection || !(termEndsAt instanceof Date) || isNaN(termEndsAt.getTime()))
        {
            return { updated: false };
        }

        const result = await collection.updateOne
        (
            { id: organizationId },
            { $set: { termEndsAt: termEndsAt.toISOString() } }
        );
        return { updated: result.matchedCount === 1 };
    }

    /**
     * Organizations whose term has already ended but whose pool is still
     * spendable. The term scheduler freezes exactly these.
     *
     * The stored termEndsAt is an ISO string (the codegen models serialise
     * dates that way), so the comparison is string-to-string — ISO-8601 sorts
     * chronologically, and comparing a stored string against a Date would match
     * nothing at all.
     *
     * @param {Date} now
     * @returns {Promise<Array<Organization>>}
     */
    static async listOrganizationsWithLapsedTerm(now = new Date())
    {
        const collection = await OrganizationQueryEngine.#getCollection();
        if (!collection)
        {
            return [];
        }

        const epochIsoString = new Date(0).toISOString();
        const nowIsoString = now.toISOString();

        const documents = await collection
            .find({ termEndsAt: { $gt: epochIsoString, $lte: nowIsoString } }, { projection: { _id: 0 } })
            .toArray();

        return documents.map(document => Organization.fromJson(document));
    }

    /**
     * Organizations whose term ends inside the given window — the ones worth
     * warning before it lapses.
     */
    static async listOrganizationsWithTermEndingBetween(fromDate, toDate)
    {
        const collection = await OrganizationQueryEngine.#getCollection();
        if (!collection)
        {
            return [];
        }

        const documents = await collection
            .find({ termEndsAt: { $gt: fromDate.toISOString(), $lte: toDate.toISOString() } }, { projection: { _id: 0 } })
            .toArray();

        return documents.map(document => Organization.fromJson(document));
    }

    /**
     * Records that a term-expiry warning for this many days has been sent, so a
     * scheduler that ticks several times a day announces each threshold once.
     *
     * @param {string} organizationId
     * @param {number} thresholdDays
     */
    static async recordAnnouncedTermThreshold(organizationId, thresholdDays)
    {
        const collection = await OrganizationQueryEngine.#getCollection();
        if (!collection || !Number.isInteger(thresholdDays))
        {
            return { updated: false };
        }

        const result = await collection.updateOne
        (
            { id: organizationId },
            { $addToSet: { "additionalData.announcedTermThresholds": thresholdDays } }
        );
        return { updated: result.matchedCount === 1 };
    }

    /**
     * Clears the announced-warning record, so a renewed term warns again as it
     * approaches instead of staying silent because the previous term already
     * announced those thresholds.
     */
    static async clearAnnouncedTermThresholds(organizationId)
    {
        const collection = await OrganizationQueryEngine.#getCollection();
        if (!collection)
        {
            return { updated: false };
        }

        const result = await collection.updateOne
        (
            { id: organizationId },
            { $unset: { "additionalData.announcedTermThresholds": "" } }
        );
        return { updated: result.matchedCount === 1 };
    }

    /**
     * Renames an organization. Returns true iff a row was updated. The name
     * is length-guarded by the model setter at the endpoint; this is the
     * raw persistence write.
     * @param {string} organizationId
     * @param {string} newName
     * @returns {Promise<boolean>}
     */
    static async renameOrganization(organizationId, newName)
    {
        const collection = await OrganizationQueryEngine.#getCollection();
        if (!collection || typeof newName !== "string" || newName.trim().length === 0)
        {
            return false;
        }

        const result = await collection.updateOne
        (
            { id: organizationId },
            { $set: { name: newName.trim().slice(0, 256) } }
        );
        return result.matchedCount === 1;
    }

    /**
     * Sets maxMembers directly (super-admin). Atomically guarded so the cap
     * can never drop BELOW the current member count — the `$expr` filter
     * rejects the update, and the caller surfaces MAX_MEMBERS_BELOW_CURRENT.
     * @param {string} organizationId
     * @param {number} newMax
     * @returns {Promise<{ ok: boolean, reason: string }>}
     */
    static async setMaxMembers(organizationId, newMax)
    {
        if (!Number.isInteger(newMax) || newMax <= 0)
        {
            return { ok: false, reason: ErrorCodes.INVALID_MAX_MEMBERS };
        }

        const collection = await OrganizationQueryEngine.#getCollection();
        if (!collection)
        {
            return { ok: false, reason: ErrorCodes.DATABASE_UNAVAILABLE };
        }

        const result = await collection.updateOne
        (
            { id: organizationId, $expr: { $gte: [newMax, "$currentMemberCount"] } },
            { $set: { maxMembers: newMax } }
        );

        if (result.matchedCount === 1)
        {
            return { ok: true, reason: "OK" };
        }

        // matchedCount 0 — either the org is gone or newMax < currentMemberCount.
        const existing = await collection.findOne({ id: organizationId }, { projection: { _id: 0, id: 1 } });
        return { ok: false, reason: existing ? ErrorCodes.MAX_MEMBERS_BELOW_CURRENT : ErrorCodes.ORG_NOT_FOUND };
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

        // Take the organization's decks back from every member BEFORE the
        // roster is dropped: the withdrawal walks holders one at a time, and
        // once the member rows are gone there is nothing left to walk. An
        // organization that vanished while its material stayed on people's
        // devices would leave content nobody can withdraw and nobody owns.
        try
        {
            const OrganizationDeckWithdrawalService = require("./OrganizationDeckWithdrawalService");
            const OrganizationDeckQueryEngine = require("./OrganizationDeckQueryEngine");

            for (const organizationDeck of await OrganizationDeckQueryEngine.listDecksForOrganization(organizationId))
            {
                await OrganizationDeckWithdrawalService.withdraw(organizationId, organizationDeck.getId());
            }

            // The listings go with the organization. Their master content is
            // left in place rather than purged here — it is encrypted, it is
            // unreachable without a listing pointing at it, and deleting
            // gigabytes of assets inside a request that a human is waiting on
            // is the wrong place for it.
            await database
                .collection(DatabaseConstants.PAID_DECKS_COLLECTION)
                .deleteMany({ audienceOrganizationId: organizationId });
        }
        catch (deckTeardownError)
        {
            console.error(`[OrganizationQueryEngine] Deck teardown failed for ${organizationId}: ${deckTeardownError?.message || deckTeardownError}`);
        }

        await database.collection(OrganizationQueryEngine.#MEMBERS_COLLECTION_NAME).deleteMany({ organizationId: organizationId });
        await database.collection(OrganizationQueryEngine.#PERKS_COLLECTION_NAME).deleteMany({ organizationId: organizationId });
        await database.collection(DatabaseConstants.ORGANIZATION_PERMISSION_RULES_COLLECTION).deleteMany({ organizationId: organizationId });
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
