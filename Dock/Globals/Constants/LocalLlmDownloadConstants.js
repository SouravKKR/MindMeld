class LocalLlmDownloadConstants
{
    static MANIFEST_ENDPOINT_PATH = '/LocalLlm/Manifest';
    static LEGACY_MANIFEST_ENDPOINT_PATH = '/BrowserLlm/Manifest';
    static ASSETS_BASE_PATH = '/Assets/Models';
    static RUNTIME_ASSETS_BASE_PATH = '/Assets/Runtime/OnnxRuntime/';
    static WORKER_SCRIPT_PATH = '/ThirdParty/BrowserLlm/BrowserLlmWorker.js';
    static ENGINE_RUNNER_MODULE_PATH = '/ThirdParty/BrowserLlm/BrowserLlmEngineRunner.js';
    static LOCAL_STATE_PERSISTENCE_KEY = 'BrowserLlm/DownloadState.mmsd';
    static LOCAL_DECLINED_PERSISTENCE_KEY = 'BrowserLlm/Declined.mmsd';
    static LOCAL_PREFERRED_TIER_PERSISTENCE_KEY = 'BrowserLlm/PreferredTier.mmsd';
    static LOCAL_ASK_AI_LANGUAGE_PERSISTENCE_KEY = 'AskAi/LanguagePreference.mmsd';
    static LOCAL_GRAPHICS_UNUSABLE_PERSISTENCE_KEY = 'BrowserLlm/GraphicsUnusable.mmsd';
    static LOCAL_MANIFEST_CACHE_PERSISTENCE_KEY = 'BrowserLlm/ManifestCache.mmsd';
    static MODEL_OVERRIDE_QUERY_PARAMETER = 'browserLlmModel';
    static LOAD_TIMEOUT_MILLISECONDS = 1800000;
    static GENERATION_TIMEOUT_MILLISECONDS = 180000;
    static DECK_PREFERENCES_FIELD_KEY = 'askAiPreferences';
}

module.exports = LocalLlmDownloadConstants;
