const PaidDeckPublishService = require("../../Globals/Classes/PaidDeck/PaidDeckPublishService");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

/**
 * POST /Admin/PaidDecks/Upload
 *
 * The super-admin catalogue upload. The work itself lives in
 * PaidDeckPublishService, shared with the organization publish route: the two
 * differ only in audience and price, and every hard part — per-entity
 * encryption, key versioning, the content-version bump, the review gate, the
 * provenance stamp — must behave identically or a member's deck would fail to
 * decrypt in ways the catalogue never sees.
 *
 * This endpoint is the only caller allowed to set a price at all.
 */
async function uploadPaidDeck(request, response)
{
    const body = await request.getBody();

    const publishResult = await PaidDeckPublishService.publish
    ({
        metadata: body?.metadata,
        deckPayload: body?.deckPayload,
        publisherUserId: request.user?.getId() || "",
        audienceOrganizationId: "",
        audienceTags: [],
        allowPricing: true
    });

    if (!publishResult.success)
    {
        response.statusCode = resolveFailureStatusCode(publishResult.reason);

        if (publishResult.reason === "ENTITY_TOO_LARGE")
        {
            // The upload dialog surfaces `error` directly, so the human-readable
            // message goes there and `code` stays machine-readable.
            response.sendJson({ error: publishResult.error, code: publishResult.code, entityId: publishResult.entityId });
            return;
        }

        if (publishResult.reason === "PUBLISH_GATE")
        {
            response.sendJson({ error: publishResult.error, detail: publishResult.detail, blockingFlags: publishResult.blockingFlags });
            return;
        }

        response.sendJson({ error: publishResult.error });
        return;
    }

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        deckId: publishResult.deckId,
        keyVersion: publishResult.keyVersion,
        contentVersion: publishResult.contentVersion,
        trademarkWarnings: publishResult.trademarkWarnings
    });
}

function resolveFailureStatusCode(reason)
{
    if (reason === "KEY_MANAGEMENT")
    {
        return httpStatus.SERVICE_UNAVAILABLE;
    }
    if (reason === "ENTITY_TOO_LARGE")
    {
        return httpStatus.PAYLOAD_TOO_LARGE;
    }
    if (reason === "PUBLISH_GATE")
    {
        return httpStatus.CONFLICT;
    }
    if (reason === "AUDIENCE_MISMATCH")
    {
        return httpStatus.FORBIDDEN;
    }
    return httpStatus.BAD_REQUEST;
}

module.exports = { uploadPaidDeck };
