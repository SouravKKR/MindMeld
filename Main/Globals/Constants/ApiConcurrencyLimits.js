class ApiConcurrencyLimits
{
    static MAX_CONCURRENT_BY_BUCKET = {"gemini-3.1-pro-preview":3,"gemini-3.1-flash-lite":8,"gemini-3-flash-preview":8,"gemini-2.5-flash":5,"gemini-2.5-flash-lite":10};
    static DEFAULT_MAX_CONCURRENT = 5;
    static SLOT_HOLD_TIMEOUT_SECONDS = 180;
    static ACQUIRE_POLL_INTERVAL_SECONDS = 1;
}

module.exports = ApiConcurrencyLimits;
