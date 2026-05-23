import { convertElementToColorPicker } from "../../../Globals/UtilityFunctions/ConvertElementToColorPicker.js";
import { applyImageResizeDecorator } from "../../../Globals/UtilityFunctions/ApplyImageResizeDecorator.js";
import { scaleDownImage } from "../../../Globals/UtilityFunctions/ScaleDownImage.js";
import DrawingCanvasDialog from "../../../CommonComponents/DrawingCanvasDialog.js";

class RichTextEditor extends HTMLElement
{
    // JPEG quality used when compressing inserted images. Mirrors the
    // value the CardEditorPage paste handler uses so paste / file-pick /
    // draw all produce equally sized payloads.
    static IMAGE_COMPRESSION_QUALITY = 0.7;

    // Selection range captured before opening the draw dialog so we can
    // restore it after the modal steals focus.
    #savedSelectionRange = null;

    #setupColorPickers()
    {
        const pickers = this.querySelectorAll(".color-picker");

        for (const picker of pickers)
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
        const insertImageButton = this.querySelector(".insert-image-button");
        const insertImageFileInput = this.querySelector(".insert-image-file-input");
        const drawButton = this.querySelector(".draw-button");

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
            if (document.activeElement !== editor)
            {
                editor.focus();
            }

            const colorPicker = textColorButton.querySelector('input[type="color"]');
            const color = colorPicker.value;

            document.execCommand("foreColor", false, color);
        });

        highlightButton.addEventListener("click", (event) =>
        {
            if (document.activeElement !== editor)
            {
                editor.focus();
            }

            const colorPicker = highlightButton.querySelector('input[type="color"]');
            const color = colorPicker.value;

            document.execCommand("backColor", false, color);
        });

        insertImageButton.addEventListener("click", () =>
        {
            this.#captureSelectionRange(editor);
            insertImageFileInput.value = "";
            insertImageFileInput.click();
        });

        insertImageFileInput.addEventListener("change", (changeEvent) =>
        {
            const pickedFile = changeEvent.target.files && changeEvent.target.files[0];
            if (!pickedFile)
            {
                return;
            }

            const fileReader = new FileReader();
            fileReader.onload = (readerLoadEvent) =>
            {
                scaleDownImage(readerLoadEvent.target.result, RichTextEditor.IMAGE_COMPRESSION_QUALITY, (compressedDataUrl) =>
                {
                    this.insertImageAtSavedSelection(compressedDataUrl, editor);
                });
            };
            fileReader.readAsDataURL(pickedFile);
        });

        drawButton.addEventListener("click", async () =>
        {
            this.#captureSelectionRange(editor);

            const drawnDataUrl = await DrawingCanvasDialog.show({ initialWidth: 600, initialHeight: 400 });
            if (!drawnDataUrl)
            {
                return;
            }

            scaleDownImage(drawnDataUrl, RichTextEditor.IMAGE_COMPRESSION_QUALITY, (compressedDataUrl) =>
            {
                this.insertImageAtSavedSelection(compressedDataUrl, editor);
            });
        });
    }

    /**
     * Captures the current selection range so the editor can restore it
     * after a modal steals focus. If the editor was not focused, the
     * saved range is set to the end of the editor so subsequent inserts
     * land somewhere sensible.
     */
    #captureSelectionRange(editor)
    {
        const selection = window.getSelection();
        if (selection && selection.rangeCount > 0)
        {
            const activeRange = selection.getRangeAt(0);
            if (editor.contains(activeRange.commonAncestorContainer))
            {
                this.#savedSelectionRange = activeRange.cloneRange();
                return;
            }
        }

        // No usable selection inside the editor — point at the end so the
        // insertion is non-destructive.
        const fallbackRange = document.createRange();
        fallbackRange.selectNodeContents(editor);
        fallbackRange.collapse(false);
        this.#savedSelectionRange = fallbackRange;
    }

    /**
     * Inserts the given image data URL as an <img> at the saved selection
     * range (or at the end of the editor if no range was saved). Public
     * so the existing paste handler (lives in CardEditorPage) and other
     * callers can reuse it.
     */
    insertImageAtSavedSelection(imageDataUrl, editorElement = null)
    {
        const editor = editorElement || this.querySelector('[contenteditable]');
        const selection = window.getSelection();

        let insertionRange = this.#savedSelectionRange;
        if (!insertionRange)
        {
            insertionRange = document.createRange();
            insertionRange.selectNodeContents(editor);
            insertionRange.collapse(false);
        }

        // Restore the saved range into the live selection so DOM ops act
        // on the same place the user was editing before the modal opened.
        selection.removeAllRanges();
        selection.addRange(insertionRange);

        const imageElement = document.createElement("img");
        imageElement.src = imageDataUrl;
        imageElement.style.maxWidth = "100%";

        insertionRange.deleteContents();
        insertionRange.insertNode(imageElement);
        insertionRange.setStartAfter(imageElement);
        insertionRange.setEndAfter(imageElement);
        selection.removeAllRanges();
        selection.addRange(insertionRange);

        this.#savedSelectionRange = insertionRange.cloneRange();
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
                <button class="icon-button insert-image-button" title="Insert image from file">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                        <circle cx="8.5" cy="8.5" r="1.5"/>
                        <polyline points="21 15 16 10 5 21"/>
                    </svg>
                </button>
                <button class="icon-button draw-button" title="Draw">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M12 19l7-7 3 3-7 7-3-3z"/>
                        <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/>
                        <path d="M2 2l7.586 7.586"/>
                        <circle cx="11" cy="11" r="2"/>
                    </svg>
                </button>
                <input type="file" class="insert-image-file-input" accept="image/*" style="display:none;" />
            </div>
            <div contenteditable placeholder="${this.getAttribute("placeholder") || ""}"></div>
        `;

        this.#handleEvents();
    }
}

customElements.define("rich-text-editor", RichTextEditor);
export default RichTextEditor;
