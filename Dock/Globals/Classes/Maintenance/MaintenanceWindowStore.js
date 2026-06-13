const DatabaseConstants = require("../../Constants/DatabaseConstants");
const DatabaseConnector = require("../Database/DatabaseConnector");
const MaintenanceWindow = require("../../Model/MaintenanceWindow");

// Persists scheduled maintenance windows and serves the hot-path "is maintenance
// active right now?" check that gates every task-creating request. The active
// check runs on every Generate / AskAi call, so the full window list is cached
// in process for a short window (like CreditConfigurationStore) — admin edits
// invalidate the cache so they apply within seconds.

class MaintenanceWindowStore
{
    static #CACHE_TTL_MILLISECONDS = 15 * 1000;

    static #cachedWindows = null;
    static #cachedAtMilliseconds = 0;

    static async #getCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        return database.collection(DatabaseConstants.MAINTENANCE_WINDOWS_COLLECTION);
    }

    static invalidateCache()
    {
        MaintenanceWindowStore.#cachedWindows = null;
        MaintenanceWindowStore.#cachedAtMilliseconds = 0;
    }

    /**
     * Returns every scheduled window as MaintenanceWindow instances, cached for a
     * short window. Sorted by start date ascending.
     * @returns {Promise<Array<MaintenanceWindow>>}
     */
    static async list()
    {
        const now = Date.now();
        if (MaintenanceWindowStore.#cachedWindows !== null && (now - MaintenanceWindowStore.#cachedAtMilliseconds) < MaintenanceWindowStore.#CACHE_TTL_MILLISECONDS)
        {
            return MaintenanceWindowStore.#cachedWindows;
        }

        const collection = await MaintenanceWindowStore.#getCollection();
        const documents = await collection.find({}).toArray();

        const windows = documents
            .map(document => MaintenanceWindow.fromJson(document))
            .filter(window => window !== null)
            .sort((firstWindow, secondWindow) =>
            {
                const firstStart = firstWindow.getStartDate() ? firstWindow.getStartDate().getTime() : 0;
                const secondStart = secondWindow.getStartDate() ? secondWindow.getStartDate().getTime() : 0;
                return firstStart - secondStart;
            });

        MaintenanceWindowStore.#cachedWindows = windows;
        MaintenanceWindowStore.#cachedAtMilliseconds = now;
        return windows;
    }

    /**
     * @param {MaintenanceWindow} window
     * @param {string} createdByUserId
     * @returns {Promise<MaintenanceWindow>}
     */
    static async add(window, createdByUserId)
    {
        const collection = await MaintenanceWindowStore.#getCollection();

        const document = { _id: window.getId(), ...window.toJson() };
        document.createdBy = createdByUserId || "";

        await collection.insertOne(document);
        MaintenanceWindowStore.invalidateCache();
        return MaintenanceWindow.fromJson(document);
    }

    /**
     * Patches start/end/title/message on an existing window. Returns the updated
     * window, or null if no window has that id.
     * @param {string} id
     * @param {object} updates
     * @param {string} updatedByUserId
     * @returns {Promise<MaintenanceWindow|null>}
     */
    static async update(id, updates, updatedByUserId)
    {
        const collection = await MaintenanceWindowStore.#getCollection();
        const document = await collection.findOne({ _id: id });

        if (!document)
        {
            return null;
        }

        const window = MaintenanceWindow.fromJson(document);

        if (updates.startDate !== undefined)
        {
            window.setStartDate(updates.startDate);
        }
        if (updates.endDate !== undefined)
        {
            window.setEndDate(updates.endDate);
        }
        if (updates.title !== undefined)
        {
            window.setTitle(updates.title);
        }
        if (updates.message !== undefined)
        {
            window.setMessage(updates.message);
        }
        window.setUpdatedAt(new Date());

        const updatedDocument = window.toJson();
        updatedDocument.updatedBy = updatedByUserId || "";

        await collection.updateOne({ _id: id }, { $set: updatedDocument });
        MaintenanceWindowStore.invalidateCache();
        return window;
    }

    /**
     * @param {string} id
     * @returns {Promise<boolean>} True if a window was removed.
     */
    static async remove(id)
    {
        const collection = await MaintenanceWindowStore.#getCollection();
        const result = await collection.deleteOne({ _id: id });
        MaintenanceWindowStore.invalidateCache();
        return result.deletedCount > 0;
    }

    /**
     * @param {Date} now
     * @returns {Promise<MaintenanceWindow|null>} The active window, or null.
     */
    static async getActiveWindow(now)
    {
        const windows = await MaintenanceWindowStore.list();
        return windows.find(window => window.isActiveAt(now)) || null;
    }

    /**
     * @param {Date} now
     * @param {number} leadMilliseconds
     * @returns {Promise<Array<MaintenanceWindow>>} Windows starting within the lead window.
     */
    static async getUpcomingWindows(now, leadMilliseconds)
    {
        const windows = await MaintenanceWindowStore.list();
        return windows.filter(window => window.isUpcomingWithin(now, leadMilliseconds));
    }
}

module.exports = MaintenanceWindowStore;
