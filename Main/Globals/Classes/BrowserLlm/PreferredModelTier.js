import { modelTiers } from "../../Enumerations/ModelTiers.js";
import { dataFormats } from "../../Enumerations/DataFormats.js";
import BrowserLlmDownloadEvents from "../../Events/BrowserLlmDownloadEvents.js";
import Persistence from "../Persistence.js";


/**
 * PreferredModelTier
 *
 * Tiny accessor around the user's last-selected LLM tier in the
 * text-selection dropdown. Persisted locally on this device so the
 * choice survives reloads without round-tripping the server on every
 * Study session.
 *
 * The matching `ProfileSettingKeys.PREFERRED_MODEL_TIER` exists in the
 * synced settings shape so a future wire-up can hydrate this on login
 * (and push back on change). For this round, that sync path is not
 * connected — local-only is enough to deliver the UX.
 */
class PreferredModelTier
{
    static #PERSISTENCE_KEY = "BrowserLlm/PreferredTier.mmsd";
    static #cachedTier = null;
    static #hydratePromise = null;

    static getDefaultTier()
    {
        return modelTiers.BASIC;
    }

    /**
     * Hydrate the cache from disk once. Subsequent calls are sync via
     * `getCurrentTier()`. Safe to await more than once.
     */
    static hydrate()
    {
        if (PreferredModelTier.#hydratePromise)
        {
            return PreferredModelTier.#hydratePromise;
        }

        PreferredModelTier.#hydratePromise = (async () =>
        {
            try
            {
                const bExists = await Persistence.exists(PreferredModelTier.#PERSISTENCE_KEY);
                if (!bExists)
                {
                    PreferredModelTier.#cachedTier = PreferredModelTier.getDefaultTier();
                    return;
                }
                const record = await Persistence.read(PreferredModelTier.#PERSISTENCE_KEY, dataFormats.JSON);
                if (record && typeof record.tier === "number" && PreferredModelTier.#isValidTier(record.tier))
                {
                    PreferredModelTier.#cachedTier = record.tier;
                }
                else
                {
                    PreferredModelTier.#cachedTier = PreferredModelTier.getDefaultTier();
                }
            }
            catch (hydrateError)
            {
                console.warn(`[PreferredModelTier] Could not hydrate: ${hydrateError?.message || hydrateError}`);
                PreferredModelTier.#cachedTier = PreferredModelTier.getDefaultTier();
            }
        })();

        return PreferredModelTier.#hydratePromise;
    }

    /**
     * Returns the cached tier. Defaults to BASIC if hydrate() has not
     * yet completed — synchronous callers won't block, and the dropdown
     * re-renders once hydration finishes.
     */
    static getCurrentTier()
    {
        if (PreferredModelTier.#cachedTier === null)
        {
            return PreferredModelTier.getDefaultTier();
        }
        return PreferredModelTier.#cachedTier;
    }

    static async setCurrentTier(tier)
    {
        if (!PreferredModelTier.#isValidTier(tier))
        {
            console.warn(`[PreferredModelTier] Refusing to set invalid tier value: ${tier}`);
            return;
        }
        PreferredModelTier.#cachedTier = tier;
        try
        {
            await Persistence.write(PreferredModelTier.#PERSISTENCE_KEY, { tier, at: Date.now() }, dataFormats.JSON);
        }
        catch (writeError)
        {
            console.warn(`[PreferredModelTier] Could not persist tier: ${writeError?.message || writeError}`);
        }
        // Fire AFTER the write so listeners that re-read the cache see
        // the new value. Window-level so every mounted dropdown picks
        // it up without a wiring chain.
        window.dispatchEvent(new CustomEvent(BrowserLlmDownloadEvents.PREFERRED_TIER_CHANGED,
        {
            detail: { tier }
        }));
    }

    static #isValidTier(value)
    {
        return Object.values(modelTiers).includes(value);
    }
}

export default PreferredModelTier;
