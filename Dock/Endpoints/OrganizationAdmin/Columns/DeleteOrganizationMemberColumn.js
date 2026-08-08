const OrganizationAuthorityResolver = require("../../../Globals/Classes/Organization/OrganizationAuthorityResolver");
const OrganizationMemberColumnQueryEngine = require("../../../Globals/Classes/Organization/OrganizationMemberColumnQueryEngine");
const OrganizationMemberQueryEngine = require("../../../Globals/Classes/Organization/OrganizationMemberQueryEngine");
const { organizationDelegatePowers } = require("../../../Globals/Enumerations/OrganizationDelegatePowers");
const { memberColumnRenamePhases } = require("../../../Globals/Enumerations/MemberColumnRenamePhases");
const {httpStatus} = require("../../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");


/**
 * POST /Organization/Members/Columns/Delete
 *
 * Body: { organizationId, key }
 *
 * Removes a column from the roster — the description AND the values.
 *
 * Both, necessarily. The schema is rebuilt from the attribute keys members
 * actually carry, so deleting only the description would recreate the column on
 * the very next read; the institute would delete it, reload the page, and find
 * it still there. The values therefore go with it, which is destructive, so the
 * screen says so before asking.
 *
 * A column mid-rename is refused rather than deleted: its values are in the
 * middle of being copied to another key, and removing the row would strand them
 * under a key nothing describes.
 */
async function deleteOrganizationMemberColumn(request, response)
{
    const body = await request.getBody();
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";
    const key = typeof body?.key === "string" ? body.key.trim() : "";

    if (key.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.COLUMN_NOT_FOUND });
        return;
    }

    const authority = await OrganizationAuthorityResolver.requirePower(request.user, organizationId, organizationDelegatePowers.MANAGE_MEMBERS);
    if (!authority.allowed)
    {
        response.statusCode = OrganizationAuthorityResolver.statusForDenial(authority);
        response.sendJson({ success: false, error: authority.reason });
        return;
    }

    const column = await OrganizationMemberColumnQueryEngine.findColumnByKey(organizationId, key);
    if (!column)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ success: false, error: ErrorCodes.COLUMN_NOT_FOUND });
        return;
    }

    if (column.getRenamePhase() !== memberColumnRenamePhases.IDLE)
    {
        response.statusCode = httpStatus.CONFLICT;
        response.sendJson({ success: false, error: ErrorCodes.COLUMN_RENAME_IN_PROGRESS });
        return;
    }

    // Values first. If this fails, the column is still described and the roster
    // is unchanged; the opposite order could strip the data and leave nothing
    // saying it ever existed.
    const clearResult = await OrganizationMemberQueryEngine.removeAttributeFromAllMembers(organizationId, key);
    await OrganizationMemberColumnQueryEngine.deleteColumn(organizationId, key);

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, membersCleared: clearResult.updated });
}

module.exports = { deleteOrganizationMemberColumn };
