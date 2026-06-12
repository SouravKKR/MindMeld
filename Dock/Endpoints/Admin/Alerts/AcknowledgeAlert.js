const AlertQueryEngine = require("../../../Globals/Classes/Database/AlertQueryEngine");
const {httpStatus} = require("../../../Globals/Enumerations/HttpStatus");

/**
 * POST /Admin/Alerts/Acknowledge
 * Body: { id: string }
 *
 * Closes an open alert. The next occurrence of the same (source, title)
 * opens a fresh row rather than reviving this one.
 */
async function acknowledgeAlert(request, response)
{
    let body;
    try
    {
        body = await request.getBody();
    }
    catch (bodyError)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "Malformed JSON body." });
        return;
    }

    const alertId = typeof body?.id === "string" ? body.id : "";
    if (alertId.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "id is required." });
        return;
    }

    try
    {
        const result = await AlertQueryEngine.acknowledge(alertId);
        if (!result.ok)
        {
            response.statusCode = result.reason === "NOT_FOUND" ? 404 : 500;
            response.sendJson({ error: result.reason });
            return;
        }
        response.statusCode = httpStatus.OK;
        response.sendJson({ ok: true });
    }
    catch (acknowledgeError)
    {
        console.error(`[AcknowledgeAlert] ${acknowledgeError.message}`);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: "Failed to acknowledge alert." });
    }
}

module.exports = { acknowledgeAlert };
