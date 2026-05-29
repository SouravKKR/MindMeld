class DialogBox extends HTMLElement
{
    // ── Singleton queue ────────────────────────────────────────────────────────
    //
    // Only one DialogBox is allowed in the DOM at a time. Subsequent calls (e.g.
    // a model-download prompt firing while an onboarding tutorial alert is
    // already up) park the new dialog in a queue; it gets appended to the body
    // when the active one closes. Without this, dialogs stacked on top of one
    // another and the topmost one's backdrop covered the others, making the
    // queued popup feel "stuck behind" the visible one.
    //
    // The element is created and configured (innerHTML, listeners, inline
    // styles set by callers like MockTestStartDialog) BEFORE it is appended.
    // Custom-element lifecycle hooks (connectedCallback / disconnectedCallback)
    // run only when the element is actually attached — that's how the backdrop
    // is gated to the visible dialog.

    static #queue = [];
    static #activeDialog = null;

    #backdrop = null;

    static #presentNext()
    {
        if (DialogBox.#activeDialog)
        {
            return;
        }
        if (DialogBox.#queue.length === 0)
        {
            return;
        }
        const nextDialog = DialogBox.#queue.shift();
        DialogBox.#activeDialog = nextDialog;
        document.body.appendChild(nextDialog);
    }

    /**
     * Adds a configured dialog element to the queue. If nothing is currently
     * showing, it's presented immediately. Used internally by every static
     * factory below — callers never touch the queue directly.
     */
    static #enqueue(dialog)
    {
        DialogBox.#queue.push(dialog);
        DialogBox.#presentNext();
    }

    connectedCallback()
    {
        this.#backdrop = document.createElement("div");
        this.#backdrop.className = "dialog-backdrop";
        document.body.insertBefore(this.#backdrop, this);
    }

    disconnectedCallback()
    {
        this.#backdrop?.remove();
        this.#backdrop = null;

        // The active dialog being removed (either via close() or because the
        // caller mutated the DOM directly) is the trigger for advancing the
        // queue. If a queued dialog is closed before it ever appeared, this
        // hook doesn't fire — close() handles that path separately.
        if (DialogBox.#activeDialog === this)
        {
            DialogBox.#activeDialog = null;
            DialogBox.#presentNext();
        }
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

            DialogBox.#enqueue(dialog);
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

            DialogBox.#enqueue(dialog);
        });
    }

    static async prompt(title, message)
    {
        const dialog = document.createElement("dialog-box");
        dialog.innerHTML =
        `
            <div class="title-section">${title}</div>
            <div class="message-section">
                ${message}<br><br>
                <input type="text" placeholder="Enter Value..." class="input-field">
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
                    const enteredValue = inputField.value;
                    dialog.close();
                    resolve(enteredValue);
                }
            });

            DialogBox.#enqueue(dialog);
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

        DialogBox.#enqueue(dialog);
        return dialog;
    }

    close()
    {
        // Two paths into close():
        //   1. The dialog is currently shown — remove it from the DOM. The
        //      disconnectedCallback then clears the active-dialog slot and
        //      presents the next queued entry.
        //   2. The dialog is still queued (never appeared) — splice it out of
        //      the queue. No DOM removal needed; no advancement needed since
        //      whichever dialog is currently active is unaffected.
        const queueIndex = DialogBox.#queue.indexOf(this);
        if (queueIndex !== -1)
        {
            DialogBox.#queue.splice(queueIndex, 1);
            return;
        }
        this.remove();
    }
}

customElements.define("dialog-box", DialogBox);
export default DialogBox;
