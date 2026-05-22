import PageNavigator from "../../Globals/Classes/PageNavigator.js";
import GenerationProgressComponent from "./Components/GenerationProgressComponent.js";

const POLL_INTERVAL_MS = 2000;

class ProgressPage extends HTMLElement
{
    #taskId = null;
    #pollIntervalId = null;
    #bTerminated = false;

    /**
     * Called by PageNavigator before connectedCallback.
     * @param {string} taskId - The main task ID returned by /Generate.
     */
    initialize(taskId)
    {
        this.#taskId = taskId;
    }

    #getProgressComponent()
    {
        return this.querySelector("generation-progress-component");
    }

    async #poll()
    {
        if (this.#bTerminated) return;

        try
        {
            const response = await fetch(`/Generate/Progress?taskid=${this.#taskId}`);

            if (!response.ok)
            {
                console.warn(`[ProgressPage] Poll returned ${response.status}`);
                return;
            }

            const taskTree = await response.json();

            this.#getProgressComponent().update(taskTree);

            if (this.#getProgressComponent().isTerminal())
            {
                this.#stopPolling();
                this.#onTerminated(taskTree.status);
            }
        }
        catch (error)
        {
            console.error("[ProgressPage] Poll error:", error);
        }
    }

    #startPolling()
    {
        this.#poll();
        this.#pollIntervalId = setInterval(() => this.#poll(), POLL_INTERVAL_MS);
    }

    #stopPolling()
    {
        if (this.#pollIntervalId !== null)
        {
            clearInterval(this.#pollIntervalId);
            this.#pollIntervalId = null;
        }
    }

    #onTerminated(status)
    {
        this.#bTerminated = true;

        // 3 = COMPLETED, 4 = FAILED
        const bSuccess = status === 3;

        const statusBanner = this.querySelector(".progress-page-status-banner");

        if (bSuccess)
        {
            statusBanner.textContent = "Generation complete — your decks are ready.";
            statusBanner.classList.add("progress-page-status-banner--success");
        }
        else
        {
            statusBanner.textContent = "Generation failed. Please try again.";
            statusBanner.classList.add("progress-page-status-banner--error");
        }

        statusBanner.style.display = "block";
    }

    #handleEvents()
    {
        const continueButton = this.querySelector(".progress-page-continue-button");

        continueButton.addEventListener("click", () =>
        {
            this.#stopPolling();
            PageNavigator.clearAndOpen("home-page");
        });
    }

    connectedCallback()
    {
        this.setAttribute("page", "");

        this.innerHTML =
        `
            <header-component title="Generation in Progress"></header-component>

            <div class="progress-page-body">

                <div class="progress-page-left">
                    <div class="progress-page-section-title">Generation Pipeline</div>
                    <div class="progress-page-status-banner"></div>
                    <generation-progress-component></generation-progress-component>
                </div>

                <div class="progress-page-right">
                    <div class="progress-page-section-title">Sponsored</div>
                    <div class="progress-page-ad-slot">
                        <svg class="progress-page-ad-placeholder-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <rect x="2" y="4" width="20" height="16" rx="2" stroke="#ffffff" stroke-width="1.5"/>
                            <path d="M8 12H16M12 8V16" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round"/>
                        </svg>
                        <span class="progress-page-ad-label">Advertisement</span>
                    </div>
                </div>

            </div>

            <div class="progress-page-footer">
                <button class="progress-page-continue-button">Continue Studying →</button>
            </div>
        `;

        this.#handleEvents();

        if (this.#taskId)
        {
            this.#startPolling();
        }
    }

    disconnectedCallback()
    {
        this.#stopPolling();
    }
}

customElements.define("progress-page", ProgressPage);
export default ProgressPage;