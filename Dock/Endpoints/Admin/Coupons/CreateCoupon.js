const CouponQueryEngine = require("../../../Globals/Classes/Database/CouponQueryEngine");
const Coupon = require("../../../Globals/Classes/Coupons/Coupon");
const { buildCouponTemplate } = require("./CouponAdminHelper");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");

/**
 * POST /Admin/Coupons/Create
 *
 * Creates a single coupon carrying one benefit (discount / grant). The code is
 * normalized (uppercased, trimmed); the unique index forbids a duplicate.
 *
 * Body: { codeString, benefitTarget, benefitKind, benefitValue, maxRedemptions,
 *         redemptionWindowDurationValue, redemptionWindowDurationUnit,
 *         benefitSpanValue, benefitSpanUnit, targetPlanTier?, targetDeckId?,
 *         providerOfferId?, enabled? }
 */
async function createCoupon(request, response)
{
    const body = await request.getBody();
    const codeString = body?.codeString;

    if (typeof codeString !== "string" || codeString.trim().length === 0 || codeString.length > 128)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_CODE });
        return;
    }

    const templateResult = buildCouponTemplate(body, request.user ? request.user.getId() : "", Date.now());
    if (!templateResult.ok)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: templateResult.reason });
        return;
    }

    const coupon = new Coupon({ ...templateResult.template, codeString: codeString });
    const result = await CouponQueryEngine.createCoupon(coupon);

    if (!result.success)
    {
        response.statusCode = result.reason === ErrorCodes.COUPON_ALREADY_EXISTS ? httpStatus.CONFLICT : httpStatus.BAD_REQUEST;
        response.sendJson({ error: result.reason });
        return;
    }

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, coupon: result.coupon.toJson() });
}

module.exports = { createCoupon };
