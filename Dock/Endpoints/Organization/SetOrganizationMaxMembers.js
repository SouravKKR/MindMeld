const OrganizationQueryEngine = require("../../Globals/Classes/Organization/OrganizationQueryEngine");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");

/**
 * POST /Admin/Organizations/SetMaxMembers  (super-admin)
 *
 * Sets the member cap directly. Atomically refuses any value below the current
 * member count. Body: { organizationId, maxMembers }
 */
async function setOrganizationMaxMembers(request, response)
{
    const body = await request.getBody();
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";
    const maxMembers = parseInt(body?.maxMembers, 10);

    if (organizationId.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_ORGANIZATION_ID });
        return;
    }

    if (!Number.isInteger(maxMembers) || maxMembers <= 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_MAX_MEMBERS });
        return;
    }

    const result = await OrganizationQueryEngine.setMaxMembers(organizationId, maxMembers);
    if (!result.ok)
    {
        response.statusCode = result.reason === ErrorCodes.ORG_NOT_FOUND ? httpStatus.NOT_FOUND : httpStatus.BAD_REQUEST;
        response.sendJson({ error: result.reason });
        return;
    }

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, organizationId: organizationId, maxMembers: maxMembers });
}

module.exports = { setOrganizationMaxMembers };
