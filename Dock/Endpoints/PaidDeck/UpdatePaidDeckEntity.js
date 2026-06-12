const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const KeyManagementService = require("../../Globals/Classes/Security/KeyManagementService");
const { entityTypes } = require("../../Globals/Enumerations/EntityTypes");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

/**
 * POST /PaidDecks/Entities/Update
 *
 * Wrapped by EcdhResponseEnvelope. The buyer's edit (plaintext entity
 * JSON) arrives over HTTPS in the request body; the response goes back
 * through the ECDH envelope carrying the freshly re-encrypted entity
 * so the client can replace its IDB-cached blob without an extra fetch.
 *
 * Body : { deckId, entityType, entityId, plaintext }
 * Reply: {
 *   deckId,
 *   contentKeyVersion,
 *   entity: { entityId, entityType, ivBase64, ciphertextBase64 }
 * }
 */
async function updatePaidDeckEntity(request, response)
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

    const body = await request.getBody();
    const deckId = body?.deckId;
    const entityType = body?.entityType;
    const entityId = body?.entityId;
    const plaintextValue = body?.plaintext;

    if (typeof deckId !== "string" || deckId.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "MISSING_DECK_ID" });
        return;
    }

    const allowedEntityTypeValues = new Set([entityTypes.CARD, entityTypes.STUDY_MATERIAL, entityTypes.MOCK_TEST, entityTypes.DECK]);
    if (!allowedEntityTypeValues.has(entityType))
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "UNSUPPORTED_ENTITY_TYPE" });
        return;
    }

    if (typeof entityId !== "string" || entityId.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "MISSING_ENTITY_ID" });
        return;
    }

    if (!plaintextValue || typeof plaintextValue !== "object")
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "MISSING_PLAINTEXT" });
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
    const userContentEntitiesCollection = database.collection(DatabaseConstants.PAID_DECK_USER_CONTENT_ENTITIES_COLLECTION);

    // Look up the entity in the per-entity store, falling back to the legacy
    // embedded contentByEntityId map for buyers seeded before the migration.
    let existingEntityRecord = await userContentEntitiesCollection.findOne({ userId: userId, deckId: deckId, entityId: entityId });

    if (!existingEntityRecord)
    {
        const legacyDocument = await database
            .collection(DatabaseConstants.PAID_DECK_USER_CONTENT_COLLECTION)
            .findOne({ userId: userId, deckId: deckId });

        if (!legacyDocument)
        {
            response.statusCode = httpStatus.NOT_FOUND;
            response.sendJson({ error: "USER_CONTENT_NOT_SEEDED" });
            return;
        }

        existingEntityRecord = legacyDocument.contentByEntityId?.[entityId] || null;
    }

    if (!existingEntityRecord)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: "ENTITY_NOT_IN_DECK" });
        return;
    }

    if (existingEntityRecord.entityType !== entityType)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "ENTITY_TYPE_MISMATCH" });
        return;
    }

    // Upsert the single per-entity doc (also migrates a legacy buyer's entity
    // into the per-entity store on first edit).
    await userContentEntitiesCollection.updateOne
    (
        { userId: userId, deckId: deckId, entityId: entityId },
        {
            $set:
            {
                userId: userId,
                deckId: deckId,
                entityId: entityId,
                entityType: entityType,
                parentDeckId: existingEntityRecord.parentDeckId ?? null,
                plaintext: plaintextValue,
                updatedAt: new Date()
            }
        },
        { upsert: true }
    );

    const contentKeyBytes = KeyManagementService.unwrapPaidDeckContentKeyWithServerKek
    (
        license.getServerWrappedIvBase64(),
        license.getServerWrappedContentKeyBase64(),
        deckId
    );
    const encryptedEntity = KeyManagementService.encryptPaidDeckEntityPlaintext(plaintextValue, contentKeyBytes);
    contentKeyBytes.fill(0);

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        deckId: deckId,
        contentKeyVersion: license.getContentKeyVersion(),
        entity:
        {
            entityId: entityId,
            entityType: entityType,
            ivBase64: encryptedEntity.ivBase64,
            ciphertextBase64: encryptedEntity.ciphertextBase64
        }
    });
}

module.exports = { updatePaidDeckEntity };
