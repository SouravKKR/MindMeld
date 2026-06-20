import DialogBox from "./DialogBox.js";


/**
 * ProgressDialog
 *
 * Modal dialog with a determinate progress bar and a status line, used by
 * long-running synchronous-feeling flows like deck import and export where
 * the user otherwise sees a frozen UI. The dialog has no close button —
 * the caller controls its lifetime via close().
 *
 * Usage:
 *     const progress = ProgressDialog.show("Exporting deck");
 *     progress.setProgress(0.25, "Collecting decks");
 *     ...
 *     progress.close();
 *
 * setProgress accepts a fraction in [0, 1]. Calling close() while the
 * dialog is already closed is a no-op so callers can use it in finally
 * blocks without guarding.
 */
class ProgressDialog
{
    #dialog = null;
    #barFill = null;
    #percentLabel = null;
    #statusLabel = null;
    #bClosed = false;

    static show(title)
    {
        const instance = new ProgressDialog();
        instance.#mount(title);
        return instance;
    }

    #mount(title)
    {
        this.#dialog = DialogBox.modal(`
            <div class="progress-dialog-content">
                <h2 class="progress-dialog-title">${title}</h2>
                <div class="progress-dialog-bar-track">
                    <div class="progress-dialog-bar-fill"></div>
                </div>
                <div class="progress-dialog-footer">
                    <span class="progress-dialog-status">Starting...</span>
                    <span class="progress-dialog-percent">0%</span>
                </div>
            </div>
        `);

        // Hide the auto-injected close button — the caller controls lifetime.
        const closeButton = this.#dialog.querySelector(".close-button");
        if (closeButton)
        {
            closeButton.style.display = "none";
        }

        this.#barFill = this.#dialog.querySelector(".progress-dialog-bar-fill");
        this.#percentLabel = this.#dialog.querySelector(".progress-dialog-percent");
        this.#statusLabel = this.#dialog.querySelector(".progress-dialog-status");
    }

    /**
     * Updates the progress bar.
     * @param {number} fraction Value in [0, 1].
     * @param {string} [statusText] Optional status text. If omitted, the current text is kept.
     */
    setProgress(fraction, statusText)
    {
        if (this.#bClosed)
        {
            return;
        }

        const clampedFraction = Math.max(0, Math.min(1, fraction));
        const percent = Math.round(clampedFraction * 100);

        this.#barFill.style.width = `${percent}%`;
        this.#percentLabel.textContent = `${percent}%`;

        if (typeof statusText === "string")
        {
            this.#statusLabel.textContent = statusText;
        }
    }

    /**
     * Updates progress, then yields to the browser so the new bar width
     * actually paints before the next synchronous chunk of work runs.
     * Awaiting this between heavy phases is what makes the dialog feel
     * live instead of jumping from 0 to 100 at the end.
     */
    async setProgressAndYield(fraction, statusText)
    {
        this.setProgress(fraction, statusText);
        await new Promise(resolve => requestAnimationFrame(() => resolve()));
        await new Promise(resolve => setTimeout(resolve, 0));
    }

    close()
    {
        if (this.#bClosed)
        {
            return;
        }
        this.#bClosed = true;
        this.#dialog?.close();
        this.#dialog = null;
    }
}

export default ProgressDialog;
