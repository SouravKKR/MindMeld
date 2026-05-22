import { ocrModes } from "../../../Globals/Enumerations/OcrModes.js";
import { convertElementToEnumSelect } from "../../../Globals/UtilityFunctions/ConvertElementToEnumSelect.js";


class InformationSourceFileSelector extends HTMLElement
{
    static tagName = "information-source-file-selector";

    #fileInput = null;
    #nameInput = null;
    #tagsInput = null;
    #ocrModeSelect = null;
    #fileNameDisplay = null;

    connectedCallback()
    {
        this.innerHTML =
        `
            <style>
                information-source-file-selector
                {
                    display: flex;
                    flex-direction: column;
                    gap: 15px;
                    width: 100%;
                    box-sizing: border-box;
                }

                .file-selector-drop-zone
                {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    gap: 8px;
                    padding: 24px 16px;
                    border-radius: 10px;
                    border: 2px dashed #3a3a3a;
                    background-color: #1a1a1a;
                    cursor: pointer;
                    transition: border-color 0.2s ease-in-out, background-color 0.2s ease-in-out;
                    text-align: center;
                    box-sizing: border-box;
                    width: 100%;
                }

                .file-selector-drop-zone:hover,
                .file-selector-drop-zone.drag-active
                {
                    border-color: #0098C4;
                    background-color: rgba(0, 152, 196, 0.05);
                }

                .file-selector-drop-zone-icon
                {
                    width: 36px;
                    height: 36px;
                    opacity: 0.5;
                    flex-shrink: 0;
                }

                .file-selector-drop-zone-primary-text
                {
                    font-size: 0.875rem;
                    color: #cccccc;
                }

                .file-selector-drop-zone-secondary-text
                {
                    font-size: 0.75rem;
                    color: #666666;
                }

                .file-selector-selected-file-name
                {
                    font-size: 0.75rem;
                    color: #0098C4;
                    font-weight: 500;
                    min-height: 15px;
                    word-break: break-all;
                    max-width: 100%;
                }

                input[type="file"]
                {
                    display: none;
                }

                .file-selector-field-group
                {
                    display: flex;
                    flex-direction: column;
                    gap: 5px;
                    width: 100%;
                    box-sizing: border-box;
                }

                .file-selector-field-label
                {
                    font-size: 11px;
                    font-weight: 600;
                    letter-spacing: 0.8px;
                    text-transform: uppercase;
                    color: #888888;
                }

                .file-selector-field-input
                {
                    padding: 10px 15px;
                    border-radius: 8px;
                    background-color: #1a1a1a;
                    color: #ffffff;
                    border: 1px solid #333333;
                    font-size: 0.875rem;
                    outline: none;
                    transition: border-color 0.2s ease-in-out;
                    box-sizing: border-box;
                    width: 100%;
                    min-width: 0;
                }

                .file-selector-field-input:focus
                {
                    border-color: #0098C4;
                }

                .file-selector-field-input::placeholder
                {
                    color: #555555;
                }
            </style>

            <div class="file-selector-drop-zone">
                <svg class="file-selector-drop-zone-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M12 15V3M12 3L8 7M12 3L16 7" stroke="#0098C4" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                    <path d="M3 15V19C3 20.1046 3.89543 21 5 21H19C20.1046 21 21 20.1046 21 19V15" stroke="#888888" stroke-width="1.5" stroke-linecap="round"/>
                </svg>
                <div class="file-selector-drop-zone-primary-text">Drop a file here or click to browse</div>
                <div class="file-selector-drop-zone-secondary-text">Any file type accepted</div>
                <div class="file-selector-selected-file-name"></div>
                <input type="file" class="file-selector-hidden-file-input">
            </div>

            <div class="file-selector-field-group">
                <label class="file-selector-field-label">Name</label>
                <input
                    type="text"
                    class="file-selector-field-input file-selector-name-input"
                    placeholder="Enter a display name..."
                >
            </div>

            <div class="file-selector-field-group">
                <label class="file-selector-field-label">Tags</label>
                <input
                    type="text"
                    class="file-selector-field-input file-selector-tags-input"
                    placeholder="e.g. biology, chapter-3, important"
                >
            </div>

            <div class="file-selector-field-group">
                <label class="file-selector-field-label" title="Runs ocrmypdf during upload so downstream chunking and image extraction can see clean text. Enabled re-OCRs pages whose existing text looks low-quality.">OCR Mode</label>
                <select class="file-selector-field-input file-selector-ocr-mode-select"></select>
            </div>
        `;

        this.#fileInput = this.querySelector(".file-selector-hidden-file-input");
        this.#nameInput = this.querySelector(".file-selector-name-input");
        this.#tagsInput = this.querySelector(".file-selector-tags-input");
        this.#ocrModeSelect = this.querySelector(".file-selector-ocr-mode-select");
        this.#fileNameDisplay = this.querySelector(".file-selector-selected-file-name");

        convertElementToEnumSelect(this.#ocrModeSelect, ocrModes);
        // Default to ENABLED so newly uploaded PDFs get cleaned-up OCR text
        // without the user having to think about it. They can switch to
        // DISABLED for already-clean digital PDFs.
        const enabledKey = Object.keys(ocrModes).find(key => ocrModes[key] === ocrModes.ENABLED);
        if (enabledKey)
        {
            this.#ocrModeSelect.value = enabledKey;
        }

        this.#handleEvents();
    }

    #handleEvents()
    {
        const dropZone = this.querySelector(".file-selector-drop-zone");

        dropZone.addEventListener("click", () =>
        {
            this.#fileInput.click();
        });

        this.#fileInput.addEventListener("change", () =>
        {
            const selectedFile = this.#fileInput.files[0];
            if (selectedFile)
            {
                this.#onFileSelected(selectedFile);
            }
        });

        dropZone.addEventListener("dragover", (event) =>
        {
            event.preventDefault();
            dropZone.classList.add("drag-active");
        });

        dropZone.addEventListener("dragleave", () =>
        {
            dropZone.classList.remove("drag-active");
        });

        dropZone.addEventListener("drop", (event) =>
        {
            event.preventDefault();
            dropZone.classList.remove("drag-active");

            const droppedFile = event.dataTransfer.files[0];
            if (droppedFile)
            {
                const dataTransfer = new DataTransfer();
                dataTransfer.items.add(droppedFile);
                this.#fileInput.files = dataTransfer.files;
                this.#onFileSelected(droppedFile);
            }
        });
    }

    #onFileSelected(file)
    {
        this.#fileNameDisplay.textContent = file.name;

        if (!this.#nameInput.value)
        {
            this.#nameInput.value = file.name.replace(/\.[^/.]+$/, "");
        }
    }

    getFile()
    {
        return this.#fileInput.files[0] ?? null;
    }

    getName()
    {
        return this.#nameInput.value.trim();
    }

    getTags()
    {
        return this.#tagsInput.value
            .split(",")
            .map(tag => tag.trim())
            .filter(tag => tag.length > 0);
    }

    getOcrMode()
    {
        const selectedKey = this.#ocrModeSelect?.value;
        if (selectedKey && Object.prototype.hasOwnProperty.call(ocrModes, selectedKey))
        {
            return ocrModes[selectedKey];
        }
        return ocrModes.ENABLED;
    }
}

customElements.define("information-source-file-selector", InformationSourceFileSelector);
export default InformationSourceFileSelector;