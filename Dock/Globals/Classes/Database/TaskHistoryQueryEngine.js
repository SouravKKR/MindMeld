const DatabaseConnector = require("./DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const TaskHistoryRecord = require("../../Model/TaskHistoryRecord");
const { taskStatus } = require("../../Enumerations/TaskStatus");
const { taskTypeDisplayName } = require("../../UtilityFunctions.js/TaskTypeDisplayName");


/**
 * TaskHistoryQueryEngine
 *
 * Long-term archive for generation tasks. Redis holds in-progress and
 * very-recent tasks (5-hour TTL via TaskManager); once a top-level
 * task transitions to COMPLETED or FAILED we mirror a denormalised
 * summary row here so the Activity page can show the user's full
 * history. Children of a top-level task are intentionally NOT
 * archived — the summary row references parentTaskId only.
 *
 * Schema lives in [Common/Classes/TaskHistoryRecord.json].
 * Collection: [DatabaseConstants.TASK_HISTORY_COLLECTION].
 * Indexes:
 *   - { id: 1 } unique
 *   - { userId: 1, completedAt: -1 } — Activity newest-first
 *   - { userId: 1, status: 1 } — Activity status filter
 *
 * Filtering reuses the [PaidDeckFilters] base classes' toMongoQuery
 * contract — every registered filter outputs a Mongo fragment that the
 * search engine $and's together with `userId` to scope the query.
 */
class TaskHistoryQueryEngine
{
    static #COLLECTION_NAME = DatabaseConstants.TASK_HISTORY_COLLECTION;
    static #PAYLOAD_SUMMARY_MAX_LENGTH = 512;

    static async #getCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return null;
        }
        return database.collection(TaskHistoryQueryEngine.#COLLECTION_NAME);
    }

    /**
     * Idempotently writes a summary row for a finished top-level task.
     * Re-recording the same id (e.g. a retry path that finishes twice
     * for some reason) keeps the first completedAt and overwrites the
     * mutable fields. Tasks lacking a userId are skipped — pre-existing
     * tasks created before the userId field was added cannot be
     * attributed to anyone, and we would rather drop them than fan
     * them out to every Activity view.
     * @param {TaskDescriptor} taskDescriptor
     * @returns {Promise<{ inserted: boolean, skipped: boolean }>}
     */
    static async recordCompletion(taskDescriptor)
    {
        if (!taskDescriptor)
        {
            return { inserted: false, skipped: true };
        }

        const userId = TaskHistoryQueryEngine.#readUserId(taskDescriptor);
        if (userId.length === 0)
        {
            return { inserted: false, skipped: true };
        }

        const collection = await TaskHistoryQueryEngine.#getCollection();
        if (!collection)
        {
            return { inserted: false, skipped: true };
        }

        const startDate = taskDescriptor.getStartDate() || new Date();
        const completedAt = new Date();
        const durationMillis = Math.max(0, completedAt.getTime() - new Date(startDate).getTime());

        // Carry the partialCompletion marker into the archive so the Activity
        // page can still offer "keep what's here, retry the rest" long after the
        // live Redis descriptor has expired.
        const payload = typeof taskDescriptor.getPayload === "function" ? taskDescriptor.getPayload() : null;
        const archivedAdditionalData = (payload && typeof payload === "object" && payload.partialCompletion)
            ? { partialCompletion: payload.partialCompletion }
            : {};

        const record = new TaskHistoryRecord
        ({
            id: taskDescriptor.getId(),
            userId: userId,
            type: taskDescriptor.getType(),
            status: taskDescriptor.getStatus(),
            completion: typeof taskDescriptor.getCompletion === "function" ? taskDescriptor.getCompletion() : 0,
            startDate: startDate,
            completedAt: completedAt,
            durationMillis: durationMillis,
            payloadSummary: TaskHistoryQueryEngine.#buildPayloadSummary(taskDescriptor),
            parentTaskId: taskDescriptor.getParentTaskId() || "",
            additionalData: archivedAdditionalData
        });

        const update =
        {
            $setOnInsert:
            {
                id: record.getId(),
                userId: record.getUserId(),
                startDate: record.getStartDate(),
                completedAt: record.getCompletedAt(),
                durationMillis: record.getDurationMillis()
            },
            $set:
            {
                type: record.getType(),
                status: record.getStatus(),
                completion: record.getCompletion(),
                payloadSummary: record.getPayloadSummary(),
                parentTaskId: record.getParentTaskId(),
                additionalData: record.getAdditionalData()
            }
        };

        const result = await collection.updateOne({ id: record.getId() }, update, { upsert: true });
        return { inserted: result.upsertedCount > 0, skipped: false };
    }

    /**
     * Reads `userId` off the descriptor regardless of whether the
     * getter has been added by codegen yet — codegen adds the getter
     * the next time setup.bat runs, but live Dock processes may still
     * be holding an old class instance for the duration of a request.
     * @param {TaskDescriptor} taskDescriptor
     * @returns {string}
     */
    static #readUserId(taskDescriptor)
    {
        if (typeof taskDescriptor.getUserId === "function")
        {
            return taskDescriptor.getUserId() || "";
        }
        const json = typeof taskDescriptor.toJson === "function" ? taskDescriptor.toJson() : null;
        return (json && typeof json === "object" && typeof json.userId === "string") ? json.userId : "";
    }

    static #buildPayloadSummary(taskDescriptor)
    {
        const typeName = taskTypeDisplayName(taskDescriptor.getType());
        const payload = taskDescriptor.getPayload();

        if (!payload || typeof payload !== "object")
        {
            return typeName;
        }

        // subjectName is what a generation run carries (GeneralGenerationSettings),
        // so an archived "AI Generation" reads "AI Generation — Emotional
        // Intelligence" instead of the bare type name the user found cryptic.
        const interesting = payload.parentDeckTitle || payload.deckTitle || payload.title || payload.name || payload.subjectName || payload.parentDeckId;
        if (typeof interesting === "string" && interesting.length > 0)
        {
            const composed = `${typeName} — ${interesting}`;
            if (composed.length <= TaskHistoryQueryEngine.#PAYLOAD_SUMMARY_MAX_LENGTH)
            {
                return composed;
            }
            return composed.substring(0, TaskHistoryQueryEngine.#PAYLOAD_SUMMARY_MAX_LENGTH);
        }

        return typeName;
    }

    /**
     * @param {string} userId
     * @param {{ filters?: object, sort?: object, limit?: number, offset?: number }} options
     * @returns {Promise<{ rows: Array<object>, totalCount: number }>}
     */
    static async listForUser(userId, options = {})
    {
        const collection = await TaskHistoryQueryEngine.#getCollection();
        if (!collection)
        {
            return { rows: [], totalCount: 0 };
        }

        const mongoQuery = TaskHistoryQueryEngine.#buildMongoQuery(userId, options.filters || {});
        const sortSpec = TaskHistoryQueryEngine.#buildSortSpec(options.sort);
        const limit = Math.max(1, Math.min(200, Number.isFinite(options.limit) ? options.limit : 50));
        const offset = Math.max(0, Number.isFinite(options.offset) ? options.offset : 0);

        const totalCount = await collection.countDocuments(mongoQuery);
        const cursor = collection.find(mongoQuery, { projection: { _id: 0 } }).sort(sortSpec).skip(offset).limit(limit);
        const rows = await cursor.toArray();
        return { rows, totalCount };
    }

    /**
     * Looks up a single historical row by id, returning it only if the
     * requesting user owns it. Returns null when the row is missing or
     * belongs to someone else — the Activity progress endpoint uses this
     * after a Redis miss to render the "completed" view for tasks whose
     * live descriptor has already expired.
     * @param {string} taskId
     * @param {string} userId
     * @returns {Promise<object|null>}
     */
    static async getByIdForUser(taskId, userId)
    {
        if (!taskId || !userId)
        {
            return null;
        }
        const collection = await TaskHistoryQueryEngine.#getCollection();
        if (!collection)
        {
            return null;
        }
        const row = await collection.findOne({ id: taskId, userId: userId }, { projection: { _id: 0 } });
        return row || null;
    }

    static #buildMongoQuery(userId, filterValuesByKey)
    {
        const queryFragments = [{ userId: userId }];

        // Free-text search: match payloadSummary case-insensitively.
        const query = (filterValuesByKey.query || "").toString().trim();
        if (query.length > 0)
        {
            const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            queryFragments.push({ payloadSummary: { $regex: escaped, $options: "i" } });
        }

        // Status filter — numeric task status.
        if (filterValuesByKey.status !== undefined && filterValuesByKey.status !== null && filterValuesByKey.status !== "")
        {
            const numericStatus = Number(filterValuesByKey.status);
            if (Number.isFinite(numericStatus))
            {
                queryFragments.push({ status: numericStatus });
            }
        }

        // Type filter — numeric task type.
        if (filterValuesByKey.type !== undefined && filterValuesByKey.type !== null && filterValuesByKey.type !== "")
        {
            const numericType = Number(filterValuesByKey.type);
            if (Number.isFinite(numericType))
            {
                queryFragments.push({ type: numericType });
            }
        }

        // Date range — { from, until } ISO strings.
        const range = filterValuesByKey.timestamp || {};
        if (range.from)
        {
            const fromDate = new Date(range.from);
            if (!Number.isNaN(fromDate.getTime()))
            {
                queryFragments.push({ completedAt: { $gte: fromDate } });
            }
        }
        if (range.until)
        {
            const untilDate = new Date(range.until);
            if (!Number.isNaN(untilDate.getTime()))
            {
                queryFragments.push({ completedAt: { $lte: untilDate } });
            }
        }

        return queryFragments.length === 1 ? queryFragments[0] : { $and: queryFragments };
    }

    static #buildSortSpec(sortOption)
    {
        if (!sortOption || typeof sortOption !== "object")
        {
            return { completedAt: -1 };
        }
        const direction = sortOption.direction === 1 || sortOption.direction === "asc" ? 1 : -1;
        const fieldByActivitySortField =
        {
            0: "completedAt",
            1: "type",
            2: "status",
            3: "payloadSummary"
        };
        const fieldName = fieldByActivitySortField[Number(sortOption.field)] || "completedAt";
        return { [fieldName]: direction };
    }
}

module.exports = TaskHistoryQueryEngine;
