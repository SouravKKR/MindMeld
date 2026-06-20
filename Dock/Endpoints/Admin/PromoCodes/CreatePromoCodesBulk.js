const PromoCodeQueryEngine = require("../../../Globals/Classes/Database/PromoCodeQueryEngine");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");

/**
 * POST /Admin/Credits/Promo/CreateBulk
 *
 * Creates `count` codes from a base string, appending 1..count with no
 * separator (base "LAUNCH", count 3 -> LAUNCH1, LAUNCH2, LAUNCH3). Each code
 * carries the same maxRedemptions. Codes that collide with an existing code
 * are skipped and reported back so the admin sees exactly what was created.
 *
 * Body: { baseString, count, maxRedemptions }
 */
async function createPromoCodesBulk(request, response)
{
    const body = await request.getBody();
    const baseString = body?.baseString;
    const count = parseInt(body?.count, 10);
    const maxRedemptions = parseInt(body?.maxRedemptions, 10);

    if (typeof baseString !== "string" || baseString.trim().length === 0 || baseString.length > 64)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_CODE });
        return;
    }

    if (isNaN(count) || count < 1 || count > PromoCodeQueryEngine.MAX_BULK_CREATE_COUNT)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_COUNT });
        return;
    }

    if (isNaN(maxRedemptions) || maxRedemptions < 1)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_COUNT });
        return;
    }

    const result = await PromoCodeQueryEngine.createPromoCodesBulk
    ({
        baseString: baseString,
        count: count,
        maxRedemptions: maxRedemptions,
        createdByUserId: request.user ? request.user.getId() : ""
    });

    if (!result.success)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: result.reason });
        return;
    }

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, created: result.created, skipped: result.skipped });
}

module.exports = { createPromoCodesBulk };
