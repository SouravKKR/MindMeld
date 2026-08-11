import { askAiLanguages } from "../Globals/Enumerations/AskAiLanguages.js";
import LocalLlmDownloadEvents from "../Globals/Events/LocalLlmDownloadEvents.js";
import PreferredAskAiLanguage from "../Globals/Classes/LocalLlm/PreferredAskAiLanguage.js";


/**
 * LanguageSelect
 *
 * Native <select> that picks the output language for an Ask AI answer,
 * paired with a "Combine with English" checkbox. English is the default
 * and a deliberate no-op end-to-end — when English is selected nothing
 * extra is appended to the Gemini prompt, so the call is identical to
 * the pre-language behaviour. The other languages instruct the worker's
 * AskAiPromptBuilder to respond in that language.
 *
 * The "Combine with English" checkbox only makes sense for a non-English
 * language: when ticked it asks for a natural bilingual / code-mixed
 * answer (primarily the target language, but English kept for technical
 * terms / proper nouns / standard keywords). Because it is meaningless
 * for English, the whole row is fully hidden (removed from layout, not
 * just disabled) whenever English is the current selection, and it is
 * (re)set to checked-by-default whenever the user switches to a
 * non-English language.
 *
 * Persistence is global and device-local, owned by PreferredAskAiLanguage
 * (the same idiom LlmTierSelect uses for PreferredModelTier). Any change
 * writes to PreferredAskAiLanguage.setLanguage, which dispatches
 * LocalLlmDownloadEvents.PREFERRED_ASK_AI_LANGUAGE_CHANGED; every
 * mounted instance listens for that event and re-syncs, so a language
 * picked in Settings ▸ AI flips the Study menu / bottom-panel selects
 * live (and vice versa). Hosts call getSelectedLanguageKey() /
 * getCombineWithEnglish() for one-shot reads on the action path.
 */
class LanguageSelect extends HTMLElement
{
    static tagName = "language-select";

    static #SELECTED_EVENT_NAME = "language-selected";

    static #DEFAULT_LANGUAGE_KEY = "ENGLISH";

    // Display labels keyed by enum key — native script first, English
    // name in parentheses so the option is recognisable regardless of
    // which language the user reads. Any enum key without an entry here
    // falls back to a title-cased version of the key.
    static #DISPLAY_LABELS =
    {
        ENGLISH:  "English",
        HINDI:    "हिन्दी (Hindi)",
        KANNADA:  "ಕನ್ನಡ (Kannada)",
        FRENCH:   "Français (French)",
        SPANISH:  "Español (Spanish)",
        JAPANESE: "日本語 (Japanese)",
        KOREAN:   "한국어 (Korean)",
        CHINESE:  "中文 (Chinese)",
    };

    #selectElement = null;
    #combineRowElement = null;
    #combineCheckboxElement = null;
    #boundPreferredLanguageChangedHandler = null;

