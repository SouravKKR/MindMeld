import { tutorialStepTypes } from "../Globals/Enumerations/TutorialStepTypes.js";
import FullscreenImageViewer from "./FullscreenImageViewer.js";

/**
 * TutorialOverlay
 *
 * The visual layer of the tutorial system. It can render four kinds of
 * step (see tutorialStepTypes) and exposes a small imperative API the
 * TutorialEngine drives:
 *
 *   showStep(step, { stepIndex, stepCount, callbacks })
 *   hide()
 *
 * Highlight steps draw a CSS clip-path "spotlight" over a real DOM
 * element so the rest of the screen is dimmed but the target stays fully
 * lit and re-rendered live (no DOM cloning). The tooltip is positioned
 * adjacent to the target with a small gap.
 *
 * The overlay is mounted once globally (see index.html). Pointer / key
 * events are captured at the overlay level so background pages cannot
 * receive input during a tutorial — except the highlighted target during
 * WAIT_FOR_CLICK steps, which deliberately passes through.
 */
class TutorialOverlay extends HTMLElement
{
    static #SPOTLIGHT_PADDING_PIXELS  = 8;
    static #TOOLTIP_GAP_PIXELS        = 12;

    static #TARGET_POLL_TIMEOUT_MILLISECONDS = 2000;

    #currentStep      = null;
    #currentCallbacks = null;
    #targetElement    = null;
    #waitForClickHandler = null;
    #waitForEventHandler = null;
    #waitForEventName    = null;
    #repositionFrameId   = null;
    #stepTokenId         = 0;
    #validatorPollFrameId  = null;
    #validatorTargetElement = null;
    #validatorInputHandler  = null;

    connectedCallback()
    {
        this.innerHTML =
        `
            <div class="tutorial-overlay-mask">
                <div class="tutorial-overlay-spotlight"></div>
            </div>
            <div class="tutorial-overlay-iframe-frame" style="display: none;">
                <iframe class="tutorial-overlay-iframe" sandbox="allow-scripts allow-forms allow-same-origin"></iframe>
            </div>
            <div class="tutorial-overlay-tooltip" role="dialog" aria-modal="true">
                <div class="tutorial-overlay-progress"></div>
                <div class="tutorial-overlay-title"></div>
                <div class="tutorial-overlay-body"></div>
                <div class="tutorial-overlay-buttons">
                    <button class="tutorial-overlay-skip-button">Skip</button>
                    <div class="tutorial-overlay-buttons-right">
                        <button class="tutorial-overlay-start-over-button">Start over</button>
                        <button class="tutorial-overlay-next-button">Next</button>
                        <button class="tutorial-overlay-finish-button" style="display: none;">Finish</button>
                    </div>
                </div>
            </div>
        `;

        this.style.display = "none";

        this.#bindButtonHandlers();
        this.#bindReposition();
    }

