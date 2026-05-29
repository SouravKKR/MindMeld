/**
 * StudyZoomControls
 *
 * Compact +/- zoom widget for the Study page. Sets a CSS variable
 * (--study-card-zoom) on the host study-page element so all card / study-
 * material content scales via font-size: calc(var(--study-card-zoom, 1) *
 * 1em). Persists the multiplier in localStorage so it sticks across
 * sessions.
 *
 * Bounds [0.6, 2.0] in 0.1 steps. Centre button shows the current
 * percentage and double-clicks back to 100%.
 */
class StudyZoomControls extends HTMLElement
{
    static MIN_ZOOM_MULTIPLIER = 0.6;
    static MAX_ZOOM_MULTIPLIER = 2.0;
    static ZOOM_STEP = 0.1;
    static DEFAULT_ZOOM_MULTIPLIER = 1.0;
    static STORAGE_KEY = "mindmeld-study-zoom";
    static CSS_VARIABLE_NAME = "--study-card-zoom";

    #zoomMultiplier = StudyZoomControls.DEFAULT_ZOOM_MULTIPLIER;

    connectedCallback()
    {
        this.#zoomMultiplier = StudyZoomControls.#readPersistedMultiplier();

        this.innerHTML =
        `
            <button class="study-zoom-decrease-button" type="button" aria-label="Zoom out">&minus;</button>
            <button class="study-zoom-reset-button" type="button" aria-label="Reset zoom to 100%">100%</button>
            <button class="study-zoom-increase-button" type="button" aria-label="Zoom in">+</button>
        `;

        this.querySelector(".study-zoom-decrease-button").addEventListener("click", () =>
        {
            this.#applyMultiplier(this.#zoomMultiplier - StudyZoomControls.ZOOM_STEP);
        });

        this.querySelector(".study-zoom-increase-button").addEventListener("click", () =>
        {
            this.#applyMultiplier(this.#zoomMultiplier + StudyZoomControls.ZOOM_STEP);
        });

        this.querySelector(".study-zoom-reset-button").addEventListener("click", () =>
        {
            this.#applyMultiplier(StudyZoomControls.DEFAULT_ZOOM_MULTIPLIER);
        });

        this.#applyMultiplier(this.#zoomMultiplier);
    }

    #applyMultiplier(rawMultiplier)
    {
        const clampedMultiplier = Math.max
        (
            StudyZoomControls.MIN_ZOOM_MULTIPLIER,
            Math.min(StudyZoomControls.MAX_ZOOM_MULTIPLIER, Math.round(rawMultiplier * 100) / 100)
        );

        this.#zoomMultiplier = clampedMultiplier;

        const studyPageElement = this.closest("study-page");
        if(studyPageElement)
        {
            studyPageElement.style.setProperty(StudyZoomControls.CSS_VARIABLE_NAME, clampedMultiplier.toString());
        }

        const resetButton = this.querySelector(".study-zoom-reset-button");
        if(resetButton)
        {
            resetButton.textContent = Math.round(clampedMultiplier * 100) + "%";
        }

        try
        {
            window.localStorage.setItem(StudyZoomControls.STORAGE_KEY, clampedMultiplier.toString());
        }
        catch(storageError)
        {
            // localStorage may be unavailable (private mode); zoom still
            // works for the current session, just won't persist.
        }
    }

    static #readPersistedMultiplier()
    {
        try
        {
            const storedValue = window.localStorage.getItem(StudyZoomControls.STORAGE_KEY);
            if(storedValue === null)
            {
                return StudyZoomControls.DEFAULT_ZOOM_MULTIPLIER;
            }

            const parsedValue = parseFloat(storedValue);
            if(!Number.isFinite(parsedValue))
            {
                return StudyZoomControls.DEFAULT_ZOOM_MULTIPLIER;
            }

            return Math.max
            (
                StudyZoomControls.MIN_ZOOM_MULTIPLIER,
                Math.min(StudyZoomControls.MAX_ZOOM_MULTIPLIER, parsedValue)
            );
        }
        catch(storageError)
        {
            return StudyZoomControls.DEFAULT_ZOOM_MULTIPLIER;
        }
    }
}

customElements.define("study-zoom-controls", StudyZoomControls);
export default StudyZoomControls;
