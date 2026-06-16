import DialogBox from "../../../CommonComponents/DialogBox.js";
import CreditPurchaseFlow from "./CreditPurchaseFlow.js";
import CreditNotice from "./CreditNotice.js";
import TaskStateClient from "../TaskStateClient.js";
import PageNavigator from "../PageNavigator.js";

/**
 * OutOfCreditsResumeFlow
 *
 * Drives the "you ran out of credits mid-generation" recovery experience:
 *   - present(): a popup offering "Top up now" or "Later".
 *       Top up now -> the existing Buy Credits UI; on success, a "Continue"
 *       prompt that resumes the saved generation right away.
 *       Later -> dismiss; the generation stays saved as a resumable TaskState
 *       the user can continue from the Activity page or the Home banner.
 *   - resumeAndOpenProgress(): re-submits the saved generation and opens the
 *     progress page for the new run. Shared by the Continue prompt and the
 *     PausedTaskBanner.
 *
 * The backend saves the resumable TaskState when a generation stops on
 * INSUFFICIENT_CREDITS (see Dock Generate.js); this class only consumes it.
 */
class OutOfCreditsResumeFlow
{
    static #PROGRESS_PAGE_TAG = "progress-page";

    /**
     * Shows the out-of-credits popup and drives the chosen path. Safe to call
     * from a progress page that has just detected a credit stop.
     */
    static async present()
    {
        const choice = await OutOfCreditsResumeFlow.#showChoiceDialog();

        if (choice !== "topup")
        {
            // "Later" (or dismissed): leave the saved state in place so the
            // user can resume from Activity / Home whenever they top up.
            return;
        }

        const bPurchased = await CreditPurchaseFlow.run();
        if (!bPurchased)
        {
            // Cancelled or failed payment — the saved state is untouched.
            return;
        }

        const bContinueNow = await DialogBox.confirm(
            "Purchase complete",
            "Your credits have been added. Continue your generation now?"
        );
        if (bContinueNow)
        {
            await OutOfCreditsResumeFlow.resumeAndOpenProgress();
        }
    }

    /**
     * Re-submits the saved generation and opens the progress page for the new
     * run. Returns true when the resume request was accepted.
     * @returns {Promise<boolean>}
     */
    static async resumeAndOpenProgress()
    {
        const taskState = await TaskStateClient.fetch();
        if (!taskState)
        {
            await DialogBox.alert(
                "Nothing to resume",
                "We couldn't find a saved generation to continue. It may have already finished or expired."
            );
            return false;
        }

        let response;
        try
        {
            response = await TaskStateClient.resume(taskState);
        }
        catch (resumeError)
        {
            await DialogBox.alert("Resume failed", "We couldn't resume your generation. Please try again in a moment.");
            return false;
        }

        if (response.status === 402)
        {
            // Still short on credits (e.g. balance changed since the top-up).
            const insufficientDetail = await response.json().catch(() => ({}));
            await CreditNotice.showInsufficientCredits(insufficientDetail);
            return false;
        }

        if (!response.ok)
        {
            await DialogBox.alert("Resume failed", "We couldn't resume your generation. Please try again in a moment.");
            return false;
        }

        const responseBody = await response.json().catch(() => ({}));
        const newTaskId = responseBody && typeof responseBody.taskId === "string" ? responseBody.taskId : null;

        // The saved state has been consumed — discard it so it doesn't linger
        // as a stale "paused" entry. If the resumed run stops on credits again
        // the backend writes a fresh one.
        await TaskStateClient.discard();

        if (!newTaskId)
        {
            await DialogBox.alert(
                "Generation resumed",
                "Your generation has resumed. You can track it from the Activity page."
            );
            return true;
        }

        PageNavigator.open(OutOfCreditsResumeFlow.#PROGRESS_PAGE_TAG, newTaskId);
        return true;
    }

    /**
     * Renders the two-choice popup and resolves "topup" | "later". Closing the
     * dialog (X) is treated as "later".
     * @returns {Promise<string>}
     */
    static #showChoiceDialog()
    {
        return new Promise((resolve) =>
        {
            const dialog = DialogBox.modal(`
                <style>
                    .out-of-credits-dialog { display: flex; flex-direction: column; gap: 14px; max-width: 420px; padding: 4px 4px 8px; }
                    .out-of-credits-dialog-title { font-size: 18px; font-weight: 700; color: var(--primary-text-color); }
                    .out-of-credits-dialog-message { font-size: 14px; line-height: 1.5; color: var(--secondary-text-color); }
                    .out-of-credits-dialog-buttons { display: flex; gap: 12px; justify-content: flex-end; margin-top: 8px; }
                    .out-of-credits-dialog-buttons button { padding: 9px 16px; border-radius: 8px; border: none; cursor: pointer; font-weight: 600; font-size: 13px; }
                    .out-of-credits-dialog-later { background: transparent; outline: 1px solid var(--outline-color-strong); outline-offset: -1px; color: var(--primary-text-color); }
                    .out-of-credits-dialog-later:hover { background-color: var(--tertiary-background-color); }
                    .out-of-credits-dialog-topup { background: var(--primary-background-gradient); color: var(--primary-text-color); }
                </style>
                <div class="out-of-credits-dialog">
                    <div class="out-of-credits-dialog-title">You ran out of credits</div>
                    <div class="out-of-credits-dialog-message">
                        Your generation paused because your credits ran out. Top up now to
                        continue right away, or do it later — we've saved your generation so
                        you can continue it from the Activity page whenever you're ready.
                    </div>
                    <div class="out-of-credits-dialog-buttons">
                        <button class="out-of-credits-dialog-later" type="button">Later</button>
                        <button class="out-of-credits-dialog-topup" type="button">Top up now</button>
                    </div>
                </div>
            `);

            let bResolved = false;
            const settle = (choice) =>
            {
                if (bResolved)
                {
                    return;
                }
                bResolved = true;
                resolve(choice);
            };

            dialog.querySelector(".out-of-credits-dialog-topup").addEventListener("click", () =>
            {
                settle("topup");
                dialog.close();
            });

            dialog.querySelector(".out-of-credits-dialog-later").addEventListener("click", () =>
            {
                settle("later");
                dialog.close();
            });

            const closeButton = dialog.querySelector(".close-button");
            if (closeButton)
            {
                closeButton.addEventListener("click", () => settle("later"));
            }
        });
    }
}

export default OutOfCreditsResumeFlow;
