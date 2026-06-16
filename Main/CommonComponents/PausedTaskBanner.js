import TaskStateClient from "../Globals/Classes/TaskStateClient.js";
import CreditNotice from "../Globals/Classes/Credits/CreditNotice.js";
import DialogBox from "./DialogBox.js";
import PageNavigator from "../Globals/Classes/PageNavigator.js";
import { taskTypes } from "../Globals/Enumerations/TaskTypes.js";
import { enumerationToTitleCase } from "../Globals/UtilityFunctions/EnumerationToTitleCase.js";

/**
 * PausedTaskBanner
 *
 * Self-contained banner that surfaces the user's single paused task (saved
 * when a run was blocked for credits). On connect it fetches /TaskState and
 * renders Resume / Discard only when a state exists; otherwise it stays
 * hidden. Resuming re-submits the original request to its original route.
 */
class PausedTaskBanner extends HTMLElement
{
    #taskState = null;

    async connectedCallback()
    {
        this.style.display = "none";

        this.#taskState = await TaskStateClient.fetch();
        if (!this.#taskState)
        {
            return;
        }

        this.style.display = "";
        this.#render();
    }

    #taskLabel()
    {
        const taskTypeName = Object.keys(taskTypes).find(name => taskTypes[name] === this.#taskState.taskType);
        return taskTypeName ? enumerationToTitleCase(taskTypeName) : "task";
    }

    #render()
    {
        this.innerHTML =
        `
            <style>
                paused-task-banner
                {
                    display: block;
                    margin: 12px 16px 0;
                }
                .paused-task-banner-inner
                {
                    display: flex;
                    align-items: center;
                    gap: 14px;
                    flex-wrap: wrap;
                    padding: 12px 16px;
                    border-radius: 10px;
                    background-color: var(--accent-background-color);
                    border: 1px solid var(--accent-color);
                }
                .paused-task-banner-text
                {
                    flex: 1 1 240px;
                    font-size: 13px;
                    color: var(--primary-text-color);
                    line-height: 1.4;
                }
                .paused-task-banner-actions
                {
                    display: flex;
                    gap: 10px;
                    flex-shrink: 0;
                }
                .paused-task-banner-resume,
                .paused-task-banner-discard
                {
                    padding: 8px 16px;
                    border-radius: 8px;
                    border: none;
                    cursor: pointer;
                    font-weight: 600;
                    font-size: 13px;
                }
                .paused-task-banner-resume
                {
                    background: var(--primary-background-gradient);
                    color: var(--primary-text-color);
                }
                .paused-task-banner-discard
                {
                    background: transparent;
                    outline: 1px solid var(--outline-color-strong);
                    outline-offset: -1px;
                    color: var(--secondary-text-color);
                }
                .paused-task-banner-resume:disabled { opacity: 0.6; cursor: default; }
            </style>
            <div class="paused-task-banner-inner">
                <span class="paused-task-banner-text">Your <strong>${PausedTaskBanner.#escape(this.#taskLabel())}</strong> was paused (out of credits). Top up your credits, then resume it.</span>
                <div class="paused-task-banner-actions">
                    <button class="paused-task-banner-resume">Resume</button>
                    <button class="paused-task-banner-discard">Discard</button>
                </div>
            </div>
        `;

        this.querySelector(".paused-task-banner-resume").addEventListener("click", () => this.#resume());
        this.querySelector(".paused-task-banner-discard").addEventListener("click", () => this.#discard());
    }

    async #resume()
    {
        const resumeButton = this.querySelector(".paused-task-banner-resume");
        resumeButton.disabled = true;
        resumeButton.textContent = "Resuming…";

        let response;
        try
        {
            response = await TaskStateClient.resume(this.#taskState);
        }
        catch (resumeError)
        {
            await DialogBox.alert("Resume failed", "Could not reach the server. Please try again.");
            resumeButton.disabled = false;
            resumeButton.textContent = "Resume";
            return;
        }

        if (response.status === 402)
        {
            const insufficientDetail = await response.json().catch(() => ({}));
            await CreditNotice.showInsufficientCredits(insufficientDetail);
            resumeButton.disabled = false;
            resumeButton.textContent = "Resume";
            return;
        }

        if (!response.ok)
        {
            await DialogBox.alert("Resume failed", "Could not resume the task. Please try again.");
            resumeButton.disabled = false;
            resumeButton.textContent = "Resume";
            return;
        }

        // Success — the resumed task is now running. Discard the saved state
        // (only an explicit resume/discard clears it, so an unrelated success
        // elsewhere never wipes a still-pending paused task).
        const responseBody = await response.json().catch(() => ({}));
        const newTaskId = responseBody && typeof responseBody.taskId === "string" ? responseBody.taskId : null;
        const resumedTaskType = this.#taskState.taskType;

        await TaskStateClient.discard();
        this.remove();

        // A resumed generation returns a fresh task id — open its progress page
        // so the user lands back on the same live view. Other resumable task
        // types (deck analysis, mock-test grading) have no progress page, so
        // they keep the simple confirmation.
        if (resumedTaskType === taskTypes.PREPARE_FOR_GENERATION && newTaskId)
        {
            PageNavigator.open("progress-page", newTaskId);
            return;
        }

        await DialogBox.alert("Task resumed", "Your task has been resumed and is now running. You can track its progress in Activity.");
    }

    async #discard()
    {
        await TaskStateClient.discard();
        this.remove();
    }

    static #escape(text)
    {
        const div = document.createElement("div");
        div.textContent = String(text ?? "");
        return div.innerHTML;
    }
}

customElements.define("paused-task-banner", PausedTaskBanner);
export default PausedTaskBanner;
