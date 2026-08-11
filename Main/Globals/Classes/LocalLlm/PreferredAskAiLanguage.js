import { askAiLanguages } from "../../Enumerations/AskAiLanguages.js";
import { dataFormats } from "../../Enumerations/DataFormats.js";
import LocalLlmDownloadEvents from "../../Events/LocalLlmDownloadEvents.js";
import LocalLlmDownloadConstants from "../../Constants/LocalLlmDownloadConstants.js";
import Persistence from "../Persistence.js";


/**
 * PreferredAskAiLanguage
 *
 * Global, device-local accessor for the user's chosen Ask AI output
 * language and the paired "Combine with English" flag. Mirrors
 * PreferredModelTier: persisted once via Persistence so the choice
 * survives reloads, hydrated lazily, and broadcast on change through a
 * window-level event so every mounted <language-select> (the Study text-
 * selection menu, the Study bottom panel, and the Settings ▸ AI tab)
 * re-syncs live.
 *
 * Previously the language lived per-deck under
 * deck.additionalData.askAiPreferences. It is now a single global
 * preference so the last-picked language follows the user across decks
 * instead of resetting to English on every new deck. The legacy per-deck
 * field is simply ignored — no migration is needed because English is the
 * default either way.
 */
class PreferredAskAiLanguage
{
    static #DEFAULT_LANGUAGE = "ENGLISH";

    static #cachedLanguage = null;
    static #cachedCombineWithEnglish = false;
    static #hydratePromise = null;

    static getDefaultLanguage()
    {
        return PreferredAskAiLanguage.#DEFAULT_LANGUAGE;
    }

    /**
     * Hydrate the cache from disk once. Subsequent calls are sync via
     * getSelectedLanguage() / getCombineWithEnglish(). Safe to await more
     * than once.
     */
    static hydrate()
    {
        if (PreferredAskAiLanguage.#hydratePromise)
        {
            return PreferredAskAiLanguage.#hydratePromise;
        }

        PreferredAskAiLanguage.#hydratePromise = (async () =>
        {
            try
            {
                const bExists = await Persistence.exists(LocalLlmDownloadConstants.LOCAL_ASK_AI_LANGUAGE_PERSISTENCE_KEY);
                if (!bExists)
                {
                    PreferredAskAiLanguage.#applyDefault();
                    return;
                }
                const record = await Persistence.read(LocalLlmDownloadConstants.LOCAL_ASK_AI_LANGUAGE_PERSISTENCE_KEY, dataFormats.JSON);
                if (record && PreferredAskAiLanguage.#isValidLanguage(record.selectedLanguage))
                {
                    PreferredAskAiLanguage.#cachedLanguage = record.selectedLanguage;
                    // English carries no combine flag; for any other
                    // language default to true unless explicitly stored
                    // false, matching the old per-deck default.
                    PreferredAskAiLanguage.#cachedCombineWithEnglish =
                        record.selectedLanguage !== PreferredAskAiLanguage.#DEFAULT_LANGUAGE
                        && record.combineWithEnglish !== false;
                }
                else
                {
                    PreferredAskAiLanguage.#applyDefault();
                }
            }
            catch (hydrateError)
            {
                console.warn(`[PreferredAskAiLanguage] Could not hydrate: ${hydrateError?.message || hydrateError}`);
                PreferredAskAiLanguage.#applyDefault();
            }
        })();

        return PreferredAskAiLanguage.#hydratePromise;
    }

    /**
     * Returns the cached language enum key (e.g. "HINDI"). Defaults to
     * ENGLISH if hydrate() has not yet completed — synchronous callers
     * won't block, and any mounted <language-select> re-syncs once
     * hydration finishes.
     */
    static getSelectedLanguage()
    {
        if (PreferredAskAiLanguage.#cachedLanguage === null)
        {
            return PreferredAskAiLanguage.getDefaultLanguage();
        }
        return PreferredAskAiLanguage.#cachedLanguage;
    }

    static getCombineWithEnglish()
    {
        if (PreferredAskAiLanguage.getSelectedLanguage() === PreferredAskAiLanguage.#DEFAULT_LANGUAGE)
        {
            return false;
        }
        return PreferredAskAiLanguage.#cachedCombineWithEnglish === true;
    }

    static async setLanguage(selectedLanguage, combineWithEnglish)
    {
        if (!PreferredAskAiLanguage.#isValidLanguage(selectedLanguage))
        {
            console.warn(`[PreferredAskAiLanguage] Refusing to set invalid language: ${selectedLanguage}`);
            return;
        }
        const bEnglish = selectedLanguage === PreferredAskAiLanguage.#DEFAULT_LANGUAGE;
        PreferredAskAiLanguage.#cachedLanguage = selectedLanguage;
        PreferredAskAiLanguage.#cachedCombineWithEnglish = bEnglish ? false : Boolean(combineWithEnglish);
        try
        {
            await Persistence.write(
                LocalLlmDownloadConstants.LOCAL_ASK_AI_LANGUAGE_PERSISTENCE_KEY,
                {
                    selectedLanguage: PreferredAskAiLanguage.#cachedLanguage,
                    combineWithEnglish: PreferredAskAiLanguage.#cachedCombineWithEnglish,
                    at: Date.now()
                },
                dataFormats.JSON
            );
        }
        catch (writeError)
        {
            console.warn(`[PreferredAskAiLanguage] Could not persist language: ${writeError?.message || writeError}`);
        }
        // Fire AFTER the write so listeners that re-read the cache see the
        // new value. Window-level so every mounted <language-select> picks
        // it up without a wiring chain.
        window.dispatchEvent(new CustomEvent(LocalLlmDownloadEvents.PREFERRED_ASK_AI_LANGUAGE_CHANGED,
        {
            detail:
            {
                selectedLanguage: PreferredAskAiLanguage.#cachedLanguage,
                combineWithEnglish: PreferredAskAiLanguage.#cachedCombineWithEnglish
            }
        }));
    }

    static #applyDefault()
    {
        PreferredAskAiLanguage.#cachedLanguage = PreferredAskAiLanguage.getDefaultLanguage();
        PreferredAskAiLanguage.#cachedCombineWithEnglish = false;
    }

    static #isValidLanguage(value)
    {
        return typeof value === "string" && Object.prototype.hasOwnProperty.call(askAiLanguages, value);
    }
}

export default PreferredAskAiLanguage;
