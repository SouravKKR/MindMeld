const CreditGrantTargetResolver = require("../../Globals/Classes/Credits/CreditGrantTargetResolver");
const CreditGrantExecutor = require("../../Globals/Classes/Credits/CreditGrantExecutor");
const OrganizationPoolGrantService = require("../../Globals/Classes/Credits/OrganizationPoolGrantService");
const { creditGrantTargetTypes } = require("../../Globals/Enumerations/CreditGrantTargetTypes");
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
 * An ORGANIZATION_POOL target credits that organization's pool instead, which
 * is how an institute is topped up: it buys credits as a block and decides
 * itself who gets them. Idempotent on the same grantKey through the pool
 * ledger's reference key, so a retried apply credits once.
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

    if (typeof grantKey !== "string" || grantKey.trim().length < 8 || grantKey.length > 128)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_GRANT_KEY });
        return;
    }

    // Checked BEFORE the amount-mode validation, which a pool grant has no use
    // for: one recipient means there is nothing to divide.
    if (target.targetType === creditGrantTargetTypes.ORGANIZATION_POOL)
    {
        const poolResult = await OrganizationPoolGrantService.apply
        ({
            organizationId: typeof target.organizationId === "string" ? target.organizationId : "",
            amountCredits: amount,
            grantKey: grantKey.trim(),
            reason: reason,
            grantedByUserId: request.user ? request.user.getId() : ""
        });

        if (!poolResult.success)
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ error: poolResult.error });
            return;
        }

        response.statusCode = httpStatus.OK;
        response.sendJson
        ({
            success: true,
            // An explicit marker rather than leaving the client to infer the
            // shape from which fields are present. `balanceAfter` is null when
            // the replayed movement never settled, and inferring from it would
            // then send the panel down the recipient-summary path and render
            // "granted undefined credits to undefined users".
            poolTopUp: true,
            organizationId: target.organizationId,
            amount: poolResult.amount,
            balanceAfter: poolResult.balanceAfter,
            alreadyApplied: poolResult.alreadyApplied === true,
            // Zeroed on purpose rather than omitted: the panel reads these to
            // report an outcome, and a missing count would render as "undefined
            // recipients credited".
            grantedCount: 0,
            alreadyAppliedCount: 0,
            failedCount: 0,
            unmatchedEmails: []
        });
        return;
    }

    if (!Object.values(creditGrantAmountModes).includes(amountMode) || amountMode === creditGrantAmountModes.UNKNOWN)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_AMOUNT_MODE });
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
