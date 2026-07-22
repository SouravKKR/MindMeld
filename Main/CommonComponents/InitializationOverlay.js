import InitializationEvents from "../Globals/Events/InitializationEvents.js";
import BlockingOverlayCoordinator from "../Globals/Classes/BlockingOverlayCoordinator.js";
import CopyrightNotice from "./CopyrightNotice.js";
import PopupStack from "../Globals/Classes/PopupStack.js";

/**
 * InitializationOverlay
 *
 * A full-screen, non-dismissable overlay shown at app startup while the
 * user's data (decks, identity) is being loaded. It is mounted directly
 * in index.html as the FIRST body child so it covers every other element
 * before any page or sidebar mounts, and intercepts pointer/keyboard
 * input so the sidebar/header cannot be clicked before the data is ready.
 *
 * It listens for the three InitializationEvents fired by Deck bootstrap:
 *   - PROGRESS  { fraction: 0..1, message: string }
 *   - COMPLETE  (overlay hides)
 *   - FAILED    { error } (overlay swaps to a retry view)
 *
 * Progress bar: deterministic linear fill. When PROGRESS arrives without
 * a numeric fraction, the bar tweens linearly toward 95% via a pure-CSS
 * width transition (no JS frame loop), so the user always sees forward
 * motion. A real fraction snaps the bar with a short ease-out. COMPLETE
 * snaps to 100%.
 */
class InitializationOverlay extends HTMLElement
{
    static #STYLE_ID = "initialization-overlay-style";
    static #COORDINATOR_OWNER_ID = "InitializationOverlay";
    static #CREEP_DURATION_MILLISECONDS = 6000;
    static #SETTLE_DURATION_MILLISECONDS = 220;

    #progressElement = null;
    #progressFillElement = null;
    #messageElement  = null;
    #panelElement    = null;
    #popupStackHandle = null;

