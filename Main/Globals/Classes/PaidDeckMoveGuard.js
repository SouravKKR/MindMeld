/**
 * PaidDeckMoveGuard
 *
 * Decides whether an entity may be re-homed into a different deck.
 *
 * Paid content is protected by two things that both hang off the OWNING DECK's
 * `additionalData.paidDeckId` tag: the client refuses to export a paid subtree,
 * and the model routes edits into encrypted overlays instead of overwriting the
 * seller's fields. Move a paid card into a normal deck and both protections
 * evaporate, because the card is now judged by its new deck's tag.
 *
 * The rule is therefore simply: an entity's paid tag may not change. A move
 * within the same paid deck (or between two decks of the same purchase) is
 * fine; a move that crosses a paid boundary in either direction is not.
 *
 * ── The re-stamp trap ─────────────────────────────────────────────────────
 *
 * Deck.addCard / addStudyMaterial / addMockTest call setDeckId on every entity
 * they adopt — including while LOADING a deck from disk and while applying a
 * bulk snapshot. Those calls pass the entity's existing deck, so they are
 * same-tag re-stamps, and the guard must allow them. A guard that only compared
 * deck IDS rather than paid tags would refuse them and break loading outright.
 */
class PaidDeckMoveGuard
{
    /**
     * The paid tag governing a deck, or "" when it is a normal deck.
     */
    static getPaidTag(deck)
    {
        return deck?.getAdditionalData?.()?.paidDeckId || "";
    }

    /**
     * Whether an entity currently in `currentDeck` may be moved into
     * `targetDeck`.
     *
     * @param {object} currentDeck the entity's current owning deck (may be null
     *   for an entity being created, which is always allowed)
     * @param {object} targetDeck the deck it is being moved into
     *
     * @returns {boolean} true when the move keeps the entity under the same
     *   paid tag (including "no tag" on both sides)
     */
    static canMove(currentDeck, targetDeck)
    {
        const currentPaidTag = PaidDeckMoveGuard.getPaidTag(currentDeck);
        const targetPaidTag = PaidDeckMoveGuard.getPaidTag(targetDeck);

        // A brand-new entity has no current deck yet — nothing to protect.
        if (!currentDeck)
        {
            return true;
        }

        return currentPaidTag === targetPaidTag;
    }

    /**
     * The sentence to show a learner when a move is refused.
     */
    static explainRefusal()
    {
        return "Content in a purchased deck has to stay in that deck — it can't be moved into another one.";
    }
}

export default PaidDeckMoveGuard;
