import Persistence from "../Persistence.js";
import { dataFormats } from "../../Enumerations/DataFormats.js";

/**
 * PaidDeckCache
 *
 * Encrypted-only IDB cache for paid-deck content. Every blob written
 * here is AES-GCM ciphertext under the deck's content key — without
 * the in-memory CryptoKey held by PaidDeckSession, the stored bytes
 * are inert. We never persist plaintext entities, never persist the
 * content key, and never persist the manifest in clear form.
 *
 * Each cached blob is stored as a `{ ivBase64, ciphertextBase64,
 * contentKeyVersion }` JSON envelope so a stale-version mismatch is
 * detectable (PaidDeckContentClient compares against the current
 * server-reported contentKeyVersion and triggers a purge when they
 * diverge).
 */
class PaidDeckCache
{
    static #cacheBasePath(deckId)
    {
        return `PaidDecks/Cache/${deckId}`;
    }

    static #manifestPath(deckId)
    {
        return `${PaidDeckCache.#cacheBasePath(deckId)}/manifest.bin`;
    }

    static #entityPath(deckId, entityId)
    {
        return `${PaidDeckCache.#cacheBasePath(deckId)}/entities/${entityId}.bin`;
    }

    static async cacheManifest(deckId, manifestEnvelope)
    {
        await Persistence.write(PaidDeckCache.#manifestPath(deckId), manifestEnvelope, dataFormats.JSON);
    }

    static async readCachedManifestEnvelope(deckId)
    {
        try
        {
            const cachedEnvelope = await Persistence.read(PaidDeckCache.#manifestPath(deckId), dataFormats.JSON);
            return cachedEnvelope || null;
        }
        catch (readError)
        {
            return null;
        }
    }

    static async cacheEntity(deckId, entityId, entityEnvelope)
    {
        await Persistence.write(PaidDeckCache.#entityPath(deckId, entityId), entityEnvelope, dataFormats.JSON);
    }

    static async readCachedEntityEnvelope(deckId, entityId)
    {
        try
        {
            const cachedEnvelope = await Persistence.read(PaidDeckCache.#entityPath(deckId, entityId), dataFormats.JSON);
            return cachedEnvelope || null;
        }
        catch (readError)
        {
            return null;
        }
    }

    static async invalidateEntity(deckId, entityId)
    {
        try
        {
            await Persistence.delete(PaidDeckCache.#entityPath(deckId, entityId));
        }
        catch (removeError)
        {
            // Cache invalidation is best-effort; a missing key isn't an error.
        }
    }

    static async purgeDeck(deckId)
    {
        try
        {
            const matchingPaths = await Persistence.listKeysWithPrefix(`${PaidDeckCache.#cacheBasePath(deckId)}/`);
            if (matchingPaths.length > 0)
            {
                await Persistence.deleteMany(matchingPaths);
            }
        }
        catch (purgeError)
        {
            // Best-effort. Any encrypted blobs left behind are inert
            // without the in-memory content key.
            console.warn(`[PaidDeckCache] purgeDeck(${deckId}) skipped:`, purgeError);
        }
    }
}

export default PaidDeckCache;
