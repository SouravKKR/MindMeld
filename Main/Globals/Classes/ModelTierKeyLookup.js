import ModelTierMetadata from "../Constants/ModelTierMetadata.js";
import { modelTiers } from "../Enumerations/ModelTiers.js";


/**
 * ModelTierKeyLookup
 *
 * Bridges the two representations of an AI tier that the app unavoidably
 * carries: the numeric `modelTiers` enum value that travels through selects,
 * events and persistence, and the key NAME that indexes ModelTierMetadata.
 *
 * The mapping used to be a private static repeated verbatim in AskAiSession,
 * TextSelectionContextMenu and StudySessionBottomPanel, with ChatView keeping
 * a fourth variant that spoke key names where the others spoke numbers. One
 * copy, used everywhere, removes the class of bug where a tier is added and
 * one of the four copies is missed.
 */
class ModelTierKeyLookup
{
    static #VALUE_TO_KEY_NAME = new Map(
        Object.entries(modelTiers).map(([tierKeyName, tierValue]) => [tierValue, tierKeyName])
    );

    /**
     * The metadata key name for a numeric tier value, or null when the value
     * matches no tier.
     */
    static keyFor(tierValue)
    {
        const tierKeyName = ModelTierKeyLookup.#VALUE_TO_KEY_NAME.get(tierValue);
        return tierKeyName === undefined ? null : tierKeyName;
    }

    /**
     * The numeric tier value for a metadata key name, or null when the name
     * matches no tier.
     */
    static valueFor(tierKeyName)
    {
        const tierValue = modelTiers[tierKeyName];
        return tierValue === undefined ? null : tierValue;
    }

    /**
     * The metadata record for a numeric tier value, or null. Saves every
     * caller the two-step of resolving the key and then indexing the
     * constant.
     */
    static metadataFor(tierValue)
    {
        const tierKeyName = ModelTierKeyLookup.keyFor(tierValue);
        return tierKeyName && ModelTierMetadata[tierKeyName] ? ModelTierMetadata[tierKeyName] : null;
    }
}

export default ModelTierKeyLookup;