    connectedCallback()
    {
        InitializationOverlay.#ensureStylesInjected();

        this.innerHTML =
        `
            <div class="initialization-overlay-backdrop">
                <div class="initialization-overlay-panel">
                    <img class="initialization-overlay-logo"
                         src="./Globals/Assets/Images/Logos/CogniumLearnLogoIcon.png"
                         alt="CogniumLearn">
                    <div class="initialization-overlay-title">CogniumLearn</div>
                    <div class="initialization-overlay-progress">
                        <div class="initialization-overlay-progress-fill"></div>
                    </div>
                    <div class="initialization-overlay-message">Preparing your library…</div>
                    <div class="initialization-overlay-attribution">
                        <span class="initialization-overlay-attribution-label">by</span>
                        <img class="initialization-overlay-attribution-logo"
                             src="./Globals/Assets/Images/Logos/CogniumLabsLogo.png"
                             alt="Cognium Labs">
                    </div>
                </div>
                <copyright-notice position="bottom-center"></copyright-notice>
            </div>
        `;

        this.#panelElement        = this.querySelector(".initialization-overlay-panel");
        this.#progressElement     = this.querySelector(".initialization-overlay-progress");
        this.#progressFillElement = this.querySelector(".initialization-overlay-progress-fill");
        this.#messageElement      = this.querySelector(".initialization-overlay-message");

        this.style.display = "block";

        // Claim the blocking-overlay slot synchronously. We mount eagerly
        // from index.html on page load, so by definition we're first and
        // nothing else has had a chance to grab the slot yet.
        BlockingOverlayCoordinator.markActive(InitializationOverlay.#COORDINATOR_OWNER_ID);

        // A non-dismissible PopupStack entry so a stray Escape during startup
        // is swallowed rather than driving history.back() on the page behind
        // the overlay. Released in #handleComplete once the overlay hides.
        this.#popupStackHandle = PopupStack.register({ dismissible: false });

        for(const eventName of ["click", "pointerdown", "pointerup", "keydown", "keyup", "wheel", "touchstart", "touchend"])
        {
            this.addEventListener(eventName, (event) =>
            {
                event.stopPropagation();
                event.preventDefault();
            }, { capture: true });
        }

        window.addEventListener(InitializationEvents.PROGRESS, this.#handleProgress);
        window.addEventListener(InitializationEvents.COMPLETE, this.#handleComplete);
        window.addEventListener(InitializationEvents.FAILED,   this.#handleFailed);
    }

    disconnectedCallback()
    {
        window.removeEventListener(InitializationEvents.PROGRESS, this.#handleProgress);
        window.removeEventListener(InitializationEvents.COMPLETE, this.#handleComplete);
        window.removeEventListener(InitializationEvents.FAILED,   this.#handleFailed);

        PopupStack.unregister(this.#popupStackHandle);
        this.#popupStackHandle = null;
    }

    #handleProgress = (event) =>
    {
        const detail   = event.detail || {};
        const fraction = typeof detail.fraction === "number" ? Math.max(0, Math.min(1, detail.fraction)) : null;
        const message  = typeof detail.message === "string" ? detail.message : null;

        if(this.#progressFillElement)
        {
            if(fraction === null)
            {
                this.#enterCreepMode();
            }
            else
            {
                this.#applyFraction(fraction);
            }
        }

        if(message && this.#messageElement)
        {
            this.#messageElement.textContent = message;
        }
    };

    #handleComplete = () =>
    {
        if(this.#progressFillElement)
        {
            this.#applyFraction(1);
        }

        requestAnimationFrame(() =>
        {
            this.style.display = "none";
            // Release the slot once we're visually gone so the next
            // queued overlay (sync / tutorial) can take over.
            BlockingOverlayCoordinator.release(InitializationOverlay.#COORDINATOR_OWNER_ID);

            // Hand Escape back to normal navigation now the overlay is gone.
            PopupStack.unregister(this.#popupStackHandle);
            this.#popupStackHandle = null;
        });
    };

    #handleFailed = (event) =>
    {
        const errorDetail = event.detail && event.detail.error ? String(event.detail.error) : "Unknown error";
        // Keep the technical detail in the console; show the user a calm, plain message.
        console.error(`[InitializationOverlay] Library load failed: ${errorDetail}`);

        if(this.#panelElement)
        {
            this.#panelElement.innerHTML =
            `
                <div class="initialization-overlay-title">Couldn't load your library</div>
                <div class="initialization-overlay-message">Something went wrong while loading your data. Please check your connection and try again.</div>
                <button class="initialization-overlay-retry">Retry</button>
            `;

            const retryButton = this.#panelElement.querySelector(".initialization-overlay-retry");
            if(retryButton)
            {
                retryButton.addEventListener("click", () =>
                {
                    window.location.reload();
                });
            }
        }
    };

    #enterCreepMode()
    {
        // Freeze the bar at its current rendered width before swapping
        // transition timings so the linear creep starts from "now"
        // rather than snapping backward.
        const computedWidth = window.getComputedStyle(this.#progressFillElement).width;
        const trackWidth = window.getComputedStyle(this.#progressElement).width;
        const trackPixels = parseFloat(trackWidth) || 1;
        const currentPixels = parseFloat(computedWidth) || 0;
        const currentFraction = Math.max(0, Math.min(0.95, currentPixels / trackPixels));

        this.#progressFillElement.style.transition = "none";
        this.#progressFillElement.style.width = `${currentFraction * 100}%`;
        // Force a reflow so the "none" transition takes effect before
        // we re-arm the long linear creep.
        void this.#progressFillElement.offsetWidth;
        this.#progressFillElement.style.transition = `width ${InitializationOverlay.#CREEP_DURATION_MILLISECONDS}ms linear`;
        this.#progressFillElement.style.width = "95%";
    }

    #applyFraction(fraction)
    {
        this.#progressFillElement.style.transition = `width ${InitializationOverlay.#SETTLE_DURATION_MILLISECONDS}ms ease-out`;
        this.#progressFillElement.style.width = `${fraction * 100}%`;
    }

    static #ensureStylesInjected()
    {
        if(document.getElementById(InitializationOverlay.#STYLE_ID))
        {
            return;
        }

        const styleElement = document.createElement("style");
        styleElement.id = InitializationOverlay.#STYLE_ID;
        styleElement.textContent =
        `
            initialization-overlay
            {
                position: fixed;
                inset: 0;
                z-index: 2147483601;
                display: none;
            }

            .initialization-overlay-backdrop
            {
                position: absolute;
                inset: 0;
                background-color: var(--background-color, #1f1f23);
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: wait;
            }

            .initialization-overlay-panel
            {
                color: var(--text-color, #ffffff);
                padding: 32px 40px;
                border-radius: 12px;
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 18px;
                min-width: 320px;
                max-width: 520px;
                text-align: center;
                font-family: inherit;
            }

            .initialization-overlay-logo
            {
                width: 132px;
                max-width: 45vw;
                height: auto;
                display: block;
                user-select: none;
                -webkit-user-drag: none;
                pointer-events: none;
            }

            .initialization-overlay-title
            {
                font-size: 1.4rem;
                font-weight: 600;
                letter-spacing: 0.04em;
                color: var(--secondary-text-color, #b8b8c4);
            }

            .initialization-overlay-attribution
            {
                display: flex;
                align-items: center;
                gap: 8px;
                margin-top: 22px;
                opacity: 0.7;
            }

            .initialization-overlay-attribution-label
            {
                font-size: 0.72rem;
                letter-spacing: 0.06em;
                text-transform: lowercase;
                color: var(--secondary-text-color, #b8b8c4);
            }

            .initialization-overlay-attribution-logo
            {
                width: 118px;
                max-width: 32vw;
                height: auto;
                display: block;
                user-select: none;
                -webkit-user-drag: none;
                pointer-events: none;
            }

            .initialization-overlay-progress
            {
                width: 280px;
                max-width: 70vw;
                height: 8px;
                border-radius: 4px;
                overflow: hidden;
                background-color: rgba(255, 255, 255, 0.12);
            }

            .initialization-overlay-progress-fill
            {
                width: 0%;
                height: 100%;
                background-color: var(--accent-color, #5a9cff);
                border-radius: 4px;
                transition: width 220ms ease-out;
            }

            .initialization-overlay-message
            {
                font-size: 0.95rem;
                color: var(--secondary-text-color, #b8b8c4);
                line-height: 1.4;
            }

            .initialization-overlay-retry
            {
                margin-top: 8px;
                padding: 8px 22px;
                font-size: 0.95rem;
                color: var(--text-color, #ffffff);
                background-color: var(--accent-color, #5a9cff);
                border: none;
                border-radius: 6px;
                cursor: pointer;
            }

            .initialization-overlay-retry:hover
            {
                filter: brightness(1.1);
            }
        `;

        document.head.appendChild(styleElement);
    }
}

customElements.define("initialization-overlay", InitializationOverlay);
export default InitializationOverlay;
