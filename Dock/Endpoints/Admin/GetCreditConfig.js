const CreditConfigurationStore = require("../../Globals/Classes/Credits/CreditConfigurationStore");
const CreditPurchasePricingEngine = require("../../Globals/Classes/Credits/CreditPurchasePricingEngine");
const RegionMetadata = require("../../Globals/Classes/Pricing/RegionMetadata");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

/**
 * GET /Admin/Credits/Config
 *
 * Returns the singleton credit configuration, seeding safe defaults on the
 * first ever read so the admin editor always has a document to render. The
 * response is enriched with the supported currency list and the effective
 * per-currency credit prices (explicit vs auto-converted from the base) so
 * the editor needs no FX logic of its own.
 */
async function getCreditConfig(request, response)
{
    try
    {
        const configuration = await CreditConfigurationStore.load();
        const effectivePricing = await CreditPurchasePricingEngine.computeEffectivePrices(configuration);

        response.statusCode = httpStatus.OK;
        response.sendJson
        ({
            config: configuration.toJson(),
            supportedCurrencies: RegionMetadata.getSupportedCurrencies(),
            effectivePricing: effectivePricing
        });
    }
    catch (loadError)
    {
        console.error(`[GetCreditConfig] ${loadError.message}`);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: ErrorCodes.FAILED_TO_LOAD_CREDIT_CONFIG });
    }
}

module.exports = { getCreditConfig };
