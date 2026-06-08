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
    }

    static lockAll()
    {
        PaidDeckSession.#unlockedContentKeysByDeckId.clear();
        PaidDeckSession.#contentKeyVersionByDeckId.clear();
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
