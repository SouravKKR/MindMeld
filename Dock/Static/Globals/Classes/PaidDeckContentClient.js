import EcdhTransport from "./Crypto/EcdhTransport.js";
import PaidDeckCache from "./Crypto/PaidDeckCache.js";
import PaidDeckSession from "./Crypto/PaidDeckSession.js";
import PaidDeckPasswordPrompt from "./PaidDeckPasswordPrompt.js";
import LicenseConstants from "../Constants/LicenseConstants.js";

/**
 * PaidDeckContentClient
 *
 * Single entry point the rest of the app uses to read or write paid
 * deck content. Handles password-prompt + unlock, lazy entity fetch
 * with a small batching window, IDB caching of encrypted blobs, and
 * the version-skew retry path that triggers after a server-side
 * content-key rotation.
 *
 * Never returns or exposes raw key material — only decrypted plaintext
 * entity JSON and the manifest. The CryptoKey itself stays inside
 * PaidDeckSession's private map.
 */
class PaidDeckContentClient
{
    static #MANIFEST_ENDPOINT = "/PaidDecks/Manifest";
    static #ENTITIES_FETCH_ENDPOINT = "/PaidDecks/Entities/Fetch";
    static #ENTITIES_UPDATE_ENDPOINT = "/PaidDecks/Entities/Update";

    static #BATCH_DEBOUNCE_MILLISECONDS = 50;

    static #pendingFetchByDeckId = new Map();

    static async openDeck(deckId)
    {
        // Try at most twice — once with the existing (or freshly
        // prompted) session, once more if a content-key rotation between
        // unlock and manifest fetch invalidated the cached key.
        for (let attemptIndex = 0; attemptIndex < 2; attemptIndex++)
        {
            if (!PaidDeckSession.isUnlocked(deckId))
            {
                const passwordPromptResult = await PaidDeckPasswordPrompt.show(deckId);
                if (!passwordPromptResult.confirmed)
                {
                    return { success: false, reason: "PASSWORD_CANCELLED" };
                }
            }

            const manifestResult = await PaidDeckContentClient.#loadManifest(deckId);
            if (manifestResult.manifest)
            {
                return { success: true, manifest: manifestResult.manifest };
            }
            if (!manifestResult.skewDetected)
            {
                return { success: false, reason: "MANIFEST_FETCH_FAILED" };
            }
            // Skew detected — session was locked + cache purged.
            // Loop re-prompts the password and tries again.
        }
        return { success: false, reason: "MANIFEST_FETCH_FAILED" };
    }

    static async getEntity(deckId, entityId)
    {
        if (!PaidDeckSession.isUnlocked(deckId))
        {
            throw new Error("Paid deck is locked");
        }

        const cachedEnvelope = await PaidDeckCache.readCachedEntityEnvelope(deckId, entityId);
        const currentSessionVersion = PaidDeckSession.getCachedContentKeyVersion(deckId);
        if (cachedEnvelope && Number(cachedEnvelope.contentKeyVersion) === currentSessionVersion)
        {
            return await PaidDeckSession.decryptEntityEnvelope(deckId, cachedEnvelope);
        }

        const batchedResults = await PaidDeckContentClient.#fetchEntityBatch(deckId, [entityId]);
        return batchedResults[entityId] || null;
    }

    static async prefetchEntities(deckId, entityIds)
    {
        if (!PaidDeckSession.isUnlocked(deckId) || entityIds.length === 0)
        {
            return;
        }
        const uncachedIds = [];
        for (const entityIdToCheck of entityIds)
        {
            const cachedEnvelope = await PaidDeckCache.readCachedEntityEnvelope(deckId, entityIdToCheck);
            const currentSessionVersion = PaidDeckSession.getCachedContentKeyVersion(deckId);
            if (!cachedEnvelope || Number(cachedEnvelope.contentKeyVersion) !== currentSessionVersion)
            {
                uncachedIds.push(entityIdToCheck);
            }
        }
        if (uncachedIds.length > 0)
        {
            await PaidDeckContentClient.#fetchEntityBatch(deckId, uncachedIds);
        }
    }

    static async updateEntity(deckId, entityType, entityId, plaintextJson)
    {
        if (!PaidDeckSession.isUnlocked(deckId))
        {
            return { success: false, reason: "DECK_LOCKED" };
        }

        const transportResult = await EcdhTransport.fetchProtected(PaidDeckContentClient.#ENTITIES_UPDATE_ENDPOINT,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify
            ({
                deckId: deckId,
                entityType: entityType,
                entityId: entityId,
                plaintext: plaintextJson
            })
        });

        if (!transportResult.ok)
        {
            return { success: false, reason: transportResult?.error?.error || `HTTP_${transportResult.status}` };
        }

        const innerJson = transportResult.json;
        const contentKeyVersion = Number(innerJson.contentKeyVersion) || 0;

        await PaidDeckContentClient.#handlePossibleVersionSkew(deckId, contentKeyVersion);

