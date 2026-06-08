/**
 * EcdhTransport
 *
 * Client-side counterpart to the EcdhResponseEnvelope packetron plugin.
 * Generates an ephemeral P-256 ECDH key pair per request, exports the
 * public key in SPKI form for the server to ingest, and decrypts the
 * server's ECDH-AES-GCM envelope into the inner JSON.
 *
 * The ephemeral private key never leaves the WebCrypto Subtle context
 * (it's created with `extractable: false`) so even page-level JS can't
 * read it back as raw bytes — the only thing it ever does is feed into
 * `crypto.subtle.deriveBits` to compute the shared secret.
 */
class EcdhTransport
{
    static #CLIENT_PUBLIC_KEY_HEADER = "X-Client-Ephemeral-Public-Key";
    static #INFO_LABEL = "paid-deck-ecdh-envelope";
    static #SHARED_KEY_BITS = 256;
    static #IV_BYTES = 12;

    static async fetchProtected(url, fetchOptions)
    {
        const ephemeralKeyPair = await crypto.subtle.generateKey
        (
            { name: "ECDH", namedCurve: "P-256" },
            false,
            ["deriveBits"]
        );

        const clientPublicKeySpkiBytes = new Uint8Array(await crypto.subtle.exportKey("spki", ephemeralKeyPair.publicKey));
        const clientPublicKeyBase64 = EcdhTransport.#bytesToBase64(clientPublicKeySpkiBytes);

        const requestHeaders = new Headers((fetchOptions && fetchOptions.headers) || {});
        requestHeaders.set(EcdhTransport.#CLIENT_PUBLIC_KEY_HEADER, clientPublicKeyBase64);

        let fetchResponse;
        try
        {
            fetchResponse = await fetch(url,
            {
                ...(fetchOptions || {}),
                headers: requestHeaders
            });
        }
        catch (networkError)
        {
            return { ok: false, status: 0, error: { error: "NETWORK_ERROR", message: networkError.message } };
        }

        // Parse the body once as text so we can decide whether it's an
        // ECDH envelope (handler response after the plugin patched
        // sendJson) or a plaintext error (plugin's own pre-handler
        // validation failure, before the patch took effect). Both 200
        // and 4xx/5xx can carry an envelope — the plugin patches
        // sendJson before the handler runs, so every handler-side
        // response.sendJson(...) goes through the cipher regardless of
        // statusCode.
        const responseBodyText = await fetchResponse.text();
        let parsedBody = null;
        try { parsedBody = JSON.parse(responseBodyText); }
        catch (parseError) { parsedBody = null; }

        if (parsedBody && typeof parsedBody.serverEphemeralPublicKeyBase64 === "string"
            && typeof parsedBody.ivBase64 === "string"
            && typeof parsedBody.ciphertextBase64 === "string")
        {
            const decryptedInnerJson = await EcdhTransport.#decryptEnvelope(parsedBody, ephemeralKeyPair.privateKey);
            return {
                ok: fetchResponse.ok,
                status: fetchResponse.status,
                json: fetchResponse.ok ? decryptedInnerJson : null,
                error: fetchResponse.ok ? null : decryptedInnerJson
            };
        }

        return {
            ok: fetchResponse.ok,
            status: fetchResponse.status,
            json: fetchResponse.ok ? parsedBody : null,
            error: fetchResponse.ok ? null : parsedBody
        };
    }

    static async #decryptEnvelope(envelopeJson, clientPrivateKey)
    {
        const serverPublicKeySpkiBytes = EcdhTransport.#base64ToBytes(envelopeJson.serverEphemeralPublicKeyBase64);
        const serverPublicKey = await crypto.subtle.importKey
        (
            "spki",
            serverPublicKeySpkiBytes,
            { name: "ECDH", namedCurve: "P-256" },
            false,
            []
        );

        const sharedSecretBits = await crypto.subtle.deriveBits
        (
            { name: "ECDH", public: serverPublicKey },
            clientPrivateKey,
            EcdhTransport.#SHARED_KEY_BITS
        );

        const sharedKey = await EcdhTransport.#hkdfSha256ToAesGcmKey(sharedSecretBits);

        const initializationVector = EcdhTransport.#base64ToBytes(envelopeJson.ivBase64);
        const ciphertextBytes = EcdhTransport.#base64ToBytes(envelopeJson.ciphertextBase64);

        const plaintextBuffer = await crypto.subtle.decrypt
        (
            { name: "AES-GCM", iv: initializationVector },
            sharedKey,
            ciphertextBytes
        );

        return JSON.parse(new TextDecoder().decode(plaintextBuffer));
    }

    static async #hkdfSha256ToAesGcmKey(sharedSecretBuffer)
    {
        const baseKey = await crypto.subtle.importKey
        (
            "raw",
            sharedSecretBuffer,
            { name: "HKDF" },
            false,
            ["deriveKey"]
        );
        return await crypto.subtle.deriveKey
        (
            {
                name: "HKDF",
                hash: "SHA-256",
                salt: new Uint8Array(0),
                info: new TextEncoder().encode(EcdhTransport.#INFO_LABEL)
            },
            baseKey,
            { name: "AES-GCM", length: 256 },
            false,
            ["decrypt", "encrypt"]
        );
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
}

export default EcdhTransport;
