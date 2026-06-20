import { convertElementToColorPicker } from "../../../Globals/UtilityFunctions/ConvertElementToColorPicker.js";
import { applyImageResizeDecorator } from "../../../Globals/UtilityFunctions/ApplyImageResizeDecorator.js";
import { scaleDownImage } from "../../../Globals/UtilityFunctions/ScaleDownImage.js";
import DrawingCanvasDialog from "../../../CommonComponents/DrawingCanvasDialog.js";
import HtmlSanitizer from "../../../Globals/Classes/HtmlSanitizer.js";
import TableEditingContextMenu from "./TableEditingContextMenu.js";

class RichTextEditor extends HTMLElement
{
    // JPEG quality used when compressing inserted images. Mirrors the
    // value the CardEditorPage paste handler uses so paste / file-pick /
    // draw all produce equally sized payloads.
    static IMAGE_COMPRESSION_QUALITY = 0.7;

    // Default grid emitted by the Insert Table button. Two rows + two
    // columns gives the user a starting frame they can extend via the
    // right-click table menu without having to fight an empty 1x1 cell.
    static #DEFAULT_TABLE_ROW_COUNT = 2;
    static #DEFAULT_TABLE_COLUMN_COUNT = 2;

    // Selection range captured before opening the draw dialog so we can
    // restore it after the modal steals focus.
    #savedSelectionRange = null;

    // True while the editor is in raw-HTML mode (textarea shown,
    // contenteditable hidden). Tracked per-instance so multiple editors
    // on the same page (e.g. card question + answer) toggle independently.
    #bRawHtmlMode = false;

    // Maps short, human-readable tokens (MM_IMG_1, MM_IMG_2, …) to the
    // full `data:image/...;base64,…` src they replace while raw-HTML
    // mode is active. The textarea shows the tokens in place of multi-
    // megabyte base64 strings so the user can actually edit surrounding
    // HTML; the map lets us restore the originals on the way back into
    // rich-text mode and on save. Re-built every time we enter raw mode
    // so tokens are deterministic and sequential per session.
    #imageTokenMap = new Map();

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
        const insertTableButton = this.querySelector(".insert-table-button");
        const rawHtmlToggleButton = this.querySelector(".raw-html-toggle-button");

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

        insertTableButton.addEventListener("click", () =>
        {
            this.#captureSelectionRange(editor);
            this.#insertTableAtSavedSelection(editor);
        });

        rawHtmlToggleButton.addEventListener("click", () =>
        {
            this.#toggleRawHtmlMode();
        });

