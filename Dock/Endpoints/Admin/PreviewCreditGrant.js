const CreditGrantTargetResolver = require("../../Globals/Classes/Credits/CreditGrantTargetResolver");
const CreditGrantExecutor = require("../../Globals/Classes/Credits/CreditGrantExecutor");
const { creditGrantAmountModes } = require("../../Globals/Enumerations/CreditGrantAmountModes");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");

/**
 * POST /Admin/Credits/Grant/Preview
 *
 * Dry-runs an admin credit grant: resolves the target specification to the
 * concrete recipient list and computes the per-user amount, without touching
 * any balance. The admin panel shows this before the confirm step so the
 * blast radius (and any unmatched emails) is explicit.
 *
 * Body: { target: { targetType, emails?, filter?, organizationId? }, amount, amountMode }
 */
async function previewCreditGrant(request, response)
{
    const body = await request.getBody();
    const target = body?.target;
    const amount = parseFloat(body?.amount);
    const amountMode = body?.amountMode;

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

    const resolution = await CreditGrantTargetResolver.resolve(target);
    if (resolution.error)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: resolution.error });
        return;
    }

    const perUserAmount = CreditGrantExecutor.computePerUserAmount(amount, amountMode, resolution.recipients.length);
    const totalAmount = Math.round(perUserAmount * resolution.recipients.length * 10000) / 10000;

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        recipients: resolution.recipients,
        unmatchedEmails: resolution.unmatchedEmails,
        recipientCount: resolution.recipients.length,
        perUserAmount: perUserAmount,
        totalAmount: totalAmount
    });
}

module.exports = { previewCreditGrant };
