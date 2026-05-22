import { modelTiers } from "../Globals/Enumerations/ModelTiers.js";
import { browserLlmDownloadStates } from "../Globals/Enumerations/BrowserLlmDownloadStates.js";
import ModelTierMetadata from "../Globals/Constants/ModelTierMetadata.js";
import BrowserLlmDownloadEvents from "../Globals/Events/BrowserLlmDownloadEvents.js";
import BrowserLlmCapability from "../Globals/Classes/BrowserLlm/BrowserLlmCapability.js";
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

        // Re-pick the persisted tier as soon as Persistence finishes
        // hydration — first render uses the in-memory default (BASIC)
        // because hydrate is async.
        PreferredModelTier.hydrate().then(() => this.#syncSelectionFromCache());

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
            const tagline = tierMeta.tagline || "";
            const optionText = tagline.length > 0 ? `${label} (${tagline})` : label;

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
        const reasonText = BrowserLlmCapability.getDisabledReasonText();
        if (!reasonText)
        {
            this.#statusElement.hidden = true;
            this.#statusElement.textContent = "";
            return;
        }
        this.#statusElement.hidden = false;
        this.#statusElement.textContent = `Free unavailable — ${reasonText}`;
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
