const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const LicenseConstants = require("../../Globals/Constants/LicenseConstants");
const KeyManagementService = require("../../Globals/Classes/Security/KeyManagementService");

/**
 * POST /PaidDecks/Entities/Fetch
 *
 * Wrapped by EcdhResponseEnvelope. Each requested entity is also
 * AES-GCM-encrypted with the deck's content key inside the envelope.
 *
 * Body : { deckId, entityIds: [...] }
 * Reply: {
 *   deckId,
 *   contentKeyVersion,
 *   entities: [ { entityId, entityType, ivBase64, ciphertextBase64 } ]
 * }
 *
 * Capped at LicenseConstants.PAID_DECK_ENTITY_FETCH_BATCH_LIMIT
 * entities per call to keep the buyer lazy and bounded.
 */
async function fetchPaidDeckEntities(request, response)
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
    const requestedEntityIds = Array.isArray(body?.entityIds) ? body.entityIds : [];

    if (typeof deckId !== "string" || deckId.length === 0)
    {
        response.statusCode = 400;
        response.sendJson({ error: "MISSING_DECK_ID" });
        return;
    }

    if (requestedEntityIds.length === 0)
    {
        response.statusCode = 400;
        response.sendJson({ error: "MISSING_ENTITY_IDS" });
        return;
    }

    if (requestedEntityIds.length > LicenseConstants.PAID_DECK_ENTITY_FETCH_BATCH_LIMIT)
    {
        response.statusCode = 400;
        response.sendJson({ error: "BATCH_LIMIT_EXCEEDED" });
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

    const database = await DatabaseConnector.getDatabase();
    const userContentDocument = await database
        .collection(DatabaseConstants.PAID_DECK_USER_CONTENT_COLLECTION)
        .findOne({ userId: userId, deckId: deckId });

    if (!userContentDocument || !userContentDocument.contentByEntityId)
    {
        response.statusCode = 404;
        response.sendJson({ error: "USER_CONTENT_NOT_SEEDED" });
        return;
    }

    const contentKeyBytes = KeyManagementService.unwrapPaidDeckContentKeyWithServerKek
    (
        license.getServerWrappedIvBase64(),
        license.getServerWrappedContentKeyBase64(),
        deckId
    );

    const encryptedEntities = [];
    try
    {
        for (const requestedEntityId of requestedEntityIds)
        {
            const entityRecord = userContentDocument.contentByEntityId[requestedEntityId];
            if (!entityRecord)
            {
                continue;
            }

            const encryptedEntity = KeyManagementService.encryptPaidDeckEntityPlaintext(entityRecord.plaintext, contentKeyBytes);
            encryptedEntities.push
            ({
                entityId: requestedEntityId,
                entityType: entityRecord.entityType,
                ivBase64: encryptedEntity.ivBase64,
                ciphertextBase64: encryptedEntity.ciphertextBase64
            });
        }
    }
    finally
    {
        contentKeyBytes.fill(0);
    }

    response.statusCode = 200;
    response.sendJson
    ({
        deckId: deckId,
        contentKeyVersion: license.getContentKeyVersion(),
        entities: encryptedEntities
    });
}

module.exports = { fetchPaidDeckEntities };
