/**
 * PhysicalDeviceFingerprint
 *
 * Computes a SHA-256 hash of a small set of OS / hardware signals that
 * are stable across browsers on the same physical machine. Used by
 * the device-registration flow to resolve "Chrome on this laptop" and
 * "Firefox on this laptop" to the same Device row server-side, so the
 * 4-device limit counts physical devices rather than browsers.
 *
 * Best-effort: browsers intentionally sandbox storage per profile, so
 * a perfectly stable cross-browser id isn't possible. The signal mix
 * (UA Client Hints + screen geometry + hardware concurrency + memory +
 * timezone) is chosen to minimise collisions between distinct
 * machines while staying stable across browser-only changes.
 *
 * Deliberately NOT included: browser name, full userAgent string,
 * locale, fonts, canvas / WebGL fingerprints. Those churn across
 * browsers on the same machine, which would defeat the purpose.
 *
 * The hash is cached in localStorage under a versioned key so we can
 * invalidate every user's cached value by bumping
 * #STABLE_SIGNAL_VERSION without forcing manual cache clears.
 */
class PhysicalDeviceFingerprint
{
    static #CACHE_STORAGE_KEY = "mindmeld.physicalDeviceFingerprint.v1";
    static #STABLE_SIGNAL_VERSION = 1;
    static #STABLE_SIGNAL_PAYLOAD_LABEL = "mindmeld.fingerprint";
    static #UA_CLIENT_HINT_FIELDS = ["platform", "model", "architecture", "bitness"];

    static #cachedHashPromise = null;

    /**
     * Returns the 64-character hex SHA-256 hash of the stable signals.
     * Cached in memory (per page load) and in localStorage (across
     * page loads). The first call performs the digest; subsequent
     * calls are constant-time.
     * @returns {Promise<string>}
     */
    static async getHash()
    {
        if (PhysicalDeviceFingerprint.#cachedHashPromise !== null)
        {
            return PhysicalDeviceFingerprint.#cachedHashPromise;
        }

        PhysicalDeviceFingerprint.#cachedHashPromise = PhysicalDeviceFingerprint.#resolveHash();
        return PhysicalDeviceFingerprint.#cachedHashPromise;
    }

    static async #resolveHash()
    {
        try
        {
            const cachedHash = localStorage.getItem(PhysicalDeviceFingerprint.#CACHE_STORAGE_KEY);
            if (typeof cachedHash === "string" && cachedHash.length === 64)
            {
                return cachedHash;
            }
        }
        catch (cacheReadError)
        {
            // localStorage may be blocked (private mode on some browsers);
            // proceed to compute fresh.
        }

        const freshHash = await PhysicalDeviceFingerprint.#computeStableSignalDigest();

        try
        {
            localStorage.setItem(PhysicalDeviceFingerprint.#CACHE_STORAGE_KEY, freshHash);
        }
        catch (cacheWriteError)
        {
            // Non-fatal. The in-memory cache still survives the page load.
        }

        return freshHash;
    }

    static async #computeStableSignalDigest()
    {
        const uaClientHints = await PhysicalDeviceFingerprint.#readClientHints();
        const screenSignature = PhysicalDeviceFingerprint.#readScreenSignature();
        const concurrencyAndMemory = PhysicalDeviceFingerprint.#readConcurrencyAndMemory();
        const timeZone = PhysicalDeviceFingerprint.#readTimeZone();

        const stableSignalPayload = JSON.stringify
        ({
            label: PhysicalDeviceFingerprint.#STABLE_SIGNAL_PAYLOAD_LABEL,
            version: PhysicalDeviceFingerprint.#STABLE_SIGNAL_VERSION,
            uaClientHints: uaClientHints,
            screenSignature: screenSignature,
            concurrencyAndMemory: concurrencyAndMemory,
            timeZone: timeZone
        });

        const payloadBytes = new TextEncoder().encode(stableSignalPayload);
        const digestBuffer = await crypto.subtle.digest("SHA-256", payloadBytes);
        return PhysicalDeviceFingerprint.#bytesToHex(new Uint8Array(digestBuffer));
    }

    static async #readClientHints()
    {
        // navigator.userAgentData is shipped by Chromium-based browsers
        // and an increasing share of Edge / Opera builds. Safari and
        // Firefox don't expose it; fall back to navigator.platform so
        // the digest still has some OS signal in the mix.
        try
        {
            const userAgentData = navigator.userAgentData;
            if (userAgentData && typeof userAgentData.getHighEntropyValues === "function")
            {
                const highEntropy = await userAgentData.getHighEntropyValues(PhysicalDeviceFingerprint.#UA_CLIENT_HINT_FIELDS);
                return {
                    platform: highEntropy.platform || "",
                    model: highEntropy.model || "",
                    architecture: highEntropy.architecture || "",
                    bitness: highEntropy.bitness || ""
                };
            }
        }
        catch (clientHintError)
        {
            // Some browsers reject getHighEntropyValues outside of secure
            // contexts. Treat as absent.
        }

        return {
            platform: (navigator.platform || "").toString(),
            model: "",
            architecture: "",
            bitness: ""
        };
    }

    static #readScreenSignature()
    {
        const screenWidth = (typeof screen !== "undefined" && screen.width) ? screen.width : 0;
        const screenHeight = (typeof screen !== "undefined" && screen.height) ? screen.height : 0;
        const screenColorDepth = (typeof screen !== "undefined" && screen.colorDepth) ? screen.colorDepth : 0;
        const devicePixelRatio = (typeof window !== "undefined" && window.devicePixelRatio) ? window.devicePixelRatio : 1;
        return `${screenWidth}x${screenHeight}x${screenColorDepth}@${devicePixelRatio}`;
    }

    static #readConcurrencyAndMemory()
    {
        const hardwareConcurrency = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) ? navigator.hardwareConcurrency : 0;
        const deviceMemory = (typeof navigator !== "undefined" && navigator.deviceMemory) ? navigator.deviceMemory : 0;
        return `${hardwareConcurrency}|${deviceMemory}`;
    }

    static #readTimeZone()
    {
        try
        {
            return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
        }
        catch (timeZoneError)
        {
            return "";
        }
    }

    static #bytesToHex(byteArray)
    {
        let hexString = "";
        for (let byteIndex = 0; byteIndex < byteArray.length; byteIndex++)
        {
            const currentByte = byteArray[byteIndex];
            hexString += currentByte.toString(16).padStart(2, "0");
        }
        return hexString;
    }
}

export default PhysicalDeviceFingerprint;
