const OrganizationAuthorityResolver = require("../../../Globals/Classes/Organization/OrganizationAuthorityResolver");
const OrganizationDeckQueryEngine = require("../../../Globals/Classes/Organization/OrganizationDeckQueryEngine");
const PaidDeckPublishService = require("../../../Globals/Classes/PaidDeck/PaidDeckPublishService");
const { organizationDelegatePowers } = require("../../../Globals/Enumerations/OrganizationDelegatePowers");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");


/**
 * POST /Organization/PaidDecks/Upload
 *
 * Body: { organizationId, metadata, deckPayload, audienceTags }
 *
 * Publishes a deck to this organization's own members. Shares
 * PaidDeckPublishService with the catalogue upload, so the encryption, key
 * versioning and review gate are identical — the only things this route decides
 * for itself are the two it is not allowed to let the caller decide: the
 * audience is forced to the caller's organization, and the deck is free.
 *
 * Being free is enforced by the service rather than checked here, which means
 * there is no request an organization admin could craft that puts a price on a
 * deck, creates an order, or reaches a payment provider at all.
 */
async function uploadOrganizationDeck(request, response)
{
    const body = await request.getBody();
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";

    const authority = await OrganizationAuthorityResolver.requirePower(request.user, organizationId, organizationDelegatePowers.PUBLISH_DECKS);
    if (!authority.allowed)
    {
        response.statusCode = OrganizationAuthorityResolver.statusForDenial(authority);
        response.sendJson({ success: false, error: authority.reason });
        return;
    }

    // The publish cap bounds what an institute puts in front of its members.
    // Checked only when this upload would ADD to the published set: re-uploading
    // content over a deck that is already published must not be refused because
    // the organization is at its limit — it is not growing the set.
    if (body?.metadata?.isPublished === true)
    {
        const maximumPublishedDecks = Number(authority.organization.getMaxPublishedDecks()) || 0;
        const existingDeck = body?.metadata?.id
            ? await OrganizationDeckQueryEngine.getOrganizationDeck(organizationId, body.metadata.id)
            : null;
        const bWouldAddToPublishedSet = !existingDeck || existingDeck.getIsPublished() !== true;

        if (bWouldAddToPublishedSet)
        {
            const publishedCount = await OrganizationDeckQueryEngine.countPublishedDecks(organizationId);
            if (maximumPublishedDecks <= 0 || publishedCount >= maximumPublishedDecks)
            {
                response.statusCode = httpStatus.CONFLICT;
                response.sendJson
                ({
                    success: false,
                    error: ErrorCodes.PUBLISHED_DECK_LIMIT_REACHED,
                    publishedCount: publishedCount,
                    maximumPublishedDecks: maximumPublishedDecks
                });
                return;
            }
        }
    }

    const publishResult = await PaidDeckPublishService.publish
    ({
        metadata: body?.metadata,
        deckPayload: body?.deckPayload,
        publisherUserId: request.user?.getId() || "",
        audienceOrganizationId: organizationId,
        audienceTags: body?.audienceTags,
        allowPricing: false
    });

    if (!publishResult.success)
    {
        response.statusCode = resolveFailureStatusCode(publishResult.reason);
        response.sendJson
        ({
            success: false,
            error: publishResult.error,
            code: publishResult.code,
            detail: publishResult.detail,
            blockingFlags: publishResult.blockingFlags,
            entityId: publishResult.entityId
        });
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

module.exports = { uploadOrganizationDeck };
