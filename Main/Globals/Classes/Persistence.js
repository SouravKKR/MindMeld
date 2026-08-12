import { dataFormats } from "../Enumerations/DataFormats.js";
import { platforms } from "../Enumerations/Platforms.js";
import Platform from "./Platform.js";
import IndexedDbHelper from "./IndexedDbHelper.js";
import UserIdentityManager from "./UserIdentityManager.js";
import UserIdentityConstants from "../Constants/UserIdentityConstants.js";


class Persistence
{
    /**
     * Wraps a raw path with the current user-identity prefix unless the
     * path is on the GLOBAL_KEYS allowlist. The prefix is e.g.
     *   Users/<userId>/Decks/0.mmd
     *   Users/anonymous/Sync/SyncLog.mmsd
     * so logged-in users and anonymous sessions cannot see each other's
     * files, eliminating the logout/login deletion-resurrection bug.
     */
    static #prefixPath(path)
    {
        if (UserIdentityConstants.GLOBAL_KEYS.has(path))
        {
            return path;
        }

        return `${UserIdentityManager.getStoragePrefix()}/${path}`;
    }

    static async write(path, data, dataFormat)
    {
        path = Persistence.#prefixPath(path);

        switch (Platform.get())
        {
            case platforms.APP:
            {
                const { fs } = window.__TAURI__;
                const { writeTextFile, writeFile, mkdir, BaseDirectory } = fs;

                const dir = path.substring(0, path.lastIndexOf('/'));

                if (dir)
                {
                    await mkdir(dir, { recursive: true, baseDir: BaseDirectory.AppData });
                }

                switch (dataFormat)
                {
                    case dataFormats.STRING:
                    {
                        await writeTextFile(path, data, { baseDir: BaseDirectory.AppData });
                    }
                    break

                    case dataFormats.JSON:
                    {
                        await writeTextFile(path, JSON.stringify(data), { baseDir: BaseDirectory.AppData });
                    }
                    break

                    case dataFormats.BUFFER:
                    {
                        await writeFile(path, data, { baseDir: BaseDirectory.AppData });
                    }
                    break

                    case dataFormats.BASE64:
                    {
                        const buffer = Uint8Array.from(atob(data), c => c.charCodeAt(0));
                        await writeFile(path, buffer, { baseDir: BaseDirectory.AppData });
                    }
                    break
                }
            }
            break

            case platforms.WEB:
            {
                switch (dataFormat)
                {
                    case dataFormats.STRING:
                    case dataFormats.JSON:
                    case dataFormats.BASE64:
                    {
                        await IndexedDbHelper.setValue(path, data);
                    }
                    break;
                    case dataFormats.BUFFER:
                    {
                        const bytes = data instanceof Uint8Array ? data: new Uint8Array(data);
                        await IndexedDbHelper.setValue(path, bytes);
                    }
                    break;

                }
            }
            break
        }
    }

    /**
     * Bulk-write variant of `write()` — accepts a Map<unprefixedPath, data>
     * of BUFFER-shaped payloads and, on the WEB platform, commits the
     * lot in ONE IndexedDB transaction. Used by the Force Pull bulk-
     * snapshot path so a 2000-deck reconstruction lands in a single
     * commit instead of 2000 sequential per-deck transactions.
     *
     * On APP (Tauri) we fall back to a sequential `write()` per entry
     * since the filesystem has no equivalent batch primitive — Force
     * Pull on desktop is rare and the per-write overhead is much
     * smaller than IDB's anyway.
     *
     * Only `dataFormats.BUFFER` is supported here; the slow paths
     * (STRING/JSON/BASE64) aren't used by the bulk path.
     *
     * @param {Map<string, Uint8Array|ArrayBuffer>} entriesMap
     */
    static async writeMany(entriesMap)
    {
        if (!entriesMap || entriesMap.size === 0)
        {
            return;
        }

        switch (Platform.get())
        {
            case platforms.WEB:
            {
                const prefixedEntries = new Map();
                for (const [unprefixedPath, data] of entriesMap)
                {
                    const prefixedPath = Persistence.#prefixPath(unprefixedPath);
                    const bytes        = data instanceof Uint8Array ? data : new Uint8Array(data);
                    prefixedEntries.set(prefixedPath, bytes);
                }
                await IndexedDbHelper.setManyValues(prefixedEntries);
                return;
            }

            case platforms.APP:
            {
                for (const [unprefixedPath, data] of entriesMap)
                {
                    await Persistence.write(unprefixedPath, data, dataFormats.BUFFER);
                }
                return;
            }
        }
    }

