const { getUser } = require("../Helpers/GetUser");
const PromoCodeQueryEngine = require("../../Globals/Classes/Database/PromoCodeQueryEngine");
const PromoCode = require("../../Globals/Classes/Credits/PromoCode");
const PromoCodeRedemption = require("../../Globals/Classes/Credits/PromoCodeRedemption");
const CreditLedger = require("../../Globals/Classes/Credits/CreditLedger");
const CreditConfigurationStore = require("../../Globals/Classes/Credits/CreditConfigurationStore");
const { creditTransactionTypes } = require("../../Globals/Enumerations/CreditTransactionTypes");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");

/**
 * POST /Profile/RedeemPromoCode
 *
 * Redeems a promo code for the logged-in user, granting the configured promo
 * credit amount. Three independent guards make this safe under concurrency:
 *
 *  1. claimRedemptionSlot atomically reserves a slot only while the code is
 *     enabled and usedCount < maxRedemptions — the cap can never be exceeded.
 *  2. The unique (promoCodeId, userId) index makes a second redemption by the
 *     same user impossible; a race loses the slot it claimed (released here).
 *  3. CreditLedger.grant is idempotent on `promoRedeem:{codeId}:{userId}`, so
 *     even a duplicate-delivered request never grants twice.
 *
 * Body: { codeString }
 */
async function redeemPromoCode(request, response)
{
    const user = await getUser(request);
    if (!user)
    {
        response.statusCode = httpStatus.UNAUTHORIZED;
        response.sendJson({ error: ErrorCodes.INVALID_REQUEST });
        return;
    }

    const body = await request.getBody();
    const rawCodeString = body?.codeString;
    if (typeof rawCodeString !== "string" || rawCodeString.trim().length === 0 || rawCodeString.length > 128)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_CODE });
        return;
    }

    const normalizedCodeString = PromoCode.normalizeCodeString(rawCodeString);
    const userId = user.getId();
    const email = user.getAdditionalData()?.email || "";

    const promoCode = await PromoCodeQueryEngine.getByCodeString(normalizedCodeString);
    if (!promoCode)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.PROMO_CODE_NOT_FOUND });
        return;
    }

    if (!promoCode.getEnabled())
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.PROMO_CODE_DISABLED });
        return;
    }

    // Fast path: surface an already-used code before touching the cap counter.
    // The unique redemption index is the authoritative guard against a race.
    const existingRedemption = await PromoCodeQueryEngine.findRedemption(promoCode.getId(), userId);
    if (existingRedemption)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.PROMO_CODE_ALREADY_REDEEMED });
        return;
    }

    // Atomic cap gate.
    const claimedPromoCode = await PromoCodeQueryEngine.claimRedemptionSlot(promoCode.getId());
    if (!claimedPromoCode)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.PROMO_CODE_EXHAUSTED });
        return;
    }

    const configuration = await CreditConfigurationStore.load();
    const promoGrantAmount = configuration.getPromoGrantAmount();

    const redemption = new PromoCodeRedemption
    ({
        promoCodeId: promoCode.getId(),
        codeString: promoCode.getCodeString(),
        userId: userId,
        email: email,
        creditsGranted: promoGrantAmount,
        redeemedAt: new Date()
    });

    const insertResult = await PromoCodeQueryEngine.insertRedemption(redemption);
    if (!insertResult.inserted)
    {
        // Give back the slot we reserved so usedCount stays accurate.
        await PromoCodeQueryEngine.releaseRedemptionSlot(promoCode.getId());

        if (insertResult.alreadyRedeemed)
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ error: ErrorCodes.PROMO_CODE_ALREADY_REDEEMED });
            return;
        }

        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: ErrorCodes.DATABASE_UNAVAILABLE });
        return;
    }

    const grantResult = await CreditLedger.grant
    (
        userId,
        promoGrantAmount,
        creditTransactionTypes.PROMO_GRANT,
        `promoRedeem:${promoCode.getId()}:${userId}`,
        { codeString: promoCode.getCodeString(), promoCodeId: promoCode.getId(), email: email }
    );

    if (!grantResult.applied && !grantResult.alreadyApplied)
    {
        // The grant failed hard (e.g. the user record was missing). Undo the
        // redemption row and release the slot so the user can retry cleanly.
        await PromoCodeQueryEngine.deleteRedemption(promoCode.getId(), userId);
        await PromoCodeQueryEngine.releaseRedemptionSlot(promoCode.getId());

        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: ErrorCodes.PERSIST_FAILED });
        return;
    }

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        creditsGranted: grantResult.amount,
        balanceAfter: grantResult.balanceAfter ?? null
    });
}

module.exports = { redeemPromoCode };
