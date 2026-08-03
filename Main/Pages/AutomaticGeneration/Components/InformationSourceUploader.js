import DialogBox from "../../../CommonComponents/DialogBox.js";
import InformationSource from "../../../Globals/Model/InformationSource.js";
import InformationSourceFileSelector from "./InformationSourceFileSelector.js";
import InformationSourceExistingSelector from "./InformationSourceExistingSelector.js";
import AutomaticGenerationEvents from "../../../Globals/Events/AutomaticGenerationEvents.js";
import { informationSourceTypes } from "../../../Globals/Enumerations/InformationSourceTypes.js";
import { contentRetentionModes } from "../../../Globals/Enumerations/ContentRetentionModes.js";
import { ocrModes } from "../../../Globals/Enumerations/OcrModes.js";
import IntellectualPropertyNotice from "../../../CommonComponents/IntellectualPropertyNotice.js";

class InformationSourceUploader extends HTMLElement
{
    static tagName = "information-source-uploader";

    connectedCallback()
    {
        this.innerHTML =
        `
            <style>
                information-source-uploader
                {
                    display: flex;
                    gap: 10px;
                }

                .information-source-uploader-button
                {
                    flex: 1;
                    padding: 10px 15px;
                    border-radius: 8px;
                    font-size: 13px;
                    font-weight: 600;
                    cursor: pointer;
                    letter-spacing: 0.3px;
                    transition: opacity 0.2s ease-in-out, background-color 0.2s ease-in-out;
                }

                .information-source-select-existing-button
                {
                    background-color: #252525;
                    color: #cccccc;
                    border: 1px solid #383838;
                }

                .information-source-select-existing-button:hover
                {
                    background-color: #2c2c2c;
                    color: #ffffff;
                    border-color: #555555;
                }

                .information-source-upload-new-button
                {
                    background: linear-gradient(45deg, #0098C4, #B55BD0);
                    color: #ffffff;
                    border: none;
                }

                .information-source-upload-new-button:hover
                {
                    opacity: 0.85;
                    background: linear-gradient(45deg, #0098C4, #B55BD0);
                }
            </style>

            <button class="information-source-uploader-button information-source-select-existing-button">Select From Existing</button>
            <button class="information-source-uploader-button information-source-upload-new-button">Upload New</button>
        `;

        this.#handleEvents();
    }

