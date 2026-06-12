const CreditConfiguration = require("../../Globals/Classes/Credits/CreditConfiguration");
const CreditConfigurationStore = require("../../Globals/Classes/Credits/CreditConfigurationStore");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

/**
 * POST /Admin/Credits/Config/Save
 *
 * Validates and persists the full credit configuration. The store bumps the
 * version, stamps updatedAt / updatedBy, and invalidates the in-process cache
 * so the next task / sync sees the new rules.
 *
 * Body: { config: <CreditConfiguration JSON> }
 */
async function setCreditConfig(request, response)
{
    try
    {
        const body = await request.getBody();
        const configJson = body?.config;

        if (!configJson || typeof configJson !== "object")
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ error: "MISSING_CONFIG" });
            return;
        }

        const configuration = CreditConfiguration.fromJson(configJson);
        const updatedByUserId = request.user ? request.user.getId() : "";

        const savedConfiguration = await CreditConfigurationStore.save(configuration, updatedByUserId);

        response.statusCode = httpStatus.OK;
        response.sendJson({ config: savedConfiguration.toJson() });
    }
    catch (saveError)
    {
        console.error(`[SetCreditConfig] ${saveError.message}`);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: "FAILED_TO_SAVE_CREDIT_CONFIG" });
    }
}

module.exports = { setCreditConfig };
