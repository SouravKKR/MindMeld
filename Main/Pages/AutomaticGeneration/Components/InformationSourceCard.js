import { ocrModes } from "../../../Globals/Enumerations/OcrModes.js";
import { pollTaskCompletion } from "../../../Globals/UtilityFunctions/PollTaskCompletion.js";


class InformationSourceCard extends HTMLElement
{
    static tagName = "information-source-card";

    // Fraction of the bar reserved for the byte-upload phase when OCR is
    // also expected — the remainder is fed by the Agent OCR task's
    // completion ticks via /Generate/Progress polling.
    static UPLOAD_PHASE_FRACTION_WITH_OCR = 0.5;

    #informationSource = null;
    #xhr = null;

    #progressFill = null;
    #statusLabel = null;
    #progressTrack = null;
    #tagsContainer = null;
    #errorMessage = null;

    static create(informationSource, xhr)
    {
        const informationSourceCard = document.createElement("information-source-card");
        informationSourceCard.initialize(informationSource, xhr);
        return informationSourceCard;
    }

    initialize(informationSource, xhr)
    {
        this.#informationSource = informationSource;
        this.#xhr = xhr;

        if (this.isConnected && this.#progressFill !== null)
        {
            this.#bindXhrEvents();
        }
    }

    connectedCallback()
    {
        this.innerHTML =
        `
            <style>
                information-source-card
                {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                    padding: 12px 15px;
                    border-radius: 8px;
                    background-color: #1f1f1f;
                    border: 1px solid #2c2c2c;
                    margin-top: 5px;
                    transition: border-color 0.3s ease-in-out;
                }

                information-source-card.state-uploading
                {
                    border-color: rgba(0, 152, 196, 0.35);
                }

                information-source-card.state-complete
                {
                    border-color: rgba(0, 196, 130, 0.35);
                }

                information-source-card.state-error
                {
                    border-color: rgba(220, 80, 80, 0.35);
                }

                .information-source-card-header
                {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                }

                .information-source-card-icon
                {
                    width: 16px;
                    height: 16px;
                    flex-shrink: 0;
                }

                .information-source-card-name
                {
                    flex: 1;
                    font-size: 13px;
                    font-weight: 600;
                    color: #ffffff;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }

                .information-source-card-status-label
                {
                    font-size: 11px;
                    font-weight: 500;
                    flex-shrink: 0;
                }

                information-source-card.state-uploading .information-source-card-status-label
                {
                    color: #0098C4;
                }

                information-source-card.state-complete .information-source-card-status-label
                {
                    color: #00C482;
                }

                information-source-card.state-error .information-source-card-status-label
                {
                    color: #DC5050;
                }

                .information-source-card-progress-track
                {
                    width: 100%;
                    height: 3px;
                    border-radius: 2px;
                    background-color: #2c2c2c;
                    overflow: hidden;
                }

                .information-source-card-progress-fill
                {
                    height: 100%;
                    border-radius: 2px;
                    background: linear-gradient(90deg, #0098C4, #B55BD0);
                    transition: width 0.15s ease-out;
                    width: 0%;
                }

                .information-source-card-tags
                {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 5px;
                }

                .information-source-card-tag
                {
                    font-size: 11px;
                    font-weight: 500;
                    color: #0098C4;
                    background-color: rgba(0, 152, 196, 0.1);
                    border: 1px solid rgba(0, 152, 196, 0.25);
                    border-radius: 4px;
                    padding: 2px 7px;
                }

                .information-source-card-error-message
                {
                    font-size: 11px;
                    color: #DC5050;
                }
            </style>

            <div class="information-source-card-header">
                <svg class="information-source-card-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M14 2H6C5.46957 2 4.96086 2.21071 4.58579 2.58579C4.21071 2.96086 4 3.46957 4 4V20C4 20.5304 4.21071 21.0391 4.58579 21.4142C4.96086 21.7893 5.46957 22 6 22H18C18.5304 22 19.0391 21.7893 19.4142 21.4142C19.7893 21.0391 20 20.5304 20 20V8L14 2Z" stroke="#888888" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                    <path d="M14 2V8H20" stroke="#888888" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                <div class="information-source-card-name">${this.#informationSource?.getName() ?? "Unnamed Source"}</div>
                <div class="information-source-card-status-label">Uploading...</div>
            </div>

            <div class="information-source-card-progress-track">
                <div class="information-source-card-progress-fill"></div>
            </div>

            <div class="information-source-card-tags" style="display: none;"></div>
            <div class="information-source-card-error-message" style="display: none;"></div>
        `;

        this.#progressFill = this.querySelector(".information-source-card-progress-fill");
        this.#statusLabel = this.querySelector(".information-source-card-status-label");
        this.#progressTrack = this.querySelector(".information-source-card-progress-track");
        this.#tagsContainer = this.querySelector(".information-source-card-tags");
        this.#errorMessage = this.querySelector(".information-source-card-error-message");

        if (this.#xhr === null)
        {
            this.#renderCompleteState();
        }
        else
        {
            this.classList.add("state-uploading");
            this.#bindXhrEvents();
        }
    }

    #bindXhrEvents()
    {
        const bOcrExpected = this.#isOcrRequested();
        const uploadPhaseCeiling = bOcrExpected ? InformationSourceCard.UPLOAD_PHASE_FRACTION_WITH_OCR : 1;

        if (bOcrExpected)
        {
            // Set the initial label so the user knows OCR will run after
            // the byte upload finishes — the bar otherwise looks paused
            // mid-way through the operation.
            this.#statusLabel.textContent = "Uploading...";
        }

        this.#xhr.upload.addEventListener("progress", (uploadProgressEvent) =>
        {
            if (uploadProgressEvent.lengthComputable)
            {
                const uploadFraction = uploadProgressEvent.loaded / uploadProgressEvent.total;
                const overallPercent = Math.round(uploadFraction * uploadPhaseCeiling * 100);
                this.#progressFill.style.width = `${overallPercent}%`;
                this.#statusLabel.textContent = `${overallPercent}%`;
            }
        });

        this.#xhr.addEventListener("load", () =>
        {
            if (this.#xhr.status !== 200)
            {
                if (this.#xhr.status === 409)
                {
                    this.#renderErrorState(this.#xhr.responseText || "You have already uploaded a source with the same content.");
                }
                else
                {
                    this.#renderErrorState(`Upload failed (${this.#xhr.status})`);
                }
                return;
            }

            const pendingTaskId = this.#extractPendingTaskIdFromResponse();
            if (pendingTaskId === null)
            {
                this.#renderCompleteState();
                return;
            }

            this.#trackOcrTaskCompletion(pendingTaskId);
        });

        this.#xhr.addEventListener("error", () =>
        {
            this.#renderErrorState("Network error — upload could not complete");
        });

        this.#xhr.addEventListener("abort", () =>
        {
            this.#renderErrorState("Upload was cancelled");
        });
    }

