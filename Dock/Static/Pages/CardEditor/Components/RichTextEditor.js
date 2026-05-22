import { convertElementToColorPicker } from "../../../Globals/UtilityFunctions/ConvertElementToColorPicker.js";
import { applyImageResizeDecorator } from "../../../Globals/UtilityFunctions/ApplyImageResizeDecorator.js";

class RichTextEditor extends HTMLElement 
{
    
    #setupColorPickers()
    {
        const pickers = this.querySelectorAll(".color-picker");

        for(const picker of pickers)
        {
            convertElementToColorPicker(picker);
        }
    }

    #handleEvents()
    {
        this.#setupColorPickers();

        const boldButton = this.querySelector(".bold-button");
        const italicButton = this.querySelector(".italic-button");
        const underlineButton = this.querySelector(".underline-button");
        const highlightButton = this.querySelector(".highlight-button");
        const textColorButton = this.querySelector(".text-color-button");

        const editor = this.querySelector('[contenteditable]');

        applyImageResizeDecorator(editor);

        boldButton.addEventListener("click", () => 
        {
            // I DONT KNOW WHY THEY DEPRECATED THIS BUT KEEP CHECKING FOR REPLACEMENTS IN THE FUTURE
            document.execCommand("bold");
        });
        italicButton.addEventListener("click", () => 
        {
            document.execCommand("italic")
        });

        underlineButton.addEventListener("click", () => 
        {
            document.execCommand("underline")
        });

        textColorButton.addEventListener("click", (event) =>
        {
            if(document.activeElement !== editor)
            {
                editor.focus();
            }

            const colorPicker = textColorButton.querySelector('input[type="color"]');
            const color = colorPicker.value;

            document.execCommand("foreColor", false, color);
        });

        highlightButton.addEventListener("click", (event) =>
        {
            if(document.activeElement !== editor)
            {
                editor.focus();
            }

            const colorPicker = highlightButton.querySelector('input[type="color"]');
            const color = colorPicker.value;

            document.execCommand("backColor", false, color);
        });

    }

    getInnerHtml()
    {
        return this.querySelector('[contenteditable]').innerHTML;
    }

    setInnerHtml(html)
    {
        this.querySelector('[contenteditable]').innerHTML = html;
    }
    clear()
    {
        this.querySelector('[contenteditable]').innerHTML = "";
    }
    
    connectedCallback()
    {
        this.innerHTML = 
        `
            
            <div class="format-options-container">
                <button class="icon-button bold-button">
                    <img src="./Globals/Assets/Images/Icons/BoldIcon.svg" alt="Bold Icon">
                </button>
                <button class="icon-button italic-button">
                    <img src="./Globals/Assets/Images/Icons/ItalicIcon.svg" alt="Italic Icon">
                </button>
                <button class="icon-button underline-button">
                    <img src="./Globals/Assets/Images/Icons/UnderLineIcon.svg" alt="Underline Icon">
                </button>
                <button class="icon-button color-picker-button text-color-button">
                    <img src="./Globals/Assets/Images/Icons/TextIcon.svg" alt="Text Icon">
                    <div class="color-picker"></div>
                </button>
                <button class="icon-button color-picker-button highlight-button">
                    <img src="./Globals/Assets/Images/Icons/HighlightIcon.svg" alt="Highlight Icon">
                    <div class="color-picker"></div>
                </button>
            </div>
            <div contenteditable placeholder="${this.getAttribute("placeholder") || ""}"></div>
        `;

        this.#handleEvents();
    }
}

customElements.define("rich-text-editor", RichTextEditor);
export default RichTextEditor;