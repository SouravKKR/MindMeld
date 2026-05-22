class DialogBox extends HTMLElement
{
    #backdrop = null;

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
    }

    static async alert(title, message)
    {
        const dialog = document.createElement("dialog-box");
        document.body.appendChild(dialog);

        return await new Promise((resolve, reject) => 
        {
            dialog.innerHTML = 
            `   
                <div class="title-section">${title}</div>
                <div class="message-section">${message}</div>
                <div class="button-section">
                    <button class="ok-button">OK</button>
                </div>
            `;

            const okButton = dialog.querySelector(".ok-button");

            okButton.addEventListener("click", () =>
            {
                dialog.remove()
                resolve();
            });

        });

    }

    static async confirm(title, message)
    {
        const dialog = document.createElement("dialog-box");
        document.body.appendChild(dialog);

        return await new Promise((resolve, reject) => 
        {

            dialog.innerHTML = 
            `
                

                <div class="title-section">${title}</div>
                <div class="message-section">${message}</div>
                <div class="button-section">
                    <button class="ok-button">Ok</button>
                    <button class="cancel-button">Cancel</button>
                </div>
            `;

            const okButton = dialog.querySelector(".ok-button");
            const cancelButton = dialog.querySelector(".cancel-button");

            okButton.addEventListener("click", () =>
            {
                dialog.remove()
                resolve(true);
            });

            cancelButton.addEventListener("click", () =>
            {
                dialog.remove()
                resolve(false);
            });

        });
    }

    static async prompt(title, message)
    {
        const dialog = document.createElement("dialog-box");
        document.body.appendChild(dialog);

        return await new Promise((resolve, reject) => 
        {

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

            const okButton = dialog.querySelector(".ok-button");
            const inputField = dialog.querySelector(".input-field");

            okButton.addEventListener("click", () =>
            {
                dialog.remove()
                resolve(inputField.value);
            });

            inputField.addEventListener("keydown", (event) => 
            {
                if(event.key === "Enter")
                {
                    dialog.remove()
                    resolve(inputField.value);
                }
            });

        });
    }

    static modal(html)
    {
        const dialog = document.createElement("dialog-box");
        document.body.appendChild(dialog);

        dialog.innerHTML = 
        `

            <div style="display:flex;flex-direction:column;padding:20px;">` +
        html + 
        `
            <button class="close-button">
                <img src="./Globals/Assets/Images/Icons/CloseIcon.svg" alt="Close Icon">
            </button>
        `+
        `</div>`;

        const closeButton = dialog.querySelector(".close-button");
        closeButton.addEventListener("click", () =>
        {
            dialog.close();
        });

        return dialog;
        
    }
    
    close()
    {
        this.remove();
    }
}

customElements.define("dialog-box", DialogBox);
export default DialogBox;