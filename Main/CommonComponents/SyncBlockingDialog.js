import DialogBox from "./DialogBox.js";


/**
 * SyncBlockingDialog
 *
 * Non-dismissible modal shown during a "force" sync operation — either
 * a full local push (lastSync === 0 with a non-empty local library) or
 * a bulk snapshot pull (Force Pull, fresh-client auto-route, or the
 * empty-after-sync auto-retry). The user is blocked from interacting
 * with the rest of the UI until the operation finishes, because
 * anything they touch can race with the bulk apply.
 *
 * Lifecycle:
 *     const dialog = SyncBlockingDialog.show("Restoring your library");
 *     dialog.updateFraction(0.4);
 *     dialog.updateLabel("1247 / 8243 items…");
 *     dialog.markSuccessAndAutoClose();   // or dialog.markError("...")
 *
 * The close button injected by DialogBox.modal is hidden by default
 * and re-enabled by markError() so the user always has an escape
 * hatch when something goes wrong.
 */
class SyncBlockingDialog
{
    static #AUTO_CLOSE_AFTER_SUCCESS_MILLISECONDS = 700;
    static #DEFAULT_BODY_TEXT =
        "This may be due to an app update or because your saved sync state is stale. "
        + "Please don't close this tab — we're getting everything back in sync now.";

    #dialog      = null;
    #closeButton = null;
    #barFill     = null;
    #statusLabel = null;
    #bClosed     = false;
    #forceActionRow = null;
    #forceButton = null;

    static show(title, bodyText = SyncBlockingDialog.#DEFAULT_BODY_TEXT)
    {
        const instance = new SyncBlockingDialog();
        instance.#mount(title, bodyText);
        return instance;
    }

    #mount(title, bodyText)
    {
        this.#dialog = DialogBox.modal(`
            <div class="sync-blocking-content">
                <h2 class="sync-blocking-title">${title}</h2>
                <p class="sync-blocking-body">${bodyText}</p>
                <div class="sync-blocking-bar-track">
                    <div class="sync-blocking-bar-fill"></div>
                </div>
                <div class="sync-blocking-status">Preparing…</div>
                <div class="sync-blocking-actions" style="display: none;">
                    <button class="sync-blocking-force-button" type="button" title="Another device holds the sync lock — force release it and retry.">Force Unlock &amp; Retry</button>
                </div>
            </div>
        `);

        // Elevate this dialog above every other interactive surface so the
        // user cannot click through to the OptionsSidebar (z-index 1000),
        // drag ghosts (10000), the rich-text editor (9999) or the tutorial
        // overlay (2147483500) while a force sync is in flight — any of
        // those would race with the bulk apply that's about to wipe the
        // in-memory deck tree. Tag the backdrop too so it shares the lift.
        this.#dialog.classList.add("sync-blocking-dialog-elevated");

        const backdropElement = this.#dialog.previousElementSibling;
        if (backdropElement && backdropElement.classList.contains("dialog-backdrop"))
        {
            backdropElement.classList.add("sync-blocking-backdrop-elevated");

            // Absorb every interactive event on the backdrop so taps that
            // land "between" the dialog and the surrounding viewport
            // can't trigger anything underneath. Capture-phase so the
            // stop happens before any underlying listener can fire.
            for (const interactiveEventName of ["click", "pointerdown", "pointerup", "keydown", "keyup", "wheel", "touchstart", "touchend"])
            {
                backdropElement.addEventListener(interactiveEventName, (interactiveEvent) =>
                {
                    interactiveEvent.stopPropagation();
                    interactiveEvent.preventDefault();
                }, { capture: true });
            }
        }

        this.#closeButton = this.#dialog.querySelector(".close-button");
        this.#barFill     = this.#dialog.querySelector(".sync-blocking-bar-fill");
        this.#statusLabel = this.#dialog.querySelector(".sync-blocking-status");
        this.#forceActionRow = this.#dialog.querySelector(".sync-blocking-actions");
        this.#forceButton = this.#dialog.querySelector(".sync-blocking-force-button");

        if (this.#closeButton)
        {
            this.#closeButton.style.display = "none";
        }
    }

    /**
     * Reveal a "Force Unlock & Retry" affordance below the status line.
     * Called by SyncOrchestrator's LOCK_BLOCKED listener when the cycle
     * couldn't acquire the server-side lock and the user would otherwise
     * be stuck staring at "Preparing…". The handler is wired by the
     * caller so the dialog stays decoupled from sync internals.
     */
    showForceAction(onForceClick)
    {
        if (this.#bClosed || this.#forceButton === null || this.#forceActionRow === null)
        {
            return;
        }
        this.#forceButton.onclick = async () =>
        {
            if (this.#bClosed)
            {
                return;
            }
            this.#forceButton.disabled = true;
            try
            {
                await onForceClick();
            }
            catch (forceClickError)
            {
                console.error("[SyncBlockingDialog] Force action handler threw:", forceClickError);
                this.#forceButton.disabled = false;
            }
        };
        this.#forceButton.disabled = false;
        this.#forceActionRow.style.display = "";
        if (this.#statusLabel !== null)
        {
            this.#statusLabel.textContent = "Couldn't acquire sync lock — another device may be syncing.";
        }
    }

    hideForceAction()
    {
        if (this.#bClosed || this.#forceActionRow === null)
        {
            return;
        }
        this.#forceActionRow.style.display = "none";
        if (this.#forceButton !== null)
        {
            this.#forceButton.disabled = false;
            this.#forceButton.onclick = null;
        }
    }

    updateFraction(fraction)
    {
        if (this.#bClosed || this.#barFill === null)
        {
            return;
        }
        const clampedFraction = Math.max(0, Math.min(1, fraction));
        this.#barFill.style.width = `${(clampedFraction * 100).toFixed(1)}%`;
    }

    updateLabel(statusText)
    {
        if (this.#bClosed || this.#statusLabel === null)
        {
            return;
        }
        this.#statusLabel.textContent = statusText;
    }

    markSuccessAndAutoClose()
    {
        if (this.#bClosed)
        {
            return;
        }
        this.updateFraction(1);
        this.updateLabel("Done!");
        setTimeout(() =>
        {
            this.close();
        }, SyncBlockingDialog.#AUTO_CLOSE_AFTER_SUCCESS_MILLISECONDS);
    }

    markError(errorMessage)
    {
        if (this.#bClosed || this.#statusLabel === null)
        {
            return;
        }
        this.#statusLabel.textContent = errorMessage
            ? `Sync failed: ${errorMessage}. You can close this dialog and retry.`
            : "Sync failed. You can close this dialog and retry.";
        this.#statusLabel.classList.add("sync-blocking-status-error");
        if (this.#closeButton)
        {
            this.#closeButton.style.display = "";
        }
    }

    close()
    {
        if (this.#bClosed)
        {
            return;
        }
        this.#bClosed = true;
        if (this.#dialog !== null)
        {
            this.#dialog.close();
            this.#dialog = null;
        }
    }
}

export default SyncBlockingDialog;
