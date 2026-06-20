import DialogBox from "../../../CommonComponents/DialogBox.js";

/**
 * Shared user-facing presentation for credit-related outcomes. Keeps the
 * "out of credits" message identical across every call site (generation,
 * analysis, mock-test grading) so the 402 response surfaces as one friendly
 * dialog rather than a raw error string.
 */
class CreditNotice
{
    static INSUFFICIENT_CREDITS_ERROR = "INSUFFICIENT_CREDITS";

    /**
     * Shows the appropriate dialog for a blocked 402 response. `detail` is the
     * parsed body: { error, balance, required }. A SERVICE_DISABLED reason
     * shows an "unavailable" dialog; anything else shows "Out of Credits".
     * All fields are optional — the message degrades gracefully when absent.
     * @param {{ error?: string, balance?: number, required?: number }} detail
     */
    static async showInsufficientCredits(detail = {})
    {
        if (detail && detail.error === "SERVICE_DISABLED")
        {
            await DialogBox.alert("Feature Unavailable", "This feature is currently turned off. Please try again later.");
            return;
        }

        const balance = typeof detail.balance === "number" ? detail.balance : null;
        const required = typeof detail.required === "number" ? detail.required : null;

        let message = "You don't have enough credits for this action.";
        if (balance !== null)
        {
            message += ` Your balance is ${CreditNotice.#format(balance)} credit${balance === 1 ? "" : "s"}`;
            message += (required !== null && required > 0)
                ? `, and this needs at least ${CreditNotice.#format(required)}.`
                : ".";
        }

        // When the server saved a resumable task, tell the user where to pick
        // it back up after topping up.
        if (detail && detail.resumable === true)
        {
            message += " Your task has been saved — resume it from the Home page once you have enough credits.";
        }

        // Offer a direct path to top up rather than sending the user hunting
        // through Settings. Returns true when the user chose to buy credits.
        const wantsToBuy = await CreditNotice.#showBuyOrDismiss("Out of Credits", message);
        if (wantsToBuy)
        {
            // Dynamic import keeps CreditNotice free of a static dependency on
            // the purchase flow (which itself surfaces credit notices), avoiding
            // a module-load cycle.
            const { default: CreditPurchaseFlow } = await import("./CreditPurchaseFlow.js");
            return await CreditPurchaseFlow.run();
        }

        return false;
    }

    /**
     * Shows a two-action dialog: "Buy Credits" (primary) and "Not now".
     * Resolves true when the user picks Buy Credits, false otherwise.
     * Built directly on the dialog-box element so it can carry custom button
     * labels (DialogBox.confirm only offers Ok/Cancel).
     * @returns {Promise<boolean>}
     */
    static #showBuyOrDismiss(title, message)
    {
        const dialog = document.createElement("dialog-box");
        dialog.innerHTML =
        `
            <div class="title-section">${title}</div>
            <div class="message-section">${message}</div>
            <div class="button-section">
                <button class="ok-button credit-notice-buy-button">Buy Credits</button>
                <button class="cancel-button">Not now</button>
            </div>
        `;

        return new Promise((resolve) =>
        {
            const buyButton = dialog.querySelector(".credit-notice-buy-button");
            const dismissButton = dialog.querySelector(".cancel-button");

            buyButton.addEventListener("click", () =>
            {
                dialog.close();
                resolve(true);
            });

            dismissButton.addEventListener("click", () =>
            {
                dialog.close();
                resolve(false);
            });

            document.body.appendChild(dialog);
        });
    }

    /**
     * True when a caught error originated from a 402 INSUFFICIENT_CREDITS
     * response (as tagged by the queueing helpers).
     * @param {any} error
     */
    static isInsufficientCreditsError(error)
    {
        return Boolean(error && error.insufficientCredits === true);
    }

    static #format(value)
    {
        return Math.round(value * 100) / 100;
    }
}

export default CreditNotice;
