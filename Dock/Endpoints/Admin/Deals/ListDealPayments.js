const CreditDealPaymentQueryEngine = require("../../../Globals/Classes/Credits/CreditDealPaymentQueryEngine");
const { creditDealTargetTypes } = require("../../../Globals/Enumerations/CreditDealTargetTypes");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");

/**
 * GET /Admin/Credits/Deals/List?targetType=&targetId=
 *
 * Lists every deal/invoice record attached to a target (a periodic assignment
 * or a fixed grant), newest first.
 */
async function listDealPayments(request, response)
{
    const queryParameters = await request.getQueryParams();
    const targetType = parseInt(queryParameters["targetType"], 10);
    const targetId = queryParameters["targetId"];

    if (!Object.values(creditDealTargetTypes).includes(targetType) || targetType === creditDealTargetTypes.UNKNOWN || typeof targetId !== "string" || targetId.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_REQUEST });
        return;
    }

    const deals = await CreditDealPaymentQueryEngine.listForTarget(targetType, targetId);
    response.statusCode = httpStatus.OK;
    response.sendJson({ deals: deals.map(deal => deal.toJson()) });
}

module.exports = { listDealPayments };
