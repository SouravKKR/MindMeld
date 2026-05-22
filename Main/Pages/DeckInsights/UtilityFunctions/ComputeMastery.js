import Deck from "../../../Globals/Model/Deck.js";
/**
 * Computes the mastery of a deck by averaging the progress of all cards in the deck.
 * @param {Deck} deck - The deck to compute the mastery of.
 * @returns {Number} The computed mastery of the deck.
 */
export function computeMastery(deck, date = new Date())
{
    const allCards = deck.getCards(true);

    if(allCards.length == 0) return 0.0;

    let sum = 0.0;
    let count = 0;

    for(const card of allCards)
    {
        const progressPoint = card.getProgress().getProgressPointOnDate(date);
        const fsrsState = progressPoint.getFsrsState();
        const glickoState = progressPoint.getGlickoState();
        const baseDifficulty = card.getBaseDifficulty();

        const bConsider = fsrsState["repetitions"] == 0 ? 0 : 1;
        const attemptWeight = 1 / (glickoState["ratingDeviation"]);

        const clampedRating = Math.min(Math.max(glickoState["rating"], 1000), baseDifficulty + 180);

        const normalizedRating = (clampedRating - 1000) / (baseDifficulty + 180 - 1000);

        sum += bConsider * normalizedRating * attemptWeight;
        count += attemptWeight;
    }

    if(count == 0) return 0.0;

    return sum / count;
}