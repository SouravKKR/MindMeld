/**
 * PaidDeckSession
 *
 * Holds the in-memory non-extractable AES-GCM CryptoKey for each paid
 * deck the user has unlocked this browser session. Keys live in a
 * private module-scope Map keyed by deckId — they're never written to
 * IDB, never serialised, never extractable as raw bytes. Lost on page
 * reload, which is the entire point: every fresh session re-prompts
 * the user for the paid-deck password.
 *
 * `unlock()` POSTs to /PaidDecks/UnlockSession through EcdhTransport,
 * derives the PBKDF2 KEK locally, unwraps the content key, and stashes
 * it. `decryptEntityEnvelope()` is the read path; `encryptForUpload()`
 * is the edit path (used by PaidDeckContentClient before posting to
 * /PaidDecks/Entities/Update).
 */
import ContentOverlayStore from "../Content/ContentOverlayStore.js";
import EcdhTransport from "./EcdhTransport.js";
import AuthenticationEvents from "../../Events/AuthenticationEvents.js";

class PaidDeckSession
{
    static #UNLOCK_ENDPOINT = "/PaidDecks/UnlockSession";

    static #unlockedContentKeysByDeckId = new Map();
    static #contentKeyVersionByDeckId = new Map();

    static
    {
        window.addEventListener(AuthenticationEvents.ON_USER_LOGGED_OUT, () =>
        {
            PaidDeckSession.lockAll();
        });
    }

    static async unlock(deckId, plaintextPassword)
    {
        const transportResult = await EcdhTransport.fetchProtected(PaidDeckSession.#UNLOCK_ENDPOINT,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ deckId: deckId, password: plaintextPassword })
        });

        if (!transportResult.ok)
        {
            const errorCode = transportResult?.error?.error || `HTTP_${transportResult.status}`;
            return { success: false, error: errorCode };
        }

        const innerJson = transportResult.json;
        const passwordSaltBase64 = innerJson.passwordSaltBase64;
        const pbkdf2Iterations = Number(innerJson.pbkdf2Iterations) || 100000;
        const passwordWrappedContentKeyBase64 = innerJson.passwordWrappedContentKeyBase64;
        const passwordWrappedIvBase64 = innerJson.passwordWrappedIvBase64;
        const contentKeyVersion = Number(innerJson.contentKeyVersion) || 0;

        const passwordKekCryptoKey = await PaidDeckSession.#derivePasswordKekFromPbkdf2
        (
            plaintextPassword,
            passwordSaltBase64,
            pbkdf2Iterations
        );

        const wrappedContentKeyBytes = PaidDeckSession.#base64ToBytes(passwordWrappedContentKeyBase64);
        const wrappedContentKeyIv = PaidDeckSession.#base64ToBytes(passwordWrappedIvBase64);

        let contentKeyRawBytes;
        try
        {
            contentKeyRawBytes = await crypto.subtle.decrypt
            (
                { name: "AES-GCM", iv: wrappedContentKeyIv },
                passwordKekCryptoKey,
                wrappedContentKeyBytes
            );
        }
        catch (unwrapError)
        {
            return { success: false, error: "UNWRAP_FAILED" };
        }

        const contentCryptoKey = await crypto.subtle.importKey
        (
            "raw",
            contentKeyRawBytes,
            { name: "AES-GCM" },
            false,
            ["encrypt", "decrypt"]
        );

        new Uint8Array(contentKeyRawBytes).fill(0);

