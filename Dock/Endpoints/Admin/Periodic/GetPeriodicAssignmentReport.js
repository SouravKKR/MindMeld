const PeriodicAssignmentReportBuilder = require("../../../Globals/Classes/Credits/PeriodicAssignmentReportBuilder");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");

/**
 * GET /Admin/Credits/Periodic/Report?assignmentId=...
 *
 * Returns the full printable report payload for one assignment — timestamps,
 * scope, validity, period, all beneficiaries (current + former) with their
 * cumulative credits, current org members, org admin(s), the all-time total,
 * and any attached deal/invoice records.
 */
async function getPeriodicAssignmentReport(request, response)
{
    const queryParameters = await request.getQueryParams();
    const assignmentId = queryParameters["assignmentId"];

    if (typeof assignmentId !== "string" || assignmentId.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_ID });
        return;
    }

    const report = await PeriodicAssignmentReportBuilder.build(assignmentId);
    if (!report)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.ASSIGNMENT_NOT_FOUND });
        return;
    }

    response.statusCode = httpStatus.OK;
    response.sendJson(report);
}

module.exports = { getPeriodicAssignmentReport };
