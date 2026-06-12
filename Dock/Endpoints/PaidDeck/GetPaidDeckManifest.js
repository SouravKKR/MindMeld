const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const KeyManagementService = require("../../Globals/Classes/Security/KeyManagementService");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

/**
 * GET /PaidDecks/Manifest?deckId=...
 *
 * Wrapped by EcdhResponseEnvelope. The returned manifest is also
 * AES-GCM-encrypted with the deck's content key (server unwraps via
 * the server-wrapped variant, never holds the buyer's password) so a
 * decryption of the outer ECDH envelope still doesn't yield the
 * plaintext manifest — only the holder of the content key (the buyer,
 * client-side, after UnlockSession) can read it.
 *
 * Returns
 *   {
 *     deckId,
 *     contentKeyVersion,
 *     manifestIvBase64,
 *     manifestCiphertextBase64
 *   }
 */
async function getPaidDeckManifest(request, response)
{
    if (!KeyManagementService.isReady())
    {
        response.statusCode = httpStatus.SERVICE_UNAVAILABLE;
        response.sendJson({ error: "KEY_MANAGEMENT_NOT_READY" });
        return;
    }

    const session = request.session;
    if (!session)
    {
        response.sendStatusCode(401);
        return;
    }

    const queryParameters = await request.getQueryParams();
    const deckId = queryParameters.deckId;

    if (typeof deckId !== "string" || deckId.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "MISSING_DECK_ID" });
        return;
    }

    const userId = session.getUserId();
    const license = await KeyManagementService.getLicense(userId, deckId);

    if (!KeyManagementService.isLicenseActive(license))
    {
        response.statusCode = httpStatus.FORBIDDEN;
        response.sendJson({ error: "NO_ACTIVE_LICENSE" });
        return;
    }

    const database = await DatabaseConnector.getDatabase();
    const userContentDocument = await database
        .collection(DatabaseConstants.PAID_DECK_USER_CONTENT_COLLECTION)
        .findOne({ userId: userId, deckId: deckId });

    if (!userContentDocument || !userContentDocument.manifest)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: "USER_CONTENT_NOT_SEEDED" });
        return;
    }

    const contentKeyBytes = KeyManagementService.unwrapPaidDeckContentKeyWithServerKek
    (
        license.getServerWrappedIvBase64(),
        license.getServerWrappedContentKeyBase64(),
        deckId
    );

    const encryptedManifest = KeyManagementService.encryptPaidDeckEntityPlaintext(userContentDocument.manifest, contentKeyBytes);
    contentKeyBytes.fill(0);

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        deckId: deckId,
        contentKeyVersion: license.getContentKeyVersion(),
        manifestIvBase64: encryptedManifest.ivBase64,
        manifestCiphertextBase64: encryptedManifest.ciphertextBase64
    });
}

module.exports = { getPaidDeckManifest };