    #handleEvents()
    {
        const selectFromExistingButton = this.querySelector(".information-source-select-existing-button");
        const uploadNewButton = this.querySelector(".information-source-upload-new-button");

        selectFromExistingButton.addEventListener("click", () => this.#handleSelectFromExisting());
        uploadNewButton.addEventListener("click", () => this.#handleUploadNew());
    }

    #handleSelectFromExisting()
    {
        const existingSelector = document.createElement("information-source-existing-selector");

        const dialog = DialogBox.modal
        (
            `
                <style>
                    .select-existing-modal-header
                    {
                        font-size: 18px;
                        font-weight: 700;
                        color: #ffffff;
                        padding-bottom: 15px;
                        margin-bottom: 15px;
                        border-bottom: 1px solid #2c2c2c;
                    }

                    .select-existing-modal-selector-container
                    {
                        margin-top: 5px;
                    }
                </style>

                <div class="select-existing-modal-header">Select From Existing</div>
                <div class="select-existing-modal-selector-container"></div>
            `
        );

        const selectorContainer = dialog.querySelector(".select-existing-modal-selector-container");
        selectorContainer.appendChild(existingSelector);

        existingSelector.addEventListener(AutomaticGenerationEvents.ON_EXISTING_INFORMATION_SOURCE_SELECTED, (event) =>
        {
            const { informationSource } = event.detail;

            dialog.close();

            this.dispatchEvent(new CustomEvent(AutomaticGenerationEvents.ON_INFORMATION_SOURCE_UPLOADED,
            {
                bubbles: true,
                detail: { informationSource, xhr: null }
            }));
        });
    }

    #handleUploadNew()
    {
        const informationSourceFileSelector = document.createElement("information-source-file-selector");

        const dialog = DialogBox.modal
        (
            `
                <style>
                    .upload-new-modal-header
                    {
                        font-size: 18px;
                        font-weight: 700;
                        color: #ffffff;
                        padding-bottom: 15px;
                        margin-bottom: 5px;
                        border-bottom: 1px solid #2c2c2c;
                    }

                    .upload-new-modal-file-selector-container
                    {
                        width: min(400px, calc(90vw - 48px));
                        margin: 15px 0;
                    }

                    .upload-new-modal-option-row
                    {
                        display: flex;
                        align-items: center;
                        gap: 8px;
                        margin: 4px 0;
                        font-size: 13px;
                        cursor: pointer;
                    }

                    /* Sits directly under the OCR checkbox it explains, indented to
                       the checkbox's label so it reads as that row's footnote
                       rather than as a second, unrelated option. */
                    .upload-new-modal-option-hint
                    {
                        margin: 0 0 8px 26px;
                        font-size: 11.5px;
                        line-height: 1.45;
                        color: #9a9a9a;
                    }

                    .upload-new-modal-upload-button
                    {
                        width: 100%;
                        padding: 12px 20px;
                        border-radius: 8px;
                        background: linear-gradient(45deg, #0098C4, #B55BD0);
                        color: #ffffff;
                        font-weight: 700;
                        font-size: 14px;
                        cursor: pointer;
                        border: none;
                        margin-top: 5px;
                        letter-spacing: 0.3px;
                        transition: opacity 0.2s ease-in-out;
                        box-sizing: border-box;
                    }

                    .upload-new-modal-upload-button:hover
                    {
                        opacity: 0.85;
                        background: linear-gradient(45deg, #0098C4, #B55BD0);
                    }
                </style>

                <div class="upload-new-modal-header">Upload New Source</div>
                <intellectual-property-notice context="upload"></intellectual-property-notice>
                <div class="upload-new-modal-file-selector-container"></div>
                <label class="upload-new-modal-option-row">
                    <input type="checkbox" class="upload-new-modal-keep-permanently" checked>
                    Keep this source permanently (stored sources count toward storage credits; uncheck to keep it temporary)
                </label>
                <label class="upload-new-modal-option-row">
                    <input type="checkbox" class="upload-new-modal-run-ocr" checked>
                    Run text recognition (OCR) on this document
                </label>
                <div class="upload-new-modal-option-hint">
                    Leave this on for scanned books, photographed pages or slide images — it is what makes their text readable.
                    Turn it off for documents that already have selectable text: the upload finishes noticeably faster and the file is stored exactly as you sent it.
                </div>
                <button class="upload-new-modal-upload-button">Upload</button>
            `
        );

        const fileSelectorContainer = dialog.querySelector(".upload-new-modal-file-selector-container");
        fileSelectorContainer.appendChild(informationSourceFileSelector);

        const uploadButton = dialog.querySelector(".upload-new-modal-upload-button");

        uploadButton.addEventListener("click", async () =>
        {
            const file = informationSourceFileSelector.getFile();
            const name = informationSourceFileSelector.getName();
            const tags = informationSourceFileSelector.getTags();
            const sourceTypeKey = this.getAttribute("source-type-key");

            const keepPermanentlyCheckbox = dialog.querySelector(".upload-new-modal-keep-permanently");
            const retentionMode = (keepPermanentlyCheckbox === null || keepPermanentlyCheckbox.checked)
                ? contentRetentionModes.PERMANENT
                : contentRetentionModes.TEMPORARY;

            // OCR is opt-OUT, not opt-in: a missing checkbox resolves to ENABLED,
            // which is the behaviour every upload had before this control existed.
            // Getting this backwards would silently stop OCRing scanned uploads,
            // and the symptom (a generation that finds no text) would surface far
            // from the cause.
            const runOcrCheckbox = dialog.querySelector(".upload-new-modal-run-ocr");
            const ocrMode = (runOcrCheckbox === null || runOcrCheckbox.checked)
                ? ocrModes.ENABLED
                : ocrModes.DISABLED;

            const informationSource = new InformationSource
            ({
                name: name,
                tags: tags,
                sourceType: informationSourceTypes[sourceTypeKey],
                mimeType: file !== null ? file.type : '',
                retentionMode: retentionMode,
                ocrMode: ocrMode
            });

            const xhr = new XMLHttpRequest();
            xhr.open("POST", `/InformationSource/Upload?metadata=${encodeURIComponent(JSON.stringify(informationSource.toJson()))}`);

            this.dispatchEvent(new CustomEvent(AutomaticGenerationEvents.ON_INFORMATION_SOURCE_UPLOADED,
            {
                bubbles: true,
                detail: { informationSource, xhr }
            }));

            dialog.close();

            const formData = new FormData();
            formData.append("file", file ?? new Blob([], { type: "application/octet-stream" }));

            xhr.send(formData);
        });
    }
}

customElements.define("information-source-uploader", InformationSourceUploader);
export default InformationSourceUploader;