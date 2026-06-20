const PromoCodeQueryEngine = require("../../../Globals/Classes/Database/PromoCodeQueryEngine");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");

/**
 * POST /Admin/Credits/Promo/Delete
 *
 * Retires a promo code and clears its redemption rows. Credits already granted
 * to past redeemers are intentionally NOT clawed back — deletion only prevents
 * future use.
 *
 * Body: { promoCodeId }
 */
async function deletePromoCode(request, response)
{
    const body = await request.getBody();
    const promoCodeId = body?.promoCodeId;

    if (typeof promoCodeId !== "string" || promoCodeId.trim().length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_ID });
        return;
    }

    const result = await PromoCodeQueryEngine.deletePromoCode(promoCodeId.trim());

    if (!result.success)
    {
        response.statusCode = result.reason === ErrorCodes.PROMO_CODE_NOT_FOUND ? httpStatus.NOT_FOUND : httpStatus.BAD_REQUEST;
        response.sendJson({ error: result.reason });
        return;
    }

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true });
}

module.exports = { deletePromoCode };