        // Right-click inside a table cell opens TableEditingContextMenu.
        // The native menu still appears for clicks outside any table so
        // the user keeps paste / spellcheck on plain text. Clicks
        // outside the editor are unaffected — the host page's
        // contextmenu handlers continue to run.
        editor.addEventListener("contextmenu", (contextMenuEvent) =>
        {
            const targetElement = contextMenuEvent.target;
            const targetCell = targetElement && typeof targetElement.closest === "function"
                ? targetElement.closest("td, th")
                : null;
            if (!targetCell || !editor.contains(targetCell))
            {
                return;
            }
            contextMenuEvent.preventDefault();
            contextMenuEvent.stopPropagation();
            TableEditingContextMenu.create(
                { x: contextMenuEvent.clientX, y: contextMenuEvent.clientY },
                targetCell
            );
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

    /**
     * Splices a freshly-built <table> at the previously captured
     * selection range. Cells default to a non-breaking space so the
     * grid is visible and click-targets are non-zero. Caret lands in
     * the first cell so the user can start typing straight away.
     */
    #insertTableAtSavedSelection(editor)
    {
        const tableElement = document.createElement("table");
        const tableBody = document.createElement("tbody");
        tableElement.appendChild(tableBody);

        for (let rowIndex = 0; rowIndex < RichTextEditor.#DEFAULT_TABLE_ROW_COUNT; rowIndex++)
        {
            const rowElement = document.createElement("tr");
            for (let columnIndex = 0; columnIndex < RichTextEditor.#DEFAULT_TABLE_COLUMN_COUNT; columnIndex++)
            {
                const cellElement = document.createElement("td");
                cellElement.innerHTML = "&nbsp;";
                rowElement.appendChild(cellElement);
            }
            tableBody.appendChild(rowElement);
        }

        const selection = window.getSelection();
        let insertionRange = this.#savedSelectionRange;
        if (!insertionRange)
        {
            insertionRange = document.createRange();
            insertionRange.selectNodeContents(editor);
            insertionRange.collapse(false);
        }

        selection.removeAllRanges();
        selection.addRange(insertionRange);

        insertionRange.deleteContents();
        insertionRange.insertNode(tableElement);

        // Place the caret inside the first cell so the user can start
        // typing immediately after pressing Insert Table.
        const firstCell = tableElement.querySelector("td");
        if (firstCell)
        {
            const caretRange = document.createRange();
            caretRange.selectNodeContents(firstCell);
            caretRange.collapse(true);
            selection.removeAllRanges();
            selection.addRange(caretRange);
            this.#savedSelectionRange = caretRange.cloneRange();
        }
        else
        {
            insertionRange.setStartAfter(tableElement);
            insertionRange.setEndAfter(tableElement);
            selection.removeAllRanges();
            selection.addRange(insertionRange);
            this.#savedSelectionRange = insertionRange.cloneRange();
        }
    }

    /**
     * Flip between rich-text and raw-HTML modes in place. The textarea
     * mirrors whichever side the user just left, so an edit on one side
     * shows up untouched on the other. Toolbar buttons that only make
     * sense in rich-text mode (everything except the toggle itself) are
     * disabled while raw HTML is active.
     *
     * Image data URLs (`<img src="data:image/...;base64,...">`) get
     * substituted for short `MM_IMG_N` tokens before being shown in the
     * textarea — see #substituteDataUrlsWithTokens for the rationale.
     */
    #toggleRawHtmlMode()
    {
        const editor = this.querySelector('[contenteditable]');
        const rawHtmlTextarea = this.querySelector(".raw-html-textarea");
        const toggleButton = this.querySelector(".raw-html-toggle-button");
        const rawHtmlInfoBanner = this.querySelector(".raw-html-info-banner");

        if (!editor || !rawHtmlTextarea || !toggleButton)
        {
            return;
        }

        if (!this.#bRawHtmlMode)
        {
            rawHtmlTextarea.value = this.#substituteDataUrlsWithTokens(editor.innerHTML);
            editor.style.display = "none";
            rawHtmlTextarea.style.display = "block";
            if (rawHtmlInfoBanner)
            {
                rawHtmlInfoBanner.style.display = (this.#imageTokenMap.size > 0) ? "block" : "none";
            }
            this.#bRawHtmlMode = true;
            toggleButton.classList.add("active");
            toggleButton.title = "Back to rich text";
        }
        else
        {
            editor.innerHTML = this.#restoreDataUrlsFromTokens(rawHtmlTextarea.value);
            rawHtmlTextarea.style.display = "none";
            editor.style.display = "";
            if (rawHtmlInfoBanner)
            {
                rawHtmlInfoBanner.style.display = "none";
            }
            this.#bRawHtmlMode = false;
            toggleButton.classList.remove("active");
            toggleButton.title = "Edit raw HTML";
        }

        this.#applyRawHtmlDisabledStateToToolbar();
    }

    /**
     * Walks the supplied HTML and replaces every `<img src="data:…">`
     * payload with a short, sequential placeholder token (MM_IMG_1,
     * MM_IMG_2, …). Stores the original data URL in #imageTokenMap so
     * #restoreDataUrlsFromTokens can put it back on the way out.
     *
     * Why: a single inlined PNG can be hundreds of KB of base64 noise
     * that turns the raw-HTML editor into an unusable wall of text.
     * Tokens keep each image's position and identity visible while
     * letting the user actually read and edit the surrounding markup.
     * If they delete the whole <img> tag, the corresponding map entry
     * becomes unused and is naturally dropped on the next mode flip.
     */
    #substituteDataUrlsWithTokens(htmlString)
    {
        this.#imageTokenMap.clear();
        let sequentialIndex = 0;
        return htmlString.replace(
            /(<img\b[^>]*\bsrc=)(['"])(data:[^'"]+)\2/gi,
            (_fullMatch, attributePrefix, quoteCharacter, originalDataUrl) =>
            {
                sequentialIndex += 1;
                const token = `MM_IMG_${sequentialIndex}`;
                this.#imageTokenMap.set(token, originalDataUrl);
                return `${attributePrefix}${quoteCharacter}${token}${quoteCharacter}`;
            }
        );
    }

    /**
     * Inverse of #substituteDataUrlsWithTokens. Tokens that the user
     * has deleted from the textarea are simply absent from the result;
     * tokens the map no longer knows about (e.g. literal text that
     * happens to look like MM_IMG_N) are left untouched.
     */
    #restoreDataUrlsFromTokens(htmlString)
    {
        if (this.#imageTokenMap.size === 0)
        {
            return htmlString;
        }

        let restoredHtml = htmlString;
        for (const [token, originalDataUrl] of this.#imageTokenMap)
        {
            const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const tokenSrcPattern = new RegExp(
                `(<img\\b[^>]*\\bsrc=)(['"])${escapedToken}\\2`,
                "gi"
            );
            restoredHtml = restoredHtml.replace(
                tokenSrcPattern,
                (_fullMatch, attributePrefix, quoteCharacter) =>
                    `${attributePrefix}${quoteCharacter}${originalDataUrl}${quoteCharacter}`
            );
        }
        return restoredHtml;
    }

    /**
     * Disable every toolbar button except the raw-HTML toggle while raw
     * HTML mode is on — those commands operate on the (now hidden)
     * contenteditable selection, so leaving them enabled lets the user
     * fire commands against stale state.
     */
    #applyRawHtmlDisabledStateToToolbar()
    {
        const bDisabled = this.#bRawHtmlMode;
        const toolbarButtons = this.querySelectorAll(".format-options-container .icon-button:not(.raw-html-toggle-button)");
        for (const toolbarButton of toolbarButtons)
        {
            toolbarButton.disabled = bDisabled;
        }
    }

    getInnerHtml()
    {
        // When the user is mid-edit in raw-HTML mode the textarea holds
        // the authoritative content. Reading from the (stale)
        // contenteditable would silently lose those edits on save.
        // Image data URLs collapsed into MM_IMG_N tokens by the toggle
        // have to be restored before the HTML is persisted, otherwise
        // the saved card would store the token string as the image src
        // and the image would fail to render.
        if (this.#bRawHtmlMode)
        {
            const rawTextareaValue = this.querySelector(".raw-html-textarea").value;
            return this.#restoreDataUrlsFromTokens(rawTextareaValue);
        }
        return this.querySelector('[contenteditable]').innerHTML;
    }

    setInnerHtml(html)
    {
        // This loads STORED content (a card / study material that may have
        // been authored elsewhere, synced in, or imported) into a
        // contenteditable. A contenteditable does not run <script>, but it
        // DOES fire inline handlers like <img onerror=...>, so the stored
        // markup is untrusted and must be sanitised before it touches the
        // DOM. Live raw-HTML authoring goes through #toggleRawHtmlMode, not
        // here, so the author's in-session editing stays fully permissive.
        const sanitizedHtml = HtmlSanitizer.sanitize(html);
        this.querySelector('[contenteditable]').innerHTML = sanitizedHtml;
        // Keep the raw-HTML mirror in sync so a subsequent toggle into
        // raw mode reflects the freshly-loaded content instead of
        // whatever the textarea held from a previous instance.
        const rawHtmlTextarea = this.querySelector(".raw-html-textarea");
        if (rawHtmlTextarea)
        {
            rawHtmlTextarea.value = sanitizedHtml;
        }
    }

    clear()
    {
        this.querySelector('[contenteditable]').innerHTML = "";
        const rawHtmlTextarea = this.querySelector(".raw-html-textarea");
        if (rawHtmlTextarea)
        {
            rawHtmlTextarea.value = "";
        }
    }

    connectedCallback()
    {
        this.innerHTML =
        `
            <div class="format-options-container">
                <button class="icon-button bold-button" title="Bold">
                    <img src="./Globals/Assets/Images/Icons/BoldIcon.svg" alt="Bold Icon">
                </button>
                <button class="icon-button italic-button" title="Italic">
                    <img src="./Globals/Assets/Images/Icons/ItalicIcon.svg" alt="Italic Icon">
                </button>
                <button class="icon-button underline-button" title="Underline">
                    <img src="./Globals/Assets/Images/Icons/UnderLineIcon.svg" alt="Underline Icon">
                </button>
                <button class="icon-button color-picker-button text-color-button" title="Text color">
                    <img src="./Globals/Assets/Images/Icons/TextIcon.svg" alt="Text Icon">
                    <div class="color-picker"></div>
                </button>
                <button class="icon-button color-picker-button highlight-button" title="Highlight">
                    <img src="./Globals/Assets/Images/Icons/HighlightIcon.svg" alt="Highlight Icon">
                    <div class="color-picker"></div>
                </button>
                <button class="icon-button insert-image-button" title="Insert image from file">
                    <img src="./Globals/Assets/Images/Icons/ImageIcon.svg" alt="Insert image">
                </button>
                <button class="icon-button draw-button" title="Draw">
                    <img src="./Globals/Assets/Images/Icons/DrawIcon.svg" alt="Draw">
                </button>
                <button class="icon-button insert-table-button" title="Insert table">
                    <img src="./Globals/Assets/Images/Icons/TableIcon.svg" alt="Insert table">
                </button>
                <button class="icon-button raw-html-toggle-button" title="Edit raw HTML">
                    <img src="./Globals/Assets/Images/Icons/CodeIcon.svg" alt="Edit raw HTML">
                </button>
                <input type="file" class="insert-image-file-input" accept="image/*" style="display:none;" />
            </div>
            <div contenteditable placeholder="${this.getAttribute("placeholder") || ""}"></div>
            <div class="raw-html-info-banner" style="display:none;">
                Image data is hidden as <code>MM_IMG_N</code> tokens to keep this view readable.
                Delete the whole <code>&lt;img&gt;</code> tag to remove an image; tokens are restored on save.
            </div>
            <textarea class="raw-html-textarea" placeholder="Edit raw HTML here..." style="display:none;"></textarea>
        `;

        this.#handleEvents();
    }
}

customElements.define("rich-text-editor", RichTextEditor);
export default RichTextEditor;
