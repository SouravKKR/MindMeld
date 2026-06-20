const DatabaseConnector = require("./DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const AdminEmailRecord = require("../../Model/AdminEmailRecord");
const ErrorCodes = require("../../Constants/ErrorCodes");


/**
 * AdminEmailQueryEngine
 *
 * Source of truth for the admin-email allowlist. The login flow
 * ([HandleLoginCallback.js]) consults isAdminEmail() on every login and
 * synchronises the User document's role accordingly — so adding or
 * removing an email here takes effect the next time the target user
 * signs in. The admin panel's Admins tab is the editorial UI on top.
 *
 * Seed file: [Dock/SeedData/AdminEmails.json] — bootstrap entries.
 * Mongo collection: [DatabaseConstants.ADMIN_EMAILS_COLLECTION].
 *
 * Email comparisons are case-insensitive — every read/write lowercases
 * the input. The unique index in [DatabaseConnector.js] is also on the
 * lowercased email so duplicate-with-different-case rows can't sneak in.
 */
class AdminEmailQueryEngine
{
    static #COLLECTION_NAME = DatabaseConstants.ADMIN_EMAILS_COLLECTION;

    static async #getCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return null;
        }
        return database.collection(AdminEmailQueryEngine.#COLLECTION_NAME);
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
     * Returns true when the supplied email is currently in the allowlist.
     * Empty / non-string input returns false rather than throwing — the
     * login flow uses this on every callback and a bad value should fail
     * closed (no admin promotion), not crash the login.
     * @param {string} email
     * @returns {Promise<boolean>}
     */
    static async isAdminEmail(email)
    {
        const normalised = AdminEmailQueryEngine.#normaliseEmail(email);
        if (normalised.length === 0)
        {
            return false;
        }

        const collection = await AdminEmailQueryEngine.#getCollection();
        if (!collection)
        {
            return false;
        }

        const found = await collection.findOne({ email: normalised });
        return found !== null && found !== undefined;
    }

    /**
     * Returns every admin-email row as plain JSON objects, sorted by
     * addedAt ascending so seeded founder accounts surface first in the
     * admin panel.
     * @returns {Promise<Array<object>>}
     */
    static async listAdmins()
    {
        const collection = await AdminEmailQueryEngine.#getCollection();
        if (!collection)
        {
            return [];
        }

        const cursor = collection.find({}, { projection: { _id: 0 } }).sort({ addedAt: 1 });
        const rows = await cursor.toArray();
        return rows;
    }

    /**
     * Returns the row count, used by removeAdmin's last-admin guard.
     * @returns {Promise<number>}
     */
    static async countAdmins()
    {
        const collection = await AdminEmailQueryEngine.#getCollection();
        if (!collection)
        {
            return 0;
        }
        return await collection.countDocuments({});
    }

    /**
     * Upserts an admin row. Idempotent — re-adding an existing email
     * touches `notes` but preserves the original `addedAt` and
     * `addedBy`. Seeded entries pass `addedByUserId = null` so the
     * column shows blank in the UI.
     * @param {string} email
     * @param {string|null} addedByUserId
     * @param {string} notes
     * @returns {Promise<{ inserted: boolean }>}
     */
    static async addAdmin(email, addedByUserId, notes = "")
    {
        const normalised = AdminEmailQueryEngine.#normaliseEmail(email);
        if (normalised.length === 0 || normalised.indexOf("@") < 0)
        {
            throw new Error("Invalid email");
        }

        const collection = await AdminEmailQueryEngine.#getCollection();
        if (!collection)
        {
            throw new Error("Database unavailable");
        }

        const record = new AdminEmailRecord
        ({
            email: normalised,
            addedBy: addedByUserId || "",
            addedAt: new Date(),
            notes: typeof notes === "string" ? notes : ""
        });

        const update =
        {
            $setOnInsert:
            {
                email: record.getEmail(),
                addedBy: record.getAddedBy(),
                addedAt: record.getAddedAt()
            },
            $set:
            {
                notes: record.getNotes()
            }
        };

        const result = await collection.updateOne({ email: normalised }, update, { upsert: true });
        return { inserted: result.upsertedCount > 0 };
    }

    /**
     * Deletes an admin row by email. Refuses if the table would be
     * emptied; the caller (the endpoint handler) layers a self-removal
     * refusal on top so the currently-logged-in admin can never lock
     * themselves out in a single click.
     * @param {string} email
     * @returns {Promise<{ removed: boolean, reason: string }>}
     */
    static async removeAdmin(email)
    {
        const normalised = AdminEmailQueryEngine.#normaliseEmail(email);
        if (normalised.length === 0)
        {
            return { removed: false, reason: ErrorCodes.INVALID_EMAIL };
        }

        const collection = await AdminEmailQueryEngine.#getCollection();
        if (!collection)
        {
            return { removed: false, reason: ErrorCodes.DATABASE_UNAVAILABLE };
        }

        const totalAdmins = await collection.countDocuments({});
        if (totalAdmins <= 1)
        {
            return { removed: false, reason: ErrorCodes.LAST_ADMIN_PROTECTED };
        }

        const result = await collection.deleteOne({ email: normalised });
        if (result.deletedCount === 0)
        {
            return { removed: false, reason: ErrorCodes.NOT_FOUND };
        }

        return { removed: true, reason: "OK" };
    }
}

module.exports = AdminEmailQueryEngine;
