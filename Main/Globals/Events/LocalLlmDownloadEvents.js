/**
 * LocalLlmDownloadEvents
 *
 * Window-level CustomEvent names for the offline (Free-tier) in-browser
 * LLM download lifecycle. Fired by LocalLlmDownloadManager and listened
 * to by the tier dropdown, the activity surface, and the login bootstrap.
 *
 * Event detail shapes:
 *   STARTED            — { totalBytes }
 *   PROGRESS           — { processedBytes, totalBytes, fraction, statusText }
 *   COMPLETED          — {}
 *   FAILED             — { error: Error|string }
 *   DECLINED           — {}
 *   RESUMED            — {}
 *   CAPABILITY_CHANGED — { state: localLlmDownloadStates }
 *
 * CAPABILITY_CHANGED is the umbrella signal — every state transition
 * fires one so re-renderers don't have to subscribe to each lifecycle
 * event individually. The fine-grained events still exist for callers
 * that need the payloads (progress %, error message, etc.).
 */
class LocalLlmDownloadEvents
{
    static STARTED = "browser-llm-download-started";
    static PROGRESS = "browser-llm-download-progress";
    static COMPLETED = "browser-llm-download-completed";
    static FAILED = "browser-llm-download-failed";
    static DECLINED = "browser-llm-download-declined";
    static RESUMED = "browser-llm-download-resumed";
    static CAPABILITY_CHANGED = "browser-llm-capability-changed";
    // Dispatched after PreferredModelTier.setCurrentTier persists a new
    // selection. Every mounted <llm-tier-select> instance listens and
    // re-syncs its <select> value, so picking a tier in one place
    // (Settings, Study menu, Study bottom panel) updates the others
    // live.
    static PREFERRED_TIER_CHANGED = "browser-llm-preferred-tier-changed";
    // Dispatched after PreferredAskAiLanguage.setLanguage persists a new
    // Ask AI output language / "Combine with English" flag. Every mounted
    // <language-select> instance listens and re-syncs, so picking a
    // language in one place (Settings ▸ AI, Study text-selection menu,
    // Study bottom panel) updates the others live.
    static PREFERRED_ASK_AI_LANGUAGE_CHANGED = "preferred-ask-ai-language-changed";
    // Dispatched after PreferredLocalLlmModel.setModelKey persists a new
    // choice of WHICH Free model this device runs. The capability layer
    // re-resolves and, if the chosen model is not already downloaded, the
    // picker drops back to its "click to download" state for the new one.
    static PREFERRED_MODEL_CHANGED = "browser-llm-preferred-model-changed";
    // Dispatched whenever LocalLlmModelInventory records or forgets a model —
    // a download finishing, a deletion completing, a state being reconciled
    // against what storage actually holds. The model table listens and
    // re-renders the affected row.
    //
    // Separate from CAPABILITY_CHANGED because they answer different
    // questions. CAPABILITY_CHANGED means "the tier's usability changed" and
    // concerns only the model currently selected; this means "what this device
    // holds changed" and concerns every row in the table, including models
    // that are not selected and never will be.
    //
    // Detail: { modelKey, state }
    static INVENTORY_CHANGED = "browser-llm-inventory-changed";
}

export default LocalLlmDownloadEvents;
