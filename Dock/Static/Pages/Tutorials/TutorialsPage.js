import TutorialRegistry from "../../Globals/Constants/TutorialRegistry.js";
import TutorialEngine from "../../Globals/Classes/TutorialEngine.js";
import TutorialCompletionTracker from "../../Globals/Classes/TutorialCompletionTracker.js";
import PageNavigator from "../../Globals/Classes/PageNavigator.js";

/**
 * TutorialsPage
 *
 * Lists every tutorial registered in TutorialRegistry. Each row shows the
 * tutorial's title, a short description, completion status (per device),
 * and a Play button. Selecting Play closes the page (so the underlying
 * Home page is visible for highlight-style steps) and asks
 * TutorialEngine to run the chosen tutorial.
 *
 * Auto-play of the Beginners tutorial on first device launch happens
 * independently of this page — see TutorialEngine.maybeAutoPlay().
 */
class TutorialsPage extends HTMLElement
{
    initialize()
    {
        // No init args required.
    }

    async #renderRows()
    {
        const tutorials = TutorialRegistry.getAll();

        const rowsHtml = await Promise.all(tutorials.map(async (tutorial) =>
        {
            const bCompleted = await TutorialCompletionTracker.isCompleted(tutorial.id);

            return `
                <div class="tutorials-row" data-tutorial-id="${tutorial.id}">
                    <div class="tutorials-row-text">
                        <div class="tutorials-row-title">${tutorial.title}</div>
                        <div class="tutorials-row-body">${tutorial.body || ""}</div>
                        <div class="tutorials-row-status ${bCompleted ? "tutorials-row-status--completed" : ""}">
                            ${bCompleted ? "Completed on this device" : "Not yet started on this device"}
                        </div>
                    </div>
                    <div class="tutorials-row-actions">
                        <button class="tutorials-row-play-button">${bCompleted ? "Replay" : "Play"}</button>
                    </div>
                </div>
            `;
        }));

        return rowsHtml.join("");
    }

    #handleEvents()
    {
        this.querySelectorAll(".tutorials-row-play-button").forEach((playButton) =>
        {
            playButton.addEventListener("click", () =>
            {
                const row = playButton.closest(".tutorials-row");
                const tutorialId = row?.getAttribute("data-tutorial-id");

                if (!tutorialId)
                {
                    return;
                }

                // Return to Home so HIGHLIGHT-type steps can find DOM
                // targets. PageNavigator.back() reveals the previous page.
                if (PageNavigator.canGoBack())
                {
                    PageNavigator.back();
                }

                // Defer the play call so the home page mounts/renders first,
                // giving highlight selectors a chance to resolve.
                requestAnimationFrame(() =>
                {
                    TutorialEngine.play(tutorialId);
                });
            });
        });
    }

    async connectedCallback()
    {
        this.setAttribute("page", "");

        this.innerHTML =
        `
            <header-component title="Tutorials"></header-component>
            <div class="tutorials-page-container">
                <h2 class="tutorials-page-heading">Interactive Tutorials</h2>
                <p class="tutorials-page-intro">
                    Pick a tutorial below to walk through a guided tour. The Beginners tour plays automatically the first time you open MindMeld on a new device.
                </p>
                <div class="tutorials-list">
                    ${await this.#renderRows()}
                </div>
            </div>
        `;

        this.#handleEvents();
    }
}

customElements.define("tutorials-page", TutorialsPage);
export default TutorialsPage;
