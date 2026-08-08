const OrganizationAuthorityResolver = require("../../../Globals/Classes/Organization/OrganizationAuthorityResolver");
const OrganizationMemberColumnRenamer = require("../../../Globals/Classes/Organization/OrganizationMemberColumnRenamer");
const { organizationDelegatePowers } = require("../../../Globals/Enumerations/OrganizationDelegatePowers");
const {httpStatus} = require("../../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");


/**
 * POST /Organization/Members/Columns/Rename
 *
 * Body: { organizationId, key, newKey, newLabel? }
 *
 * Renames a column for real — the stored key on every member, every rule that
 * targets it, and the column row itself.
 *
 * A label-only rename was considered and rejected: the stored key is where a
 * column's identity actually lives, so an institute that changed only the
 * caption would still meet "joinYear" in its exports, in its rule payloads and
 * in the header its office has to keep typing. The migration is run by
 * OrganizationMemberColumnRenamer in three phases so that no member loses an
 * entitlement while it is in flight.
 *
 * The old name is kept as an alias, so the spreadsheet the office already has
 * goes on importing into the renamed column instead of quietly recreating the
 * old one beside it.
 */
async function renameOrganizationMemberColumn(request, response)
{
    const body = await request.getBody();
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";
    const key = typeof body?.key === "string" ? body.key.trim() : "";
    const newKey = typeof body?.newKey === "string" ? body.newKey.trim() : "";
    const newLabel = typeof body?.newLabel === "string" ? body.newLabel : "";

    if (key.length === 0 || newKey.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.INVALID_REQUEST });
        return;
    }

    const authority = await OrganizationAuthorityResolver.requirePower(request.user, organizationId, organizationDelegatePowers.MANAGE_MEMBERS);
    if (!authority.allowed)
    {
        response.statusCode = OrganizationAuthorityResolver.statusForDenial(authority);
        response.sendJson({ success: false, error: authority.reason });
        return;
    }

    const renameResult = await OrganizationMemberColumnRenamer.rename(organizationId, key, newKey, newLabel);

    if (!renameResult.ok)
    {
        response.statusCode = renameResult.reason === ErrorCodes.COLUMN_NOT_FOUND
            ? httpStatus.NOT_FOUND
            : (renameResult.reason === ErrorCodes.COLUMN_ALREADY_EXISTS || renameResult.reason === ErrorCodes.COLUMN_RENAME_IN_PROGRESS)
                ? httpStatus.CONFLICT
                : httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: renameResult.reason });
        return;
    }

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        newKey: renameResult.newKey,
        membersUpdated: renameResult.membersCopied,
        rulesRepointed: renameResult.rulesRepointed
    });
}

module.exports = { renameOrganizationMemberColumn };
