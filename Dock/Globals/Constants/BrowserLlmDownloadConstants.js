class BrowserLlmDownloadConstants
{
    static MODEL_ID = 'Qwen2.5-3B-Instruct-q4f16_1-MLC';
    static MANIFEST_ENDPOINT_PATH = '/BrowserLlm/Manifest';
    static ASSETS_BASE_PATH = '/Assets/Models';
    static LOCAL_STATE_PERSISTENCE_KEY = 'BrowserLlm/DownloadState.mmsd';
    static LOCAL_DECLINED_PERSISTENCE_KEY = 'BrowserLlm/Declined.mmsd';
    static ESTIMATED_TOTAL_BYTES = 2147483648;
    static ESTIMATED_TOTAL_LABEL = '~2 GB';
    static DECK_PREFERENCES_FIELD_KEY = 'askAiPreferences';
}

module.exports = BrowserLlmDownloadConstants;
