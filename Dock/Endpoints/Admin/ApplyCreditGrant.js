const CreditGrantTargetResolver = require("../../Globals/Classes/Credits/CreditGrantTargetResolver");
const CreditGrantExecutor = require("../../Globals/Classes/Credits/CreditGrantExecutor");
const { creditGrantAmountModes } = require("../../Globals/Enumerations/CreditGrantAmountModes");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");

/**
 * POST /Admin/Credits/Grant/Apply
 *
 * Applies an admin credit grant. The target is re-resolved server-side (the
 * preview is advisory, never trusted) and every recipient is granted through
 * CreditLedger with type ADMIN_ADJUSTMENT. The client-supplied grantKey makes
 * the whole operation idempotent: replaying the same grantKey grants nothing
 * twice, so a timed-out apply can be retried safely.
 *
 * Body: { target: { targetType, emails?, filter?, organizationId? }, amount, amountMode, grantKey, reason? }
 */
async function applyCreditGrant(request, response)
{
    const body = await request.getBody();
    const target = body?.target;
    const amount = parseFloat(body?.amount);
    const amountMode = body?.amountMode;
    const grantKey = body?.grantKey;
    const reason = body?.reason;

    if (!target || typeof target !== "object")
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_TARGET });
        return;
    }

    if (!isFinite(amount) || amount <= 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_AMOUNT });
        return;
    }

    if (!Object.values(creditGrantAmountModes).includes(amountMode) || amountMode === creditGrantAmountModes.UNKNOWN)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_AMOUNT_MODE });
        return;
    }

    if (typeof grantKey !== "string" || grantKey.trim().length < 8 || grantKey.length > 128)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_GRANT_KEY });
        return;
    }

    const resolution = await CreditGrantTargetResolver.resolve(target);
    if (resolution.error)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: resolution.error });
        return;
    }

    if (resolution.recipients.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.NO_MATCHING_USERS, unmatchedEmails: resolution.unmatchedEmails });
        return;
    }

    const perUserAmount = CreditGrantExecutor.computePerUserAmount(amount, amountMode, resolution.recipients.length);
    if (perUserAmount <= 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.AMOUNT_TOO_SMALL_TO_SPLIT });
        return;
    }

    const results = await CreditGrantExecutor.execute
    ({
        recipients: resolution.recipients,
        perUserAmount: perUserAmount,
        grantKey: grantKey.trim(),
        reason: reason,
        grantedByUserId: request.user ? request.user.getId() : "",
        targetType: target.targetType,
        organizationId: typeof target.organizationId === "string" ? target.organizationId : ""
    });

    const grantedCount = results.filter(result => result.applied && !result.alreadyApplied).length;
    const alreadyAppliedCount = results.filter(result => result.alreadyApplied).length;
    const failedCount = results.length - grantedCount - alreadyAppliedCount;

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        perUserAmount: perUserAmount,
        totalGranted: Math.round(perUserAmount * grantedCount * 10000) / 10000,
        grantedCount: grantedCount,
        alreadyAppliedCount: alreadyAppliedCount,
        failedCount: failedCount,
        unmatchedEmails: resolution.unmatchedEmails,
        results: results
    });
}

module.exports = { applyCreditGrant };
