import SoundEffects from "../Globals/Classes/SoundEffects.js";

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

    connectedCallback()
    {
        this.#backdrop = document.createElement("div");
        this.#backdrop.className = "dialog-backdrop";
        this.#backdrop.style.zIndex = String(DialogBox.#nextDialogZIndex++);
        document.body.insertBefore(this.#backdrop, this);

        this.style.zIndex = String(DialogBox.#nextDialogZIndex++);

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
        dialog.innerHTML =
        `
            <div style="display:flex;flex-direction:column;padding:20px;">` +
            html +
        `
                <button class="close-button">
                    <img src="./Globals/Assets/Images/Icons/CloseIcon.svg" alt="Close Icon">
                </button>
            </div>
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
