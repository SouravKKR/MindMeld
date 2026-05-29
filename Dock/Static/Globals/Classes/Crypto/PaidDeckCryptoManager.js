import DeviceKekManager from "./DeviceKekManager.js";

/**
 * PaidDeckCryptoManager
 *
 * Per-deck cipher routines. The server hands the client a per-user
 * "wrapped key blob" inside the DeckLicense; this module unwraps it
 * with the DeviceKek and keeps the unwrapped per-deck CryptoKey in a
 * module-scoped Map. The Map is never exposed to the window object so
 * console scripts cannot enumerate it.
 *
 * All decryption paths return plaintext Strings/Uint8Arrays that the
 * caller is expected to drop reference to as soon as the consumer
 * renders them. There is no JS API to retrieve the underlying key
 * material — only call `decryptPayload` / `encryptPayload`.
 *
 * Caveats (best-effort, not a guarantee):
 *   - WebCrypto's non-extractable flag prevents `exportKey('raw')` but
 *     not in-page misuse.
 *   - A page that runs attacker-controlled JS (e.g. a malicious
 *     extension) can call our public functions; the same is true of
 *     any browser app.
 *   - The wrapped key blob from the server is bound to the user's
 *     keyVersion. When the server rotates keys, the old wrapped blob
 *     stops working — old in-memory CryptoKeys are replaced.
 */

const keyCache = new Map();

class PaidDeckCryptoManager
{
    static async #importContentKeyFromBlob(wrappedKeyBlobJsonString)
    {
        const wrappedBlob = JSON.parse(wrappedKeyBlobJsonString);
        const initializationVector = PaidDeckCryptoManager.#base64ToBytes(wrappedBlob.ivBase64);
        const ciphertext = PaidDeckCryptoManager.#base64ToBytes(wrappedBlob.ciphertextBase64);

        const kek = await DeviceKekManager.getOrCreateKek();

        // The wrapped payload is the raw content-key bytes encrypted
        // under the device KEK. Decrypt to the raw bytes, then import
        // them as a non-extractable CryptoKey so they cannot be read
        // back from JS land.
        const contentKeyBytes = await crypto.subtle.decrypt
        (
            { name: "AES-GCM", iv: initializationVector },
            kek,
            ciphertext
        );

        const contentKey = await crypto.subtle.importKey
        (
            "raw",
            contentKeyBytes,
            { name: "AES-GCM" },
            false,
            ["encrypt", "decrypt"]
        );

        const contentKeyBytesView = new Uint8Array(contentKeyBytes);
        contentKeyBytesView.fill(0);

        return contentKey;
    }

    static async applyLicenseUpdate(license)
    {
        if (!license || !license.deckId || !license.wrappedKeyBlob)
        {
            return;
        }

        try
        {
            const contentKey = await PaidDeckCryptoManager.#importContentKeyFromBlob(license.wrappedKeyBlob);
            keyCache.set(`${license.deckId}:${license.keyVersion}`, contentKey);
        }
        catch (unwrapError)
        {
            console.warn(`[PaidDeckCryptoManager] Failed to unwrap key for deck ${license.deckId}:`, unwrapError);
        }
    }

    static hasKey(deckId, keyVersion)
    {
        return keyCache.has(`${deckId}:${keyVersion}`);
    }

    static evictKey(deckId, keyVersion)
    {
        keyCache.delete(`${deckId}:${keyVersion}`);
    }

    static evictAllForDeck(deckId)
    {
        for (const cacheKey of Array.from(keyCache.keys()))
        {
            if (cacheKey.startsWith(`${deckId}:`))
            {
                keyCache.delete(cacheKey);
            }
        }
    }

    static async decryptPayload(deckId, keyVersion, ivBase64, ciphertextBase64)
    {
        const cacheKey = `${deckId}:${keyVersion}`;
        const contentKey = keyCache.get(cacheKey);

        if (!contentKey)
        {
            throw new Error(`No key for deck ${deckId} keyVersion ${keyVersion} — call applyLicenseUpdate first`);
        }

        const initializationVector = PaidDeckCryptoManager.#base64ToBytes(ivBase64);
        const ciphertext = PaidDeckCryptoManager.#base64ToBytes(ciphertextBase64);

        const plaintextBuffer = await crypto.subtle.decrypt
        (
            { name: "AES-GCM", iv: initializationVector },
            contentKey,
            ciphertext
        );

        return new TextDecoder().decode(plaintextBuffer);
    }

    static async encryptPayload(deckId, keyVersion, plaintextString)
    {
        const cacheKey = `${deckId}:${keyVersion}`;
        const contentKey = keyCache.get(cacheKey);

        if (!contentKey)
        {
            throw new Error(`No key for deck ${deckId} keyVersion ${keyVersion}`);
        }

        const initializationVector = crypto.getRandomValues(new Uint8Array(12));
        const plaintextBytes = new TextEncoder().encode(plaintextString);

        const ciphertextBuffer = await crypto.subtle.encrypt
        (
            { name: "AES-GCM", iv: initializationVector },
            contentKey,
            plaintextBytes
        );

        plaintextBytes.fill(0);

        return {
            ivBase64: PaidDeckCryptoManager.#bytesToBase64(initializationVector),
            ciphertextBase64: PaidDeckCryptoManager.#bytesToBase64(new Uint8Array(ciphertextBuffer))
        };
    }

    static #base64ToBytes(base64String)
    {
        const binaryString = atob(base64String);
        const bytes = new Uint8Array(binaryString.length);
        for (let byteIndex = 0; byteIndex < binaryString.length; byteIndex++)
        {
            bytes[byteIndex] = binaryString.charCodeAt(byteIndex);
        }
        return bytes;
    }

    static #bytesToBase64(bytes)
    {
        let binaryString = "";
        for (const byte of bytes)
        {
            binaryString += String.fromCharCode(byte);
        }
        return btoa(binaryString);
    }
}

export default PaidDeckCryptoManager;
