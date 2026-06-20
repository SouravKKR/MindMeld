const OrganizationQueryEngine = require("../../Globals/Classes/Organization/OrganizationQueryEngine");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");

/**
 * POST /Admin/Organizations/Rename  (super-admin)
 *
 * Renames an organization. Body: { organizationId, name }
 */
async function renameOrganization(request, response)
{
    const body = await request.getBody();
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";
    const name = typeof body?.name === "string" ? body.name.trim() : "";

    if (organizationId.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_ORGANIZATION_ID });
        return;
    }

    if (name.length === 0 || name.length > 256)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_NAME });
        return;
    }

    const renamed = await OrganizationQueryEngine.renameOrganization(organizationId, name);
    if (!renamed)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.ORG_NOT_FOUND });
        return;
    }

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, organizationId: organizationId, name: name });
}

module.exports = { renameOrganization };
