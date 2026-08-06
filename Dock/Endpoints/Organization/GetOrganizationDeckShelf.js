const OrganizationDeckQueryEngine = require("../../Globals/Classes/Organization/OrganizationDeckQueryEngine");
const OrganizationMemberQueryEngine = require("../../Globals/Classes/Organization/OrganizationMemberQueryEngine");
const PaidDeckAudienceResolver = require("../../Globals/Classes/PaidDeck/PaidDeckAudienceResolver");
const KeyManagementService = require("../../Globals/Classes/Security/KeyManagementService");
const { getUser } = require("../Helpers/GetUser");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");


/**
 * GET /Organization/Decks/Shelf?organizationId=...&includeAll=true|false
 *
 * What this organization is offering its members, and which of it this member
 * already holds.
 *
 * By default the list is narrowed to the decks whose audience tags match this
 * member's — that is the useful default, since a first-year student opening a
 * shelf of four hundred decks aimed at six cohorts is not being helped. But
 * `includeAll=true` returns everything the organization published, and any of
 * it can be added: the targeting is a filter over a shelf everyone can reach,
 * not a fence around parts of it. An institute that needs material kept from
 * some of its people publishes it to a different audience.
 */
async function getOrganizationDeckShelf(request, response)
{
    const queryParams = await request.getQueryParams();
    const organizationId = typeof queryParams?.organizationId === "string" ? queryParams.organizationId : "";
    const bIncludeAll = String(queryParams?.includeAll || "") === "true";

    const user = await getUser(request);
    if (!user)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    // Membership is re-checked against the stored roster on every request. The
    // shelf is the one surface where an organization's material is listed by
    // name, so an ex-member reaching it would learn what an institute provides
    // after they have left it.
    const membership = await PaidDeckAudienceResolver.requireActiveMembership(organizationId, user);
    if (!membership.member)
    {
        response.statusCode = httpStatus.FORBIDDEN;
        response.sendJson({ success: false, error: ErrorCodes.ACCESS_NOT_ALLOWED });
        return;
    }

    const memberRecord = await OrganizationMemberQueryEngine.findMemberByUserIdOrEmail
    (
        organizationId,
        user.getId(),
        user.getAdditionalData()?.email || ""
    );
    const memberTags = memberRecord ? memberRecord.getTags() : [];

    const paidDecks = await OrganizationDeckQueryEngine.listShelfForMember(organizationId, memberTags, bIncludeAll);

    const decks = [];
    for (const paidDeck of paidDecks)
    {
        const license = await KeyManagementService.getLicense(user.getId(), paidDeck.getId());

        decks.push
        ({
            id: paidDeck.getId(),
            title: paidDeck.getTitle(),
            description: paidDeck.getDescription(),
            category: paidDeck.getCategory(),
            tags: paidDeck.getTags(),
            audienceTags: paidDeck.getAudienceTags(),
            thumbnailUrl: paidDeck.getThumbnailUrl(),
            contentSummary: paidDeck.getContentSummary(),
            publishedAt: paidDeck.getPublishedAt(),
            // What the member can DO with this row, answered by the server so
            // the button state never has to be guessed from a licence the client
            // may not have pulled yet.
            held: KeyManagementService.isLicenseActive(license)
        });
    }

    // Reported so the shelf can say "showing the 6 decks for your year" and
    // offer the rest, rather than silently hiding them behind a toggle nobody
    // knows to look for.
    const totalPublishedCount = (await OrganizationDeckQueryEngine.listShelfForMember(organizationId, memberTags, true)).length;

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        organizationId: organizationId,
        organizationName: membership.organization.getName(),
        memberTags: memberTags,
        decks: decks,
        showingAll: bIncludeAll,
        totalPublishedCount: totalPublishedCount
    });
}

module.exports = { getOrganizationDeckShelf };
