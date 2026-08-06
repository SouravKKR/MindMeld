const OrganizationAuthorityResolver = require("../../../Globals/Classes/Organization/OrganizationAuthorityResolver");
const OrganizationCreditDistributionService = require("../../../Globals/Classes/Organization/OrganizationCreditDistributionService");
const PeriodicAssignmentQueryEngine = require("../../../Globals/Classes/Credits/PeriodicAssignmentQueryEngine");
const { creditGrantAmountModes } = require("../../../Globals/Enumerations/CreditGrantAmountModes");
const {httpStatus} = require("../../../Globals/Enumerations/HttpStatus");


/**
 * GET /Organization/Credits/Periodic/List?organizationId=...
 *
 * The organization's recurring distributions, each with the cost its NEXT cycle
 * would incur at today's roster.
 *
 * That projection is the point of this endpoint. A recurring plan reserves
 * nothing, so the only way an administrator can tell whether the pool will
 * cover the next run is to be shown what it would cost — before the cycle
 * arrives and is skipped.
 */
async function listOrganizationPeriodicAssignments(request, response)
{
    const queryParams = await request.getQueryParams();
    const organizationId = typeof queryParams?.organizationId === "string" ? queryParams.organizationId : "";

    const authority = await OrganizationAuthorityResolver.resolve(request.user, organizationId);
    if (!authority.allowed)
    {
        response.statusCode = OrganizationAuthorityResolver.statusForDenial(authority);
        response.sendJson({ success: false, error: authority.reason });
        return;
    }

    const assignments = await PeriodicAssignmentQueryEngine.listActiveByOrganizationId(organizationId);

    const rows = [];
    for (const assignment of assignments)
    {
        // Priced through the same planner a one-off distribution uses, so the
        // projection and the eventual grant agree on who is covered.
        const projection = await OrganizationCreditDistributionService.plan
        (
            authority.organization,
            {
                tagFilter: assignment.getTagFilter(),
                tagMatchMode: assignment.getTagMatchMode(),
                amount: assignment.getAmount(),
                amountMode: creditGrantAmountModes.PER_USER
            }
        );

        rows.push
        ({
            ...assignment.toJson(),
            nextCycleRecipientCount: projection.ok ? projection.recipientCount : 0,
            nextCycleCost: projection.ok ? projection.totalAmount : 0,
            bPoolCoversNextCycle: projection.ok ? projection.poolBalanceBefore >= projection.totalAmount : false
        });
    }

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, assignments: rows });
}

module.exports = { listOrganizationPeriodicAssignments };
