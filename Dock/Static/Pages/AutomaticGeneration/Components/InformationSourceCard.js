class InformationSourceCard extends HTMLElement
{
    static tagName = "information-source-card";

    // Fraction of the bar reserved for the byte-upload phase. The remainder
    // is held back until the server response returns (which happens after
    // the server-side OCR step). Without the cap the bar would hit 100%
    // immediately on upload completion while OCR was still running.
    static UPLOAD_PHASE_FRACTION = 0.5;

    // Asymptotic ceiling for the OCR-phase animation. The bar approaches
    // this value while the HTTP response is in flight but never reaches
    // it — that final jump happens when the server actually responds.
    static OCR_PHASE_CEILING = 0.95;

    // Tunes how fast the OCR animation creeps. Higher = slower approach
    // to the ceiling. At t = HALF_LIFE_MILLISECONDS, the animation is at
    // half the remaining distance to the ceiling; at 2 × that, it's at
    // three-quarters; etc. Picked so a typical sub-minute OCR pass looks
    // visibly active without sprinting to the ceiling in 5 seconds.
    static OCR_ANIMATION_HALF_LIFE_MILLISECONDS = 20 * 1000;

    // Cadence for the OCR-phase animation tick. 200ms is the longest
    // interval that still feels live to the user; anything shorter
    // wastes redraws.
    static OCR_ANIMATION_TICK_MILLISECONDS = 200;

    #informationSource = null;
    #xhr = null;

    #progressFill = null;
    #statusLabel = null;
    #progressTrack = null;
    #tagsContainer = null;
    #errorMessage = null;

    #ocrAnimationIntervalId = null;

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
                    display: block;
                }

                .information-source-card-check-icon
                {
                    width: 14px;
                    height: 14px;
                    display: block;
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

        // Once the byte upload finishes the server starts OCR. We have
        // no real progress channel from ocrmypdf back to the client
        // during a single HTTP request, so animate an asymptotic creep
        // from the upload ceiling toward (but never to) OCR_PHASE_CEILING.
        // The bar visibly moves, the user sees a percentage, and the
        // final jump to 100% happens when the response actually lands.
        this.#xhr.upload.addEventListener("load", () =>
        {
            this.#startOcrPhaseAnimation();
        });

        this.#xhr.addEventListener("load", () =>
        {
            this.#stopOcrPhaseAnimation();

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
                    this.#renderErrorState(`Upload failed (${this.#xhr.status})`);
                }
                return;
            }

            this.#renderCompleteState();
        });

        this.#xhr.addEventListener("error", () =>
        {
            this.#stopOcrPhaseAnimation();
            this.#renderErrorState("Network error — upload could not complete");
        });

        this.#xhr.addEventListener("abort", () =>
        {
            this.#stopOcrPhaseAnimation();
            this.#renderErrorState("Upload was cancelled");
        });
    }

    #startOcrPhaseAnimation()
    {
        // Defensive: if a previous call already started the animation
        // (e.g. xhr.upload "load" fired twice on a quirky browser),
        // don't stack a second interval.
        if (this.#ocrAnimationIntervalId !== null)
        {
            return;
        }

        const animationStartFraction  = InformationSourceCard.UPLOAD_PHASE_FRACTION;
        const animationCeilingFraction = InformationSourceCard.OCR_PHASE_CEILING;
        const animationStartTime       = Date.now();
        const halfLifeMilliseconds     = InformationSourceCard.OCR_ANIMATION_HALF_LIFE_MILLISECONDS;

        const tick = () =>
        {
            const elapsedMilliseconds = Date.now() - animationStartTime;
            // Exponential approach: at elapsed == halfLife the bar is at
            // half the remaining distance to the ceiling; at 2× halfLife,
            // three-quarters; etc. Bounded above by the ceiling.
            const approachProgress = 1 - Math.pow(0.5, elapsedMilliseconds / halfLifeMilliseconds);
            const currentFraction  = animationStartFraction
                + (animationCeilingFraction - animationStartFraction) * approachProgress;
            const currentPercent   = Math.round(currentFraction * 100);

            this.#progressFill.style.width = `${currentPercent}%`;
            this.#statusLabel.textContent  = `OCR ${currentPercent}%`;
        };

        tick();
        this.#ocrAnimationIntervalId = setInterval(tick, InformationSourceCard.OCR_ANIMATION_TICK_MILLISECONDS);
    }

    #stopOcrPhaseAnimation()
    {
        if (this.#ocrAnimationIntervalId === null)
        {
            return;
        }
        clearInterval(this.#ocrAnimationIntervalId);
        this.#ocrAnimationIntervalId = null;
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