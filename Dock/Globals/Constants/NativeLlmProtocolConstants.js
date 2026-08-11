class NativeLlmProtocolConstants
{
    static COMMAND_PROBE_CAPABILITY = 'probe_native_llm_capability';
    static COMMAND_ENSURE_MODEL_PRESENT = 'ensure_native_model_present';
    static COMMAND_LOAD_MODEL = 'load_native_model';
    static COMMAND_GENERATE_COMPLETION = 'generate_native_completion';
    static COMMAND_INTERRUPT_GENERATION = 'interrupt_native_generation';
    static COMMAND_UNLOAD_MODEL = 'unload_native_model';
    static EVENT_DOWNLOAD_PROGRESS = 'native-llm-download-progress';
    static EVENT_LOAD_PROGRESS = 'native-llm-load-progress';
    static EVENT_TOKEN = 'native-llm-token';
    static EVENT_FAILED = 'native-llm-failed';
    static DEVICE_LOST_ERROR_NAME = 'LocalLlmDeviceLostError';
}

module.exports = NativeLlmProtocolConstants;
