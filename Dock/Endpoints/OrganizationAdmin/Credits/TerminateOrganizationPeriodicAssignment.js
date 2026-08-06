const OrganizationAuthorityResolver = require("../../../Globals/Classes/Organization/OrganizationAuthorityResolver");
const PeriodicAssignmentQueryEngine = require("../../../Globals/Classes/Credits/PeriodicAssignmentQueryEngine");
const { organizationDelegatePowers } = require("../../../Globals/Enumerations/OrganizationDelegatePowers");
const {httpStatus} = require("../../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");


/**
 * POST /Organization/Credits/Periodic/Terminate
 *
 * Body: { organizationId, assignmentId }
 *
 * Stops a recurring distribution. Credits already given out are the members'
 * and are not reclaimed; only future cycles stop.
 *
 * The assignment is re-checked against the caller's organization before
 * anything is terminated, so quoting another organization's assignment id
 * cannot stop their distributions.
 */
async function terminateOrganizationPeriodicAssignment(request, response)
{
    const body = await request.getBody();
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";
    const assignmentId = typeof body?.assignmentId === "string" ? body.assignmentId : "";

    const authority = await OrganizationAuthorityResolver.requirePower(request.user, organizationId, organizationDelegatePowers.DISTRIBUTE_CREDITS);
    if (!authority.allowed)
    {
        response.statusCode = OrganizationAuthorityResolver.statusForDenial(authority);
        response.sendJson({ success: false, error: authority.reason });
        return;
    }

    const assignment = await PeriodicAssignmentQueryEngine.getById(assignmentId);
    if (!assignment || assignment.getOrganizationId() !== organizationId)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ success: false, error: ErrorCodes.ASSIGNMENT_NOT_FOUND });
        return;
    }

    await PeriodicAssignmentQueryEngine.terminate(assignmentId, new Date());

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, assignmentId: assignmentId });
}

module.exports = { terminateOrganizationPeriodicAssignment };