        if (innerJson.entity)
        {
            await PaidDeckCache.cacheEntity(deckId, innerJson.entity.entityId,
            {
                ivBase64: innerJson.entity.ivBase64,
                ciphertextBase64: innerJson.entity.ciphertextBase64,
                contentKeyVersion: contentKeyVersion
            });
        }
        return { success: true };
    }

    static async #loadManifest(deckId)
    {
        const transportResult = await EcdhTransport.fetchProtected(`${PaidDeckContentClient.#MANIFEST_ENDPOINT}?deckId=${encodeURIComponent(deckId)}`,
        {
            method: "GET"
        });

        if (!transportResult.ok)
        {
            return { manifest: null, skewDetected: false };
        }

        const innerJson = transportResult.json;
        const contentKeyVersion = Number(innerJson.contentKeyVersion) || 0;

        const skewDetected = await PaidDeckContentClient.#handlePossibleVersionSkew(deckId, contentKeyVersion);
        if (skewDetected)
        {
            return { manifest: null, skewDetected: true };
        }

        const manifestEnvelope =
        {
            ivBase64: innerJson.manifestIvBase64,
            ciphertextBase64: innerJson.manifestCiphertextBase64,
            contentKeyVersion: contentKeyVersion
        };
        await PaidDeckCache.cacheManifest(deckId, manifestEnvelope);

        try
        {
            const decryptedManifest = await PaidDeckSession.decryptEntityEnvelope(deckId, manifestEnvelope);
            return { manifest: decryptedManifest, skewDetected: false };
        }
        catch (decryptError)
        {
            // A decrypt failure here almost always means a quiet
            // rotation we didn't catch with the version compare —
            // treat as a skew so openDeck re-prompts.
            PaidDeckSession.lock(deckId);
            await PaidDeckCache.purgeDeck(deckId);
            return { manifest: null, skewDetected: true };
        }
    }

    static async #fetchEntityBatch(deckId, requestedEntityIds)
    {
        const batchLimit = LicenseConstants.PAID_DECK_ENTITY_FETCH_BATCH_LIMIT;
        const decryptedEntitiesByEntityId = {};

        for (let batchStartIndex = 0; batchStartIndex < requestedEntityIds.length; batchStartIndex += batchLimit)
        {
            const batchSlice = requestedEntityIds.slice(batchStartIndex, batchStartIndex + batchLimit);
            const transportResult = await EcdhTransport.fetchProtected(PaidDeckContentClient.#ENTITIES_FETCH_ENDPOINT,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ deckId: deckId, entityIds: batchSlice })
            });

            if (!transportResult.ok)
            {
                continue;
            }

            const innerJson = transportResult.json;
            const contentKeyVersion = Number(innerJson.contentKeyVersion) || 0;
            const skewDetected = await PaidDeckContentClient.#handlePossibleVersionSkew(deckId, contentKeyVersion);
            if (skewDetected)
            {
                // Mid-flight rotation. Caller (getEntity / prefetch) gets
                // an empty result and is expected to recover via openDeck
                // on next access.
                return decryptedEntitiesByEntityId;
            }

            const encryptedEntities = Array.isArray(innerJson.entities) ? innerJson.entities : [];
            for (const encryptedEntity of encryptedEntities)
            {
                const envelope =
                {
                    ivBase64: encryptedEntity.ivBase64,
                    ciphertextBase64: encryptedEntity.ciphertextBase64,
                    contentKeyVersion: contentKeyVersion
                };
                await PaidDeckCache.cacheEntity(deckId, encryptedEntity.entityId, envelope);
                try
                {
                    decryptedEntitiesByEntityId[encryptedEntity.entityId] = await PaidDeckSession.decryptEntityEnvelope(deckId, envelope);
                }
                catch (decryptError)
                {
                    PaidDeckSession.lock(deckId);
                    await PaidDeckCache.purgeDeck(deckId);
                    return decryptedEntitiesByEntityId;
                }
            }
        }

        return decryptedEntitiesByEntityId;
    }

    /**
     * If the server reports a contentKeyVersion that's newer than the
     * one we have an unlocked CryptoKey for, the server has rotated
     * mid-session. The cached CryptoKey can no longer decrypt anything
     * new, so we purge the entity cache, lock the session, and signal
     * the caller (openDeck loops + re-prompts the password).
     *
     * @returns {Promise<boolean>} true when a skew was detected and the
     *   caller should treat the current response as unusable.
     */
    static async #handlePossibleVersionSkew(deckId, serverContentKeyVersion)
    {
        if (!PaidDeckSession.isUnlocked(deckId))
        {
            return false;
        }
        const sessionVersion = PaidDeckSession.getCachedContentKeyVersion(deckId);
        if (serverContentKeyVersion <= sessionVersion)
        {
            return false;
        }
        PaidDeckSession.lock(deckId);
        await PaidDeckCache.purgeDeck(deckId);
        return true;
    }
}

export default PaidDeckContentClient;
