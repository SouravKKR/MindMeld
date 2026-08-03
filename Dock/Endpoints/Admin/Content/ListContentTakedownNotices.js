const ContentTakedownNoticeQueryEngine = require("../../../Globals/Classes/Database/ContentTakedownNoticeQueryEngine");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");

/**
 * GET /Admin/Content/TakedownNotices?limit=&offset=
 *
 * Reads the append-only content-takedown register, newest first. This is the
 * record produced when a rightsholder or regulator asks what was removed, when
 * and on whose notice — so it is a plain read with no filtering that could hide
 * an entry.
 */
async function listContentTakedownNotices(request, response)
{
    const MAXIMUM_PAGE_SIZE = 200;
    const DEFAULT_PAGE_SIZE = 50;

    const queryParams = await request.getQueryParams();

    const requestedLimit = Number.parseInt(queryParams.limit, 10);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, MAXIMUM_PAGE_SIZE)
        : DEFAULT_PAGE_SIZE;

    const requestedOffset = Number.parseInt(queryParams.offset, 10);
    const offset = Number.isFinite(requestedOffset) && requestedOffset > 0 ? requestedOffset : 0;

    try
    {
        const registerPage = await ContentTakedownNoticeQueryEngine.list(limit, offset);
        response.statusCode = httpStatus.OK;
        response.sendJson({
            notices: registerPage.notices,
            totalCount: registerPage.totalCount,
            limit: limit,
            offset: offset
        });
    }
    catch (listError)
    {
        console.error(`[ListContentTakedownNotices] ${listError.message}`);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: listError.message || "Failed to list takedown notices." });
    }
}

module.exports = { listContentTakedownNotices };
