const crypto = require("crypto");
const { PacketronPlugin, PacketronRequest, PacketronResponse } = require("@gamiumgamers/packetron");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

/**
 * EcdhResponseEnvelope
 *
 * Packetron plugin that wraps the response body of any sensitive
 * paid-deck endpoint in an ephemeral-ECDH-derived AES-256-GCM envelope
 * on top of HTTPS. Even if the HTTPS layer is decrypted (corporate
 * proxy / debug build / extension), the response body stays opaque
 * because the ephemeral private keys never leave the negotiating peer.
 *
 * Protocol:
 *   Request : X-Client-Ephemeral-Public-Key: <base64 SPKI P-256>
 *   Response: { serverEphemeralPublicKeyBase64, ivBase64, ciphertextBase64 }
 *
 * The plugin patches response.sendJson so the handler keeps writing
 * plaintext JSON; the patched sendJson intercepts the value, performs
 * the wrap, and forwards the envelope as the actual response body.
 *
 * Handlers that need this protection register it in their plugins
 * array (after EnsureLogin) — e.g.
 *   server.handle({
 *       routePath: "/PaidDecks/UnlockSession",
 *       handler: unlockPaidDeckSession,
 *       plugins: [ensureLogin, ecdhResponseEnvelope]
 *   });
 */
class EcdhResponseEnvelope
{
    static CLIENT_PUBLIC_KEY_HEADER = "x-client-ephemeral-public-key";
    static SERVER_PUBLIC_KEY_HEADER = "x-server-ephemeral-public-key";

    static #INFO_LABEL = Buffer.from("paid-deck-ecdh-envelope", "utf8");
    static #IV_BYTES = 12;
    static #SHARED_KEY_BYTES = 32;
    static #CURVE_NAME = "prime256v1";

    static async wrap(request, response)
    {
        const clientPublicKeyBase64 = request.headers?.[EcdhResponseEnvelope.CLIENT_PUBLIC_KEY_HEADER];

        if (typeof clientPublicKeyBase64 !== "string" || clientPublicKeyBase64.length === 0)
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ error: ErrorCodes.MISSING_CLIENT_EPHEMERAL_PUBLIC_KEY });
            return true;
        }

        let clientPublicKey;
        try
        {
            const clientPublicKeyDer = Buffer.from(clientPublicKeyBase64, "base64");
            clientPublicKey = crypto.createPublicKey
            ({
                key: clientPublicKeyDer,
                format: "der",
                type: "spki"
            });
        }
        catch (parseError)
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ error: ErrorCodes.MALFORMED_CLIENT_EPHEMERAL_PUBLIC_KEY });
            return true;
        }

        const serverEcdh = crypto.createECDH(EcdhResponseEnvelope.#CURVE_NAME);
        const serverEphemeralPublicKeyRaw = serverEcdh.generateKeys();

        const clientRawPublicKeyBytes = EcdhResponseEnvelope.#extractRawPublicKeyBytes(clientPublicKey);
        const sharedSecretBuffer = serverEcdh.computeSecret(clientRawPublicKeyBytes);

        const derivedKey = Buffer.from
        (
            crypto.hkdfSync("sha256", sharedSecretBuffer, Buffer.alloc(0), EcdhResponseEnvelope.#INFO_LABEL, EcdhResponseEnvelope.#SHARED_KEY_BYTES)
        );
        sharedSecretBuffer.fill(0);

        const serverEphemeralPublicKeyBase64 = EcdhResponseEnvelope.#wrapRawPublicKeyAsSpkiBase64(serverEphemeralPublicKeyRaw);

        if (typeof response.setHeader === "function")
        {
            response.setHeader(EcdhResponseEnvelope.SERVER_PUBLIC_KEY_HEADER, serverEphemeralPublicKeyBase64);
        }

        const originalSendJson = response.sendJson.bind(response);

        response.sendJson = (innerJsonValue) =>
        {
            const initializationVector = crypto.randomBytes(EcdhResponseEnvelope.#IV_BYTES);
            const cipher = crypto.createCipheriv("aes-256-gcm", derivedKey, initializationVector);
            const plaintextBuffer = Buffer.from(JSON.stringify(innerJsonValue), "utf8");
            const ciphertextBuffer = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);
            const authenticationTag = cipher.getAuthTag();
            const combinedCiphertext = Buffer.concat([ciphertextBuffer, authenticationTag]);

            plaintextBuffer.fill(0);
            derivedKey.fill(0);

            originalSendJson
            ({
                serverEphemeralPublicKeyBase64: serverEphemeralPublicKeyBase64,
                ivBase64: initializationVector.toString("base64"),
                ciphertextBase64: combinedCiphertext.toString("base64")
            });
        };

        return false;
    }

    /**
     * Node's createECDH expects the peer's public key as raw curve
     * bytes (uncompressed 0x04 || X || Y), but the wire format we use
     * is SPKI (so it's WebCrypto-compatible on the client). This
     * extracts the raw bytes from a parsed SPKI public key.
     */
    static #extractRawPublicKeyBytes(publicKey)
    {
        const jwk = publicKey.export({ format: "jwk" });
        const xBytes = Buffer.from(jwk.x, "base64url");
        const yBytes = Buffer.from(jwk.y, "base64url");
        return Buffer.concat([Buffer.from([0x04]), xBytes, yBytes]);
    }

    /**
     * Inverse of #extractRawPublicKeyBytes: takes raw uncompressed
     * curve bytes from `serverEcdh.generateKeys()` and re-encodes them
     * as an SPKI-formatted base64 string so the client (using
     * WebCrypto's `importKey('spki', ...)`) can ingest it directly.
     */
    static #wrapRawPublicKeyAsSpkiBase64(rawPublicKeyBytes)
    {
        const xBytes = rawPublicKeyBytes.subarray(1, 33);
        const yBytes = rawPublicKeyBytes.subarray(33, 65);
        const publicKey = crypto.createPublicKey
        ({
            key:
            {
                kty: "EC",
                crv: "P-256",
                x: xBytes.toString("base64url"),
                y: yBytes.toString("base64url")
            },
            format: "jwk"
        });
        const spkiDer = publicKey.export({ format: "der", type: "spki" });
        return spkiDer.toString("base64");
    }
}

const ecdhResponseEnvelope = new PacketronPlugin
({
    /**
     * @param {PacketronRequest} request
     * @param {PacketronResponse} response
     * @returns {Promise<boolean>} true if the request was short-circuited
     */
    handler: async (request, response) =>
    {
        return await EcdhResponseEnvelope.wrap(request, response);
    }
});

module.exports = { ecdhResponseEnvelope, EcdhResponseEnvelope };