    #isOcrRequested()
    {
        if (!this.#informationSource || typeof this.#informationSource.getOcrMode !== "function")
        {
            return false;
        }
        const ocrModeValue = this.#informationSource.getOcrMode();
        return ocrModeValue !== undefined && ocrModeValue !== null && ocrModeValue !== ocrModes.DISABLED;
    }

    #extractPendingTaskIdFromResponse()
    {
        try
        {
            const parsedResponse = JSON.parse(this.#xhr.responseText);
            return parsedResponse?.pendingTaskId ?? null;
        }
        catch (parseError)
        {
            return null;
        }
    }

    async #trackOcrTaskCompletion(pendingTaskId)
    {
        // Snap the bar to the upload-phase ceiling and switch the label so
        // the user knows we're now waiting on the Agent rather than the
        // network upload.
        const uploadPercent = Math.round(InformationSourceCard.UPLOAD_PHASE_FRACTION_WITH_OCR * 100);
        this.#progressFill.style.width = `${uploadPercent}%`;
        this.#statusLabel.textContent = "Running OCR...";

        try
        {
            await pollTaskCompletion(pendingTaskId, (taskCompletionFraction) =>
            {
                const overallFraction = InformationSourceCard.UPLOAD_PHASE_FRACTION_WITH_OCR
                    + (1 - InformationSourceCard.UPLOAD_PHASE_FRACTION_WITH_OCR) * taskCompletionFraction;
                const overallPercent = Math.round(overallFraction * 100);
                this.#progressFill.style.width = `${overallPercent}%`;
                this.#statusLabel.textContent = `OCR ${overallPercent}%`;
            });

            this.#renderCompleteState();
        }
        catch (pollError)
        {
            console.error(`[InformationSourceCard] OCR poll failed: ${pollError.message}`);
            this.#renderErrorState("OCR processing failed. Please retry, or upload with OCR disabled.");
        }
    }

    #renderCompleteState()
    {
        this.classList.remove("state-uploading");
        this.classList.add("state-complete");

        this.#progressTrack.style.display = "none";
        this.#statusLabel.innerHTML =
        `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M20 6L9 17L4 12" stroke="#00C482" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
        `;

        const tags = this.#informationSource.getTags() ?? [];
        if (tags.length > 0)
        {
            this.#tagsContainer.style.display = "flex";
            this.#tagsContainer.innerHTML = tags
                .map(tag => `<span class="information-source-card-tag">${tag}</span>`)
                .join("");
        }
    }

    #renderErrorState(message)
    {
        this.classList.remove("state-uploading");
        this.classList.add("state-error");

        this.#progressTrack.style.display = "none";
        this.#statusLabel.textContent = "Failed";

        this.#errorMessage.style.display = "block";
        this.#errorMessage.textContent = message;
    }
}

customElements.define("information-source-card", InformationSourceCard);
export default InformationSourceCard;