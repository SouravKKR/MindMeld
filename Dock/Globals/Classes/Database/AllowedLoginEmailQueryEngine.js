const DatabaseConnector = require("./DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const AllowedLoginEmailRecord = require("../../Model/AllowedLoginEmailRecord");
const ErrorCodes = require("../../Constants/ErrorCodes");


/**
 * AllowedLoginEmailQueryEngine
 *
 * Source of truth for the per-environment login allowlist. When the
 * ACCESS_ALLOWLIST_ENABLED flag is on (dev / test only), AccessGate
 * consults isAllowedEmail() on every login path — Google OAuth and
 * email-OTP alike — so that only allowlisted emails may sign in. The
 * admin panel's Access tab is the editorial UI on top.
 *
 * Being on this list only PERMITS login; it never grants the ADMIN
 * role (that stays governed by the separate adminEmails collection).
 *
 * Seed file: [Dock/SeedData/AllowedLoginEmails.json] — bootstrap entries.
 * Mongo collection: [DatabaseConstants.ALLOWED_LOGIN_EMAILS_COLLECTION].
 *
 * Email comparisons are case-insensitive — every read/write lowercases
 * the input. The unique index in [DatabaseConnector.js] is also on the
 * lowercased email so duplicate-with-different-case rows can't sneak in.
 *
 * Unlike admins there is NO last-record guard: emptying this list is
 * fine — it simply means only the env / admin emails remain allowed.
 */
class AllowedLoginEmailQueryEngine
{
    static #COLLECTION_NAME = DatabaseConstants.ALLOWED_LOGIN_EMAILS_COLLECTION;

    static async #getCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return null;
        }
        return database.collection(AllowedLoginEmailQueryEngine.#COLLECTION_NAME);
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
     * Returns true when the supplied email is currently on the login
     * allowlist. Empty / non-string input returns false rather than
     * throwing — the login flow uses this on every attempt and a bad
     * value should fail closed (login refused), not crash the login.
     * @param {string} email
     * @returns {Promise<boolean>}
     */
    static async isAllowedEmail(email)
    {
        const normalised = AllowedLoginEmailQueryEngine.#normaliseEmail(email);
        if (normalised.length === 0)
        {
            return false;
        }

        const collection = await AllowedLoginEmailQueryEngine.#getCollection();
        if (!collection)
        {
            return false;
        }

        const found = await collection.findOne({ email: normalised });
        return found !== null && found !== undefined;
    }

    /**
     * Returns every allowed-email row as plain JSON objects, sorted by
     * addedAt ascending so seeded founder accounts surface first in the
     * admin panel.
     * @returns {Promise<Array<object>>}
     */
    static async listAllowed()
    {
        const collection = await AllowedLoginEmailQueryEngine.#getCollection();
        if (!collection)
        {
            return [];
        }

        const cursor = collection.find({}, { projection: { _id: 0 } }).sort({ addedAt: 1 });
        const rows = await cursor.toArray();
        return rows;
    }

    /**
     * Upserts an allowed-email row. Idempotent — re-adding an existing
     * email touches `notes` but preserves the original `addedAt` and
     * `addedBy`. Seeded entries pass `addedByUserId = null` so the
     * column shows blank in the UI.
     * @param {string} email
     * @param {string|null} addedByUserId
     * @param {string} notes
     * @returns {Promise<{ inserted: boolean }>}
     */
    static async addAllowed(email, addedByUserId, notes = "")
    {
        const normalised = AllowedLoginEmailQueryEngine.#normaliseEmail(email);
        if (normalised.length === 0 || normalised.indexOf("@") < 0)
        {
            throw new Error("Invalid email");
        }

        const collection = await AllowedLoginEmailQueryEngine.#getCollection();
        if (!collection)
        {
            throw new Error("Database unavailable");
        }

        const record = new AllowedLoginEmailRecord
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
     * Deletes an allowed-email row by email. Unlike admins there is no
     * last-record guard — emptying the list is a valid state that leaves
     * only the env / admin emails allowed.
     * @param {string} email
     * @returns {Promise<{ removed: boolean, reason: string }>}
     */
    static async removeAllowed(email)
    {
        const normalised = AllowedLoginEmailQueryEngine.#normaliseEmail(email);
        if (normalised.length === 0)
        {
            return { removed: false, reason: ErrorCodes.INVALID_EMAIL };
        }

        const collection = await AllowedLoginEmailQueryEngine.#getCollection();
        if (!collection)
        {
            return { removed: false, reason: ErrorCodes.DATABASE_UNAVAILABLE };
        }

        const result = await collection.deleteOne({ email: normalised });
        if (result.deletedCount === 0)
        {
            return { removed: false, reason: ErrorCodes.NOT_FOUND };
        }

        return { removed: true, reason: "OK" };
    }
}

module.exports = AllowedLoginEmailQueryEngine;
