const DatabaseConnector = require("./DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const ReleaseNote = require("../../Model/ReleaseNote");
const { semVerBumpTypes } = require("../../Enumerations/SemVerBumpTypes");
const ErrorCodes = require("../../Constants/ErrorCodes");


/**
 * ReleaseNoteQueryEngine
 *
 * Single source of truth for the in-product release-notes archive. Admin-
 * authored notes are stored here; user clients fetch them through
 * [ListReleaseNotes.js] to drive both the auto-popup on first login and
 * the always-available archive in the options sidebar.
 *
 * Versioning rules:
 *   - Versions are semver "MAJOR.MINOR.PATCH" strings.
 *   - The very first note ever published is always 1.0.0 regardless of
 *     the requested bump type.
 *   - Subsequent notes bump from the existing highest versionSortKey:
 *     MAJOR -> (major + 1).0.0
 *     MINOR -> major.(minor + 1).0
 *     PATCH -> major.minor.(patch + 1)
 *   - versionSortKey = major * 1_000_000 + minor * 1_000 + patch. Drives
 *     "newer than X" filtering against user.additionalData.lastSeen so
 *     editing an existing note never re-notifies anyone — the sort key
 *     is immutable once issued.
 *   - Concurrency: version + versionSortKey are unique-indexed
 *     ([DatabaseConnector.js]). Racing inserts collide on E11000; the
 *     create handler retries.
 *
 * Trust model:
 *   - contentHtml is rendered with innerHTML on the client. The /Admin
 *     endpoints are gated by [EnsureAdmin.js], so only users in the
 *     admin allowlist can author it. This mirrors the LegalDocument
 *     contentHtml model already in production.
 */
class ReleaseNoteQueryEngine
{
    static #COLLECTION_NAME = DatabaseConstants.RELEASE_NOTES_COLLECTION;
    static #VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
    static #MINOR_MULTIPLIER = 1000;
    static #MAJOR_MULTIPLIER = 1000000;
    static #LIST_LIMIT = 500;
    static #CREATE_RETRY_LIMIT = 3;

    static async #getCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return null;
        }
        return database.collection(ReleaseNoteQueryEngine.#COLLECTION_NAME);
    }

    /**
     * Returns every release note as plain JSON, sorted strictly by
     * versionSortKey descending — newest first. The product surface
     * insists on this ordering everywhere (auto-popup AND sidebar),
     * so we never re-sort on the client.
     *
     * Pass `majorVersion` (number) to restrict to notes whose major
     * component equals that value. The user-facing surfaces default
     * to the current (highest) major so users only see the latest
     * release line, and let the user pick an older major from the
     * sidebar dropdown. Admin management calls listAll() without this
     * filter to keep the full archive visible.
     *
     * Pass `includeTest: false` to hide notes flagged `test: true` —
     * the user-facing list does this for non-admin requesters so an
     * admin can publish a test note, verify it renders correctly via
     * their own popup/sidebar, then flip the flag to release it.
     */
    static async listAll({ majorVersion = null, includeTest = true } = {})
    {
        const collection = await ReleaseNoteQueryEngine.#getCollection();
        if (!collection)
        {
            return [];
        }

        const filter = {};
        if (typeof majorVersion === "number" && Number.isFinite(majorVersion) && majorVersion >= 0)
        {
            const lowerBound = majorVersion * ReleaseNoteQueryEngine.#MAJOR_MULTIPLIER;
            const upperBound = (majorVersion + 1) * ReleaseNoteQueryEngine.#MAJOR_MULTIPLIER;
            filter.versionSortKey = { $gte: lowerBound, $lt: upperBound };
        }
        if (!includeTest)
        {
            filter.test = { $ne: true };
        }

        const cursor = collection
            .find(filter, { projection: { _id: 0 } })
            .sort({ versionSortKey: -1 })
            .limit(ReleaseNoteQueryEngine.#LIST_LIMIT);

        const rows = await cursor.toArray();
        return rows;
    }

    /**
     * Returns the distinct list of major-version numbers present in
     * the archive, descending. Honours `includeTest` so the dropdown
     * presented to regular users doesn't reveal majors that exist
     * only as test releases.
     */
    static async listMajorVersions({ includeTest = true } = {})
    {
        const collection = await ReleaseNoteQueryEngine.#getCollection();
        if (!collection)
        {
            return [];
        }

        const matchStage = {};
        if (!includeTest)
        {
            matchStage.test = { $ne: true };
        }

        const pipeline = [];
        if (Object.keys(matchStage).length > 0)
        {
            pipeline.push({ $match: matchStage });
        }
        pipeline.push({
            $project: {
                _id: 0,
                major: { $floor: { $divide: ["$versionSortKey", ReleaseNoteQueryEngine.#MAJOR_MULTIPLIER] } }
            }
        });
        pipeline.push({ $group: { _id: "$major" } });
        pipeline.push({ $sort: { _id: -1 } });

        const rows = await collection.aggregate(pipeline).toArray();
        return rows
            .map(row => Number(row._id))
            .filter(value => Number.isFinite(value));
    }

    static async findById(noteId)
    {
        if (typeof noteId !== "string" || noteId.length === 0)
        {
            return null;
        }

        const collection = await ReleaseNoteQueryEngine.#getCollection();
        if (!collection)
        {
            return null;
        }

        return await collection.findOne({ id: noteId }, { projection: { _id: 0 } });
    }

    /**
     * Reads the highest existing versionSortKey, applies the requested
     * bump, and returns the new version string + sort key. Returns
     * 1.0.0 / 1_000_000 when no notes exist yet, regardless of bumpType.
     */
    static async #computeNextVersion(bumpType)
    {
        const collection = await ReleaseNoteQueryEngine.#getCollection();
        if (!collection)
        {
            throw new Error("Database unavailable");
        }

        const latest = await collection.findOne(
            {},
            { sort: { versionSortKey: -1 }, projection: { version: 1, versionSortKey: 1 } }
        );

        if (!latest)
        {
            return { version: "1.0.0", versionSortKey: ReleaseNoteQueryEngine.#MAJOR_MULTIPLIER };
        }

        const match = ReleaseNoteQueryEngine.#VERSION_PATTERN.exec(String(latest.version || ""));
        if (!match)
        {
            throw new Error(`Stored version "${latest.version}" is not valid semver`);
        }

        let major = parseInt(match[1], 10);
        let minor = parseInt(match[2], 10);
        let patch = parseInt(match[3], 10);

        if (bumpType === semVerBumpTypes.MAJOR)
        {
            major += 1;
            minor = 0;
            patch = 0;
        }
        else if (bumpType === semVerBumpTypes.MINOR)
        {
            minor += 1;
            patch = 0;
        }
        else if (bumpType === semVerBumpTypes.PATCH)
        {
            patch += 1;
        }
        else
        {
            throw new Error(`Unknown bump type: ${bumpType}`);
        }

        const version = `${major}.${minor}.${patch}`;
        const versionSortKey =
            major * ReleaseNoteQueryEngine.#MAJOR_MULTIPLIER
            + minor * ReleaseNoteQueryEngine.#MINOR_MULTIPLIER
            + patch;

        return { version, versionSortKey };
    }

    /**
     * Creates a new release note. Date / created / updated timestamps
     * are all server-stamped to the current time. The version is
     * computed from the existing archive — the client never supplies
     * one. On E11000 (duplicate versionSortKey from a concurrent
     * insert) we recompute and retry up to #CREATE_RETRY_LIMIT times.
     */
    static async create(title, contentHtml, bumpType, createdByUserId, test = false)
    {
        if (typeof title !== "string" || title.trim().length === 0)
        {
            throw new Error("title is required");
        }

        const collection = await ReleaseNoteQueryEngine.#getCollection();
        if (!collection)
        {
            throw new Error("Database unavailable");
        }

        let lastError = null;

        for (let attemptIndex = 0; attemptIndex < ReleaseNoteQueryEngine.#CREATE_RETRY_LIMIT; attemptIndex++)
        {
            const { version, versionSortKey } = await ReleaseNoteQueryEngine.#computeNextVersion(bumpType);

            const now = new Date();
            const note = new ReleaseNote({
                version,
                versionSortKey,
                title,
                contentHtml: typeof contentHtml === "string" ? contentHtml : "",
                releaseDate: now,
                createdAt: now,
                updatedAt: now,
                createdBy: typeof createdByUserId === "string" ? createdByUserId : "",
                test: test === true
            });

            try
            {
                await collection.insertOne(note.toJson());
                return note.toJson();
            }
            catch (error)
            {
                lastError = error;
                if (error && error.code === 11000)
                {
                    continue;
                }
                throw error;
            }
        }

        const wrapped = new Error("Could not allocate a unique version after retries");
        wrapped.cause = lastError;
        throw wrapped;
    }

    /**
     * Patches an existing note. Only title / contentHtml / releaseDate
     * may be changed — version, versionSortKey, createdAt and createdBy
     * are immutable. updatedAt is refreshed automatically.
     */
    static async update(noteId, updates)
    {
        if (typeof noteId !== "string" || noteId.length === 0)
        {
            throw new Error("id is required");
        }

        const collection = await ReleaseNoteQueryEngine.#getCollection();
        if (!collection)
        {
            throw new Error("Database unavailable");
        }

        const existing = await collection.findOne({ id: noteId });
        if (!existing)
        {
            return null;
        }

        const patch = {};

        if (typeof updates?.title === "string")
        {
            const trimmedTitle = updates.title.trim();
            if (trimmedTitle.length === 0 || trimmedTitle.length > 256)
            {
                throw new Error("title must be 1-256 characters");
            }
            patch.title = trimmedTitle;
        }

        if (typeof updates?.contentHtml === "string")
        {
            if (updates.contentHtml.length > 200000)
            {
                throw new Error("contentHtml exceeds 200000 characters");
            }
            patch.contentHtml = updates.contentHtml;
        }

        if (updates?.releaseDate !== undefined && updates?.releaseDate !== null)
        {
            const parsedDate = updates.releaseDate instanceof Date
                ? updates.releaseDate
                : new Date(updates.releaseDate);
            if (isNaN(parsedDate.getTime()))
            {
                throw new Error("releaseDate is not a valid date");
            }
            patch.releaseDate = parsedDate.toISOString();
        }

        if (typeof updates?.test === "boolean")
        {
            patch.test = updates.test;
        }

        if (Object.keys(patch).length === 0)
        {
            return existing;
        }

        patch.updatedAt = new Date().toISOString();

        await collection.updateOne({ id: noteId }, { $set: patch });
        return await collection.findOne({ id: noteId }, { projection: { _id: 0 } });
    }

    static async deleteById(noteId)
    {
        if (typeof noteId !== "string" || noteId.length === 0)
        {
            return { removed: false, reason: ErrorCodes.INVALID_ID };
        }

        const collection = await ReleaseNoteQueryEngine.#getCollection();
        if (!collection)
        {
            return { removed: false, reason: ErrorCodes.DATABASE_UNAVAILABLE };
        }

        const result = await collection.deleteOne({ id: noteId });
        if (result.deletedCount === 0)
        {
            return { removed: false, reason: ErrorCodes.NOT_FOUND };
        }

        return { removed: true, reason: "OK" };
    }
}

module.exports = ReleaseNoteQueryEngine;
