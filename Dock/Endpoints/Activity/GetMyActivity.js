const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const TaskHistoryQueryEngine = require("../../Globals/Classes/Database/TaskHistoryQueryEngine");
const TaskManager = require("../../Globals/Classes/Task/TaskManager");
const { activityEntryTypes } = require("../../Globals/Enumerations/ActivityEntryTypes");
const { taskStatus } = require("../../Globals/Enumerations/TaskStatus");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const { taskTypeDisplayName } = require("../../Globals/UtilityFunctions.js/TaskTypeDisplayName");


/**
 * POST /Activity/Search
 *
 * Returns the user's unified activity feed across:
 *   1. In-progress tasks (live from Redis via TaskManager.listActiveForUser)
 *   2. Finished tasks (taskHistory collection via TaskHistoryQueryEngine)
 *   3. Purchases (purchases collection)
 *
 * Body: { filters, sort, limit, offset, includeTypes }
 *   - filters: { query, type, status, timestamp: { from, until } }
 *   - sort: { field, direction }
 *   - includeTypes: array of activityEntryTypes values; omitted → both
 *
 * The three sources are unified into a single canonical entry shape and
 * then sorted + paginated in-memory. Volume per user stays well below
 * the threshold where a real federated query plan would matter.
 *
 * Canonical entry shape:
 *   {
 *     id: string,
 *     entryType: activityEntryTypes,
 *     timestamp: ISO date,
 *     title: string,
 *     subtitle: string,
 *     status: number (taskStatus for tasks, purchase status for purchases),
 *     payload: { ...source-specific fields }
 *   }
 */
class GetMyActivityEndpoint
{
    static #DEFAULT_LIMIT = 50;
    static #MAX_LIMIT = 200;

    static async handle(request, response)
    {
        const session = request.session;
        if (!session)
        {
            response.sendStatusCode(httpStatus.UNAUTHORIZED);
            return;
        }

        const userId = session.getUserId();
        const body = await request.getBody();
        const filters = (body && typeof body.filters === "object") ? body.filters : {};
        const sort = (body && typeof body.sort === "object") ? body.sort : {};
        const limit = GetMyActivityEndpoint.#clampLimit(body && body.limit);
        const offset = Math.max(0, Number.isFinite(body && body.offset) ? body.offset : 0);
        const includeTypes = Array.isArray(body && body.includeTypes) && body.includeTypes.length > 0
            ? body.includeTypes.map((rawValue) => Number(rawValue))
            : [activityEntryTypes.TASK, activityEntryTypes.PURCHASE];

        const unifiedEntries = [];

        if (includeTypes.includes(activityEntryTypes.TASK))
        {
            const activeTasks = await GetMyActivityEndpoint.#loadActiveTasks(userId, filters);
            for (const taskEntry of activeTasks)
            {
                unifiedEntries.push(taskEntry);
            }

            const historyEntries = await GetMyActivityEndpoint.#loadTaskHistory(userId, filters, sort);
            for (const historyEntry of historyEntries)
            {
                unifiedEntries.push(historyEntry);
            }
        }

        if (includeTypes.includes(activityEntryTypes.PURCHASE))
        {
            const purchaseEntries = await GetMyActivityEndpoint.#loadPurchases(userId, filters);
            for (const purchaseEntry of purchaseEntries)
            {
                unifiedEntries.push(purchaseEntry);
            }
        }

        GetMyActivityEndpoint.#sortInPlace(unifiedEntries, sort);

        const totalCount = unifiedEntries.length;
        const paginated = unifiedEntries.slice(offset, offset + limit);

        response.sendJson
        ({
            entries: paginated,
            totalCount: totalCount,
            offset: offset,
            limit: limit
        });
    }

    static #clampLimit(rawLimit)
    {
        const numeric = Number(rawLimit);
        if (!Number.isFinite(numeric) || numeric <= 0)
        {
            return GetMyActivityEndpoint.#DEFAULT_LIMIT;
        }
        return Math.min(GetMyActivityEndpoint.#MAX_LIMIT, Math.floor(numeric));
    }

    static async #loadActiveTasks(userId, filters)
    {
        try
        {
            const activeTasks = await TaskManager.listActiveForUser(userId);
            const filterStatus = GetMyActivityEndpoint.#numericFilter(filters.status);

            const entries = [];
            for (const task of activeTasks)
            {
                // Use the rolled-up tree status, NOT the task's own status: the
                // generation root (PREPARE_FOR_GENERATION) is a no-op marked
                // COMPLETED the instant it exits, so its own status would show a
                // still-running generation as "Completed". An actively-tracked
                // task is in progress (or failed) by construction.
                const status = await TaskManager.computeActiveTreeStatus(task.getId());
                if (filterStatus !== null && status !== filterStatus)
                {
                    continue;
                }

                const title = GetMyActivityEndpoint.#humaniseTaskType(task.getType());
                const subtitle = GetMyActivityEndpoint.#statusLabel(status);
                const timestamp = task.getStartDate() || new Date();
                entries.push
                ({
                    id: task.getId(),
                    entryType: activityEntryTypes.TASK,
                    timestamp: timestamp,
                    title: title,
                    subtitle: subtitle,
                    status: status,
                    payload:
                    {
                        type: task.getType(),
                        completion: typeof task.getCompletion === "function" ? task.getCompletion() : 0,
                        isLive: true
                    }
                });
            }

            if (filters.query)
            {
                const queryLower = String(filters.query).toLowerCase();
                return entries.filter((entry) => entry.title.toLowerCase().includes(queryLower));
            }
            return entries;
        }
        catch (loadError)
        {
            console.warn(`[Activity] Failed to load active tasks for ${userId}: ${loadError.message}`);
            return [];
        }
    }

    static async #loadTaskHistory(userId, filters, sort)
    {
        // Pull the entire window in one shot; merging happens in-memory.
        // Volume is bounded by per-user history which doesn't grow large.
        const { rows } = await TaskHistoryQueryEngine.listForUser(userId,
        {
            filters: filters,
            sort: sort,
            limit: 500,
            offset: 0
        });

        return rows.map((row) =>
        {
            return {
                id: row.id,
                entryType: activityEntryTypes.TASK,
                timestamp: row.completedAt || row.startDate || new Date(),
                title: row.payloadSummary || GetMyActivityEndpoint.#humaniseTaskType(row.type),
                subtitle: GetMyActivityEndpoint.#statusLabel(row.status),
                status: row.status,
                payload:
                {
                    type: row.type,
                    completion: row.completion,
                    durationMillis: row.durationMillis,
                    parentTaskId: row.parentTaskId,
                    isLive: false
                }
            };
        });
    }

    static async #loadPurchases(userId, filters)
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return [];
        }

