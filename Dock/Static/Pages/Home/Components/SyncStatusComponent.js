import SyncEvents from "../../../Globals/Events/SyncEvents.js";
import SyncManager from "../../../Globals/Classes/SyncManager.js";
import { syncStates } from "../../../Globals/Enumerations/SyncStates.js";
import DialogBox from "../../../CommonComponents/DialogBox.js";

class SyncStatusComponent extends HTMLElement
{
    static #STATUS_DISPLAY_DURATION_MILLISECONDS = 10 * 1000;

    #statusTimeoutId       = null;
    #bDeferredVisible      = false;
    #bLockBlocked          = false;
    #bNoDataVisible        = false;
    // True once a SyncEvents.ENTITY_PROGRESS arrived during the current
    // sync run. While true the bare-percentage PROGRESS event yields the
    // status label — entity counts ("1247/8243") are strictly more
    // informative than a percent that hangs at 60% for a minute.
    #bEntityProgressActive = false;

    #handleEvents()
    {
        this.addEventListener("click", async (event) =>
        {
            // The Force / Force Pull buttons are separate child elements
            // with their own listeners; the root click is a manual sync
            // only.
            if (event.target && (event.target.closest(".sync-status-force-button")
                              || event.target.closest(".sync-status-force-pull-button")))
            {
                return;
            }

            event.stopPropagation();

            if (!window["user"])
            {
                await DialogBox.alert("Sync", "You must be logged in to sync.");
                return;
            }

            if (SyncManager.getState() === syncStates.SYNCING)
            {
                return;
            }

            // Manual sync — force past the connection-quality guard. If
            // the user is genuinely offline the underlying fetch will
            // fail naturally and surface as "Sync Failed", which is more
            // informative than silently re-deferring.
            SyncManager.sync({ bForce: true });
        });

        window.addEventListener(SyncEvents.STATE_CHANGED, (event) =>
        {
            this.#render(event.detail.state);
        });

        window.addEventListener(SyncEvents.PROGRESS, (event) =>
        {
            if (SyncManager.getState() !== syncStates.SYNCING)
            {
                return;
            }

            // ENTITY_PROGRESS owns the label once any meaningful entity
            // count has arrived for this sync run. Percent-only label
            // updates would just flicker over the more useful "X / Y".
            if (this.#bEntityProgressActive)
            {
                return;
            }

            const detail = event.detail || {};
            const total = detail.total || 0;
            const completed = detail.completed || 0;

            if (total <= 0)
            {
                return;
            }

            const percent = Math.min(100, Math.round((completed / total) * 100));
            const label = this.querySelector(".sync-status-label");

            if (label)
            {
                label.textContent = `Syncing ${percent}%`;
            }
        });

        window.addEventListener(SyncEvents.ENTITY_PROGRESS, (event) =>
        {
            if (SyncManager.getState() !== syncStates.SYNCING)
            {
                return;
            }

            const detail    = event.detail || {};
            const processed = detail.processed || 0;
            const total     = detail.total     || 0;

            const label = this.querySelector(".sync-status-label");
            if (!label)
            {
                return;
            }

            if (total > 0)
            {
                this.#bEntityProgressActive = true;
                const percent = Math.min(100, Math.round((processed / total) * 100));
                label.textContent = `Syncing ${processed} / ${total} (${percent}%)`;
            }
            else if (processed > 0)
            {
                this.#bEntityProgressActive = true;
                label.textContent = `Syncing ${processed} items…`;
            }
        });

        window.addEventListener(SyncEvents.STARTED, () =>
        {
            // Fresh sync run — drop any sticky entity-progress label
            // ownership so the next cycle starts from scratch.
            this.#bEntityProgressActive = false;
        });

        window.addEventListener(SyncEvents.COMPLETED, () =>
        {
            this.#bEntityProgressActive = false;
            this.#showTemporaryStatus("Synced");
        });

        window.addEventListener(SyncEvents.FAILED, () =>
        {
            this.#bEntityProgressActive = false;
            this.#showTemporaryStatus("Sync Failed", true);
        });

        window.addEventListener(SyncEvents.DEFERRED, (event) =>
        {
            const reason = (event.detail && event.detail.reason) || "";
            const message = reason === "offline"
                ? "Offline — tap to retry"
                : "Poor connection — tap to sync";
            this.#showDeferredStatus(message);
        });

        window.addEventListener(SyncEvents.LOCK_BLOCKED, () =>
        {
            this.#showLockBlockedStatus();
        });

        window.addEventListener(SyncEvents.NO_DATA_AFTER_SYNC, () =>
        {
            this.#showNoDataStatus();
        });

        // The Force button takes a separate handler so the root click
        // (manual-sync) doesn't fire when the user is specifically
        // asking to force-release the lock. We DON'T hide the button
        // after the await — the SYNCING render hides it when the
        // retry sync starts, and if the retry also hits LOCK_BLOCKED
        // the event listener re-shows it; manually hiding here would
        // race the re-show and leave the user stranded.
        const forceButton = this.querySelector(".sync-status-force-button");
        if (forceButton)
        {
            forceButton.addEventListener("click", async (event) =>
            {
                event.stopPropagation();
                forceButton.disabled = true;
                try
                {
                    await SyncManager.forceUnlockAndResync();
                }
                catch (forceUnlockError)
                {
                    console.error("[SyncStatusComponent] Force unlock failed:", forceUnlockError);
                }
                // Re-enable so a still-visible button (because the
                // retry failed and LOCK_BLOCKED re-fired) is clickable
                // again. If it's hidden, this is harmless.
                forceButton.disabled = false;
            });
        }

        // Same shape for Force Pull: SYNCING render hides it when the
        // retry starts, NO_DATA_AFTER_SYNC re-shows + re-enables it if
        // the retry also came back empty.
        const forcePullButton = this.querySelector(".sync-status-force-pull-button");
        if (forcePullButton)
        {
            forcePullButton.addEventListener("click", async (event) =>
            {
                event.stopPropagation();
                forcePullButton.disabled = true;
                try
                {
                    await SyncManager.forcePullFromServer();
                }
                catch (forcePullError)
                {
                    console.error("[SyncStatusComponent] Force pull failed:", forcePullError);
                }
                forcePullButton.disabled = false;
            });
        }

        // If the browser/network state recovers while we're showing a
        // deferred status, swap back to the normal "Sync" idle label so
        // the user isn't stuck staring at a stale message.
        window.addEventListener("online", () =>
        {
            if (this.#bDeferredVisible && SyncManager.getState() !== syncStates.SYNCING)
            {
                this.#renderIdle();
                this.#bDeferredVisible = false;
            }
        });
    }

    /**
     * Sticky "sync lock not acquired" affordance. The server-side lock
     * is held by another device (or by a leaked TTL from a crashed
     * cycle) and we couldn't sync. Surface a Force button next to the
     * label so the user can break the lock and retry without digging
     * into the server.
     */
    #showLockBlockedStatus()
    {
        const label   = this.querySelector(".sync-status-label");
        const spinner = this.querySelector(".sync-status-spinner");
        const icon    = this.querySelector(".sync-status-icon");
        const force   = this.querySelector(".sync-status-force-button");

        if (this.#statusTimeoutId)
        {
            clearTimeout(this.#statusTimeoutId);
            this.#statusTimeoutId = null;
        }

        spinner.style.display = "none";
        icon.style.display    = "block";
        icon.textContent      = "⚠";
        icon.className        = "sync-status-icon sync-deferred";
        label.textContent     = "Sync locked";

        if (force)
        {
            force.disabled       = false;
            force.style.display  = "inline-block";
        }

        this.#bLockBlocked = true;
    }

    #hideForceButton()
    {
        const force = this.querySelector(".sync-status-force-button");
        if (force)
        {
            force.style.display = "none";
            force.disabled      = false;
        }
    }

    /**
     * Sticky "sync ran but nothing came back and the library is still
     * empty" affordance. Lets the user trigger an explicit retry that
     * resets `lastSync` to 0 and re-pulls from epoch, in case a
     * corrupted cutoff or some other edge case left them stranded.
     */
    #showNoDataStatus()
    {
        const label       = this.querySelector(".sync-status-label");
        const spinner     = this.querySelector(".sync-status-spinner");
        const icon        = this.querySelector(".sync-status-icon");
        const forcePull   = this.querySelector(".sync-status-force-pull-button");

        if (this.#statusTimeoutId)
        {
            clearTimeout(this.#statusTimeoutId);
            this.#statusTimeoutId = null;
        }

        spinner.style.display = "none";
        icon.style.display    = "block";
        icon.textContent      = "ⓘ";
        icon.className        = "sync-status-icon sync-deferred";
        label.textContent     = "No data found";

        if (forcePull)
        {
            forcePull.disabled       = false;
            forcePull.style.display  = "inline-block";
        }

        this.#bNoDataVisible = true;
    }

    #hideForcePullButton()
    {
        const forcePull = this.querySelector(".sync-status-force-pull-button");
        if (forcePull)
        {
            forcePull.style.display = "none";
            forcePull.disabled      = false;
        }
    }

    /**
     * Sticky "sync was skipped due to bad connection" affordance. Stays
     * visible until either (a) the user clicks the component to force a
     * manual sync or (b) the browser fires an "online" / connection-
     * improved event. We don't auto-clear it on a timer because the
     * underlying problem (no/poor connection) doesn't fix itself.
     */
    #showDeferredStatus(message)
    {
        // Don't trample an active sync's UI.
        if (SyncManager.getState() === syncStates.SYNCING)
        {
            return;
        }

        const label   = this.querySelector(".sync-status-label");
        const spinner = this.querySelector(".sync-status-spinner");
        const icon    = this.querySelector(".sync-status-icon");

        if (this.#statusTimeoutId)
        {
            clearTimeout(this.#statusTimeoutId);
            this.#statusTimeoutId = null;
        }

        spinner.style.display = "none";
        icon.style.display    = "block";
        icon.textContent      = "⚠";
        icon.className        = "sync-status-icon sync-deferred";
        label.textContent     = message;

        this.#bDeferredVisible = true;
    }

    /**
     * Shows a status message for a fixed duration, then reverts to the default idle label.
     * @param {string} message - The status message to display.
     * @param {boolean} bIsError - Whether the status represents an error.
     */
    #showTemporaryStatus(message, bIsError = false)
    {
        const label = this.querySelector(".sync-status-label");
        const spinner = this.querySelector(".sync-status-spinner");
        const icon = this.querySelector(".sync-status-icon");

        spinner.style.display = "none";
        icon.style.display = "block";
        icon.textContent = bIsError ? "✕" : "✓";
        icon.className = bIsError ? "sync-status-icon sync-error" : "sync-status-icon sync-success";
        label.textContent = message;

        if (this.#statusTimeoutId)
        {
            clearTimeout(this.#statusTimeoutId);
        }

        this.#statusTimeoutId = setTimeout(() =>
        {
            this.#statusTimeoutId = null;
            this.#renderIdle();

        }, SyncStatusComponent.#STATUS_DISPLAY_DURATION_MILLISECONDS);
    }

    /**
     * Updates the component display based on the current sync state.
     * @param {number} state - The sync state from the syncStates enumeration.
     */
    #render(state)
    {
        const label = this.querySelector(".sync-status-label");
        const spinner = this.querySelector(".sync-status-spinner");
        const icon = this.querySelector(".sync-status-icon");

        if (this.#statusTimeoutId)
        {
            clearTimeout(this.#statusTimeoutId);
            this.#statusTimeoutId = null;
        }

        switch (state)
        {
            case syncStates.SYNCING:
            {
                spinner.style.display = "block";
                icon.style.display = "none";
                label.textContent = "Syncing";
                this.#bDeferredVisible = false;
                if (this.#bLockBlocked)
                {
                    this.#bLockBlocked = false;
                    this.#hideForceButton();
                }
                if (this.#bNoDataVisible)
                {
                    this.#bNoDataVisible = false;
                    this.#hideForcePullButton();
                }
                break;
            }
            case syncStates.ERROR:
            {
                break;
            }
            case syncStates.IDLE:
            default:
            {
                break;
            }
        }
    }

    #renderIdle()
    {
        const label = this.querySelector(".sync-status-label");
        const spinner = this.querySelector(".sync-status-spinner");
        const icon = this.querySelector(".sync-status-icon");

        spinner.style.display = "none";
        icon.style.display = "block";
        icon.textContent = "⟳";
        icon.className = "sync-status-icon";
        label.textContent = "Sync";
    }

    connectedCallback()
    {
        this.innerHTML =
        `
            <div class="sync-status-spinner"></div>
            <span class="sync-status-icon">⟳</span>
            <span class="sync-status-label">Sync</span>
            <button class="sync-status-force-button" type="button" style="display: none;" title="Another device holds the sync lock — force release it and retry.">Force</button>
            <button class="sync-status-force-pull-button" type="button" style="display: none;" title="Sync completed but no data was returned and your library is empty — retry from scratch.">Force Pull</button>
        `;

        this.#handleEvents();
    }
}

customElements.define("sync-status-component", SyncStatusComponent);
export default SyncStatusComponent;