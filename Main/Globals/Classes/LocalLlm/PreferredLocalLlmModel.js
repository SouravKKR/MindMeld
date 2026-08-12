import LocalLlmDownloadConstants from "../../Constants/LocalLlmDownloadConstants.js";
import LocalLlmDownloadEvents from "../../Events/LocalLlmDownloadEvents.js";
import Persistence from "../Persistence.js";
import { dataFormats } from "../../Enumerations/DataFormats.js";


/**
 * PreferredLocalLlmModel
 *
 * WHICH Free-tier model this device runs, when more than one will fit.
 *
 * The tier stays a single choice — a learner picks "Free" and asks a question.
 * This is the setting underneath it: on hardware that can hold the 3B, someone
 * may still want the 1.5B for a smaller download or faster answers, and only
 * they know which trade they want.
 *
 * It records a PREFERENCE, not a decision. The selector applies it against the
 * same admission every automatic pick goes through, so a choice can only ever
 * pick among the models this device can already run. A preference carried to a
 * smaller machine, or naming a model the server has since withdrawn, is
 * ignored in favour of the ranked best rather than failing — which is why this
 * class validates nothing about hardware itself. It would be a second opinion
 * on a question the selector already answers.
 *
 * Device-scoped, like the download record it sits beside: the weights live in a
 * store shared by every identity on the machine, so which one to use is a fact
 * about the device rather than about the person signed in. See
 * UserIdentityConstants.GLOBAL_KEYS.
 */
class PreferredLocalLlmModel
{
    static #cachedModelKey = null;
    static #hydratePromise = null;

    /**
     * Reads the stored choice once. Null means "no preference" — the selector
     * then picks the best model this device can run, which is the right
     * default and the state every device starts in.
     */
    static hydrate()
    {
        if (PreferredLocalLlmModel.#hydratePromise)
        {
            return PreferredLocalLlmModel.#hydratePromise;
        }

        PreferredLocalLlmModel.#hydratePromise = (async () =>
        {
            try
            {
                const bExists = await Persistence.exists(LocalLlmDownloadConstants.LOCAL_PREFERRED_MODEL_PERSISTENCE_KEY);
                if (!bExists)
                {
                    PreferredLocalLlmModel.#cachedModelKey = null;
                    return;
                }

                const record = await Persistence.read(
                    LocalLlmDownloadConstants.LOCAL_PREFERRED_MODEL_PERSISTENCE_KEY,
                    dataFormats.JSON
                );
                PreferredLocalLlmModel.#cachedModelKey = record && typeof record.modelKey === "string"
                    ? record.modelKey
                    : null;
            }
            catch (readError)
            {
                console.warn(`[PreferredLocalLlmModel] Could not read the stored model choice: ${readError?.message || readError}`);
                PreferredLocalLlmModel.#cachedModelKey = null;
            }
        })();

        return PreferredLocalLlmModel.#hydratePromise;
    }

    /**
     * The stored choice, or null. Synchronous — callers that need it at render
     * time have already awaited hydrate() at boot.
     */
    static getModelKey()
    {
        return PreferredLocalLlmModel.#cachedModelKey;
    }

    /**
     * Records a choice. Pass null to go back to "whatever suits this device",
     * which is a real setting and not merely the absence of one.
     */
    static async setModelKey(modelKey)
    {
        const normalisedModelKey = typeof modelKey === "string" && modelKey.length > 0 ? modelKey : null;

        if (normalisedModelKey === PreferredLocalLlmModel.#cachedModelKey)
        {
            return;
        }

        PreferredLocalLlmModel.#cachedModelKey = normalisedModelKey;

        try
        {
            await Persistence.write(
                LocalLlmDownloadConstants.LOCAL_PREFERRED_MODEL_PERSISTENCE_KEY,
                { modelKey: normalisedModelKey, at: Date.now() },
                dataFormats.JSON
            );
        }
        catch (writeError)
        {
            // The in-memory value already changed, so this session honours the
            // choice either way; only carrying it to the next one is lost.
            console.warn(`[PreferredLocalLlmModel] Could not persist the model choice: ${writeError?.message || writeError}`);
        }

        window.dispatchEvent(new CustomEvent(LocalLlmDownloadEvents.PREFERRED_MODEL_CHANGED,
        {
            detail: { modelKey: normalisedModelKey }
        }));
    }
}

export default PreferredLocalLlmModel;
