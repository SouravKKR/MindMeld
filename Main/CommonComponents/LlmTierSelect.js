import { modelTiers } from "../Globals/Enumerations/ModelTiers.js";
import { browserLlmDownloadStates } from "../Globals/Enumerations/BrowserLlmDownloadStates.js";
import ModelTierMetadata from "../Globals/Constants/ModelTierMetadata.js";
import BrowserLlmDownloadEvents from "../Globals/Events/BrowserLlmDownloadEvents.js";
import BrowserLlmCapability from "../Globals/Classes/BrowserLlm/BrowserLlmCapability.js";
import BrowserLlmDownloadManager from "../Globals/Classes/BrowserLlm/BrowserLlmDownloadManager.js";
import PreferredModelTier from "../Globals/Classes/BrowserLlm/PreferredModelTier.js";


/**
 * LlmTierSelect
 *
 * Native <select> that picks one of the four LLM tiers — Free (the
 * on-device WebLLM model) plus the three cloud tiers (Basic, Pro, Pro
 * Plus). The tier concept spans both the in-browser and the cloud
 * backends, so the component name is deliberately neutral; the
 * BrowserLlm.* classes still own the offline-model download lifecycle.
 *
 * Each <option> reads "Tier name (tagline)". The Free option is
 * `disabled` when BrowserLlmCapability isn't READY — the browser
 * handles greying / no-pick natively. A small status line below the
 * select surfaces the *reason* Free is unavailable (download not
 * started, in progress, declined, failed, or unsupported hardware) so
 * users have one click-away path to remediation via the Settings ▸
 * Model tab.
 *
 * Cross-component sync: any `change` event writes to
 * `PreferredModelTier.setCurrentTier`, which dispatches
 * `BrowserLlmDownloadEvents.PREFERRED_TIER_CHANGED`. Every mounted
 * <llm-tier-select> instance listens for that event and re-syncs its
 * value, so a tier picked in Settings flips the bottom-panel + text-
 * selection menu selects live (and vice versa).
 *
 * Hosts call `getCurrentTier()` for one-shot reads, or subscribe to
 * the bubbled `tier-selected` CustomEvent if they need to react
 * specifically to this instance's changes.
 */
class LlmTierSelect extends HTMLElement
{
    static tagName = "llm-tier-select";

    static #SELECTED_EVENT_NAME = "tier-selected";

    #selectElement = null;
    #statusElement = null;
    #boundCapabilityChangedHandler = null;
    #boundProgressHandler = null;
    #boundPreferredTierChangedHandler = null;

    connectedCallback()
    {
        this.innerHTML = `
            <select class="llm-tier-select-element" data-role="select"></select>
            <span class="llm-tier-select-status" data-role="status" hidden></span>
        `;

        this.#selectElement = this.querySelector('[data-role="select"]');
        this.#statusElement = this.querySelector('[data-role="status"]');

        this.#renderOptions();
        this.#renderStatus();

        this.#selectElement.addEventListener("change", () =>
        {
            this.#handleChange();
        });

