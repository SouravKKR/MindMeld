const CouponQueryEngine = require("../../../Globals/Classes/Database/CouponQueryEngine");
const { buildCouponTemplate } = require("./CouponAdminHelper");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");

/**
 * POST /Admin/Coupons/CreateBulk
 *
 * Creates many coupons from a base string (base "SALE", count 3 → SALE1, SALE2,
 * SALE3), all sharing the same benefit template. Collisions are skipped and
 * reported.
 *
 * Body: { baseString, count, <same benefit fields as Create> }
 */
async function createCouponsBulk(request, response)
{
    const body = await request.getBody();
    const baseString = body?.baseString;
    const count = parseInt(body?.count, 10);

    if (typeof baseString !== "string" || baseString.trim().length === 0 || baseString.length > 64)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_CODE });
        return;
    }

    if (isNaN(count) || count < 1)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_COUNT });
        return;
    }

    const templateResult = buildCouponTemplate(body, request.user ? request.user.getId() : "", Date.now());
    if (!templateResult.ok)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: templateResult.reason });
        return;
    }

    const result = await CouponQueryEngine.createCouponsBulk({ baseString: baseString, count: count, template: templateResult.template });
    if (!result.success)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: result.reason });
        return;
    }

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, created: result.created, skipped: result.skipped });
}

module.exports = { createCouponsBulk };
