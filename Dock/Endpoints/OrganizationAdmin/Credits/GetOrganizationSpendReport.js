const OrganizationAuthorityResolver = require("../../../Globals/Classes/Organization/OrganizationAuthorityResolver");
const OrganizationSpendReportBuilder = require("../../../Globals/Classes/Organization/OrganizationSpendReportBuilder");
const {httpStatus} = require("../../../Globals/Enumerations/HttpStatus");


/**
 * GET /Organization/Credits/SpendReport?organizationId=...
 *
 * Per-member, per-feature spending for the organization, as JSON the client
 * renders and exports as a spreadsheet.
 *
 * The disclaimer travels ON the report rather than only in the UI: a member has
 * one balance, so the spend figures necessarily include credits they bought
 * themselves, and any rendering of this data has to say so.
 */
async function getOrganizationSpendReport(request, response)
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

    const report = await OrganizationSpendReportBuilder.build(authority.organization);

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, report: report });
}

module.exports = { getOrganizationSpendReport };