    /**
     * Bulk-delete: removes every key in `unprefixedPaths` (under the
     * current identity prefix) in a single IDB transaction on WEB, or
     * sequentially via `delete()` on APP. Used by the Force Pull path
     * to wipe stale `Decks/*.mmd` entries before writing the freshly
     * downloaded set.
     */
    static async deleteMany(unprefixedPaths)
    {
        if (!unprefixedPaths || unprefixedPaths.length === 0)
        {
            return;
        }

        switch (Platform.get())
        {
            case platforms.WEB:
            {
                const prefixedKeys = unprefixedPaths.map((path) => Persistence.#prefixPath(path));
                await IndexedDbHelper.deleteManyValues(prefixedKeys);
                return;
            }

            case platforms.APP:
            {
                for (const path of unprefixedPaths)
                {
                    try { await Persistence.delete(path); }
                    catch (deleteError) { console.warn(`[Persistence] deleteMany: '${path}' skipped — ${deleteError?.message || deleteError}`); }
                }
                return;
            }
        }
    }

    /**
     * Lists every unprefixed path that exists for the current identity
     * matching the given path prefix (e.g. `"Decks/"`). WEB walks IDB
     * keys; APP isn't currently wired (Force Pull invocations there
     * fall back to per-key delete which doesn't need a listing).
     */
    static async listKeysWithPrefix(unprefixedPrefix)
    {
        if (Platform.get() !== platforms.WEB)
        {
            return [];
        }

        const allKeys      = await IndexedDbHelper.getAllKeys();
        const identityRoot = Persistence.#prefixPath(unprefixedPrefix);

        const matched = [];
        for (let keyIndex = 0; keyIndex < allKeys.length; keyIndex++)
        {
            const key = allKeys[keyIndex];
            if (typeof key === "string" && key.startsWith(identityRoot))
            {
                // Strip the identity prefix back off so callers stay in
                // the unprefixed namespace they passed in.
                const unprefixed = key.substring(identityRoot.length - unprefixedPrefix.length);
                matched.push(unprefixed);
            }
        }
        return matched;
    }

    static async read(path, dataFormat)
    {
        path = Persistence.#prefixPath(path);

        switch (Platform.get())
        {
            case platforms.APP:
            {
                const { fs } = window.__TAURI__;
                const { readFile, readTextFile, BaseDirectory } = fs;

                switch (dataFormat)
                {
                    case dataFormats.STRING:
                    {
                        return await readTextFile(path, { baseDir: BaseDirectory.AppData });
                    }

                    case dataFormats.JSON:
                    {
                        const text = await readTextFile(path, { baseDir: BaseDirectory.AppData })
                        return JSON.parse(text);
                    }

                    case dataFormats.BUFFER:
                    {
                        return await readFile(path, { baseDir: BaseDirectory.AppData });
                    }

                    case dataFormats.BASE64:
                    {
                        const buffer = await readFile(path, { baseDir: BaseDirectory.AppData })
                        return btoa(
                            String.fromCharCode(...buffer)
                        );
                    }
                }
            }

            case platforms.WEB:
            {
                const stored = await IndexedDbHelper.getValue(path);

                if (stored === null) return null;

                if (dataFormat === dataFormats.BUFFER)
                {
                    if (stored instanceof Uint8Array)
                    {
                        return stored;
                    }

                    if (stored instanceof ArrayBuffer)
                    {
                        return new Uint8Array(stored);
                    }

                    return new Uint8Array(stored.buffer);
                }

                return stored;
            }
        }

        return null;
    }

    static async exists(path)
    {
        path = Persistence.#prefixPath(path);

        switch (Platform.get())
        {
            case platforms.APP:
            {
                const { fs } = window.__TAURI__;
                const { exists, BaseDirectory } = fs;

                return await exists(path, { baseDir: BaseDirectory.AppData });
            }

            case platforms.WEB:
            {
                return await IndexedDbHelper.valueExists(path);
            }
        }
    }

    //Should be able to delete any file system entry.. file or directory.
    static async delete(path)
    {
        path = Persistence.#prefixPath(path);

        switch (Platform.get())
        {
            case platforms.APP:
            {
                const { fs } = window.__TAURI__;
                // Tauri v2 merged v1's removeFile/removeDir into a single
                // `remove` (v1's names are undefined in v2 — calling them
                // threw "not a function", which broke every desktop deck
                // deletion AND the sync-apply of a pulled deletion). The rest
                // of this class already uses the v2 API (mkdir/writeFile/...).
                // Every caller deletes a single file (Decks/*.mmd,
                // Session/Cache.json, ...), so no directory/recursive handling
                // is needed.
                const { remove, BaseDirectory } = fs;

                await remove(path, { baseDir: BaseDirectory.AppData });
            }
            break;

            case platforms.WEB:
            {
                await IndexedDbHelper.deleteValue(path);
            }
            break;
        }
    }

    static async reset()
    {
        switch(Platform.get())
        {
            case platforms.APP:
            {
                // Mirrors the web branch's indexedDB.deleteDatabase() — every
                // identity prefix under this app's AppData root, not just the
                // current user's, so a stale prior identity's files can never
                // linger past a reset. Enumerate top-level entries and remove
                // each by name rather than assuming an empty/root path is a
                // valid `remove` target, since that is not documented Tauri
                // fs-plugin behaviour to rely on.
                const { fs } = window.__TAURI__;
                const { readDir, remove, BaseDirectory } = fs;

                const topLevelEntries = await readDir("", { baseDir: BaseDirectory.AppData });

                for (const topLevelEntry of topLevelEntries)
                {
                    await remove(topLevelEntry.name, { baseDir: BaseDirectory.AppData, recursive: true });
                }
            }
            break;

            case platforms.WEB:
            {
                await IndexedDbHelper.clear();
            }
        }
    }

}

export default Persistence;