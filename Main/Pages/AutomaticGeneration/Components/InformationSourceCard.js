import TaskProgressTracker from "../../../Globals/Classes/Task/TaskProgressTracker.js";
import InformationSource from "../../../Globals/Model/InformationSource.js";
import AutomaticGenerationEvents from "../../../Globals/Events/AutomaticGenerationEvents.js";
import { taskStatus } from "../../../Globals/Enumerations/TaskStatus.js";
import { ocrModes } from "../../../Globals/Enumerations/OcrModes.js";
import InformationSourceUploadProgress from "../../../Globals/Constants/InformationSourceUploadProgress.js";

class InformationSourceCard extends HTMLElement
{
    static tagName = "information-source-card";

    // OCR now runs in the background (on a worker, not the request) after a fast
    // upload response; the card polls the tracking task instead of holding one
    // long HTTP request open. The server writes the task's terminal status only
    // AFTER OCR (the OcrPdf worker caps it at 10 min) *and* the GCS upload of the
    // OCRed PDF *and* the DB save — so the client must poll comfortably past 10 min,
    // or it would abandon a large upload the server is still finalizing (the source
    // would save server-side but show as failed here). 15 min gives ~5 min headroom.
    static OCR_POLL_MAX_DURATION_MILLISECONDS = 15 * 60 * 1000;

