const PeriodicAssignmentQueryEngine = require("../../../Globals/Classes/Credits/PeriodicAssignmentQueryEngine");
const { periodicAssignmentStatuses } = require("../../../Globals/Enumerations/PeriodicAssignmentStatuses");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");

/**
 * POST /Admin/Credits/Periodic/Terminate
 *
 * Stops a recurring assignment at any time. Terminating only halts FUTURE
 * installments — already-granted credits are never clawed back. Idempotent:
 * a second terminate reports ASSIGNMENT_ALREADY_TERMINATED.
 *
 * Body: { assignmentId }
 */
async function terminatePeriodicAssignment(request, response)
{
    const body = await request.getBody();
    const assignmentId = body?.assignmentId;

    if (typeof assignmentId !== "string" || assignmentId.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_ID });
        return;
    }

    const assignment = await PeriodicAssignmentQueryEngine.getById(assignmentId);
    if (!assignment)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.ASSIGNMENT_NOT_FOUND });
        return;
    }

    if (assignment.getStatus() === periodicAssignmentStatuses.TERMINATED)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.ASSIGNMENT_ALREADY_TERMINATED });
        return;
    }

    const result = await PeriodicAssignmentQueryEngine.terminate(assignmentId, new Date());

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, transitioned: result.transitioned });
}

module.exports = { terminatePeriodicAssignment };
