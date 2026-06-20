const PeriodicAssignmentQueryEngine = require("../../../Globals/Classes/Credits/PeriodicAssignmentQueryEngine");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");

/**
 * GET /Admin/Credits/Periodic/List
 *
 * Returns every periodic credit assignment (active and terminated), newest
 * first, for the admin management list.
 */
async function listPeriodicAssignments(request, response)
{
    const assignments = await PeriodicAssignmentQueryEngine.listAll();
    response.statusCode = httpStatus.OK;
    response.sendJson({ assignments: assignments.map(assignment => assignment.toJson()) });
}

module.exports = { listPeriodicAssignments };
