import DialogBox from "./DialogBox.js";
import BlockingOverlayCoordinator from "../Globals/Classes/BlockingOverlayCoordinator.js";


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
    static #COORDINATOR_OWNER_ID = "SyncBlockingDialog";
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
    #logoutButton = null;

    // Buffered state for the pre-mount window. We hand the instance
    // back to the caller synchronously even though the actual mount
    // waits for the BlockingOverlayCoordinator slot — so callers can
    // freely updateFraction / updateLabel / showForceAction before
    // mount, and we replay the latest values when the slot opens up.
    #titleAtConstruction      = "";
    #bodyTextAtConstruction   = "";
    #latestFraction           = 0;
    #latestLabel              = "Preparing…";
    #pendingForceClickHandler = null;
    #bForceActionRequested    = false;
    #bErrorMarked             = false;
    #lastErrorMessage         = null;

    static show(title, bodyText = SyncBlockingDialog.#DEFAULT_BODY_TEXT)
    {
        const instance = new SyncBlockingDialog();
        instance.#titleAtConstruction    = title;
        instance.#bodyTextAtConstruction = bodyText;
        instance.#requestSlotAndMount();
        return instance;
    }

    async #requestSlotAndMount()
    {
        await BlockingOverlayCoordinator.request(SyncBlockingDialog.#COORDINATOR_OWNER_ID);

        // close() may have been called before our turn came — bail and
        // release the slot we just acquired so the next overlay can show.
        if (this.#bClosed)
        {
            BlockingOverlayCoordinator.release(SyncBlockingDialog.#COORDINATOR_OWNER_ID);
            return;
        }

        this.#mount(this.#titleAtConstruction, this.#bodyTextAtConstruction);

        // Replay buffered state into the just-mounted DOM.
        this.updateFraction(this.#latestFraction);
        this.updateLabel(this.#latestLabel);
        if (this.#bForceActionRequested && this.#pendingForceClickHandler !== null)
        {
            this.showForceAction(this.#pendingForceClickHandler);
        }
        if (this.#bErrorMarked)
        {
            this.markError(this.#lastErrorMessage);
        }
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
                    <button class="sync-blocking-force-button" type="button" style="display: none;" title="Another device holds the sync lock — force release it and retry.">Force Unlock &amp; Retry</button>
                    <button class="sync-blocking-logout-button" type="button" title="Sign out of this account and reload the page.">Log Out</button>
                </div>
            </div>
        `);

        // Tag the backdrop so it shows a busy cursor, and absorb every
        // interactive event on it so taps that land "between" the dialog
        // and the surrounding viewport can't trigger anything underneath
        // while the bulk apply is in flight. Capture-phase so the stop
        // happens before any underlying listener can fire. Stacking
        // itself is handled by DialogBox's auto-incrementing z-index.
        const backdropElement = this.#dialog.previousElementSibling;
        if (backdropElement && backdropElement.classList.contains("dialog-backdrop"))
        {
            backdropElement.classList.add("sync-blocking-backdrop-busy");

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
        this.#logoutButton = this.#dialog.querySelector(".sync-blocking-logout-button");

        // Always-available escape hatch. This modal is otherwise non-
        // dismissible, so a sync that can't make progress (e.g. the lock
        // can't be acquired because the server session expired — which the
        // status line misreports as "another device may be syncing") would
        // trap the user with no way to sign out. /Logout is GET-only on the
        // server; mirror TermsAndConditionsManager's logout-and-reload.
        if (this.#logoutButton)
        {
            this.#logoutButton.onclick = async () =>
            {
                this.#logoutButton.disabled = true;
                try
                {
                    await fetch("/Logout");
                }
                catch (logoutError)
                {
                    console.error("[SyncBlockingDialog] Logout request failed:", logoutError);
                }
                window.location.reload();
            };
        }

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
        // Buffer for the pre-mount window — if we're not on screen yet,
        // #requestSlotAndMount will call back into showForceAction with
        // this same handler once the DOM is ready.
        this.#bForceActionRequested    = true;
        this.#pendingForceClickHandler = onForceClick;

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
        this.#forceButton.style.display = "";
        this.#forceActionRow.style.display = "";
        if (this.#statusLabel !== null)
        {
            this.#statusLabel.textContent = "Couldn't acquire sync lock — another device may be syncing.";
        }
    }

    hideForceAction()
    {
        // Clear buffered request too, in case we're still pre-mount.
        this.#bForceActionRequested    = false;
        this.#pendingForceClickHandler = null;

        if (this.#bClosed || this.#forceActionRow === null)
        {
            return;
        }
        this.#forceActionRow.style.display = "none";
        if (this.#forceButton !== null)
        {
            this.#forceButton.style.display = "none";
            this.#forceButton.disabled = false;
            this.#forceButton.onclick = null;
        }
    }

    updateFraction(fraction)
    {
        this.#latestFraction = fraction;
        if (this.#bClosed || this.#barFill === null)
        {
            return;
        }
        const clampedFraction = Math.max(0, Math.min(1, fraction));
        this.#barFill.style.width = `${(clampedFraction * 100).toFixed(1)}%`;
    }

    updateLabel(statusText)
    {
        this.#latestLabel = statusText;
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
        this.#bErrorMarked     = true;
        this.#lastErrorMessage = errorMessage;

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
        // Surface the Log Out escape hatch on failure too. The force button
        // stays hidden unless this stall was specifically a lock-blocked one
        // (showForceAction reveals it); here only Log Out is offered.
        if (this.#forceActionRow !== null)
        {
            this.#forceActionRow.style.display = "";
        }
    }

    close()
    {
        if (this.#bClosed)
        {
            return;
        }
        this.#bClosed = true;

        // Release the coordinator slot in both paths — mounted-and-closed
        // and queued-but-never-presented. #requestSlotAndMount's own
        // early-exit branch handles the "released-by-close-before-our-turn"
        // case symmetrically; the explicit release here covers the
        // mounted-and-closing path.
        BlockingOverlayCoordinator.release(SyncBlockingDialog.#COORDINATOR_OWNER_ID);

        if (this.#dialog !== null)
        {
            this.#dialog.close();
            this.#dialog = null;
        }
    }
}

export default SyncBlockingDialog;
