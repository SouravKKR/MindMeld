class IndexedDbHelper
{
    static databasePromise = null;
    static databaseName = "PersistenceDatabase";
    static objectStoreName = "keyValueStore";
    static #OPEN_TIMEOUT_MILLISECONDS = 15000;

    static openDatabase()
    {
        if (this.databasePromise) return this.databasePromise;

        this.databasePromise = new Promise((resolve, reject) =>
        {
            const openRequest = indexedDB.open(this.databaseName, 1);

            // If a previous tab still holds an upgrade-blocking
            // connection (e.g. another open instance of the app, or a
            // not-yet-finalised DevTools "Clear storage" operation)
            // `onblocked` fires and `onsuccess` never does. Reject so
            // the Deck.boot catch surfaces a Retry UI instead of
            // hanging at "Preparing your library…" forever.
            openRequest.onblocked = () =>
            {
                reject(new Error("IndexedDB open is blocked — another tab may be holding the database open. Close other CogniumLearn tabs and retry."));
            };

            // Backstop: some browser states (e.g. corrupted IDB
            // metadata after a forced wipe) leave the open request
            // pending without ever firing success / error / blocked.
            // Time out so the boot path can surface FAILED → Retry.
            const openTimeoutHandle = setTimeout(() =>
            {
                reject(new Error("IndexedDB open timed out after 15s. Try reloading the page; if it persists, clear site data and reload."));
            }, IndexedDbHelper.#OPEN_TIMEOUT_MILLISECONDS);

            openRequest.onupgradeneeded = event =>
            {
                const database = event.target.result;

                if (!database.objectStoreNames.contains(this.objectStoreName))
                {
                    database.createObjectStore(this.objectStoreName);
                }
            };

            openRequest.onsuccess = () =>
            {
                clearTimeout(openTimeoutHandle);
                resolve(openRequest.result);
            };

            openRequest.onerror = () =>
            {
                clearTimeout(openTimeoutHandle);
                reject(openRequest.error || new Error("IndexedDB open failed with no error detail."));
            };
        });

        // If the open ultimately fails, drop the cached promise so a
        // subsequent retry (e.g. the user clicking Retry on the
        // initialisation overlay) can re-attempt cleanly instead of
        // inheriting the same rejected promise forever.
        this.databasePromise.catch(() =>
        {
            if (this.databasePromise && this.databasePromise.catch === Promise.prototype.catch)
            {
                this.databasePromise = null;
            }
        });

        return this.databasePromise;
    }

    static async getValue(storageKey)
    {
        const database = await IndexedDbHelper.openDatabase();

        return new Promise((resolve, reject) =>
        {
            const transaction = database.transaction(
                this.objectStoreName,
                "readonly"
            );

            const objectStore = transaction.objectStore(
                this.objectStoreName
            );

            const getRequest = objectStore.get(storageKey);

            getRequest.onsuccess = () =>
            {
                resolve(getRequest.result ?? null);
            };

            getRequest.onerror = () =>
            {
                reject(getRequest.error || new Error(`IndexedDB getValue("${storageKey}") failed.`));
            };

            transaction.onerror = () =>
            {
                reject(transaction.error || new Error(`IndexedDB getValue transaction for "${storageKey}" failed.`));
            };

            transaction.onabort = () =>
            {
                reject(transaction.error || new Error(`IndexedDB getValue transaction for "${storageKey}" was aborted.`));
            };
        });
    }

    static async setValue(storageKey, valueToStore)
    {
        const database = await IndexedDbHelper.openDatabase();

        return new Promise((resolve, reject) =>
        {
            const transaction = database.transaction(
                this.objectStoreName,
                "readwrite"
            );

            const objectStore = transaction.objectStore(
                this.objectStoreName
            );

            objectStore.put(valueToStore, storageKey);

            transaction.oncomplete = () =>
            {
                resolve();
            };

            transaction.onerror = () =>
            {
                reject(transaction.error || new Error(`IndexedDB setValue("${storageKey}") failed.`));
            };

            transaction.onabort = () =>
            {
                reject(transaction.error || new Error(`IndexedDB setValue("${storageKey}") was aborted.`));
            };
        });
    }

    static async deleteValue(storageKey)
    {
        const database = await IndexedDbHelper.openDatabase();

        return new Promise((resolve, reject) =>
        {
            const transaction = database.transaction(
                this.objectStoreName,
                "readwrite"
            );

            const objectStore = transaction.objectStore(
                this.objectStoreName
            );

            objectStore.delete(storageKey);

            transaction.oncomplete = () =>
            {
                resolve();
            };

            transaction.onerror = () =>
            {
                reject(transaction.error || new Error(`IndexedDB deleteValue("${storageKey}") failed.`));
            };

            transaction.onabort = () =>
            {
                reject(transaction.error || new Error(`IndexedDB deleteValue("${storageKey}") was aborted.`));
            };
        });
    }

    /**
     * Bulk write — puts every entry of `entriesMap` (a Map of key →
     * value) into the object store inside ONE readwrite transaction.
     * Used by the Force Pull bulk-snapshot path: 2 000 individual
     * deck.save() calls each open their own transaction and serialise
     * the event loop for tens of seconds, but a single bulkWrite
     * commits in well under a second.
     *
     * @param {Map<string, any>} entriesMap
     */
    static async setManyValues(entriesMap)
    {
        if (!entriesMap || entriesMap.size === 0)
        {
            return;
        }

        const database = await IndexedDbHelper.openDatabase();

        return new Promise((resolve, reject) =>
        {
            const transaction = database.transaction(
                this.objectStoreName,
                "readwrite"
            );

            const objectStore = transaction.objectStore(
                this.objectStoreName
            );

            for (const [storageKey, valueToStore] of entriesMap)
            {
                objectStore.put(valueToStore, storageKey);
            }

            transaction.oncomplete = () =>
            {
                resolve();
            };

            transaction.onerror = () =>
            {
                reject(transaction.error || new Error(`IndexedDB setManyValues (${entriesMap.size} entries) failed.`));
            };

            transaction.onabort = () =>
            {
                reject(transaction.error || new Error(`IndexedDB setManyValues (${entriesMap.size} entries) was aborted.`));
            };
        });
    }

    /**
     * Bulk delete — counterpart to setManyValues. Removes every key
     * in `storageKeys` in ONE readwrite transaction.
     * @param {Array<string>|Set<string>} storageKeys
     */
    static async deleteManyValues(storageKeys)
    {
        if (!storageKeys)
        {
            return;
        }
        const keysArray = Array.isArray(storageKeys) ? storageKeys : Array.from(storageKeys);
        if (keysArray.length === 0)
        {
            return;
        }

        const database = await IndexedDbHelper.openDatabase();

        return new Promise((resolve, reject) =>
        {
            const transaction = database.transaction(
                this.objectStoreName,
                "readwrite"
            );

            const objectStore = transaction.objectStore(
                this.objectStoreName
            );

            for (const storageKey of keysArray)
            {
                objectStore.delete(storageKey);
            }

            transaction.oncomplete = () =>
            {
                resolve();
            };

            transaction.onerror = () =>
            {
                reject(transaction.error || new Error(`IndexedDB deleteManyValues (${keysArray.length} keys) failed.`));
            };

            transaction.onabort = () =>
            {
                reject(transaction.error || new Error(`IndexedDB deleteManyValues (${keysArray.length} keys) was aborted.`));
            };
        });
    }

    /**
     * Returns every key currently in the object store. Used by the
     * bulk-snapshot path to discover and clear stale `Decks/*.mmd`
     * entries before writing the freshly-downloaded set.
     */
    static async getAllKeys()
    {
        const database = await IndexedDbHelper.openDatabase();

        return new Promise((resolve, reject) =>
        {
            const transaction = database.transaction(
                this.objectStoreName,
                "readonly"
            );

            const objectStore = transaction.objectStore(
                this.objectStoreName
            );

            const getRequest = objectStore.getAllKeys();

            getRequest.onsuccess = () =>
            {
                resolve(getRequest.result || []);
            };

            getRequest.onerror = () =>
            {
                reject(getRequest.error || new Error("IndexedDB getAllKeys failed."));
            };

            transaction.onerror = () =>
            {
                reject(transaction.error || new Error("IndexedDB getAllKeys transaction failed."));
            };

            transaction.onabort = () =>
            {
                reject(transaction.error || new Error("IndexedDB getAllKeys transaction was aborted."));
            };
        });
    }

    static async valueExists(storageKey)
    {
        const storedValue = await this.getValue(storageKey);
        return storedValue !== null;
    }

    static async clear()
    {
        indexedDB.deleteDatabase(this.databaseName);
        this.databasePromise = null;
    }
}

export default IndexedDbHelper;