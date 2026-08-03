/**
 * RateLimiter
 *
 * A small, allocation-light fixed-window counter used for per-user (per-identity)
 * request throttling. Each key (e.g. "user:<id>" or "ip:<address>") is bucketed
 * into an aligned time window; once a key's count exceeds the configured maximum
 * within the current window, further requests are rejected until the window rolls
 * over.
 *
 * Dock runs single-process (Packetron maxThreads = 1), so an in-memory map is an
 * accurate global counter — there is no cross-worker drift to coordinate. This
 * deliberately mirrors Packetron's own built-in per-route limiter (which provides
 * the "overall" per-endpoint cap); this class provides the complementary
 * per-user dimension as a custom plugin.
 *
 * Memory is bounded by the number of distinct identities seen within a window. A
 * periodic sweep drops buckets whose window has fully elapsed so an attacker
 * cycling keys cannot grow the map without bound. The sweep timer is unref'd so
 * it never keeps the process alive on its own.
 */
class RateLimiter
{
    // Thresholds are read once from Dock/.env at module load (dotenv has already
    // run in index.js by then), each falling back to a sane default when the
    // variable is unset, blank, or invalid. See Dock/.env.example.

    // Overall per-endpoint cap handed to Packetron's built-in maxRequestsPerSecond.
    // Sized to absorb concurrent multi-user load on hot endpoints (e.g. /Sync)
    // while still cutting off a flood.
    //   env: RATE_LIMIT_OVERALL_MAX_REQUESTS_PER_SECOND (default 100)
    static DEFAULT_OVERALL_MAX_REQUESTS_PER_SECOND = RateLimiter.#resolvePositiveIntegerSetting("RATE_LIMIT_OVERALL_MAX_REQUESTS_PER_SECOND", 100);

    // Per-user (per-identity) cap enforced by the custom plugin.
    //   env: RATE_LIMIT_PER_USER_MAX_REQUESTS    (default 300)
    //   env: RATE_LIMIT_PER_USER_WINDOW_SECONDS  (default 60)
    static DEFAULT_PER_USER_MAX_REQUESTS = RateLimiter.#resolvePositiveIntegerSetting("RATE_LIMIT_PER_USER_MAX_REQUESTS", 300);
    static DEFAULT_PER_USER_WINDOW_MILLISECONDS = RateLimiter.#resolvePositiveIntegerSetting("RATE_LIMIT_PER_USER_WINDOW_SECONDS", 60) * 1000;

    // Dedicated, much tighter per-IP cap for the OAuth login handshake
    // (/Login + /Login/Callback). The default per-user window above is sized for
    // normal app traffic and is far too loose to deter login abuse (rapid token
    // exchanges, account churn, callback probing). A legitimate sign-in is only
    // two requests, so a small allowance per IP over a few minutes is ample;
    // deployments behind a shared NAT (e.g. a school) can raise it via env.
    //   env: RATE_LIMIT_LOGIN_MAX_REQUESTS    (default 20)
    //   env: RATE_LIMIT_LOGIN_WINDOW_SECONDS  (default 300)
    static DEFAULT_LOGIN_MAX_REQUESTS = RateLimiter.#resolvePositiveIntegerSetting("RATE_LIMIT_LOGIN_MAX_REQUESTS", 20);
    static DEFAULT_LOGIN_WINDOW_MILLISECONDS = RateLimiter.#resolvePositiveIntegerSetting("RATE_LIMIT_LOGIN_WINDOW_SECONDS", 300) * 1000;

    // Dedicated, tight per-IP cap for the email-OTP handshake (/Auth/RequestOtp +
    // /Auth/VerifyOtp). These are unauthenticated, and /Auth/RequestOtp sends an
    // email on every call, so without a dedicated cap the loose per-user ceiling
    // lets one IP trigger OTP emails to unlimited distinct addresses (email-bomb /
    // delivery-cost abuse) and spread guessing across re-issued codes. A real flow
    // is one request plus a few verify attempts, so a small allowance per IP over a
    // few minutes is ample; shared-NAT deployments (e.g. a school) can raise it via
    // env. Per-code brute force stays independently capped in OtpManager.
    //   env: RATE_LIMIT_OTP_MAX_REQUESTS    (default 20)
    //   env: RATE_LIMIT_OTP_WINDOW_SECONDS  (default 300)
    static DEFAULT_OTP_MAX_REQUESTS = RateLimiter.#resolvePositiveIntegerSetting("RATE_LIMIT_OTP_MAX_REQUESTS", 20);
    static DEFAULT_OTP_WINDOW_MILLISECONDS = RateLimiter.#resolvePositiveIntegerSetting("RATE_LIMIT_OTP_WINDOW_SECONDS", 300) * 1000;

