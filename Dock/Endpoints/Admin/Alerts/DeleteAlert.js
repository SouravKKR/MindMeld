const AlertQueryEngine = require("../../../Globals/Classes/Database/AlertQueryEngine");
const {httpStatus} = require("../../../Globals/Enumerations/HttpStatus");

/**
 * POST /Admin/Alerts/Delete
 * Body: { id: string }
 */
async function deleteAlert(request, response)
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
        const result = await AlertQueryEngine.deleteById(alertId);
        if (!result.removed)
        {
            response.statusCode = result.reason === "NOT_FOUND" ? 404 : 500;
            response.sendJson({ error: result.reason });
            return;
        }
        response.statusCode = httpStatus.OK;
        response.sendJson({ ok: true });
    }
    catch (deleteError)
    {
        console.error(`[DeleteAlert] ${deleteError.message}`);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: "Failed to delete alert." });
    }
}

module.exports = { deleteAlert };
