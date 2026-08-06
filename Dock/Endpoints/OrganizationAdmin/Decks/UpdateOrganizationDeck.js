const DatabaseConnector = require("../../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../../Globals/Constants/DatabaseConstants");
const OrganizationAuthorityResolver = require("../../../Globals/Classes/Organization/OrganizationAuthorityResolver");
const OrganizationDeckQueryEngine = require("../../../Globals/Classes/Organization/OrganizationDeckQueryEngine");
const PaidDeckPublishService = require("../../../Globals/Classes/PaidDeck/PaidDeckPublishService");
const { organizationDelegatePowers } = require("../../../Globals/Enumerations/OrganizationDelegatePowers");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");


/**
 * POST /Organization/PaidDecks/Update
 *
 * Body: { organizationId, deckId, title?, description?, category?, tags?, audienceTags?, isPublished? }
 *
 * Metadata only. Content changes go through Upload, which re-encrypts and bumps
 * the content version so every holder is told an update is waiting; editing the
 * listing text must not pretend to be that.
 *
 * The fields a caller may touch are enumerated rather than merged from the body,
 * so no request can reach audienceOrganizationId, basePriceMinor or the key
 * material simply by naming them.
 */
async function updateOrganizationDeck(request, response)
{
    const body = await request.getBody();
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";
    const deckId = typeof body?.deckId === "string" ? body.deckId : "";

    const authority = await OrganizationAuthorityResolver.requirePower(request.user, organizationId, organizationDelegatePowers.PUBLISH_DECKS);
    if (!authority.allowed)
    {
        response.statusCode = OrganizationAuthorityResolver.statusForDenial(authority);
        response.sendJson({ success: false, error: authority.reason });
        return;
    }

    // Loaded through the organization-scoped lookup, so another organization's
    // deck id resolves to nothing rather than to a deck this caller could edit.
    const paidDeck = await OrganizationDeckQueryEngine.getOrganizationDeck(organizationId, deckId);
    if (!paidDeck)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ success: false, error: ErrorCodes.PAID_DECK_NOT_FOUND });
        return;
    }

    const updates = { updatedAt: new Date() };

    if (typeof body.title === "string" && body.title.trim().length > 0)
    {
        updates.title = body.title.trim().slice(0, 256);
    }
    if (typeof body.description === "string")
    {
        updates.description = body.description.slice(0, 4096);
    }
    if (typeof body.category === "string")
    {
        updates.category = body.category.slice(0, 128);
    }
    if (Array.isArray(body.tags))
    {
        updates.tags = body.tags.map(tag => String(tag).slice(0, 64)).filter(tag => tag.length > 0);
    }
    if (Array.isArray(body.audienceTags))
    {
        updates.audienceTags = PaidDeckPublishService.normaliseAudienceTags(body.audienceTags);
    }

    // Publishing through this route is a re-publish of something already
    // prepared, so it is bounded by the same cap as an upload.
    if (typeof body.isPublished === "boolean")
    {
        if (body.isPublished === true && paidDeck.getIsPublished() !== true)
        {
            const maximumPublishedDecks = Number(authority.organization.getMaxPublishedDecks()) || 0;
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

        updates.isPublished = body.isPublished;
    }

    const database = await DatabaseConnector.getDatabase();
    await database
        .collection(DatabaseConstants.PAID_DECKS_COLLECTION)
        .updateOne({ id: deckId, audienceOrganizationId: organizationId }, { $set: updates });

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, deckId: deckId });
}

module.exports = { updateOrganizationDeck };
