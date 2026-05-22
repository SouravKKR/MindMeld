import UserSetting from './UserSetting.js';
import { modelSettingKeys } from '../../Enumerations/ModelSettingKeys.js';
import { modelTiers } from '../../Enumerations/ModelTiers.js';


/**
 * ModelSettings
 *
 * Container for user-facing AI-model preferences. Lives under the
 * `MODEL` tab in the Settings page (sibling to ProfileSettings). The
 * only setting on it today is `PREFERRED_MODEL_TIER` — the
 * Free/Basic/Pro/Pro Plus tier the user has picked for the
 * text-selection ask-AI flow.
 *
 * The persistent source of truth for the live UI is the local-only
 * `PreferredModelTier` helper (writes to IndexedDB so a per-device
 * choice survives reloads without a server round-trip). This synced
 * setting holds the same value on user.additionalData.preferredModelTier
 * so a future wire-up can cross-device the preference; for now it
 * just hydrates from the user record without driving the UI directly.
 */
class ModelSettings
{
    #preferredModelTier;

    constructor()
    {
        this.#preferredModelTier = new UserSetting({
            key: modelSettingKeys.PREFERRED_MODEL_TIER,
            defaultValue: modelTiers.BASIC
        });
    }

    loadFromUser(user)
    {
        const data = user.getAdditionalData() ?? {};
        this.#preferredModelTier.setValue(data.preferredModelTier ?? this.#preferredModelTier.getDefaultValue());
    }

    getSettings()
    {
        return [this.#preferredModelTier];
    }

    getPreferredModelTier()
    {
        return this.#preferredModelTier.getValue();
    }

    setPreferredModelTier(tier)
    {
        this.#preferredModelTier.setValue(tier);
    }
}

export default ModelSettings;
