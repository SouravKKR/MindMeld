/**
 * Discriminator for the different kinds of steps a tutorial can include.
 *
 *   MODAL          - centred explanation card, no DOM target
 *   HIGHLIGHT      - spotlight a real element on the page + tooltip,
 *                    advance with the Next button
 *   WAIT_FOR_CLICK - spotlight a real element and advance only when the
 *                    user actually clicks (or taps) it; useful for
 *                    "try it yourself"-style steps
 *   WAIT_FOR_EVENT - spotlight a real element and advance only when the
 *                    given window-level event fires. Use this when a
 *                    click alone is not enough proof of completion (for
 *                    example, "save the deck" — clicking Save may bounce
 *                    off validation, so we wait for the success event)
 *   IFRAME         - full-area iframe loading a tutorial URL (e.g. a
 *                    sandboxed micro-app); user advances via the
 *                    overlay's Next button
 */
export const tutorialStepTypes =
{
    MODAL:          0,
    HIGHLIGHT:      1,
    WAIT_FOR_CLICK: 2,
    IFRAME:         3,
    WAIT_FOR_EVENT: 4
};