        PaidDeckSession.#unlockedContentKeysByDeckId.set(deckId, contentCryptoKey);
        PaidDeckSession.#contentKeyVersionByDeckId.set(deckId, contentKeyVersion);
        return { success: true, contentKeyVersion: contentKeyVersion };
    }

    /**
     * Unlocks a deck an organization provides, with no password.
     *
     * These decks have no password because there is nobody to have chosen one:
     * the institute supplies the deck, so a passphrase would be a secret the
     * member never set and the institute could not reset. The server returns the
     * content key for this session instead — still only inside the ECDH
     * envelope, still held here as a non-extractable key that dies with the page,
     * and still refused unless the member holds an active licence AND is still
     * on that organization's roster, which the server re-checks on every call.
     *
     * Returns { success: false, error: "PASSWORD_REQUIRED" } when the deck turns
     * out to be a marketplace deck after all, so the caller falls through to the
     * password prompt rather than silently failing.
     *
     * @param {string} deckId
     * @returns {Promise<{ success: boolean, contentKeyVersion?: number, error?: string }>}
     */
    static async unlockOrganizationDeck(deckId)
    {
        const transportResult = await EcdhTransport.fetchProtected(PaidDeckSession.#UNLOCK_ENDPOINT,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ deckId: deckId })
        });

        if (!transportResult.ok)
        {
            const errorCode = transportResult?.error?.error || `HTTP_${transportResult.status}`;
            return { success: false, error: errorCode };
        }

        const innerJson = transportResult.json;

        // The server decides which branch a deck is on, from the deck's own
        // audience. A response without the organization marker means this is a
        // marketplace deck and a password is genuinely needed.
        if (innerJson.organizationUnlock !== true || typeof innerJson.contentKeyBase64 !== "string")
        {
            return { success: false, error: "PASSWORD_REQUIRED" };
        }

        const contentKeyRawBytes = PaidDeckSession.#base64ToBytes(innerJson.contentKeyBase64);

        const contentCryptoKey = await crypto.subtle.importKey
        (
            "raw",
            contentKeyRawBytes,
            { name: "AES-GCM" },
            // Non-extractable, exactly as on the password path: the key can
            // decrypt in this page and can never be read back out of it.
            false,
            ["encrypt", "decrypt"]
        );

        contentKeyRawBytes.fill(0);

        const contentKeyVersion = Number(innerJson.contentKeyVersion) || 0;
        PaidDeckSession.#unlockedContentKeysByDeckId.set(deckId, contentCryptoKey);
        PaidDeckSession.#contentKeyVersionByDeckId.set(deckId, contentKeyVersion);

        return { success: true, contentKeyVersion: contentKeyVersion };
    }

    static isUnlocked(deckId)
    {
        return PaidDeckSession.#unlockedContentKeysByDeckId.has(deckId);
    }

    static getCachedContentKeyVersion(deckId)
    {
        return PaidDeckSession.#contentKeyVersionByDeckId.get(deckId) || 0;
    }

    static lock(deckId)
    {
        PaidDeckSession.#unlockedContentKeysByDeckId.delete(deckId);
        PaidDeckSession.#contentKeyVersionByDeckId.delete(deckId);
        // Decrypted overlay text is only ever held in memory, and it is only
        // held legitimately while the key is. Dropping the key without dropping
        // it would leave a locked deck's edits readable.
        ContentOverlayStore.clearDecryptedCache();
    }

    static lockAll()
    {
        PaidDeckSession.#unlockedContentKeysByDeckId.clear();
        PaidDeckSession.#contentKeyVersionByDeckId.clear();
        ContentOverlayStore.clearDecryptedCache();
    }

    static async decryptEntityEnvelope(deckId, envelope)
    {
        const contentCryptoKey = PaidDeckSession.#unlockedContentKeysByDeckId.get(deckId);
        if (!contentCryptoKey)
        {
            throw new Error(`Paid deck ${deckId} is locked — call unlock() first.`);
        }

        const initializationVector = PaidDeckSession.#base64ToBytes(envelope.ivBase64);
        const ciphertextBytes = PaidDeckSession.#base64ToBytes(envelope.ciphertextBase64);

        const plaintextBuffer = await crypto.subtle.decrypt
        (
            { name: "AES-GCM", iv: initializationVector },
            contentCryptoKey,
            ciphertextBytes
        );

        return JSON.parse(new TextDecoder().decode(plaintextBuffer));
    }

    static async encryptForUpload(deckId, plaintextJson)
    {
        const contentCryptoKey = PaidDeckSession.#unlockedContentKeysByDeckId.get(deckId);
        if (!contentCryptoKey)
        {
            throw new Error(`Paid deck ${deckId} is locked — call unlock() first.`);
        }

        const initializationVector = crypto.getRandomValues(new Uint8Array(12));
        const plaintextBuffer = new TextEncoder().encode(JSON.stringify(plaintextJson));

        const ciphertextBuffer = await crypto.subtle.encrypt
        (
            { name: "AES-GCM", iv: initializationVector },
            contentCryptoKey,
            plaintextBuffer
        );

        plaintextBuffer.fill(0);

        return {
            ivBase64: PaidDeckSession.#bytesToBase64(initializationVector),
            ciphertextBase64: PaidDeckSession.#bytesToBase64(new Uint8Array(ciphertextBuffer))
        };
    }

    /**
     * Per-FIELD string encryption (distinct from encryptForUpload, which
     * JSON-encodes a whole entity). A content field — Card.question,
     * StudyMaterial HTML, etc. — is a raw string; this encrypts the UTF-8
     * bytes directly so the ciphertext is byte-compatible with the server's
     * field cipher (12-byte IV, ciphertext||16-byte GCM tag, base64). Returns
     * the bare { ivBase64, ciphertextBase64 } pair; the envelope marker is
     * added by PaidDeckFieldCipher.
     */
    static async encryptString(deckId, plaintextString)
    {
        const contentCryptoKey = PaidDeckSession.#unlockedContentKeysByDeckId.get(deckId);
        if (!contentCryptoKey)
        {
            throw new Error(`Paid deck ${deckId} is locked — call unlock() first.`);
        }

        const initializationVector = crypto.getRandomValues(new Uint8Array(12));
        const plaintextBuffer = new TextEncoder().encode(String(plaintextString ?? ""));

        const ciphertextBuffer = await crypto.subtle.encrypt
        (
            { name: "AES-GCM", iv: initializationVector },
            contentCryptoKey,
            plaintextBuffer
        );

        plaintextBuffer.fill(0);

        return {
            ivBase64: PaidDeckSession.#bytesToBase64(initializationVector),
            ciphertextBase64: PaidDeckSession.#bytesToBase64(new Uint8Array(ciphertextBuffer))
        };
    }

    /**
     * Per-FIELD string decryption — the read counterpart to encryptString.
     * Returns the decrypted UTF-8 string (NOT JSON.parse'd). Throws if the
     * deck is locked so callers fall back to a locked placeholder.
     */
    static async decryptString(deckId, envelope)
    {
        const contentCryptoKey = PaidDeckSession.#unlockedContentKeysByDeckId.get(deckId);
        if (!contentCryptoKey)
        {
            throw new Error(`Paid deck ${deckId} is locked — call unlock() first.`);
        }

        const initializationVector = PaidDeckSession.#base64ToBytes(envelope.ivBase64);
        const ciphertextBytes = PaidDeckSession.#base64ToBytes(envelope.ciphertextBase64);

        const plaintextBuffer = await crypto.subtle.decrypt
        (
            { name: "AES-GCM", iv: initializationVector },
            contentCryptoKey,
            ciphertextBytes
        );

        return new TextDecoder().decode(plaintextBuffer);
    }

    static async #derivePasswordKekFromPbkdf2(passwordString, passwordSaltBase64, pbkdf2Iterations)
    {
        const passwordKeyMaterial = await crypto.subtle.importKey
        (
            "raw",
            new TextEncoder().encode(passwordString),
            { name: "PBKDF2" },
            false,
            ["deriveKey"]
        );
        return await crypto.subtle.deriveKey
        (
            {
                name: "PBKDF2",
                salt: PaidDeckSession.#base64ToBytes(passwordSaltBase64),
                iterations: pbkdf2Iterations,
                hash: "SHA-256"
            },
            passwordKeyMaterial,
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"]
        );
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

export default PaidDeckSession;
