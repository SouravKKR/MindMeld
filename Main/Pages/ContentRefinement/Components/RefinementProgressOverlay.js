import DialogBox from "../../../CommonComponents/DialogBox.js";

/**
 * RefinementProgressOverlay — what the reviewer looks at while a refinement is
 * being generated.
 *
 * A single proposal can take up to two minutes (the worker's own timeout) and a
 * run does that once per selected entity, in series. Before this existed the
 * only signal was the submit button's label — on the button that, until the
 * page was given a scroll container, could be off the bottom of the screen. A
 * two-minute wait with nothing on screen is indistinguishable from a hung app,
 * and the reviewer's next move is to click something else.
 *
 * Modal, and deliberately so. The passage on the right is about to be replaced
 * by whatever comes back; letting the reviewer keep editing the instruction or
 * change the selection underneath an in-flight call would mean the proposal
 * they are shown was built from something other than what the screen now says.
 *
 * INDETERMINATE, because there is no honest number to show. The server reports
 * no percentage for a single model call, and ProgressDialog — the app's other
 * progress surface — is determinate-only, so using it would mean inventing a
 * fraction and animating a lie. What IS honest is elapsed time and position in
 * the run, so that is what this shows.
 *
 * "Stop after this one" is worded literally. It does NOT abort the request in
 * flight: the worker keeps running server-side and a proposal that completes is
 * still charged. It stops the loop before the next item. A button labelled
 * "Cancel" here would be a claim about where the money went that this client is
 * in no position to make.
 */
class RefinementProgressOverlay
{
    static #ELAPSED_TICK_MILLISECONDS = 1000;

    #dialog = null;
    #elapsedTimerId = null;
    #startedAtMilliseconds = 0;
    #bStopRequested = false;

    /**
     * Opens the overlay.
     *
     * @param {object} options — totalCount (1 for a single refinement) and
     *   bAllowStop, which adds the run control only when there is a run to stop.
     */
    open({ totalCount = 1, bAllowStop = false } = {})
    {
        // #bStopRequested is deliberately NOT reset here. A run takes the
        // overlay down for each review and puts it back up afterwards, so
        // resetting on open would silently discard a stop the reviewer asked
        // for while the previous item was still being generated.
        this.#startedAtMilliseconds = Date.now();

        const stopButtonMarkup = bAllowStop
            ? `<button type="button" class="refinement-progress-stop" data-role="stop-run">Stop after this one</button>`
            : "";

        this.#dialog = DialogBox.modal(`
            <div class="refinement-progress-overlay">
                <div class="title-section">Refining your content</div>
                <div class="refinement-progress-track"><div class="refinement-progress-fill"></div></div>
                <div class="refinement-progress-status" data-role="progress-status">Preparing…</div>
                <div class="refinement-progress-elapsed" data-role="progress-elapsed">0s elapsed</div>
                ${stopButtonMarkup}
            </div>
        `);

        // Escape must not dismiss it. The call is already in flight and closing
        // the overlay would not stop it — it would only hide it.
        this.#dialog.setDismissible(false);

        const closeButton = this.#dialog.querySelector(".close-button");
        if (closeButton)
        {
            closeButton.hidden = true;
        }

        const stopButton = this.#dialog.querySelector('[data-role="stop-run"]');
        if (stopButton)
        {
            // Reopened already-stopped: the run is finishing the item in flight
            // and the button must not offer to do again what it has already done.
            if (this.#bStopRequested)
            {
                stopButton.disabled = true;
                stopButton.textContent = "Stopping after this one…";
            }

            stopButton.addEventListener("click", () =>
            {
                this.#bStopRequested = true;
                stopButton.disabled = true;
                stopButton.textContent = "Stopping after this one…";
            });
        }

        this.#elapsedTimerId = setInterval(() => this.#renderElapsed(), RefinementProgressOverlay.#ELAPSED_TICK_MILLISECONDS);

        return this;
    }

    /**
     * Updates the line under the bar. The elapsed clock restarts per item, so a
     * reviewer watching item six is told how long item six has taken rather than
     * how long they have been sitting there — the second number is discouraging
     * and says nothing about whether anything is wrong.
     */
    setStatus({ statusText, entityLabel = "", currentIndex = 0, totalCount = 1 })
    {
        if (this.#dialog === null)
        {
            return;
        }

        const positionPrefix = totalCount > 1 ? `Item ${currentIndex} of ${totalCount} — ` : "";
        const statusElement = this.#dialog.querySelector('[data-role="progress-status"]');

        if (statusElement)
        {
            statusElement.textContent = `${positionPrefix}${statusText}${entityLabel ? ` · ${entityLabel}` : ""}`;
        }

        this.#startedAtMilliseconds = Date.now();
        this.#renderElapsed();
    }

    /**
     * True once the reviewer has asked the run to stop. Read by the runner
     * between items — never mid-call, because there is nothing to stop mid-call.
     */
    isStopRequested()
    {
        return this.#bStopRequested;
    }

    /**
     * Idempotent, and safe to call from a finally. The overlay must come down
     * even when the run threw, or a failure dialog opens behind it.
     */
    close()
    {
        if (this.#elapsedTimerId !== null)
        {
            clearInterval(this.#elapsedTimerId);
            this.#elapsedTimerId = null;
        }

        if (this.#dialog !== null)
        {
            this.#dialog.close();
            this.#dialog = null;
        }
    }

    #renderElapsed()
    {
        if (this.#dialog === null)
        {
            return;
        }

        const elapsedElement = this.#dialog.querySelector('[data-role="progress-elapsed"]');

        if (elapsedElement)
        {
            const elapsedSeconds = Math.floor((Date.now() - this.#startedAtMilliseconds) / 1000);
            elapsedElement.textContent = `${elapsedSeconds}s elapsed`;
        }
    }
}

export default RefinementProgressOverlay;