        // The status line doubles as the one-click download trigger when
        // the offline model is in a user-recoverable state (NOT_STARTED /
        // DECLINED / FAILED). Its reason text already invites the click;
        // #renderStatus flips data-clickable + role so it only behaves as
        // a button when an action is actually possible (never while
        // DOWNLOADING or on an UNSUPPORTED device).
        this.#statusElement.addEventListener("click", () =>
        {
            this.#handleStatusActivation();
        });
        this.#statusElement.addEventListener("keydown", (keyboardEvent) =>
        {
            if (keyboardEvent.key === "Enter" || keyboardEvent.key === " ")
            {
                keyboardEvent.preventDefault();
                this.#handleStatusActivation();
            }
        });

        // Re-pick the persisted tier as soon as Persistence finishes
        // hydration — first render uses the in-memory default (BASIC)
        // because hydrate is async.
        PreferredModelTier.hydrate().then(() => this.#syncSelectionFromCache());

        // Resolve device capability + persisted download state, then
        // re-render. The first render uses the default (NOT_STARTED)
        // because initialize() is async (WebGPU adapter probe + a
        // Persistence read), so this is what makes the Free row reflect a
        // prior READY / DECLINED / UNSUPPORTED the moment the picker
        // mounts — independent of any boot hook having run yet. initialize()
        // shares one in-flight promise, so repeated calls are cheap.
        BrowserLlmCapability.initialize().then(() =>
        {
            this.#renderOptions();
            this.#renderStatus();
        });

        // Capability flips Free between enabled / disabled; PROGRESS
        // updates the status percentage; PREFERRED_TIER_CHANGED keeps
        // multiple mounted instances in sync with each other.
        this.#boundCapabilityChangedHandler = () =>
        {
            this.#renderOptions();
            this.#renderStatus();
        };
        this.#boundProgressHandler = () =>
        {
            this.#renderStatus();
        };
        this.#boundPreferredTierChangedHandler = () =>
        {
            this.#syncSelectionFromCache();
        };
        window.addEventListener(BrowserLlmDownloadEvents.CAPABILITY_CHANGED, this.#boundCapabilityChangedHandler);
        window.addEventListener(BrowserLlmDownloadEvents.PROGRESS, this.#boundProgressHandler);
        window.addEventListener(BrowserLlmDownloadEvents.PREFERRED_TIER_CHANGED, this.#boundPreferredTierChangedHandler);
    }

    disconnectedCallback()
    {
        if (this.#boundCapabilityChangedHandler)
        {
            window.removeEventListener(BrowserLlmDownloadEvents.CAPABILITY_CHANGED, this.#boundCapabilityChangedHandler);
            this.#boundCapabilityChangedHandler = null;
        }
        if (this.#boundProgressHandler)
        {
            window.removeEventListener(BrowserLlmDownloadEvents.PROGRESS, this.#boundProgressHandler);
            this.#boundProgressHandler = null;
        }
        if (this.#boundPreferredTierChangedHandler)
        {
            window.removeEventListener(BrowserLlmDownloadEvents.PREFERRED_TIER_CHANGED, this.#boundPreferredTierChangedHandler);
            this.#boundPreferredTierChangedHandler = null;
        }
    }

    /**
     * One-shot read of the currently-selected tier. Hosts that need to
     * route an action by tier (Explain, Send, etc.) call this on the
     * click path so they don't have to subscribe to the change event
     * for state they only need once.
     */
    getCurrentTier()
    {
        return PreferredModelTier.getCurrentTier();
    }

    #renderOptions()
    {
        const orderedKeys = Array.isArray(ModelTierMetadata.ORDER)
            ? ModelTierMetadata.ORDER
            : ["FREE", "BASIC", "PRO", "PRO_PLUS"];
        const capabilityState = BrowserLlmCapability.getState();
        const currentTier = PreferredModelTier.getCurrentTier();

        const optionsHtml = orderedKeys.map((tierKeyName) =>
        {
            const tierValue = modelTiers[tierKeyName];
            const tierMeta = ModelTierMetadata[tierKeyName] || {};
            const isFreeTier = tierValue === modelTiers.FREE;
            const isDisabled = isFreeTier && capabilityState !== browserLlmDownloadStates.READY;

            const label = tierMeta.label || tierKeyName;
            // The Free tier's tagline is device-specific: which model this
            // device resolved to, and whether it runs on the graphics
            // hardware or the processor, decide what the learner can expect.
            // Naming it here is what stops a phone's shorter answers from
            // looking like a bug.
            const tagline = isFreeTier
                ? LlmTierSelect.#buildFreeTierTagline(tierMeta.tagline || "")
                : (tierMeta.tagline || "");
            const baseOptionText = tagline.length > 0 ? `${label} (${tagline})` : label;
            // Data-driven capability hint. Each flag the tier opts in to
            // contributes one phrase to a cumulative "supports: …" suffix
            // so the user can see at a glance what each tier adds on top
            // of the cheaper one. Order matters — capabilities accumulate
            // up the tier ladder (file input → web search → reasoning).
            const capabilityPhrases = [];
            if (tierMeta.supportsImageInput)          capabilityPhrases.push("file input");
            if (tierMeta.enableGoogleSearchGrounding) capabilityPhrases.push("web search");
            if (tierMeta.supportsAdvancedReasoning)   capabilityPhrases.push("reasoning");
            const capabilitySuffix = capabilityPhrases.length > 0
                ? ` — supports: ${capabilityPhrases.join(" + ")}`
                : "";
            const optionText = baseOptionText + capabilitySuffix;

            return `
                <option
                    value="${tierValue}"
                    ${isDisabled ? "disabled" : ""}
                    ${tierValue === currentTier ? "selected" : ""}
                >${LlmTierSelect.#escapeHtml(optionText)}</option>
            `;
        }).join("");

        this.#selectElement.innerHTML = optionsHtml;
        // setting innerHTML resets `.value`; reassert the current tier
        // so the visual selection matches the cached preference even
        // when the matching <option> is disabled.
        this.#selectElement.value = String(currentTier);
    }

    /**
     * The status line under the select shows the offline-model
     * disabled reason whenever Free isn't READY. It's intentionally
     * visible regardless of which tier the user has picked — they
     * should always know why Free is unavailable, not just when they
     * happen to have it selected.
     */
    #renderStatus()
    {
        if (!this.#statusElement)
        {
            return;
        }

        // Before any of the early returns below. This method has three exits —
        // Free usable and unremarkable, Free usable with a note, and Free
        // unavailable — and the diagnostic has to survive all of them, because
        // the interesting case is often the one where the status line says
        // nothing at all.
        this.#renderDiagnostic();

        const reasonText = BrowserLlmCapability.getDisabledReasonText();
        if (!reasonText)
        {
            // Free is usable. It may still be a compromise — a smaller model,
            // or the processor backend — and the learner is told which,
            // rather than being left to guess why answers differ from
            // another device.
            const selectionNote = BrowserLlmCapability.getSelectionNoteText();
            if (selectionNote)
            {
                this.#statusElement.hidden = false;
                this.#statusElement.textContent = `Free on this device — ${selectionNote}`;
                this.#setStatusClickable(false);
                return;
            }

            this.#statusElement.hidden = true;
            this.#statusElement.textContent = "";
            this.#setStatusClickable(false);
            return;
        }
        this.#statusElement.hidden = false;
        this.#statusElement.textContent = `Free unavailable — ${reasonText}`;
        this.#setStatusClickable(BrowserLlmCapability.isRecoverableByUser());
    }

    /**
     * TEMPORARY (added 2026-08-10, remove once the repeat-download fault is
     * closed out). Prints what the session actually knows about the on-device
     * model underneath the status line, because the status line alone cannot
     * distinguish "no record was saved" from "the record named another model"
     * from "the last download never finished" — and all three read as
     * "Click to start the download."
     *
     * Deliberately rendered on screen rather than left in the console: the
     * fault reproduces on phones, where a console is not reachable without a
     * cabled desktop.
     */
    #renderDiagnostic()
    {
        if (!this.#statusElement || !this.#statusElement.parentElement)
        {
            return;
        }

        let diagnosticElement = this.#statusElement.parentElement.querySelector(".browser-llm-diagnostic");
        if (!diagnosticElement)
        {
            diagnosticElement = document.createElement("div");
            diagnosticElement.className = "browser-llm-diagnostic";
            diagnosticElement.style.cssText = "font-size:11px;opacity:0.65;margin-top:4px;word-break:break-all;user-select:text;";
            this.#statusElement.parentElement.insertBefore(diagnosticElement, this.#statusElement.nextSibling);
        }

        diagnosticElement.textContent = BrowserLlmCapability.getDiagnosticText();
    }

    /**
     * Names the model this device resolved to, so "Free" is never an opaque
     * label. Falls back to the catalogue-neutral tagline before the
     * capability probe has settled, or when no model fits at all.
     */
    static #buildFreeTierTagline(defaultTagline)
    {
        const parameterLabel = BrowserLlmCapability.getSelectedParameterLabel();
        if (!parameterLabel)
        {
            return defaultTagline;
        }

        return BrowserLlmCapability.isSelectedModelProcessorBacked()
            ? `on-device ${parameterLabel}, processor — slow`
            : `on-device ${parameterLabel}`;
    }

    /**
     * Toggles the affordances that turn the status line into a button.
     * Only set when the state is recoverable so the line doesn't look
     * clickable while a download is mid-flight or the device is
     * UNSUPPORTED. The `data-clickable` attribute drives the cursor /
     * underline styling.
     */
    #setStatusClickable(bClickable)
    {
        if (!this.#statusElement)
        {
            return;
        }
        if (bClickable)
        {
            this.#statusElement.setAttribute("data-clickable", "");
            this.#statusElement.setAttribute("role", "button");
            this.#statusElement.setAttribute("tabindex", "0");
        }
        else
        {
            this.#statusElement.removeAttribute("data-clickable");
            this.#statusElement.removeAttribute("role");
            this.#statusElement.removeAttribute("tabindex");
        }
    }

    /**
     * Click / keyboard activation of the status line — the settings-only
     * entry point for starting the offline-model download. Inert unless
     * the current state is user-recoverable (UNSUPPORTED and DOWNLOADING
     * do nothing). BrowserLlmDownloadManager.start() clears any DECLINED
     * pin and no-ops while a download is already running, so it safely
     * covers every recoverable case.
     */
    #handleStatusActivation()
    {
        if (!BrowserLlmCapability.isRecoverableByUser())
        {
            return;
        }
        BrowserLlmDownloadManager.start().catch((startError) =>
        {
            console.error("[LlmTierSelect] Failed to start model download:", startError);
        });
    }

    async #handleChange()
    {
        const rawValue = this.#selectElement.value;
        const newTier = Number(rawValue);
        if (Number.isNaN(newTier))
        {
            console.warn(`[LlmTierSelect] Ignored non-numeric select value: ${rawValue}`);
            return;
        }
        await PreferredModelTier.setCurrentTier(newTier);
        this.dispatchEvent(new CustomEvent(LlmTierSelect.#SELECTED_EVENT_NAME,
        {
            bubbles: true,
            composed: true,
            detail: { tier: newTier }
        }));
    }

    #syncSelectionFromCache()
    {
        if (!this.#selectElement)
        {
            return;
        }
        this.#selectElement.value = String(PreferredModelTier.getCurrentTier());
    }

    static #escapeHtml(rawString)
    {
        if (rawString === null || rawString === undefined) return "";
        return String(rawString)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }
}

customElements.define(LlmTierSelect.tagName, LlmTierSelect);
export default LlmTierSelect;
