import Persistence from "./Persistence.js";
import AuthenticationEvents from "../Events/AuthenticationEvents.js";
import UserIdentityManager from "./UserIdentityManager.js";
import LicenseConstants from "../Constants/LicenseConstants.js";
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

    // Secret key material that must never be persisted on the client. The
    // server already strips these from every license payload (LicenseClientView),
    // but the registry scrubs defensively too — so a future server regression,
    // or licenses cached on disk before this hardening shipped, can never leave
    // password salts / wrapped content keys sitting in IndexedDB for an offline
    // attacker. The study unlock path re-fetches the wrapped key over ECDH and
    // never reads these from a persisted license. Names match the DeckLicense
    // model members exactly.
    static #SECRET_LICENSE_FIELDS =
    [
        "wrappedKeyBlob",
        "passwordHash",
        "passwordSalt",
        "passwordWrappedContentKeyBase64",
        "passwordWrappedIvBase64",
        "serverWrappedContentKeyBase64",
        "serverWrappedIvBase64"
    ];

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

                // Scrub any secret fields cached on disk before this hardening
                // shipped. If anything was scrubbed, rewrite the file so the
                // secrets don't linger after the next reload.
                let scrubbedAnySecret = false;
                const cleanedEntries = entries.map(entry =>
                {
                    if (PaidDeckRegistry.#licenseHasSecretField(entry))
                    {
                        scrubbedAnySecret = true;
                    }
                    return PaidDeckRegistry.#stripSecretFields(entry);
                });

                PaidDeckRegistry.#licensesByDeckId = new Map(cleanedEntries.map(entry => [entry.deckId, entry]));

                PaidDeckRegistry.#initialized = true;

                if (scrubbedAnySecret)
                {
                    await PaidDeckRegistry.#saveToPersistence();
                }
                return;
            }
        }
        catch (readError)
        {
            console.warn("[PaidDeckRegistry] Failed to read licenses from persistence:", readError);
        }

        PaidDeckRegistry.#initialized = true;
    }

    /**
     * Returns a shallow copy of a license with every secret field removed.
     * Null-safe — non-objects pass through unchanged.
     */
    static #stripSecretFields(license)
    {
        if (!license || typeof license !== "object")
        {
            return license;
        }

        const safeLicense = { ...license };
        for (const secretField of PaidDeckRegistry.#SECRET_LICENSE_FIELDS)
        {
            delete safeLicense[secretField];
        }
        return safeLicense;
    }

    static #licenseHasSecretField(license)
    {
        if (!license || typeof license !== "object")
        {
            return false;
        }
        return PaidDeckRegistry.#SECRET_LICENSE_FIELDS.some(secretField => secretField in license);
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

    /**
     * Returns the buyer's copies (instances) of a paid deck — the per-copy
     * registry the manage-copies UI enumerates, synced inside the license's
     * additionalData. Three cases:
     *   - instances array present → return it (may be [] if every copy was
     *     deleted while the license is kept);
     *   - no instances array but actively licensed → one implicit "Copy 1"
     *     (a license issued before multi-copy support; its rootDeckId is
     *     server-derived and unknown here, so the caller reconciles against
     *     the deck tree);
     *   - not actively licensed → [].
     */
    static getInstances(deckId)
    {
        if (!PaidDeckRegistry.isLicensed(deckId))
        {
            return [];
        }
        const license = PaidDeckRegistry.getLicense(deckId);
        const instances = license && license.additionalData ? license.additionalData.instances : null;
        if (Array.isArray(instances))
        {
            return instances;
        }
        return [{ instanceId: LicenseConstants.PAID_DECK_FIRST_INSTANCE_ID, rootDeckId: null, label: "Copy 1" }];
    }

    static getInstanceCount(deckId)
    {
        return PaidDeckRegistry.getInstances(deckId).length;
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
            PaidDeckRegistry.#licensesByDeckId.set(license.deckId, PaidDeckRegistry.#stripSecretFields(license));
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
