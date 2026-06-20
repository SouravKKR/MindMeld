const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const KeyManagementService = require("../../Globals/Classes/Security/KeyManagementService");
const DeckLicense = require("../../Globals/Model/DeckLicense");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

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
        response.statusCode = httpStatus.SERVICE_UNAVAILABLE;
        response.sendJson({ error: ErrorCodes.KEY_MANAGEMENT_NOT_READY });
        return;
    }

    const session = request.session;
    if (!session)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    const body = await request.getBody();
    const deckId = body?.deckId;
    const passwordString = body?.password;

    if (typeof deckId !== "string" || deckId.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_DECK_ID });
        return;
    }

    if (typeof passwordString !== "string" || passwordString.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_PASSWORD });
        return;
    }

    const userId = session.getUserId();
    const license = await KeyManagementService.getLicense(userId, deckId);

    if (!KeyManagementService.isLicenseActive(license))
    {
        response.statusCode = httpStatus.FORBIDDEN;
        response.sendJson({ error: ErrorCodes.NO_ACTIVE_LICENSE });
        return;
    }

    const passwordSaltBase64 = license.getPasswordSalt();
    const passwordHashBase64 = license.getPasswordHash();

    if (typeof passwordSaltBase64 !== "string" || passwordSaltBase64.length === 0)
    {
        response.statusCode = httpStatus.CONFLICT;
        response.sendJson({ error: ErrorCodes.PASSWORD_NOT_SET });
        return;
    }

    const submittedHashBase64 = KeyManagementService.computePaidDeckPasswordHash(passwordString, passwordSaltBase64);
    if (!KeyManagementService.safeEqualPaidDeckPasswordHash(submittedHashBase64, passwordHashBase64))
    {
        response.statusCode = httpStatus.UNAUTHORIZED;
        response.sendJson({ error: ErrorCodes.WRONG_PASSWORD });
        return;
    }

    // The lazy-fill path below depends on a valid server-wrap. A
    // license that's missing it is in a malformed state (most likely
    // a partial purchase flow) — refuse rather than throw inside the
    // unwrap. The buyer can't recover without admin intervention.
    if (license.getServerWrappedContentKeyBase64().length === 0)
    {
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: ErrorCodes.LICENSE_MISSING_SERVER_WRAP });
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

    response.statusCode = httpStatus.OK;
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
