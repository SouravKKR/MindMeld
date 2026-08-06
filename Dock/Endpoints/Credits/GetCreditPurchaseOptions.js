const CreditConfigurationStore = require("../../Globals/Classes/Credits/CreditConfigurationStore");
const CreditPurchasePricingEngine = require("../../Globals/Classes/Credits/CreditPurchasePricingEngine");
const RegionResolver = require("../../Globals/Classes/Pricing/RegionResolver");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");
const PaymentAccessPolicy = require("../../Globals/Classes/Payments/PaymentAccessPolicy");
const { getUser } = require("../Helpers/GetUser");

/**
 * GET /Credits/Purchase/Options
 *
 * The buyer-facing quote for the Buy Credits dialog: the charge currency
 * (resolved from the buyer's region, falling back to the base currency when
 * no FX rate exists), the per-credit unit price, every configured pack with
 * its server-computed price, and the minimum purchasable quantities.
 *
 * Always answers 200 — "pricing not configured yet" is a state the dialog
 * renders gracefully, not an error.
 *
 * Query: ?region=<Regions name>&localeRegionHint=<Regions name>
 */
async function getCreditPurchaseOptions(request, response)
{
    try
    {
        const queryParams = await request.getQueryParams();
        const region = RegionResolver.resolveRegion
        (
            request,
            (queryParams.region || "").toUpperCase() || null,
            (queryParams.localeRegionHint || "").toUpperCase() || null
        );

        const configuration = await CreditConfigurationStore.load();
        const options = await CreditPurchasePricingEngine.computeOptions(configuration, region);

        // The price list stays readable for everyone so the page still renders,
        // but outside production only an administrator may actually buy. Saying
        // so here lets the client hide the purchase action instead of letting a
        // user configure a top-up and hit a 403 at the last step.
        const viewer = await getUser(request);
        const bPurchaseAllowed = PaymentAccessPolicy.isPaymentAllowedForUser(viewer);

        response.statusCode = httpStatus.OK;
        response.sendJson
        ({
            ...options,
            purchaseAllowed: bPurchaseAllowed,
            purchaseRestrictionReason: bPurchaseAllowed ? "" : PaymentAccessPolicy.describeRestriction()
        });
    }
    catch (optionsError)
    {
        console.error(`[GetCreditPurchaseOptions] ${optionsError.message}`);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: ErrorCodes.FAILED_TO_LOAD_PURCHASE_OPTIONS });
    }
}

module.exports = { getCreditPurchaseOptions };