        const purchasesCollection = database.collection(DatabaseConstants.PURCHASES_COLLECTION);
        const paidDecksCollection = database.collection(DatabaseConstants.PAID_DECKS_COLLECTION);

        const mongoQuery = GetMyActivityEndpoint.#buildPurchaseQuery(userId, filters);

        const purchases = await purchasesCollection
            .find(mongoQuery, { projection: { _id: 0 } })
            .sort({ purchaseDate: -1 })
            .limit(500)
            .toArray();

        if (purchases.length === 0)
        {
            return [];
        }

        const deckIds = Array.from(new Set(purchases.map((purchase) => purchase.deckId).filter(Boolean)));
        const deckRows = deckIds.length > 0
            ? await paidDecksCollection.find({ id: { $in: deckIds } }, { projection: { id: 1, title: 1, _id: 0 } }).toArray()
            : [];
        const deckTitleById = new Map();
        for (const deckRow of deckRows)
        {
            deckTitleById.set(deckRow.id, deckRow.title);
        }

        return purchases.map((purchase) =>
        {
            const deckTitle = deckTitleById.get(purchase.deckId) || "Deck";
            const amountMajor = ((purchase.amountMinor || 0) / 100).toFixed(2);
            return {
                id: purchase.id,
                entryType: activityEntryTypes.PURCHASE,
                timestamp: purchase.purchaseDate || new Date(),
                title: deckTitle,
                subtitle: `${purchase.currency || "INR"} ${amountMajor}`,
                status: purchase.status,
                payload:
                {
                    deckId: purchase.deckId,
                    amountMinor: purchase.amountMinor,
                    currency: purchase.currency,
                    region: purchase.region,
                    providerOrderId: purchase.providerOrderId,
                    providerPaymentId: purchase.providerPaymentId
                }
            };
        });
    }

    static #buildPurchaseQuery(userId, filters)
    {
        const fragments = [{ userId: userId }];

        if (filters.query)
        {
            // The purchase row itself doesn't hold the title — title-side
            // matching happens after the deck-title join.
        }

        const numericStatus = GetMyActivityEndpoint.#numericFilter(filters.status);
        if (numericStatus !== null)
        {
            // Purchase status is a string enum on the existing schema; treat numeric
            // and string forms as equivalent fallthroughs.
            fragments.push({ $or: [{ status: numericStatus }, { status: String(numericStatus) }] });
        }

        // Purchase.toJson serialises purchaseDate as an ISO string, so
        // it's stored as a string in Mongo (not a BSON Date). Compare
        // string-to-string — ISO-8601 strings sort lexicographically the
        // same as chronologically.
        const range = filters.timestamp || {};
        if (range.from)
        {
            const fromDate = new Date(range.from);
            if (!Number.isNaN(fromDate.getTime()))
            {
                fragments.push({ purchaseDate: { $gte: fromDate.toISOString() } });
            }
        }
        if (range.until)
        {
            const untilDate = new Date(range.until);
            if (!Number.isNaN(untilDate.getTime()))
            {
                fragments.push({ purchaseDate: { $lte: untilDate.toISOString() } });
            }
        }

        return fragments.length === 1 ? fragments[0] : { $and: fragments };
    }

    static #numericFilter(rawValue)
    {
        if (rawValue === undefined || rawValue === null || rawValue === "")
        {
            return null;
        }
        const numeric = Number(rawValue);
        return Number.isFinite(numeric) ? numeric : null;
    }

    static #humaniseTaskType(taskTypeValue)
    {
        return taskTypeDisplayName(taskTypeValue);
    }

    static #statusLabel(statusValue)
    {
        for (const statusName of Object.keys(taskStatus))
        {
            if (taskStatus[statusName] === statusValue)
            {
                return statusName.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (firstChar) => firstChar.toUpperCase());
            }
        }
        return "Unknown";
    }

    static #sortInPlace(entries, sortOption)
    {
        const direction = (sortOption && (sortOption.direction === 1 || sortOption.direction === "asc")) ? 1 : -1;
        entries.sort((leftEntry, rightEntry) =>
        {
            const leftTime = new Date(leftEntry.timestamp).getTime();
            const rightTime = new Date(rightEntry.timestamp).getTime();
            return (leftTime - rightTime) * direction;
        });
    }
}

async function getMyActivity(request, response)
{
    await GetMyActivityEndpoint.handle(request, response);
}

module.exports = { getMyActivity };
