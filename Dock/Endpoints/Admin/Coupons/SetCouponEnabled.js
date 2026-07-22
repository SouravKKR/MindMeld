const CouponQueryEngine = require("../../../Globals/Classes/Database/CouponQueryEngine");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");

/**
 * POST /Admin/Coupons/SetEnabled
 *
 * Enables or disables a coupon. A disabled coupon is refused by
 * claimRedemptionSlot; existing redemptions are preserved.
 *
 * Body: { couponId, enabled }
 */
async function setCouponEnabled(request, response)
{
    const body = await request.getBody();
    const couponId = body?.couponId;

    if (typeof couponId !== "string" || couponId.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_ID });
        return;
    }

    const result = await CouponQueryEngine.setEnabled(couponId, Boolean(body?.enabled));
    if (!result.success)
    {
        response.statusCode = result.reason === ErrorCodes.COUPON_NOT_FOUND ? httpStatus.NOT_FOUND : httpStatus.BAD_REQUEST;
        response.sendJson({ error: result.reason });
        return;
    }

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true });
}

module.exports = { setCouponEnabled };