    disconnectedCallback()
    {
        window.removeEventListener("resize",  this.#handleReposition);
        window.removeEventListener("scroll",  this.#handleReposition, true);
        this.#detachWaitForClickHandler();
        this.#detachWaitForEventHandler();
        this.#detachValidator();

        if (this.#repositionFrameId)
        {
            cancelAnimationFrame(this.#repositionFrameId);
            this.#repositionFrameId = null;
        }
    }

    #bindButtonHandlers()
    {
        this.querySelector(".tutorial-overlay-skip-button").addEventListener("click", () =>
        {
            this.#currentCallbacks?.onSkip?.();
        });

        this.querySelector(".tutorial-overlay-start-over-button").addEventListener("click", () =>
        {
            this.#currentCallbacks?.onStartOver?.();
        });

        this.querySelector(".tutorial-overlay-next-button").addEventListener("click", () =>
        {
            this.#currentCallbacks?.onNext?.();
        });

        this.querySelector(".tutorial-overlay-finish-button").addEventListener("click", () =>
        {
            this.#currentCallbacks?.onFinish?.();
        });
    }

    #bindReposition()
    {
        window.addEventListener("resize",  this.#handleReposition);
        window.addEventListener("scroll",  this.#handleReposition, true);
    }

    #handleReposition = () =>
    {
        if (this.#repositionFrameId)
        {
            return;
        }

        this.#repositionFrameId = requestAnimationFrame(() =>
        {
            this.#repositionFrameId = null;
            this.#layoutForCurrentStep();
        });
    };

    /**
     * Render a step. `options`:
     *   stepIndex   - zero-based current index
     *   stepCount   - total number of steps in the tutorial
     *   bIsLastStep - true on the final step (swap Next → Finish)
     *   callbacks   - { onStartOver, onNext, onSkip, onFinish }
     */
    showStep(step, options)
    {
        // Bumping the step token invalidates any selector poll still
        // running for an earlier step (page transitions can cause stale
        // polls to land on the wrong selector otherwise).
        const myToken = ++this.#stepTokenId;

        this.#currentStep      = step;
        this.#currentCallbacks = options.callbacks || {};

        this.style.display = "block";

        const progressLabel  = this.querySelector(".tutorial-overlay-progress");
        const titleElement   = this.querySelector(".tutorial-overlay-title");
        const bodyElement    = this.querySelector(".tutorial-overlay-body");
        const startOverButton = this.querySelector(".tutorial-overlay-start-over-button");
        const nextButton      = this.querySelector(".tutorial-overlay-next-button");
        const finishButton    = this.querySelector(".tutorial-overlay-finish-button");
        const tooltipElement  = this.querySelector(".tutorial-overlay-tooltip");

        progressLabel.textContent = `Step ${options.stepIndex + 1} of ${options.stepCount}`;
        titleElement.textContent  = step.title || "";
        // Body can be a string OR a function returning a string —
        // functions defer computation to render time so steps whose
        // body references other registry entries (e.g. the final
        // "list all tutorials" modal) don't trigger forward-reference
        // errors at static-field initialisation.
        const resolvedBody = (typeof step.body === "function") ? step.body() : (step.body || "");
        bodyElement.innerHTML     = resolvedBody;

        // Start over is only useful past the first step.
        startOverButton.style.display = options.stepIndex > 0 ? "" : "none";
        nextButton.style.display      = options.bIsLastStep ? "none" : "";
        finishButton.style.display    = options.bIsLastStep ? "" : "none";

        // `tooltipWidth` accepts the string variants "normal" | "wide" | "xwide".
        // For back-compat, a legacy `bWideTooltip: true` still maps to "wide".
        const resolvedTooltipWidth = step.tooltipWidth || (step.bWideTooltip ? "wide" : "normal");
        tooltipElement.classList.toggle("tutorial-overlay-tooltip--wide", resolvedTooltipWidth === "wide");
        tooltipElement.classList.toggle("tutorial-overlay-tooltip--xwide", resolvedTooltipWidth === "xwide");

        this.#bindBodyEnhancers(bodyElement);

        this.#detachWaitForClickHandler();
        this.#detachWaitForEventHandler();
        this.#detachValidator();
        this.#clearTargetState();

        if (step.type === tutorialStepTypes.MODAL)
        {
            this.#renderModalStep();
        }
        else if (step.type === tutorialStepTypes.HIGHLIGHT)
        {
            this.#renderHighlightStep(step, { bWaitForClick: false, myToken });
        }
        else if (step.type === tutorialStepTypes.WAIT_FOR_CLICK)
        {
            this.#renderHighlightStep(step, { bWaitForClick: true,  myToken });
            nextButton.style.display = "none";
        }
        else if (step.type === tutorialStepTypes.WAIT_FOR_EVENT)
        {
            this.#renderHighlightStep(step, { bWaitForClick: false, myToken });
            this.#attachWaitForEventHandler(step.eventName);
            // The user advances by completing the real action, not by
            // pressing Next.
            nextButton.style.display = "none";
        }
        else if (step.type === tutorialStepTypes.IFRAME)
        {
            this.#renderIframeStep(step);
        }

        // After step-specific rendering, wire up the Next-button gate if
        // the step ships a validator. The validator runs synchronously on
        // each input event from the spotlight target — when it returns
        // false, Next is disabled and the user is forced to fill the
        // field in before they can advance.
        this.#attachValidatorIfDefined(step);
    }

    hide()
    {
        // Bump the token so any in-flight selector poll is abandoned.
        this.#stepTokenId++;

        this.style.display = "none";
        this.#currentStep      = null;
        this.#currentCallbacks = null;
        this.classList.remove("tutorial-overlay--modal", "tutorial-overlay--highlight", "tutorial-overlay--iframe", "tutorial-overlay--floating");
        this.#detachWaitForClickHandler();
        this.#detachWaitForEventHandler();
        this.#detachValidator();
        this.#clearTargetState();
        this.#hideIframe();
    }

    // ── Step renderers ────────────────────────────────────────────────

    /**
     * Scans freshly-rendered body HTML for interactive enhancement hooks —
     * currently the lifecycle-diagram zoom button — and wires them up.
     * Called after `bodyElement.innerHTML` is set in renderStep so the
     * elements exist in the DOM.
     */
    #bindBodyEnhancers(bodyElement)
    {
        const zoomButton = bodyElement.querySelector(".tutorial-lifecycle-diagram-zoom");
        if (zoomButton)
        {
            zoomButton.addEventListener("click", (clickEvent) =>
            {
                clickEvent.stopPropagation();
                clickEvent.preventDefault();
                const imageElement = zoomButton.querySelector("img");
                if (!imageElement)
                {
                    return;
                }
                TutorialOverlay.#openImageFullscreen(imageElement.getAttribute("src"), imageElement.getAttribute("alt") || "");
            });
        }
    }

    static #openImageFullscreen(imageSourceUrl, imageAltText)
    {
        FullscreenImageViewer.open(imageSourceUrl, imageAltText);
    }

    #renderModalStep()
    {
        this.classList.add("tutorial-overlay--modal");
        this.classList.remove("tutorial-overlay--highlight", "tutorial-overlay--iframe", "tutorial-overlay--floating");

        this.querySelector(".tutorial-overlay-mask").style.clipPath = "";
        this.#applyTooltipCenter();
        this.#hideIframe();
    }

    async #renderHighlightStep(step, { bWaitForClick, myToken })
    {
        this.classList.add("tutorial-overlay--highlight");
        this.classList.remove("tutorial-overlay--modal", "tutorial-overlay--iframe", "tutorial-overlay--floating");
        this.#hideIframe();

        let target = step.selector ? document.querySelector(step.selector) : null;

        // Page transitions (e.g. WAIT_FOR_CLICK advances → next page mounts)
        // mean the next step's selector may not be present for a few frames.
        // Poll briefly before falling back, but bail if the step has changed
        // beneath us.
        if (!target && step.selector)
        {
            target = await this.#waitForElement(step.selector, TutorialOverlay.#TARGET_POLL_TIMEOUT_MILLISECONDS, myToken);
        }

        if (myToken !== this.#stepTokenId)
        {
            return;
        }

        if (!target)
        {
            // Selector never resolved. DO NOT keep the full-page dim mask
            // — that's what produced the "deck was blurred / page greyed
            // out" effect on blank accounts. Switch to a floating tooltip
            // that leaves the underlying UI fully visible and interactive.
            if (step.fallbackBody)
            {
                this.querySelector(".tutorial-overlay-body").innerHTML = step.fallbackBody;
            }

            this.classList.remove("tutorial-overlay--highlight");
            this.classList.add("tutorial-overlay--floating");
            this.querySelector(".tutorial-overlay-mask").style.clipPath = "";
            this.#applyTooltipCenter();
            return;
        }

        this.#targetElement = target;
        this.#layoutSpotlightFor(target);

        if (bWaitForClick)
        {
            this.#attachWaitForClickHandler(target);
        }
    }

    /**
     * Resolves with the matched element once it appears in the DOM, or
     * null if the timeout elapses or the step token changes (i.e. a new
     * step has already been started). Implemented via requestAnimationFrame
     * to align with the browser's render cycle.
     */
    #waitForElement(selector, timeoutMilliseconds, myToken)
    {
        return new Promise((resolve) =>
        {
            const startTime = performance.now();

            const tick = () =>
            {
                if (myToken !== this.#stepTokenId)
                {
                    resolve(null);
                    return;
                }

                const matched = document.querySelector(selector);

                if (matched)
                {
                    resolve(matched);
                    return;
                }

                if (performance.now() - startTime > timeoutMilliseconds)
                {
                    resolve(null);
                    return;
                }

                requestAnimationFrame(tick);
            };

            requestAnimationFrame(tick);
        });
    }

    #renderIframeStep(step)
    {
        this.classList.add("tutorial-overlay--iframe");
        this.classList.remove("tutorial-overlay--modal", "tutorial-overlay--highlight", "tutorial-overlay--floating");

        const iframeFrame  = this.querySelector(".tutorial-overlay-iframe-frame");
        const iframeElement = this.querySelector(".tutorial-overlay-iframe");

        iframeElement.src = step.iframeUrl || "about:blank";
        iframeFrame.style.display = "block";

        this.querySelector(".tutorial-overlay-mask").style.clipPath = "";
        this.#applyTooltipCenter();
    }

    #hideIframe()
    {
        const iframeFrame  = this.querySelector(".tutorial-overlay-iframe-frame");
        const iframeElement = this.querySelector(".tutorial-overlay-iframe");

        iframeFrame.style.display = "none";

        if (iframeElement.src && iframeElement.src !== "about:blank")
        {
            iframeElement.src = "about:blank";
        }
    }

    // ── Layout helpers ────────────────────────────────────────────────

    #layoutForCurrentStep()
    {
        if (!this.#currentStep)
        {
            return;
        }

        if (this.#currentStep.type === tutorialStepTypes.HIGHLIGHT
            || this.#currentStep.type === tutorialStepTypes.WAIT_FOR_CLICK
            || this.#currentStep.type === tutorialStepTypes.WAIT_FOR_EVENT)
        {
            if (this.#targetElement && document.contains(this.#targetElement))
            {
                this.#layoutSpotlightFor(this.#targetElement);
            }
            else
            {
                this.querySelector(".tutorial-overlay-mask").style.clipPath = "";
                this.#applyTooltipCenter();
            }
        }
    }

    #layoutSpotlightFor(target)
    {
        const rect      = target.getBoundingClientRect();
        const padding   = TutorialOverlay.#SPOTLIGHT_PADDING_PIXELS;
        const tooltipGap = TutorialOverlay.#TOOLTIP_GAP_PIXELS;

        const top    = Math.max(0, rect.top    - padding);
        const left   = Math.max(0, rect.left   - padding);
        const right  = Math.min(window.innerWidth,  rect.right  + padding);
        const bottom = Math.min(window.innerHeight, rect.bottom + padding);

        const mask     = this.querySelector(".tutorial-overlay-mask");
        const spotlight = this.querySelector(".tutorial-overlay-spotlight");

        // Hole-punch the dim mask with an SVG-style clip-path covering the page
        // minus the target rectangle.
        mask.style.clipPath =
            `polygon(
                0 0,
                100% 0,
                100% 100%,
                0 100%,
                0 ${top}px,
                ${left}px ${top}px,
                ${left}px ${bottom}px,
                ${right}px ${bottom}px,
                ${right}px ${top}px,
                0 ${top}px
            )`;

        spotlight.style.top    = `${top}px`;
        spotlight.style.left   = `${left}px`;
        spotlight.style.width  = `${right - left}px`;
        spotlight.style.height = `${bottom - top}px`;

        this.#applyTooltipNear(rect, tooltipGap);
    }

    #applyTooltipNear(targetRect, gap)
    {
        const tooltip = this.querySelector(".tutorial-overlay-tooltip");

        tooltip.style.transform = "";

        // Make sure dimensions are up-to-date.
        const tooltipRect = tooltip.getBoundingClientRect();

        // Prefer placing below; fall back above; else center.
        const spaceBelow = window.innerHeight - targetRect.bottom;
        const spaceAbove = targetRect.top;

        let topPixels;

        if (spaceBelow >= tooltipRect.height + gap + 16)
        {
            topPixels = targetRect.bottom + gap;
        }
        else if (spaceAbove >= tooltipRect.height + gap + 16)
        {
            topPixels = targetRect.top - tooltipRect.height - gap;
        }
        else
        {
            topPixels = Math.max(16, (window.innerHeight - tooltipRect.height) / 2);
        }

        const idealLeft = targetRect.left + (targetRect.width / 2) - (tooltipRect.width / 2);
        const leftPixels = Math.min(
            Math.max(16, idealLeft),
            window.innerWidth - tooltipRect.width - 16
        );

        tooltip.style.top  = `${Math.max(16, topPixels)}px`;
        tooltip.style.left = `${leftPixels}px`;
    }

    #applyTooltipCenter()
    {
        const tooltip = this.querySelector(".tutorial-overlay-tooltip");

        tooltip.style.top  = "50%";
        tooltip.style.left = "50%";
        tooltip.style.transform = "translate(-50%, -50%)";
    }

    // ── WAIT_FOR_CLICK target handler ─────────────────────────────────

    #attachWaitForClickHandler(target)
    {
        this.#waitForClickHandler = () =>
        {
            this.#detachWaitForClickHandler();
            this.#currentCallbacks?.onNext?.();
        };

        target.addEventListener("click", this.#waitForClickHandler, { once: true, capture: true });
    }

    #detachWaitForClickHandler()
    {
        if (this.#waitForClickHandler && this.#targetElement)
        {
            this.#targetElement.removeEventListener("click", this.#waitForClickHandler, { capture: true });
        }

        this.#waitForClickHandler = null;
    }

    /**
     * Listen for a window-level event and advance the tutorial on the
     * first fire. Used by WAIT_FOR_EVENT steps so the tutorial only
     * advances on a confirmed successful action (e.g. a deck save that
     * passed validation) rather than any click.
     */
    #attachWaitForEventHandler(eventName)
    {
        if (!eventName)
        {
            return;
        }

        this.#waitForEventName = eventName;

        this.#waitForEventHandler = () =>
        {
            this.#detachWaitForEventHandler();
            this.#currentCallbacks?.onNext?.();
        };

        window.addEventListener(eventName, this.#waitForEventHandler, { once: true });
    }

    #detachWaitForEventHandler()
    {
        if (this.#waitForEventHandler && this.#waitForEventName)
        {
            window.removeEventListener(this.#waitForEventName, this.#waitForEventHandler);
        }

        this.#waitForEventHandler = null;
        this.#waitForEventName    = null;
    }

    #clearTargetState()
    {
        this.#targetElement = null;
        this.querySelector(".tutorial-overlay-mask").style.clipPath = "";
    }

    // ── Per-step Next-button validator ────────────────────────────────

    /**
     * Wires up a step's optional `canAdvanceValidator()` to the Next
     * button. The validator runs:
     *   - once at attach time (sets initial Next-disabled state)
     *   - on every `input` event from the spotlight target while the
     *     step is active
     *
     * The validator is intentionally synchronous so the Next button can
     * be toggled in the same tick as the keystroke that may have just
     * fulfilled it. Steps without a validator leave the Next button
     * fully enabled — the default behaviour.
     */
    #attachValidatorIfDefined(step)
    {
        const validator = step.canAdvanceValidator;
        if (typeof validator !== "function")
        {
            return;
        }

        // The validator usually depends on the spotlight target's value,
        // but the target may not be in the DOM yet (page just navigated).
        // Poll briefly via rAF until it appears — bail if the step has
        // changed beneath us.
        const myToken = this.#stepTokenId;

        const pollForTarget = () =>
        {
            if (myToken !== this.#stepTokenId)
            {
                this.#validatorPollFrameId = null;
                return;
            }

            const targetElement = step.selector ? document.querySelector(step.selector) : null;
            if (targetElement)
            {
                this.#validatorPollFrameId = null;
                this.#installValidatorOnTarget(targetElement, validator);
                this.#refreshValidatorButtonState(validator);
                return;
            }

            this.#validatorPollFrameId = requestAnimationFrame(pollForTarget);
        };

        if (step.selector)
        {
            this.#validatorPollFrameId = requestAnimationFrame(pollForTarget);
        }

        // Refresh once now in case the validator doesn't need a target
        // (rare — included so global-state validators still work).
        this.#refreshValidatorButtonState(validator);
    }

    #installValidatorOnTarget(targetElement, validator)
    {
        this.#validatorTargetElement = targetElement;
        this.#validatorInputHandler  = () =>
        {
            this.#refreshValidatorButtonState(validator);
        };

        targetElement.addEventListener("input", this.#validatorInputHandler);
    }

    #refreshValidatorButtonState(validator)
    {
        const nextButton = this.querySelector(".tutorial-overlay-next-button");
        if (!nextButton)
        {
            return;
        }

        let allowAdvance = true;
        try
        {
            allowAdvance = validator() === true;
        }
        catch (validatorError)
        {
            console.warn("[TutorialOverlay] canAdvanceValidator threw — defaulting to disabled:", validatorError);
            allowAdvance = false;
        }

        nextButton.disabled = !allowAdvance;
        nextButton.classList.toggle("tutorial-overlay-next-button--disabled", !allowAdvance);
    }

    #detachValidator()
    {
        if (this.#validatorPollFrameId)
        {
            cancelAnimationFrame(this.#validatorPollFrameId);
            this.#validatorPollFrameId = null;
        }

        if (this.#validatorTargetElement && this.#validatorInputHandler)
        {
            this.#validatorTargetElement.removeEventListener("input", this.#validatorInputHandler);
        }

        this.#validatorTargetElement = null;
        this.#validatorInputHandler  = null;

        const nextButton = this.querySelector(".tutorial-overlay-next-button");
        if (nextButton)
        {
            nextButton.disabled = false;
            nextButton.classList.remove("tutorial-overlay-next-button--disabled");
        }
    }
}

customElements.define("tutorial-overlay", TutorialOverlay);
export default TutorialOverlay;
