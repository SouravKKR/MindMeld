import SoundEffects from "../Globals/Classes/SoundEffects.js";
import PopupStack from "../Globals/Classes/PopupStack.js";

class DialogBox extends HTMLElement
{
    // ── Stacking ───────────────────────────────────────────────────────────────
    //
    // Every new DialogBox (and its backdrop) is assigned the next two values
    // from a session-wide monotonically increasing z-index counter, so a
    // dialog opened while another is already on screen always sits visually
    // above the previous one. The backdrop sits one step below its own
    // dialog so the dialog stays clickable while the backdrop catches any
    // click-throughs against the rest of the page.
    //
    // The counter starts just above the OptionsSidebar (z-index 1000) and is
    // never decremented — closing a dialog doesn't free its slot. A user
    // would have to open ~2.147 billion dialogs in a single session to wrap
    // around to int-32 max, which is not a realistic concern.

    static #nextDialogZIndex = 1001;

    #backdrop = null;

    // Escape handling. Every dialog registers with the PopupStack while it
    // is on screen so a global Escape closes it instead of navigating the
    // page away. #dismissible = false opts a dialog out of being closed by
    // Escape at all (a blocking dialog such as a forced sync); #dismissHandler
    // lets a caller define exactly what "cancel" means for that dialog.
    #popupStackHandle = null;
    #dismissible = true;
    #dismissHandler = null;

