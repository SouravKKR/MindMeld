const PromoCodeQueryEngine = require("../../../Globals/Classes/Database/PromoCodeQueryEngine");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");

/**
 * POST /Admin/Credits/Promo/Create
 *
 * Creates a single promo code with the exact code string the admin typed. The
 * code is normalized (uppercased, trimmed) and the unique index forbids a
 * duplicate — a collision returns PROMO_CODE_ALREADY_EXISTS.
 *
 * Body: { codeString, maxRedemptions }
 */
async function createPromoCode(request, response)
{
    const body = await request.getBody();
    const codeString = body?.codeString;
    const maxRedemptions = parseInt(body?.maxRedemptions, 10);

    if (typeof codeString !== "string" || codeString.trim().length === 0 || codeString.length > 128)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_CODE });
        return;
    }

    if (isNaN(maxRedemptions) || maxRedemptions < 1)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_COUNT });
        return;
    }

    const result = await PromoCodeQueryEngine.createPromoCode
    ({
        codeString: codeString,
        maxRedemptions: maxRedemptions,
        createdByUserId: request.user ? request.user.getId() : ""
    });

    if (!result.success)
    {
        response.statusCode = result.reason === ErrorCodes.PROMO_CODE_ALREADY_EXISTS ? httpStatus.CONFLICT : httpStatus.BAD_REQUEST;
        response.sendJson({ error: result.reason });
        return;
    }

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, promoCode: result.promoCode.toJson() });
}

module.exports = { createPromoCode };
