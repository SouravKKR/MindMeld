const PeriodicAssignmentQueryEngine = require("../../../Globals/Classes/Credits/PeriodicAssignmentQueryEngine");
const PeriodicAssignmentRecipientStore = require("../../../Globals/Classes/Credits/PeriodicAssignmentRecipientStore");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");

/**
 * POST /Admin/Credits/Periodic/Delete
 *
 * Permanently removes a recurring assignment and its per-recipient cursor rows
 * (HARD delete). Unlike Terminate — which only halts FUTURE installments but
 * keeps the record for reporting — Delete clears an old / irrelevant assignment
 * from the admin list for good. It is available at ANY status: deleting an
 * ACTIVE assignment also stops it, since the lazy reconciler will no longer
 * find it as a candidate.
 *
 * Already-granted credits are never clawed back — the authoritative
 * creditTransactions ledger is left untouched, so the credit history and audit
 * trail survive even after the assignment is gone.
 *
 * Body: { assignmentId }
 */
async function deletePeriodicAssignment(request, response)
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

    const deletion = await PeriodicAssignmentQueryEngine.deleteById(assignmentId);
    const recipientRemoval = await PeriodicAssignmentRecipientStore.deleteByAssignmentId(assignmentId);

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, deleted: deletion.deleted, recipientsRemoved: recipientRemoval.deletedCount });
}

module.exports = { deletePeriodicAssignment };
