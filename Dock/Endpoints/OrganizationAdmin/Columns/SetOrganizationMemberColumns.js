const OrganizationAuthorityResolver = require("../../../Globals/Classes/Organization/OrganizationAuthorityResolver");
const OrganizationMemberColumnQueryEngine = require("../../../Globals/Classes/Organization/OrganizationMemberColumnQueryEngine");
const { organizationDelegatePowers } = require("../../../Globals/Enumerations/OrganizationDelegatePowers");
const {httpStatus} = require("../../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");


/**
 * POST /Organization/Members/Columns/Set
 *
 * Body: { organizationId, columns: [{ key, label, valueType, displayOrder }] }
 *
 * What the institute calls each column, how its values read, and the order they
 * appear in.
 *
 * The stored key is matched here, never changed — moving a column onto a new key
 * rewrites every member document and is the separate Rename operation. Sending a
 * different key simply matches nothing, which is the safe reading of an
 * ambiguous request.
 *
 * `valueType` is the setting that earns this screen. The list can infer a type
 * by sampling stored values, but a single "N/A" in a column of admission years
 * makes every value read as text and turns a year range into an alphabetical one
 * for the whole roster. Stating the type puts that beyond the sampler's reach.
 */
async function setOrganizationMemberColumns(request, response)
{
    const body = await request.getBody();
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";
    const columnInputs = Array.isArray(body?.columns) ? body.columns : [];

    const authority = await OrganizationAuthorityResolver.requirePower(request.user, organizationId, organizationDelegatePowers.MANAGE_MEMBERS);
    if (!authority.allowed)
    {
        response.statusCode = OrganizationAuthorityResolver.statusForDenial(authority);
        response.sendJson({ success: false, error: authority.reason });
        return;
    }

    for (const columnInput of columnInputs)
    {
        const validation = OrganizationMemberColumnQueryEngine.validateColumn(columnInput);
        if (!validation.valid)
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ success: false, error: validation.reason });
            return;
        }
    }

    try
    {
        const updateResult = await OrganizationMemberColumnQueryEngine.updateColumns(organizationId, columnInputs);

        response.statusCode = httpStatus.OK;
        response.sendJson({ success: true, updated: updateResult.updated });
    }
    catch (updateError)
    {
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ success: false, error: ErrorCodes.INVALID_REQUEST });
    }
}

module.exports = { setOrganizationMemberColumns };
