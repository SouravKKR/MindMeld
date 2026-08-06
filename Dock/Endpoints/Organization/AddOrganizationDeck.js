const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const OrganizationDeckQueryEngine = require("../../Globals/Classes/Organization/OrganizationDeckQueryEngine");
const PaidDeckAudienceResolver = require("../../Globals/Classes/PaidDeck/PaidDeckAudienceResolver");
const OrganizationScopeResolver = require("../../Globals/Classes/Organization/OrganizationScopeResolver");
const KeyManagementService = require("../../Globals/Classes/Security/KeyManagementService");
const LicenseClientView = require("../../Globals/Classes/Security/LicenseClientView");
const GrantSources = require("../../Globals/Constants/GrantSources");
const { grantAndSeedDeck } = require("../PaidDeck/PaidDeckGrantHelpers");
const { getUser } = require("../Helpers/GetUser");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");


/**
 * POST /Organization/Decks/Add
 *
 * Body: { organizationId, deckId }
 *
 * Puts one of the organization's decks into that member's ORGANIZATION library.
 *
 * The licence is issued directly. There is no order, no provider, no coupon and
 * no webhook anywhere on this path — an institute's deck is provided to its
 * members, and nothing about acquiring one is a transaction. That is enforced
 * twice over: the publish service forces these decks to zero, and the checkout
 * entry point refuses them outright.
 *
 * The copy is seeded into the organization's scope regardless of which view the
 * member happens to be in when they add it. Where a deck LIVES is a property of
 * the deck, not of the tab that was open — seeding by current view would put an
 * institute's material in someone's personal library on a mis-click and leave it
 * there after they left the institute.
 */
async function addOrganizationDeck(request, response)
{
    if (!KeyManagementService.isReady())
    {
        response.statusCode = httpStatus.SERVICE_UNAVAILABLE;
        response.sendJson({ success: false, error: ErrorCodes.KEY_MANAGEMENT_NOT_READY });
        return;
    }

    const body = await request.getBody();
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";
    const deckId = typeof body?.deckId === "string" ? body.deckId : "";

    const user = await getUser(request);
    if (!user)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    const membership = await PaidDeckAudienceResolver.requireActiveMembership(organizationId, user);
    if (!membership.member)
    {
        response.statusCode = httpStatus.FORBIDDEN;
        response.sendJson({ success: false, error: ErrorCodes.ACCESS_NOT_ALLOWED });
        return;
    }

    // Scoped lookup: a deck id belonging to a different organization resolves to
    // nothing here, so membership of one institute can never be used to reach
    // another's material.
    const paidDeck = await OrganizationDeckQueryEngine.getOrganizationDeck(organizationId, deckId);
    if (!paidDeck || paidDeck.getIsPublished() !== true)
    {
        // A withdrawn deck answers the same as one that never existed —
        // distinguishing them would tell a member what an institute used to
        // provide and has since pulled.
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ success: false, error: ErrorCodes.DECK_NOT_ON_SHELF });
        return;
    }

    const existingLicense = await KeyManagementService.getLicense(user.getId(), deckId);
    if (KeyManagementService.isLicenseActive(existingLicense))
    {
        // Already held. Reported rather than re-seeded: a re-seed would discard
        // the member's study progress on a double-click.
        response.statusCode = httpStatus.CONFLICT;
        response.sendJson({ success: false, error: ErrorCodes.DECK_ALREADY_ON_SHELF, deckId: deckId });
        return;
    }

    const database = await DatabaseConnector.getDatabase();
    const licenseJson = await grantAndSeedDeck(database, user.getId(), deckId,
    {
        grantSource: GrantSources.ORGANIZATION_SHELF,
        // Perpetual for as long as the organization provides it. The end of
        // access is withdrawal or the end of the membership — both of which
        // revoke explicitly — not a clock nobody set.
        expiresAt: null,
        scopeKey: OrganizationScopeResolver.buildScopeKey(user.getId(), organizationId)
    });

    if (!licenseJson)
    {
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ success: false, error: ErrorCodes.USER_CONTENT_WRITE_FAILED });
        return;
    }

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        deckId: deckId,
        organizationId: organizationId,
        organizationName: membership.organization.getName(),
        // Secret key material stripped through the same chokepoint every other
        // licence-returning endpoint uses.
        license: LicenseClientView.sanitize(licenseJson)
    });
}

module.exports = { addOrganizationDeck };
