const PromoCodeQueryEngine = require("../../../Globals/Classes/Database/PromoCodeQueryEngine");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");

/**
 * POST /Admin/Credits/Promo/SetEnabled
 *
 * Enables or disables a promo code without deleting it. A disabled code can no
 * longer be redeemed (claimRedemptionSlot requires enabled:true) but its
 * redemption history is preserved.
 *
 * Body: { promoCodeId, enabled }
 */
async function setPromoCodeEnabled(request, response)
{
    const body = await request.getBody();
    const promoCodeId = body?.promoCodeId;
    const enabled = body?.enabled;

    if (typeof promoCodeId !== "string" || promoCodeId.trim().length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_ID });
        return;
    }

    if (typeof enabled !== "boolean")
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_REQUEST });
        return;
    }

    const result = await PromoCodeQueryEngine.setEnabled(promoCodeId.trim(), enabled);

    if (!result.success)
    {
        response.statusCode = result.reason === ErrorCodes.PROMO_CODE_NOT_FOUND ? httpStatus.NOT_FOUND : httpStatus.BAD_REQUEST;
        response.sendJson({ error: result.reason });
        return;
    }

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true });
}

module.exports = { setPromoCodeEnabled };
