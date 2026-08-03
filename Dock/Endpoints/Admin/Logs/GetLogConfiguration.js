const LogConfigurationStore = require("../../../Globals/Classes/Logging/LogConfigurationStore");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");

/**
 * GET /Admin/Logs/Configuration
 *
 * Returns the current log-archival configuration (settable interval + last-run
 * timestamp) for the admin Logs panel to render.
 */
async function getLogConfiguration(request, response)
{
    try
    {
        const configuration = await LogConfigurationStore.load();
        response.statusCode = httpStatus.OK;
        response.sendJson({ configuration: configuration });
    }
    catch (loadError)
    {
        console.error(`[GetLogConfiguration] ${loadError.message}`);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: ErrorCodes.FAILED_TO_LOAD_LOG_CONFIGURATION });
    }
}

module.exports = { getLogConfiguration };
