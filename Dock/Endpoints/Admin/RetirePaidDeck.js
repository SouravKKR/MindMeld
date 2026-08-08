const PaidDeckRetirementService = require("../../Globals/Classes/PaidDeck/PaidDeckRetirementService");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

/**
 * POST /Admin/PaidDecks/Retire  (super-admin)
 *
 * Body: { deckId }
 *
 * Withdraws a deck from sale for good. Nobody new can acquire it by any route —
 * purchase, coupon, plan perk or an organization's auto-assign — and it can
 * never be published again under the same id.
 *
 * Everyone who already owns it keeps it for exactly as long as their licence
 * says. A finite licence runs to its own expiry and is then swept like any
 * other lapsed licence; a perpetual one never expires, so that buyer keeps the
 * deck permanently. Nothing here touches a licence, because withdrawing a
 * product from sale is not grounds for taking it back from the people who
 * bought it.
 *
 * Because the deck can never return, a finite licence that lapses cannot be
 * renewed — there is nothing left to buy.
 */
async function retirePaidDeck(request, response)
{
    const body = await request.getBody();
    const deckId = typeof body?.deckId === "string" ? body.deckId : "";

    if (deckId.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_DECK_ID });
        return;
    }

    const retirementResult = await PaidDeckRetirementService.retire(deckId, request.user?.getId() || "");

    if (!retirementResult.success)
    {
        response.statusCode = retirementResult.error === ErrorCodes.PAID_DECK_NOT_FOUND
            ? httpStatus.NOT_FOUND
            : httpStatus.CONFLICT;
        response.sendJson({ error: retirementResult.error });
        return;
    }

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        deckId: deckId,
        retiredAt: retirementResult.retiredAt,
        // Reported so the operator learns what they have just committed to:
        // these people keep the deck, and the perpetual ones keep it for good.
        holders: retirementResult.holders
    });
}

module.exports = { retirePaidDeck };
