const OrganizationAuthorityResolver = require("../../../Globals/Classes/Organization/OrganizationAuthorityResolver");
const OrganizationDeckQueryEngine = require("../../../Globals/Classes/Organization/OrganizationDeckQueryEngine");
const OrganizationMemberQueryEngine = require("../../../Globals/Classes/Organization/OrganizationMemberQueryEngine");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");


/**
 * GET /Organization/PaidDecks/List?organizationId=...
 *
 * The organization's own decks — drafts included, because this is the list the
 * people preparing them work from — each with how many members currently hold a
 * copy, so a withdrawal can be made with its cost in view rather than blind.
 *
 * Readable by anyone with standing in the organization; publishing itself needs
 * PUBLISH_DECKS. Seeing what your institute provides is not the same act as
 * changing it.
 */
async function listOrganizationDecks(request, response)
{
    const queryParams = await request.getQueryParams();
    const organizationId = typeof queryParams?.organizationId === "string" ? queryParams.organizationId : "";

    const authority = await OrganizationAuthorityResolver.resolve(request.user, organizationId);
    if (!authority.allowed)
    {
        response.statusCode = OrganizationAuthorityResolver.statusForDenial(authority);
        response.sendJson({ success: false, error: authority.reason });
        return;
    }

    const paidDecks = await OrganizationDeckQueryEngine.listDecksForOrganization(organizationId);

    const decks = [];
    for (const paidDeck of paidDecks)
    {
        const licenseDocuments = await OrganizationDeckQueryEngine.listActiveLicenseDocuments(paidDeck.getId());

        decks.push
        ({
            id: paidDeck.getId(),
            title: paidDeck.getTitle(),
            description: paidDeck.getDescription(),
            category: paidDeck.getCategory(),
            tags: paidDeck.getTags(),
            audienceTags: paidDeck.getAudienceTags(),
            isPublished: paidDeck.getIsPublished(),
            publishedAt: paidDeck.getPublishedAt(),
            contentSummary: paidDeck.getContentSummary(),
            holderCount: licenseDocuments.length
        });
    }

    const vocabulary = await OrganizationMemberQueryEngine.listProfileVocabulary(organizationId);
    const publishedCount = decks.filter(deck => deck.isPublished === true).length;

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        decks: decks,
        availableTags: vocabulary.tags,
        publishedCount: publishedCount,
        maxPublishedDecks: authority.organization.getMaxPublishedDecks()
    });
}

module.exports = { listOrganizationDecks };