    // Dedicated per-user cap for the generation cost estimator
    // (/Generate/EstimateCost). The button sits next to Start Generation and
    // invites repeated pressing, while each press loads the credit config and
    // walks the whole settings body. The answer only changes when the form does,
    // so one estimate per window is ample and the loose general per-user ceiling
    // is far too high to deter drumming on it.
    //   env: RATE_LIMIT_ESTIMATE_MAX_REQUESTS    (default 1)
    //   env: RATE_LIMIT_ESTIMATE_WINDOW_SECONDS  (default 30)
    static DEFAULT_ESTIMATE_MAX_REQUESTS = RateLimiter.#resolvePositiveIntegerSetting("RATE_LIMIT_ESTIMATE_MAX_REQUESTS", 1);
    static DEFAULT_ESTIMATE_WINDOW_MILLISECONDS = RateLimiter.#resolvePositiveIntegerSetting("RATE_LIMIT_ESTIMATE_WINDOW_SECONDS", 30) * 1000;

    static #SWEEP_INTERVAL_MILLISECONDS = 5 * 60 * 1000;

    /**
     * Reads a strictly-positive integer from the given environment variable,
     * returning the fallback (and warning) when the value is missing or invalid.
     *
     * @param {string} environmentVariableName
     * @param {number} fallbackValue
     * @returns {number}
     */
    static #resolvePositiveIntegerSetting(environmentVariableName, fallbackValue)
    {
        const rawValue = process.env[environmentVariableName];

        if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "")
        {
            return fallbackValue;
        }

        const parsedValue = Number(rawValue);

        if (!Number.isFinite(parsedValue) || parsedValue <= 0)
        {
            console.warn(`[RateLimiter] Ignoring invalid ${environmentVariableName}="${rawValue}"; using default ${fallbackValue}.`);
            return fallbackValue;
        }

        return Math.floor(parsedValue);
    }

    #maxRequests;
    #windowMilliseconds;
    #buckets = new Map();
    #sweepTimer = null;

    constructor(maxRequests = RateLimiter.DEFAULT_PER_USER_MAX_REQUESTS, windowMilliseconds = RateLimiter.DEFAULT_PER_USER_WINDOW_MILLISECONDS)
    {
        this.#maxRequests = maxRequests;
        this.#windowMilliseconds = windowMilliseconds;
        this.#startSweep();
    }

    /**
     * Records one request against the given key and reports whether it is within
     * the limit. Always counts the request (so the offending request itself is
     * included), then reports allowed = false once the count passes the maximum.
     *
     * @param {string} key
     * @returns {{ allowed: boolean, limit: number, windowMilliseconds: number, remaining: number, retryAfterSeconds: number }}
     */
    consume(key)
    {
        const now = Date.now();
        const windowStart = now - (now % this.#windowMilliseconds);

        let bucket = this.#buckets.get(key);

        if (!bucket || bucket.windowStart !== windowStart)
        {
            bucket = { windowStart: windowStart, count: 0 };
            this.#buckets.set(key, bucket);
        }

        bucket.count++;

        const allowed = bucket.count <= this.#maxRequests;
        const retryAfterSeconds = allowed ? 0 : Math.max(1, Math.ceil((windowStart + this.#windowMilliseconds - now) / 1000));

        return {
            allowed: allowed,
            limit: this.#maxRequests,
            windowMilliseconds: this.#windowMilliseconds,
            remaining: Math.max(0, this.#maxRequests - bucket.count),
            retryAfterSeconds: retryAfterSeconds
        };
    }

    #startSweep()
    {
        this.#sweepTimer = setInterval(() => this.#sweep(), RateLimiter.#SWEEP_INTERVAL_MILLISECONDS);

        if (this.#sweepTimer && typeof this.#sweepTimer.unref === "function")
        {
            this.#sweepTimer.unref();
        }
    }

    #sweep()
    {
        const cutoff = Date.now() - this.#windowMilliseconds;

        for (const [key, bucket] of this.#buckets)
        {
            if (bucket.windowStart < cutoff)
            {
                this.#buckets.delete(key);
            }
        }
    }
}

module.exports = RateLimiter;
