const OrganizationQueryEngine = require("../../Globals/Classes/Organization/OrganizationQueryEngine");
const OrganizationDeckPerkQueryEngine = require("../../Globals/Classes/Organization/OrganizationDeckPerkQueryEngine");
const OrganizationMemberQueryEngine = require("../../Globals/Classes/Organization/OrganizationMemberQueryEngine");
const OrganizationPaymentQueryEngine = require("../../Globals/Classes/Organization/OrganizationPaymentQueryEngine");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");


async function getOrganization(request, response)
{
    const queryParams = await request.getQueryParams();
    const organizationId = typeof queryParams?.organizationId === "string" ? queryParams.organizationId : "";

    if (!organizationId)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.MISSING_ORGANIZATION_ID });
        return;
    }

    const organization = await OrganizationQueryEngine.getOrganizationById(organizationId);
    if (!organization)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ success: false, error: ErrorCodes.ORG_NOT_FOUND });
        return;
    }

    const perks = await OrganizationDeckPerkQueryEngine.listPerksForOrganization(organizationId);
    const members = await OrganizationMemberQueryEngine.listMembers(organizationId);
    const payments = await OrganizationPaymentQueryEngine.listForOrganization(organizationId);

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        organization: organization.toJson(),
        perks: perks.map(perk => perk.toJson()),
        members: members.map(member => member.toJson()),
        payments: payments.map(payment => payment.toJson())
    });
}

module.exports = { getOrganization };
