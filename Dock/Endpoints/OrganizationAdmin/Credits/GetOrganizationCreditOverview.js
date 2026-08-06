const OrganizationAuthorityResolver = require("../../../Globals/Classes/Organization/OrganizationAuthorityResolver");
const OrganizationCreditLedger = require("../../../Globals/Classes/Organization/OrganizationCreditLedger");
const OrganizationPoolHistoryView = require("../../../Globals/Classes/Organization/OrganizationPoolHistoryView");
const CreditDealPaymentQueryEngine = require("../../../Globals/Classes/Credits/CreditDealPaymentQueryEngine");
const PaymentProviderFactory = require("../../../Globals/Classes/Payments/PaymentProviderFactory");
const PaymentAccessPolicy = require("../../../Globals/Classes/Payments/PaymentAccessPolicy");
const { creditDealTargetTypes } = require("../../../Globals/Enumerations/CreditDealTargetTypes");
const { creditDealPaymentStatuses } = require("../../../Globals/Enumerations/CreditDealPaymentStatuses");
const {httpStatus} = require("../../../Globals/Enumerations/HttpStatus");


/**
 * GET /Organization/Credits/Overview?organizationId=...
 *
 * Everything the credits section needs in one call: the pool, whether it is
 * frozen, when the contract term ends, the movements in and out, and any deal
 * still waiting to be paid.
 *
 * Readable by anyone with standing. Spending the pool needs the
 * DISTRIBUTE_CREDITS power; seeing the balance does not, because an owner
 * reviewing what a delegate did should not have to hold the delegate's power to
 * look.
 */
async function getOrganizationCreditOverview(request, response)
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

    const pool = await OrganizationCreditLedger.getPool(organizationId);
    const transactions = await OrganizationCreditLedger.listTransactions(organizationId, 50);
    const settledMovements = OrganizationPoolHistoryView.buildSettledMovements(transactions);
    const deals = await CreditDealPaymentQueryEngine.listForTarget(creditDealTargetTypes.ORGANIZATION_CREDIT_POOL, organizationId);

    response.statusCode = httpStatus.OK;
    // request.user is set by ensureOrgAdmin; the authority object carries the
    // organization and the powers, not the user.
    const bPaymentAllowed = PaymentAccessPolicy.isPaymentAllowedForUser(request.user || null);

    response.sendJson
    ({
        success: true,
        paymentAllowed: bPaymentAllowed,
        pool: pool ? pool.toJson() : null,
        termEndsAt: authority.organization.getTermEndsAt(),
        maxCreditsPerMemberPerMonth: authority.organization.getMaxCreditsPerMemberPerMonth(),
        // Only the settled movements, already described. The ledger claims a row
        // before it moves anything, so a pending row is either in flight or
        // abandoned — showing those would have an administrator counting credits
        // twice or chasing a distribution that never happened. Which statuses
        // count as settled is the ledger's vocabulary, so the filtering belongs
        // here rather than in a client comparing strings it cannot see.
        transactions: settledMovements,
        deals: deals.map((deal) =>
        {
            const bAwaitingPayment = deal.getStatus() === creditDealPaymentStatuses.PENDING;

            // The checkout context is rebuilt here rather than stored on the
            // deal: it carries the provider's key id, which has no business
            // sitting on a database row, and it is only ever needed while a
            // payment is still outstanding.
            //
            // Withheld entirely where payments are restricted to
            // administrators: handing the browser a launchable checkout that
            // /Organization/Credits/Deals/Verify would then refuse is a worse
            // experience than showing the deal as unpayable here.
            let checkoutContext = null;
            if (bAwaitingPayment && deal.getProviderOrderId() && bPaymentAllowed)
            {
                const provider = PaymentProviderFactory.getProvider(deal.getPaymentProvider());
                checkoutContext = provider.buildCheckoutContext
                ({
                    providerOrderId: deal.getProviderOrderId(),
                    amountMinor: deal.getAmountMinor(),
                    currency: deal.getCurrency()
                });
            }

            return {
                id: deal.getId(),
                label: deal.getLabel(),
                status: deal.getStatus(),
                mode: deal.getMode(),
                amountMinor: deal.getAmountMinor(),
                currency: deal.getCurrency(),
                credits: Number(deal.getAdditionalData()?.credits) || 0,
                termEndsAt: deal.getAdditionalData()?.termEndsAt || "",
                createdAt: deal.getCreatedAt(),
                bAwaitingPayment: bAwaitingPayment,
                paymentProvider: deal.getPaymentProvider(),
                checkoutContext: checkoutContext
            };
        })
    });
}

module.exports = { getOrganizationCreditOverview };
