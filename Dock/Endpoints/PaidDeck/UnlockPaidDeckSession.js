const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const KeyManagementService = require("../../Globals/Classes/Security/KeyManagementService");
const DeckLicense = require("../../Globals/Model/DeckLicense");

/**
 * POST /PaidDecks/UnlockSession
 *
 * Wrapped by EcdhResponseEnvelope — the response body (which carries
 * the password-wrapped content key) goes out through the ECDH AES-GCM
 * envelope on top of HTTPS.
 *
 * Body: { deckId, password }
 *
 * Steps:
 *   1. Look up the user's active license for this deck.
 *   2. PBKDF2-verify the password against license.passwordHash.
 *   3. If license.passwordWrappedContentKey is empty (a recent server
 *      rotation cleared it), lazily re-fill it using the just-received
 *      password and the server-wrapped content key.
 *   4. Return { passwordWrappedContentKeyBase64, passwordWrappedIvBase64,
 *      passwordSaltBase64, contentKeyVersion }. The client derives the
 *      same PBKDF2 KEK locally and unwraps to a non-extractable
 *      CryptoKey held only for the browser session.
 */
async function unlockPaidDeckSession(request, response)
{
    if (!KeyManagementService.isReady())
    {
        response.statusCode = 503;
        response.sendJson({ error: "KEY_MANAGEMENT_NOT_READY" });
        return;
    }

    const session = request.session;
    if (!session)
    {
        response.sendStatusCode(401);
        return;
    }

    const body = await request.getBody();
    const deckId = body?.deckId;
    const passwordString = body?.password;

    if (typeof deckId !== "string" || deckId.length === 0)
    {
        response.statusCode = 400;
        response.sendJson({ error: "MISSING_DECK_ID" });
        return;
    }

    if (typeof passwordString !== "string" || passwordString.length === 0)
    {
        response.statusCode = 400;
        response.sendJson({ error: "MISSING_PASSWORD" });
        return;
    }

    const userId = session.getUserId();
    const license = await KeyManagementService.getLicense(userId, deckId);

    if (!KeyManagementService.isLicenseActive(license))
    {
        response.statusCode = 403;
        response.sendJson({ error: "NO_ACTIVE_LICENSE" });
        return;
    }

    const passwordSaltBase64 = license.getPasswordSalt();
    const passwordHashBase64 = license.getPasswordHash();

    if (typeof passwordSaltBase64 !== "string" || passwordSaltBase64.length === 0)
    {
        response.statusCode = 409;
        response.sendJson({ error: "PASSWORD_NOT_SET" });
        return;
    }

    const submittedHashBase64 = KeyManagementService.computePaidDeckPasswordHash(passwordString, passwordSaltBase64);
    if (submittedHashBase64 !== passwordHashBase64)
    {
        response.statusCode = 401;
        response.sendJson({ error: "WRONG_PASSWORD" });
        return;
    }

    // The lazy-fill path below depends on a valid server-wrap. A
    // license that's missing it is in a malformed state (most likely
    // a partial purchase flow) — refuse rather than throw inside the
    // unwrap. The buyer can't recover without admin intervention.
    if (license.getServerWrappedContentKeyBase64().length === 0)
    {
        response.statusCode = 500;
        response.sendJson({ error: "LICENSE_MISSING_SERVER_WRAP" });
        return;
    }

    let needsPersist = false;
    if (license.getPasswordWrappedContentKeyBase64().length === 0)
    {
        // Lazy re-wrap path after a server-side rotation cleared the
        // password-wrap. We have the password in hand right now —
        // derive the KEK, unwrap from the server-wrap, re-wrap with the
        // password KEK, and persist.
        const passwordKekBuffer = KeyManagementService.derivePaidDeckPasswordKek(passwordString, passwordSaltBase64);
        try
        {
            const contentKeyBytes = KeyManagementService.unwrapPaidDeckContentKeyWithServerKek
            (
                license.getServerWrappedIvBase64(),
                license.getServerWrappedContentKeyBase64(),
                deckId
            );
            const passwordWrap = KeyManagementService.wrapPaidDeckContentKeyWithPasswordKek(contentKeyBytes, passwordKekBuffer);
            contentKeyBytes.fill(0);
            license.setPasswordWrappedContentKeyBase64(passwordWrap.ciphertextBase64);
            license.setPasswordWrappedIvBase64(passwordWrap.ivBase64);
            needsPersist = true;
        }
        finally
        {
            passwordKekBuffer.fill(0);
        }
    }

    if (needsPersist)
    {
        await KeyManagementService.persistLicense(license);
    }

    response.statusCode = 200;
    response.sendJson
    ({
        deckId: deckId,
        passwordWrappedContentKeyBase64: license.getPasswordWrappedContentKeyBase64(),
        passwordWrappedIvBase64: license.getPasswordWrappedIvBase64(),
        passwordSaltBase64: passwordSaltBase64,
        contentKeyVersion: license.getContentKeyVersion(),
        pbkdf2Iterations: require("../../Globals/Constants/LicenseConstants").PAID_DECK_PASSWORD_PBKDF2_ITERATIONS
    });
}

module.exports = { unlockPaidDeckSession };