    connectedCallback()
    {
        this.innerHTML = `
            <select class="language-select-element" data-role="select"></select>
            <label class="language-select-combine-row" data-role="combine-row" hidden>
                <input type="checkbox" data-role="combine-checkbox" checked>
                <span class="language-select-combine-label">Combine with English</span>
            </label>
        `;

        this.#selectElement = this.querySelector('[data-role="select"]');
        this.#combineRowElement = this.querySelector('[data-role="combine-row"]');
        this.#combineCheckboxElement = this.querySelector('[data-role="combine-checkbox"]');

        this.#renderOptions();
        // First paint from the in-memory cache (ENGLISH until hydrate
        // finishes), then re-sync once the persisted preference loads —
        // hydrate is async so the initial render can't await it.
        this.#syncFromPreference();
        PreferredAskAiLanguage.hydrate().then(() => this.#syncFromPreference());

        this.#selectElement.addEventListener("change", () =>
        {
            // Switching TO a non-English language defaults the combine
            // checkbox back to checked, per the product requirement that
            // it is on by default whenever a language is active.
            if (this.#selectElement.value !== LanguageSelect.#DEFAULT_LANGUAGE_KEY && this.#combineCheckboxElement)
            {
                this.#combineCheckboxElement.checked = true;
            }
            this.#applyCombineRowVisibility();
            this.#persistSelection();
        });

        this.#combineCheckboxElement.addEventListener("change", () =>
        {
            this.#persistSelection();
        });

        // Keep every mounted instance in lock-step: when the preference
        // changes anywhere, re-sync this select's value + checkbox.
        this.#boundPreferredLanguageChangedHandler = () =>
        {
            this.#syncFromPreference();
        };
        window.addEventListener(LocalLlmDownloadEvents.PREFERRED_ASK_AI_LANGUAGE_CHANGED, this.#boundPreferredLanguageChangedHandler);
    }

    disconnectedCallback()
    {
        if (this.#boundPreferredLanguageChangedHandler)
        {
            window.removeEventListener(LocalLlmDownloadEvents.PREFERRED_ASK_AI_LANGUAGE_CHANGED, this.#boundPreferredLanguageChangedHandler);
            this.#boundPreferredLanguageChangedHandler = null;
        }
    }

    /**
     * One-shot read of the selected language enum key (e.g. "HINDI").
     * Defaults to ENGLISH when the select hasn't rendered yet.
     */
    getSelectedLanguageKey()
    {
        return this.#selectElement?.value || LanguageSelect.#DEFAULT_LANGUAGE_KEY;
    }

    /**
     * Whether to combine with English. Always false for ENGLISH — the
     * field is meaningless there and the prompt builder treats English as
     * a no-op regardless, but returning false keeps the persisted record
     * clean.
     */
    getCombineWithEnglish()
    {
        if (this.getSelectedLanguageKey() === LanguageSelect.#DEFAULT_LANGUAGE_KEY)
        {
            return false;
        }
        return Boolean(this.#combineCheckboxElement?.checked);
    }

    setSelectedLanguageKey(languageKey)
    {
        if (!this.#selectElement)
        {
            return;
        }
        const safeKey = Object.prototype.hasOwnProperty.call(askAiLanguages, languageKey)
            ? languageKey
            : LanguageSelect.#DEFAULT_LANGUAGE_KEY;
        this.#selectElement.value = safeKey;
        this.#applyCombineRowVisibility();
    }

    setCombineWithEnglish(bCombine)
    {
        if (this.#combineCheckboxElement)
        {
            this.#combineCheckboxElement.checked = Boolean(bCombine);
        }
    }

    #renderOptions()
    {
        const currentKey = this.getSelectedLanguageKey();
        const optionsHtml = Object.keys(askAiLanguages).map((languageKey) =>
        {
            const label = LanguageSelect.#DISPLAY_LABELS[languageKey] ?? LanguageSelect.#titleCase(languageKey);
            const bSelected = languageKey === currentKey;
            return `
                <option value="${LanguageSelect.#escapeHtml(languageKey)}" ${bSelected ? "selected" : ""}>${LanguageSelect.#escapeHtml(label)}</option>
            `;
        }).join("");

        this.#selectElement.innerHTML = optionsHtml;
        // Setting innerHTML resets `.value`; reassert the default so the
        // visual selection matches.
        this.#selectElement.value = currentKey;
    }

    /**
     * The combine row is only relevant for a non-English language, so it
     * is fully hidden (display: none via [hidden]) for English — it never
     * occupies layout space and never clutters the menu.
     */
    #applyCombineRowVisibility()
    {
        if (!this.#combineRowElement)
        {
            return;
        }
        const bEnglish = this.getSelectedLanguageKey() === LanguageSelect.#DEFAULT_LANGUAGE_KEY;
        this.#combineRowElement.hidden = bEnglish;
    }

    /**
     * Re-sync the select value + combine checkbox from the global
     * PreferredAskAiLanguage cache. Used on first paint, after hydration,
     * and whenever another instance changes the preference.
     */
    #syncFromPreference()
    {
        if (!this.#selectElement)
        {
            return;
        }
        const preferredLanguage = PreferredAskAiLanguage.getSelectedLanguage();
        const safeKey = Object.prototype.hasOwnProperty.call(askAiLanguages, preferredLanguage)
            ? preferredLanguage
            : LanguageSelect.#DEFAULT_LANGUAGE_KEY;
        this.#selectElement.value = safeKey;
        if (this.#combineCheckboxElement)
        {
            // English keeps the checkbox at its checked default (hidden
            // anyway); a non-English language reflects the stored flag.
            this.#combineCheckboxElement.checked =
                safeKey === LanguageSelect.#DEFAULT_LANGUAGE_KEY
                    ? true
                    : PreferredAskAiLanguage.getCombineWithEnglish();
        }
        this.#applyCombineRowVisibility();
    }

    /**
     * Persist the current DOM selection to the global preference (which
     * broadcasts PREFERRED_ASK_AI_LANGUAGE_CHANGED so sibling instances
     * re-sync) and bubble the local `language-selected` event for hosts
     * that react specifically to this instance.
     */
    #persistSelection()
    {
        const selectedLanguage = this.getSelectedLanguageKey();
        const combineWithEnglish = this.getCombineWithEnglish();
        PreferredAskAiLanguage.setLanguage(selectedLanguage, combineWithEnglish);
        this.dispatchEvent(new CustomEvent(LanguageSelect.#SELECTED_EVENT_NAME,
        {
            bubbles: true,
            composed: true,
            detail:
            {
                selectedLanguage,
                combineWithEnglish,
            },
        }));
    }

    static #titleCase(languageKey)
    {
        const lowered = String(languageKey).toLowerCase();
        return lowered.charAt(0).toUpperCase() + lowered.slice(1);
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

customElements.define(LanguageSelect.tagName, LanguageSelect);
export default LanguageSelect;
