const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const KeyManagementService = require("../../Globals/Classes/Security/KeyManagementService");
const PaidDeckAudienceResolver = require("../../Globals/Classes/PaidDeck/PaidDeckAudienceResolver");
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
 * An ORGANIZATION deck takes a different branch: it has no password, because
 * the institute provides it rather than selling it, and a password would be a
 * secret the member never chose and the institute could not reset. The content
 * key is instead returned for this session directly — still only inside the
 * ECDH envelope, still never persisted by the client, and still gated on an
 * active licence AND live membership re-checked here rather than inferred from
 * the licence. Everything else about the deck is unchanged: encrypted at rest,
 * encrypted on the sync wire, immutable on push, export-blocked, copy-guarded.
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

    const userId = session.getUserId();
    const license = await KeyManagementService.getLicense(userId, deckId);

    if (!KeyManagementService.isLicenseActive(license))
    {
        response.statusCode = httpStatus.FORBIDDEN;
        response.sendJson({ error: ErrorCodes.NO_ACTIVE_LICENSE });
        return;
    }

    // The audience is read from the DECK, never from the request: a client
    // claiming "this one needs no password" would otherwise skip the password
    // check on a marketplace deck it merely holds a licence for.
    const database = await DatabaseConnector.getDatabase();
    const paidDeckDocument = await database
        .collection(DatabaseConstants.PAID_DECKS_COLLECTION)
        .findOne({ id: deckId }, { projection: { _id: 0, id: 1, audienceOrganizationId: 1 } });

    if (PaidDeckAudienceResolver.isOrganizationDeck(paidDeckDocument))
    {
        await unlockOrganizationDeck(request, response, license, paidDeckDocument, deckId);
        return;
    }

    if (typeof passwordString !== "string" || passwordString.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_PASSWORD });
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

/**
 * The passwordless branch, for a deck an organization provides.
 *
 * Membership is re-checked against the stored roster rather than trusted from
 * the licence, so a member removed from the institute stops being able to
 * unlock immediately — before the lapsed-licence sweeper has run and before
 * their next sync tears the content down. Losing access should not have to wait
 * for a scheduler.
 *
 * The content key is unwrapped from the server KEK and returned raw INSIDE the
 * ECDH envelope. That is the same confidentiality the password branch relies on
 * for its own wrapped key; the difference is only that no user secret is mixed
 * in, which is honest — for a deck the institute supplies there is no user
 * secret to mix in, and inventing one would be security theatre that the member
 * would then have to be prompted for.
 */
async function unlockOrganizationDeck(request, response, license, paidDeckDocument, deckId)
{
    const user = await PaidDeckAudienceResolver.resolveAudienceUser(request);
    const audienceOrganizationId = PaidDeckAudienceResolver.readAudienceOrganizationId(paidDeckDocument);
    const membership = await PaidDeckAudienceResolver.requireActiveMembership(audienceOrganizationId, user);

    if (!membership.member)
    {
        response.statusCode = httpStatus.FORBIDDEN;
        response.sendJson({ error: ErrorCodes.ACCESS_NOT_ALLOWED });
        return;
    }

    if (license.getServerWrappedContentKeyBase64().length === 0)
    {
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: ErrorCodes.LICENSE_MISSING_SERVER_WRAP });
        return;
    }

    let contentKeyBytes = null;
    try
    {
        contentKeyBytes = KeyManagementService.unwrapPaidDeckContentKeyWithServerKek
        (
            license.getServerWrappedIvBase64(),
            license.getServerWrappedContentKeyBase64(),
            deckId
        );

        response.statusCode = httpStatus.OK;
        response.sendJson
        ({
            deckId: deckId,
            organizationUnlock: true,
            organizationId: audienceOrganizationId,
            contentKeyBase64: contentKeyBytes.toString("base64"),
            contentKeyVersion: license.getContentKeyVersion()
        });
    }
    finally
    {
        // Zeroed whether or not the response was written, so the key does not
        // linger in a buffer this process still holds.
        if (contentKeyBytes)
        {
            contentKeyBytes.fill(0);
        }
    }
}

module.exports = { unlockPaidDeckSession };
