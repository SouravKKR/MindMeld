const OrganizationQueryEngine = require("../../Globals/Classes/Organization/OrganizationQueryEngine");
const OrganizationDeckPerkQueryEngine = require("../../Globals/Classes/Organization/OrganizationDeckPerkQueryEngine");
const OrganizationPaymentQueryEngine = require("../../Globals/Classes/Organization/OrganizationPaymentQueryEngine");


async function listOrganizations(request, response)
{
    const organizations = await OrganizationQueryEngine.listOrganizations();

    const rows = [];
    for (const organization of organizations)
    {
        const perks = await OrganizationDeckPerkQueryEngine.listPerksForOrganization(organization.getId());
        const payments = await OrganizationPaymentQueryEngine.listForOrganization(organization.getId());
        rows.push
        ({
            ...organization.toJson(),
            perkCount: perks.length,
            lastPaymentStatus: payments.length > 0 ? payments[0].getStatus() : null
        });
    }

    response.statusCode = 200;
    response.sendJson({ success: true, organizations: rows });
}

module.exports = { listOrganizations };
