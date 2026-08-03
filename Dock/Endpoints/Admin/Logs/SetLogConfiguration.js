const LogConfigurationStore = require("../../../Globals/Classes/Logging/LogConfigurationStore");
const LogArchivalScheduler = require("../../../Globals/Classes/Logging/LogArchivalScheduler");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");

/**
 * POST /Admin/Logs/Configuration/Save
 *
 * Body: { archivalIntervalDays: <integer >= 1> }
 *
 * Persists the settable archival interval. Requirement 7: when the interval is
 * SHORTENED and the new (shorter) duration has already elapsed since the last
 * archival, an archival run is triggered immediately rather than waiting for the
 * next scheduled tick.
 */
async function setLogConfiguration(request, response)
{
    try
    {
        const body = await request.getBody();
        const intervalDays = Math.floor(Number(body ? body.archivalIntervalDays : undefined));

        if (!Number.isInteger(intervalDays) || intervalDays < 1 || intervalDays > 3650)
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ error: ErrorCodes.INVALID_LOG_INTERVAL });
            return;
        }

        const updatedByUserId = request.user ? request.user.getId() : "";
        const { previousIntervalDays, configuration } = await LogConfigurationStore.saveIntervalDays(intervalDays, updatedByUserId);

        let triggeredImmediateArchival = false;
        if (intervalDays < previousIntervalDays)
        {
            const lastArchivedAt = configuration.lastArchivedAt ? new Date(configuration.lastArchivedAt) : null;
            const elapsedMilliseconds = lastArchivedAt ? (Date.now() - lastArchivedAt.getTime()) : Infinity;
            if (elapsedMilliseconds >= intervalDays * 24 * 60 * 60 * 1000)
            {
                triggeredImmediateArchival = true;
                LogArchivalScheduler.runNow().catch((runError) => console.error("[SetLogConfiguration] immediate archival failed:", runError?.message || runError));
            }
        }

        response.statusCode = httpStatus.OK;
        response.sendJson({ configuration: configuration, triggeredImmediateArchival: triggeredImmediateArchival });
    }
    catch (saveError)
    {
        console.error(`[SetLogConfiguration] ${saveError.message}`);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: ErrorCodes.FAILED_TO_SAVE_LOG_CONFIGURATION });
    }
}

module.exports = { setLogConfiguration };
