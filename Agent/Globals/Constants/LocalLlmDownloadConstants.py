class LocalLlmDownloadConstants:
    MANIFEST_ENDPOINT_PATH = '/LocalLlm/Manifest'
    LEGACY_MANIFEST_ENDPOINT_PATH = '/BrowserLlm/Manifest'
    ASSETS_BASE_PATH = '/Assets/Models'
    RUNTIME_ASSETS_BASE_PATH = '/Assets/Runtime/OnnxRuntime/'
    WORKER_SCRIPT_PATH = '/ThirdParty/BrowserLlm/BrowserLlmWorker.js'
    ENGINE_RUNNER_MODULE_PATH = '/ThirdParty/BrowserLlm/BrowserLlmEngineRunner.js'
    LOCAL_STATE_PERSISTENCE_KEY = 'BrowserLlm/DownloadState.mmsd'
    LOCAL_DECLINED_PERSISTENCE_KEY = 'BrowserLlm/Declined.mmsd'
    LOCAL_PREFERRED_TIER_PERSISTENCE_KEY = 'BrowserLlm/PreferredTier.mmsd'
    LOCAL_PREFERRED_MODEL_PERSISTENCE_KEY = 'BrowserLlm/PreferredModel.mmsd'
    LOCAL_ASK_AI_LANGUAGE_PERSISTENCE_KEY = 'AskAi/LanguagePreference.mmsd'
    LOCAL_GRAPHICS_UNUSABLE_PERSISTENCE_KEY = 'BrowserLlm/GraphicsUnusable.mmsd'
    LOCAL_MANIFEST_CACHE_PERSISTENCE_KEY = 'BrowserLlm/ManifestCache.mmsd'
    MODEL_OVERRIDE_QUERY_PARAMETER = 'browserLlmModel'
    LOAD_TIMEOUT_MILLISECONDS = 1800000
    GENERATION_TIMEOUT_MILLISECONDS = 180000
    DECK_PREFERENCES_FIELD_KEY = 'askAiPreferences'
