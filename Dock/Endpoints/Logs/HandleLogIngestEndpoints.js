const { PacketronHandlerFlags, PacketronRequestMethod } = require("@gamiumgamers/packetron");
const { getSession } = require("../Helpers/GetSession");
const Logger = require("../../Globals/Classes/Logger");
const { logServiceOrigin } = require("../../Globals/Enumerations/LogServiceOrigin");
const { logLevel } = require("../../Globals/Enumerations/LogLevel");
const { logCategory } = require("../../Globals/Enumerations/LogCategory");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");

/**
 * POST /Logs/Ingest
 *
 * Accepts a small batch of browser-emitted log entries (client events + captured
 * window errors) and writes them through the same durable pipeline as server
 * logs, tagged with the WEB service origin and the caller's account. Authenticated
 * via the session cookie and covered by the global rate limiter; batch size and
 * message length are capped so it can't be abused as a write amplifier.
 */

const MAXIMUM_ENTRIES_PER_REQUEST = 50;
const MAXIMUM_MESSAGE_LENGTH = 4000;
const MAXIMUM_TITLE_LENGTH = 200;

const validLevels = new Set(Object.values(logLevel));
const validCategories = new Set(Object.values(logCategory));

async function ingestLogs(request, response)
{
    let accountId = "";
    try
    {
        const session = await getSession(request);
        accountId = session ? session.getUserId() : "";
    }
    catch (sessionLookupError)
    {
        accountId = "";
    }

    let body = null;
    try
    {
        body = await request.getBody();
    }
    catch (bodyError)
    {
        body = null;
    }

    const entries = (body && Array.isArray(body.entries)) ? body.entries.slice(0, MAXIMUM_ENTRIES_PER_REQUEST) : [];
    for (const entry of entries)
    {
        if (!entry || typeof entry !== "object")
        {
            continue;
        }

        const level = validLevels.has(Number(entry.level)) ? Number(entry.level) : logLevel.INFO;
        const category = validCategories.has(Number(entry.category)) ? Number(entry.category) : logCategory.EVENT;
        const title = typeof entry.title === "string" ? entry.title.slice(0, MAXIMUM_TITLE_LENGTH) : "";
        const message = typeof entry.message === "string" ? entry.message.slice(0, MAXIMUM_MESSAGE_LENGTH) : "";
        const additionalData = (entry.additionalData && typeof entry.additionalData === "object") ? entry.additionalData : {};

        Logger.record(level, category, title, message,
        {
            accountId: accountId,
            service: logServiceOrigin.WEB,
            errorCode: typeof entry.errorCode === "string" ? entry.errorCode : "",
            errorReason: typeof entry.errorReason === "string" ? entry.errorReason : "",
            additionalData: additionalData
        });
    }

    response.statusCode = httpStatus.OK;
    response.sendJson({ accepted: entries.length });
}

function handleLogIngestEndpoints(server)
{
    server.handle
    ({
        routePath: "/Logs/Ingest",
        handler: ingestLogs,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST
    });
}

module.exports = { handleLogIngestEndpoints };
