import Persistence from "./Persistence.js";
import AuthenticationEvents from "../Events/AuthenticationEvents.js";
import UserIdentityManager from "./UserIdentityManager.js";
import { deckLicenseStatuses } from "../Enumerations/DeckLicenseStatuses.js";
import { dataFormats } from "../Enumerations/DataFormats.js";

/**
 * PaidDeckRegistry
 *
 * Single source of truth for "is this deck a paid one that the current
 * user has a license for?" The home page and DeckTile use this to drive
 * the buyer-watermark overlay; the encryption layer uses it to decide
 * whether to route reads through PaidDeckCryptoManager.
 *
 * Licenses are persisted to the user's namespace in Persistence so the
 * registry rehydrates instantly on cold start (including offline boots)
 * before any network sync has happened.
 */
class PaidDeckRegistry
{
    static #PERSISTENCE_PATH = "PaidDecks/Licenses.json";

    static #licensesByDeckId = new Map();
    static #lastSyncTimestamp = 0;
    static #initialized = false;
    static #initializationPromise = null;

    static
    {
        window.addEventListener(AuthenticationEvents.ON_USER_LOGGED_IN, async () =>
        {
            await PaidDeckRegistry.#loadFromPersistence();
        });

        window.addEventListener(AuthenticationEvents.ON_USER_LOGGED_OUT, () =>
        {
            PaidDeckRegistry.#licensesByDeckId = new Map();
            PaidDeckRegistry.#lastSyncTimestamp = 0;
            PaidDeckRegistry.#initialized = false;
        });
    }

    static async initialize()
    {
        if (PaidDeckRegistry.#initialized)
        {
            return;
        }

        if (PaidDeckRegistry.#initializationPromise)
        {
            await PaidDeckRegistry.#initializationPromise;
            return;
        }

        PaidDeckRegistry.#initializationPromise = PaidDeckRegistry.#loadFromPersistence();
        await PaidDeckRegistry.#initializationPromise;
    }

    static async #loadFromPersistence()
    {
        try
        {
            const stored = await Persistence.read(PaidDeckRegistry.#PERSISTENCE_PATH, dataFormats.JSON);

            if (stored && typeof stored === "object")
            {
                PaidDeckRegistry.#lastSyncTimestamp = stored.lastSyncTimestamp || 0;
                const entries = Array.isArray(stored.licenses) ? stored.licenses : [];

                PaidDeckRegistry.#licensesByDeckId = new Map(entries.map(entry => [entry.deckId, entry]));
            }
        }
        catch (readError)
        {
            console.warn("[PaidDeckRegistry] Failed to read licenses from persistence:", readError);
        }

        PaidDeckRegistry.#initialized = true;
    }

    static async #saveToPersistence()
    {
        if (UserIdentityManager.isAnonymous())
        {
            return;
        }

        try
        {
            await Persistence.write
            (
                PaidDeckRegistry.#PERSISTENCE_PATH,
                {
                    lastSyncTimestamp: PaidDeckRegistry.#lastSyncTimestamp,
                    licenses: Array.from(PaidDeckRegistry.#licensesByDeckId.values())
                },
                dataFormats.JSON
            );
        }
        catch (writeError)
        {
            console.warn("[PaidDeckRegistry] Failed to save licenses:", writeError);
        }
    }

    static isLicensed(deckId)
    {
        const license = PaidDeckRegistry.#licensesByDeckId.get(deckId);
        return license && license.status === deckLicenseStatuses.ACTIVE;
    }

    static getLicense(deckId)
    {
        return PaidDeckRegistry.#licensesByDeckId.get(deckId) || null;
    }

    static getAllLicenses()
    {
        return Array.from(PaidDeckRegistry.#licensesByDeckId.values());
    }

    static getLastSyncTimestamp()
    {
        return PaidDeckRegistry.#lastSyncTimestamp;
    }

    static async applyLicenseUpdates(licenseEntries, serverTimestamp)
    {
        if (!Array.isArray(licenseEntries))
        {
            return;
        }

        for (const license of licenseEntries)
        {
            if (!license?.deckId)
            {
                continue;
            }
            PaidDeckRegistry.#licensesByDeckId.set(license.deckId, license);
        }

        if (typeof serverTimestamp === "number")
        {
            PaidDeckRegistry.#lastSyncTimestamp = serverTimestamp;
        }

        await PaidDeckRegistry.#saveToPersistence();
    }

    static async clear()
    {
        PaidDeckRegistry.#licensesByDeckId = new Map();
        PaidDeckRegistry.#lastSyncTimestamp = 0;
        await PaidDeckRegistry.#saveToPersistence();
    }
}

export default PaidDeckRegistry;
