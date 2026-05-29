import SyncEvents from "../Globals/Events/SyncEvents.js";

/**
 * SyncBlockingOverlay
 *
 * A full-screen non-dismissable overlay that becomes visible only when
 * the active entity is being mutated by a *substantial* pull — i.e. a
 * chunked drain. Small one-off incremental sync pulls never raise this
 * overlay (SyncOrchestrator scopes the ACTIVE_ENTITY_SYNC_STARTED event
 * to drain cycles), so studying is not interrupted by every minor
 * change that happens to land on the deck the user has open.
 *
 * Safety net: in addition to the matched STARTED/ENDED pairs, the
 * overlay also hides on SyncEvents.COMPLETED / FAILED. If a bug ever
 * lets the started/ended pair desync, the overlay still clears at the
 * end of every sync cycle instead of getting stuck on screen.
 *
 * Push is unaffected: ENTITY_CHANGED events from local edits go
 * straight into SyncManager.#pendingChanges and never raise this
 * overlay. The whole-DB bulk-snapshot pull (forcePullFromServer) uses a
 * separate SyncBlockingDialog and is also independent of this overlay.
 */
class SyncBlockingOverlay extends HTMLElement
{
    static #STYLE_ID = "sync-blocking-overlay-style";

    #activeBlockCount = 0;

    connectedCallback()
    {
        SyncBlockingOverlay.#ensureStylesInjected();

        this.innerHTML =
        `
            <div class="sync-blocking-overlay-backdrop">
                <div class="sync-blocking-overlay-panel">
                    <div class="sync-blocking-overlay-spinner"></div>
                    <div class="sync-blocking-overlay-title">Pulling a large update…</div>
                    <div class="sync-blocking-overlay-message">Another device made a lot of changes. We're catching up so your study session stays in sync.</div>
                </div>
            </div>
        `;

        this.style.display = "none";

        // Swallow any clicks / keystrokes that bubble up to the overlay so
        // background pages cannot receive input while it is visible.
        for (const eventName of ["click", "pointerdown", "pointerup", "keydown", "keyup", "wheel", "touchstart", "touchend"])
        {
            this.addEventListener(eventName, (event) =>
            {
                event.stopPropagation();
                event.preventDefault();
            }, { capture: true });
        }

        window.addEventListener(SyncEvents.ACTIVE_ENTITY_SYNC_STARTED, this.#handleStarted);
        window.addEventListener(SyncEvents.ACTIVE_ENTITY_SYNC_ENDED,   this.#handleEnded);
        window.addEventListener(SyncEvents.COMPLETED,                  this.#handleSyncFinished);
        window.addEventListener(SyncEvents.FAILED,                     this.#handleSyncFinished);
    }

    disconnectedCallback()
    {
        window.removeEventListener(SyncEvents.ACTIVE_ENTITY_SYNC_STARTED, this.#handleStarted);
        window.removeEventListener(SyncEvents.ACTIVE_ENTITY_SYNC_ENDED,   this.#handleEnded);
        window.removeEventListener(SyncEvents.COMPLETED,                  this.#handleSyncFinished);
        window.removeEventListener(SyncEvents.FAILED,                     this.#handleSyncFinished);
    }

    #handleStarted = () =>
    {
        this.#activeBlockCount++;
        this.style.display = "block";
    };

    #handleEnded = () =>
    {
        this.#activeBlockCount = Math.max(0, this.#activeBlockCount - 1);

        if (this.#activeBlockCount === 0)
        {
            this.style.display = "none";
        }
    };

    // End-of-sync-cycle safety net. Without this, any path where
    // ACTIVE_ENTITY_SYNC_ENDED fails to fire (an unexpected throw before
    // the orchestrator's finally block runs, a future refactor that
    // skips a matched pair) would leave the overlay stuck on screen
    // until the user reloaded. COMPLETED / FAILED are guaranteed once
    // per cycle, so clamping the counter to 0 here can't go wrong.
    #handleSyncFinished = () =>
    {
        this.#activeBlockCount = 0;
        this.style.display = "none";
    };

    static #ensureStylesInjected()
    {
        if (document.getElementById(SyncBlockingOverlay.#STYLE_ID))
        {
            return;
        }

        const styleElement = document.createElement("style");
        styleElement.id = SyncBlockingOverlay.#STYLE_ID;
        styleElement.textContent =
        `
            sync-blocking-overlay
            {
                position: fixed;
                inset: 0;
                z-index: 2147483600;
                display: none;
            }

            .sync-blocking-overlay-backdrop
            {
                position: absolute;
                inset: 0;
                background-color: rgba(0, 0, 0, 0.55);
                backdrop-filter: blur(2px);
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: wait;
            }

            .sync-blocking-overlay-panel
            {
                background-color: var(--background-color, #1f1f23);
                color: var(--text-color, #ffffff);
                padding: 28px 36px;
                border-radius: 12px;
                box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6);
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 14px;
                min-width: 320px;
                max-width: 480px;
                text-align: center;
                font-family: inherit;
            }

            .sync-blocking-overlay-spinner
            {
                width: 38px;
                height: 38px;
                border-radius: 50%;
                border: 3px solid rgba(255, 255, 255, 0.18);
                border-top-color: var(--accent-color, #5a9cff);
                animation: sync-blocking-overlay-spin 0.85s linear infinite;
            }

            .sync-blocking-overlay-title
            {
                font-size: 1.05rem;
                font-weight: 600;
            }

            .sync-blocking-overlay-message
            {
                font-size: 0.9rem;
                color: var(--secondary-text-color, #b8b8c4);
                line-height: 1.35;
            }

            @keyframes sync-blocking-overlay-spin
            {
                from { transform: rotate(0deg); }
                to   { transform: rotate(360deg); }
            }
        `;

        document.head.appendChild(styleElement);
    }
}

customElements.define("sync-blocking-overlay", SyncBlockingOverlay);
export default SyncBlockingOverlay;
