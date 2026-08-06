const OrganizationQueryEngine = require("../../Globals/Classes/Organization/OrganizationQueryEngine");
const OrganizationAuthorityResolver = require("../../Globals/Classes/Organization/OrganizationAuthorityResolver");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");


/**
 * POST /Organization/Rename
 *
 * Body: { organizationId, name }
 *
 * Owner (or super-admin) only. Renaming is deliberately NOT a delegate power:
 * the name is how every member identifies the organization in their profile
 * menu and their org view, so changing it is an identity change rather than
 * day-to-day administration.
 */
async function renameMyOrganization(request, response)
{
    const body = await request.getBody();
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";
    const name = typeof body?.name === "string" ? body.name.trim() : "";

    const authority = await OrganizationAuthorityResolver.resolve(request.user, organizationId);
    if (!authority.allowed || !(authority.isOwner || authority.isSuperAdmin))
    {
        response.statusCode = authority.allowed ? httpStatus.FORBIDDEN : OrganizationAuthorityResolver.statusForDenial(authority);
        response.sendJson({ success: false, error: authority.allowed ? ErrorCodes.NOT_ORG_ADMIN : authority.reason });
        return;
    }

    if (name.length === 0 || name.length > 256)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.INVALID_NAME });
        return;
    }

    const bRenamed = await OrganizationQueryEngine.renameOrganization(organizationId, name);
    if (!bRenamed)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ success: false, error: ErrorCodes.ORG_NOT_FOUND });
        return;
    }

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, organizationId: organizationId, name: name });
}

module.exports = { renameMyOrganization };