    // Fraction of the bar reserved for the byte-upload phase, which the XHR
    // reports for real. The remainder belongs to the server phase and is driven
    // entirely by completion values the server has written — see
    // #renderServerPhaseProgress. Nothing on this card is time-based: a bar that
    // advances on a timer tells the user a number the server never claimed, and
    // it keeps climbing just as convincingly when the pipeline has stalled.
    static UPLOAD_PHASE_FRACTION = InformationSourceUploadProgress.UPLOAD_PHASE_FRACTION;

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
        // Styling lives in Pages/AutomaticGeneration/Styles/InformationSourceCard.css.
        // It used to be duplicated here as an inline <style>, which won on
        // document order and had drifted from the sheet — the two copies
        // disagreed about whether the header could shrink, which decided whether
        // a long filename truncated or overflowed the card.
        this.innerHTML =
        `
            <div class="information-source-card-header">
                <img class="information-source-card-icon" src="./Globals/Assets/Images/Icons/FileIconGray.svg" alt="">
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
        const uploadPhaseCeiling = InformationSourceCard.UPLOAD_PHASE_FRACTION;

        this.#statusLabel.textContent = "Uploading...";

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

        // The bytes are up; everything after this belongs to the server. Park the
        // bar at the end of the upload phase and say what is happening, with no
        // percentage yet — the first real number arrives on the first poll of the
        // tracking task, a moment later.
        this.#xhr.upload.addEventListener("load", () =>
        {
            this.#progressFill.style.width = `${Math.round(InformationSourceCard.UPLOAD_PHASE_FRACTION * 100)}%`;
            this.#statusLabel.textContent = `${this.#getProcessingPhaseLabel()}...`;
        });

        this.#xhr.addEventListener("load", () =>
        {
            if (this.#xhr.status !== 200)
            {
                if (this.#xhr.status === 409)
                {
                    this.#renderErrorState(this.#xhr.responseText || "You have already uploaded a source with the same content.");
                }
                else if (this.#xhr.status === 500)
                {
                    let serverReason = "Upload failed during OCR or storage step.";
                    try
                    {
                        const parsedResponse = JSON.parse(this.#xhr.responseText);
                        if (parsedResponse?.reason)
                        {
                            serverReason = parsedResponse.reason;
                        }
                    }
                    catch (_) {}
                    this.#renderErrorState(serverReason);
                }
                else
                {
                    console.error(`[InformationSourceCard] Upload failed (HTTP ${this.#xhr.status}).`);
                    this.#renderErrorState("Upload failed. Please try again.");
                }
                return;
            }

            // Success. The body is one of two shapes:
            //   { taskId, informationSource } — OCR runs in the background; the
            //     upload response returned fast, so poll the tracking task.
            //   <bare InformationSource JSON> — already OCRed (CAS hit); ready now.
            let parsedResponse = null;
            try
            {
                parsedResponse = JSON.parse(this.#xhr.responseText);
            }
            catch (parseError)
            {
                this.#renderErrorState("Upload succeeded but the server response was unreadable.");
                return;
            }

            if (parsedResponse && parsedResponse.taskId)
            {
                // Poll the tracking task; every bar update from here on comes from
                // a completion value the server wrote.
                this.#pollOcrTaskUntilReady(parsedResponse.taskId, parsedResponse.informationSource);
                return;
            }

            // Fast path: the body is the ready server source.
            this.#finishReady(parsedResponse);
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

    /**
     * The server-phase fraction (0..1) reported by a polled task tree.
     *
     * Two nodes carry a completion value. The root is the tracking task Dock
     * owns; it marks the coarse milestones around the worker (staged, processed).
     * Its single child is the OcrPdf task, which reports its own finer progress
     * as it reads the staged object, runs the syllabus gate, OCRs (or doesn't)
     * and writes the content object — so the child is mapped into the band the
     * root reserves for it.
     *
     * Taking the max of the two keeps the bar monotonic across the handover: the
     * root jumps to PROCESSED the instant the worker returns, which is never
     * behind where the child had reached.
     */
    #readServerPhaseFraction(taskTree)
    {
        if (!taskTree)
        {
            return 0;
        }

        const rootCompletion = typeof taskTree.completion === "number" ? taskTree.completion : 0;

        const workerNode = Array.isArray(taskTree.children) ? taskTree.children[0] : null;
        if (!workerNode || typeof workerNode.completion !== "number")
        {
            return rootCompletion;
        }

        const bandStart = InformationSourceUploadProgress.WORKER_BAND_START;
        const bandEnd = InformationSourceUploadProgress.WORKER_BAND_END;
        const workerContribution = bandStart + workerNode.completion * (bandEnd - bandStart);

        return Math.max(rootCompletion, workerContribution);
    }

    /**
     * Paints the bar for a polled task tree. The upload phase already owns the
     * first UPLOAD_PHASE_FRACTION of the bar, so the server phase fills the rest.
     */
    #renderServerPhaseProgress(taskTree)
    {
        const uploadFraction = InformationSourceCard.UPLOAD_PHASE_FRACTION;
        const serverFraction = this.#readServerPhaseFraction(taskTree);
        const overallPercent = Math.round((uploadFraction + serverFraction * (1 - uploadFraction)) * 100);

        this.#progressFill.style.width = `${overallPercent}%`;
        this.#statusLabel.textContent = `${this.#getProcessingPhaseLabel()} ${overallPercent}%`;
    }

    /**
     * What to call the server-side phase this card is waiting on. With OCR on it
     * really is OCR and that is the slow part worth naming; with OCR off the
     * server is only landing the file, so calling it "OCR" would be a plain lie
     * to the user who just switched it off. Falls back to the OCR wording when
     * the mode is unknown, matching the server's own default.
     */
    #getProcessingPhaseLabel()
    {
        return this.#informationSource?.getOcrMode() === ocrModes.DISABLED
            ? "Processing"
            : "OCR";
    }

    /**
     * Polls the background tracking task via /Generate/Progress until it is
     * terminal, repainting the bar from each poll's real completion values. On
     * COMPLETED the card finishes and emits the ready event; on FAILED (or a
     * poll timeout) it renders the error.
     */
    async #pollOcrTaskUntilReady(taskId, serverInformationSourceJson)
    {
        let finalTaskTree = null;

        try
        {
            finalTaskTree = await TaskProgressTracker.pollUntilTerminal(
                taskId,
                (statusChange) =>
                {
                    if (statusChange.phase === "progress")
                    {
                        this.#renderServerPhaseProgress(statusChange.taskTree);
                    }
                },
                InformationSourceCard.OCR_POLL_MAX_DURATION_MILLISECONDS
            );
        }
        catch (pollError)
        {
            this.#renderErrorState(`Timed out waiting for ${this.#getProcessingPhaseLabel().toLowerCase()} to finish. Please try again.`);
            return;
        }

        const finalStatus = (finalTaskTree && typeof finalTaskTree.status === "number")
            ? finalTaskTree.status
            : taskStatus.UNKNOWN;

        if (finalStatus === taskStatus.COMPLETED)
        {
            this.#finishReady(serverInformationSourceJson);
        }
        else
        {
            const reason = (finalTaskTree && finalTaskTree.error)
                ? finalTaskTree.error
                : `${this.#getProcessingPhaseLabel()} failed. Please try again.`;
            this.#renderErrorState(reason);
        }
    }

    /**
     * Adopts the server-resolved InformationSource (it carries the hash and
     * directory path the generation pipeline needs), renders the complete state,
     * and emits ON_INFORMATION_SOURCE_READY so the selector can make the source
     * usable. Used by both the background-OCR path and the fast CAS-hit path.
     */
    #finishReady(serverInformationSourceJson)
    {
        if (serverInformationSourceJson)
        {
            try
            {
                this.#informationSource = InformationSource.fromJson(serverInformationSourceJson);
            }
            catch (_) {}
        }

        this.#renderCompleteState();

        this.dispatchEvent(new CustomEvent(AutomaticGenerationEvents.ON_INFORMATION_SOURCE_READY,
        {
            bubbles: false,
            detail: { informationSource: this.#informationSource }
        }));
    }

    #renderCompleteState()
    {
        this.classList.remove("state-uploading");
        this.classList.add("state-complete");

        this.#progressTrack.style.display = "none";
        this.#statusLabel.innerHTML =
        `
            <img class="information-source-card-check-icon" src="./Globals/Assets/Images/Icons/CheckIcon.svg" alt="">
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