    connectedCallback()
    {
        this.#backdrop = document.createElement("div");
        this.#backdrop.className = "dialog-backdrop";
        this.#backdrop.style.zIndex = String(DialogBox.#nextDialogZIndex++);
        document.body.insertBefore(this.#backdrop, this);

        this.style.zIndex = String(DialogBox.#nextDialogZIndex++);

        // Read #dismissible live so setDismissible() called after append
        // (e.g. SyncBlockingDialog marks itself non-dismissible once mounted)
        // is still honoured at Escape time.
        this.#popupStackHandle = PopupStack.register(
        {
            dismiss: () => this.#performEscapeDismiss(),
            dismissible: () => this.#dismissible
        });

        // Cue every dialog action button centrally: .ok-button → OK, .cancel- /
        // .close-button → cancel. Capture phase so the cue fires before a button's
        // own handler removes the dialog from the DOM. Covers dialogs built ad hoc
        // on <dialog-box> too, so no call site needs to wire sounds itself.
        this.addEventListener("click", (event) =>
        {
            const target = event.target instanceof Element ? event.target : null;
            const actionButton = target ? target.closest(".ok-button, .cancel-button, .close-button") : null;
            if (!actionButton || !this.contains(actionButton))
            {
                return;
            }
            if (actionButton.classList.contains("ok-button"))
            {
                SoundEffects.playOk();
            }
            else
            {
                SoundEffects.playCancel();
            }
        }, true);
    }

    disconnectedCallback()
    {
        this.#backdrop?.remove();
        this.#backdrop = null;

        PopupStack.unregister(this.#popupStackHandle);
        this.#popupStackHandle = null;
    }

    /**
     * Opt this dialog in or out of Escape-to-close. Blocking dialogs (a
     * forced sync the user must not interrupt) call setDismissible(false)
     * so Escape is swallowed rather than closing them.
     */
    setDismissible(bDismissible)
    {
        this.#dismissible = bDismissible !== false;
    }

    /**
     * Define what "cancel" means for this dialog when the user presses
     * Escape. When unset, #performEscapeDismiss falls back to clicking the
     * dialog's own close / cancel / OK affordance so the caller's existing
     * resolve path runs exactly as if the button had been clicked.
     */
    setDismissHandler(dismissHandler)
    {
        this.#dismissHandler = typeof dismissHandler === "function" ? dismissHandler : null;
    }

    #performEscapeDismiss()
    {
        if (!this.#dismissible)
        {
            return;
        }

        if (this.#dismissHandler !== null)
        {
            this.#dismissHandler();
            return;
        }

        // Reuse whatever the dialog already wired: a cancel/close button
        // carries the caller's "dismissed" resolution, so synthesising a
        // click on it keeps Escape behaviourally identical to clicking it.
        // Fall back to the OK button (alerts have only that) and finally to
        // a bare close() for dialogs with no buttons at all.
        const cancelButton = this.querySelector(".close-button, .cancel-button");
        if (cancelButton)
        {
            cancelButton.click();
            return;
        }

        const okButton = this.querySelector(".ok-button");
        if (okButton)
        {
            okButton.click();
            return;
        }

        this.close();
    }

    static async alert(title, message)
    {
        const dialog = document.createElement("dialog-box");
        dialog.innerHTML =
        `
            <div class="title-section">${title}</div>
            <div class="message-section">${message}</div>
            <div class="button-section">
                <button class="ok-button">OK</button>
            </div>
        `;

        return await new Promise((resolve) =>
        {
            const okButton = dialog.querySelector(".ok-button");
            okButton.addEventListener("click", () =>
            {
                dialog.close();
                resolve();
            });

            document.body.appendChild(dialog);
        });
    }

    static async confirm(title, message)
    {
        const dialog = document.createElement("dialog-box");
        dialog.innerHTML =
        `
            <div class="title-section">${title}</div>
            <div class="message-section">${message}</div>
            <div class="button-section">
                <button class="ok-button">Ok</button>
                <button class="cancel-button">Cancel</button>
            </div>
        `;

        return await new Promise((resolve) =>
        {
            const okButton = dialog.querySelector(".ok-button");
            const cancelButton = dialog.querySelector(".cancel-button");

            okButton.addEventListener("click", () =>
            {
                dialog.close();
                resolve(true);
            });

            cancelButton.addEventListener("click", () =>
            {
                dialog.close();
                resolve(false);
            });

            document.body.appendChild(dialog);
        });
    }

    static async prompt(title, message, inputType = "text")
    {
        const dialog = document.createElement("dialog-box");
        dialog.innerHTML =
        `
            <div class="title-section">${title}</div>
            <div class="message-section">
                ${message}<br><br>
                <input type="${inputType}" placeholder="Enter Value..." class="input-field">
            </div>
            <div class="button-section">
                <button class="ok-button">Ok</button>
            </div>
        `;

        return await new Promise((resolve) =>
        {
            const okButton = dialog.querySelector(".ok-button");
            const inputField = dialog.querySelector(".input-field");

            okButton.addEventListener("click", () =>
            {
                const enteredValue = inputField.value;
                dialog.close();
                resolve(enteredValue);
            });

            inputField.addEventListener("keydown", (event) =>
            {
                if (event.key === "Enter")
                {
                    // Enter is a keypress, not a button click, so the delegated
                    // click cue doesn't cover it — play the OK cue explicitly.
                    SoundEffects.playOk();
                    const enteredValue = inputField.value;
                    dialog.close();
                    resolve(enteredValue);
                }
            });

            document.body.appendChild(dialog);
        });
    }

    static modal(html)
    {
        const dialog = document.createElement("dialog-box");

        // The close button is a SIBLING of the content section, not a child of
        // it. The content section is the dialog's scroll container on short
        // viewports (see .modal-content-section in DialogBox.css), and an
        // absolutely positioned descendant of a scroll container scrolls away
        // with the content — which would carry the only dismiss affordance off
        // the top of a phone screen the moment the user scrolled down.
        //
        // The wrapper's layout lives in DialogBox.css rather than in an inline
        // style so the mobile breakpoint can trim its padding.
        dialog.innerHTML =
        `
            <div class="modal-content-section">` +
            html +
        `
            </div>
            <button class="close-button">
                <img src="./Globals/Assets/Images/Icons/CloseIcon.svg" alt="Close Icon">
            </button>
        `;

        const closeButton = dialog.querySelector(".close-button");
        closeButton.addEventListener("click", () =>
        {
            dialog.close();
        });

        document.body.appendChild(dialog);
        return dialog;
    }

    close()
    {
        this.remove();
    }
}

customElements.define("dialog-box", DialogBox);
export default DialogBox;
