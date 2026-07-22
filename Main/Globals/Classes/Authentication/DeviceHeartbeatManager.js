import AuthenticationEvents from "../../Events/AuthenticationEvents.js";
import LicenseConstants from "../../Constants/LicenseConstants.js";
import DeviceKekManager from "../Crypto/DeviceKekManager.js";
import PhysicalDeviceFingerprint from "./PhysicalDeviceFingerprint.js";
import { devicePlatforms } from "../../Enumerations/DevicePlatforms.js";

/**
 * DeviceHeartbeatManager
 *
 * Keeps the server-side `devices` collection in sync with this device's
 * "I'm still active" status. On login it registers the device (which is
 * gated by the 4-device limit server-side) and then pings the
 * /Auth/Heartbeat endpoint on a fixed interval to keep `lastSeenDate`
 * fresh, so the offline-grace timer for remote sign-out works correctly.
 *
 * Skips when the session is STALE_OFFLINE (the request would fail
 * anyway and just spams the console).
 */
class DeviceHeartbeatManager
{
    static #DEVICE_ID_STORAGE_KEY = "cogniumlearn.deviceId";
    static #heartbeatIntervalId = null;
    static #installed = false;

    static install()
    {
        if (DeviceHeartbeatManager.#installed)
        {
            return;
        }
        DeviceHeartbeatManager.#installed = true;

        window.addEventListener(AuthenticationEvents.ON_USER_LOGGED_IN, async (event) =>
        {
            const sessionState = event.detail?.sessionState;

            if (sessionState === AuthenticationEvents.SESSION_STATE_STALE_OFFLINE)
            {
                return;
            }

            await DeviceHeartbeatManager.#registerDevice();
            DeviceHeartbeatManager.#startHeartbeat();
        });

        window.addEventListener(AuthenticationEvents.ON_USER_LOGGED_OUT, () =>
        {
            DeviceHeartbeatManager.#stopHeartbeat();
        });
    }

    /**
     * Returns the per-browser UUID previously used as the primary
     * device id. Now demoted to a *migration-only* signal: the server
     * uses it to find pre-existing Device rows that don't yet have a
     * fingerprintHash and backfill the new hash onto them.
     *
     * Returns the existing value when present; never mints a new UUID
     * on first use under the new code — fresh installs don't need a
     * legacy id because they'll create their Device row via the
     * fingerprintHash path.
     * @returns {string}
     */
    static #readLegacyDeviceId()
    {
        try
        {
            return localStorage.getItem(DeviceHeartbeatManager.#DEVICE_ID_STORAGE_KEY) || "";
        }
        catch (readError)
        {
            return "";
        }
    }

    static #detectPlatform()
    {
        if (window.__TAURI__)
        {
            const platformString = navigator.platform || "";
            if (/Win/i.test(platformString)) return devicePlatforms.WINDOWS;
            if (/Mac/i.test(platformString)) return devicePlatforms.MAC;
            if (/Linux/i.test(platformString)) return devicePlatforms.LINUX;
            return devicePlatforms.UNKNOWN;
        }

        const userAgent = navigator.userAgent || "";
        if (/Android/i.test(userAgent)) return devicePlatforms.ANDROID;
        if (/iPhone|iPad|iPod/i.test(userAgent)) return devicePlatforms.IOS;
        return devicePlatforms.WEB;
    }

    static #buildDeviceName()
    {
        const userAgent = navigator.userAgent || "Unknown";

        if (/Chrome/i.test(userAgent)) return "Chrome";
        if (/Safari/i.test(userAgent)) return "Safari";
        if (/Firefox/i.test(userAgent)) return "Firefox";
        if (/Edge/i.test(userAgent)) return "Edge";
        return "Web";
    }

    static async #registerDevice()
    {
        let publicKeyFingerprint = "";
        try
        {
            publicKeyFingerprint = await DeviceKekManager.computePublicFingerprint();
        }
        catch (fingerprintError)
        {
            publicKeyFingerprint = "";
        }

        let fingerprintHash = "";
        try
        {
            fingerprintHash = await PhysicalDeviceFingerprint.getHash();
        }
        catch (hashError)
        {
            // Hash computation can fail in obscure browser configurations.
            // The server tolerates an empty hash by treating the device as
            // a brand-new record (worst case: this browser counts as its
            // own device until we get a working hash on a future login).
            console.warn("[DeviceHeartbeatManager] fingerprintHash unavailable:", hashError);
            fingerprintHash = "";
        }

        const legacyDeviceId = DeviceHeartbeatManager.#readLegacyDeviceId();

        try
        {
            const response = await fetch("/Auth/Devices/Register",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify
                ({
                    fingerprintHash: fingerprintHash,
                    legacyDeviceId: legacyDeviceId,
                    deviceName: DeviceHeartbeatManager.#buildDeviceName(),
                    platform: DeviceHeartbeatManager.#detectPlatform(),
                    userAgent: (navigator.userAgent || "").slice(0, 1024),
                    publicKeyFingerprint: publicKeyFingerprint
                })
            });

            if (response.status === 409)
            {
                const responseJson = await response.json();
                window.dispatchEvent(new CustomEvent("DEVICE_LIMIT_REACHED",
                {
                    detail: { devices: responseJson.devices || [], maxDevices: responseJson.maxDevices }
                }));
            }
        }
        catch (registerError)
        {
            console.warn("[DeviceHeartbeatManager] Device register failed:", registerError);
        }
    }

    static #startHeartbeat()
    {
        DeviceHeartbeatManager.#stopHeartbeat();

        const pulse = async () =>
        {
            try
            {
                await fetch("/Auth/Heartbeat", { method: "POST" });
            }
            catch (heartbeatError)
            {
            }
        };

        DeviceHeartbeatManager.#heartbeatIntervalId = setInterval(pulse, LicenseConstants.HEARTBEAT_INTERVAL_MILLISECONDS);
    }

    static #stopHeartbeat()
    {
        if (DeviceHeartbeatManager.#heartbeatIntervalId !== null)
        {
            clearInterval(DeviceHeartbeatManager.#heartbeatIntervalId);
            DeviceHeartbeatManager.#heartbeatIntervalId = null;
        }
    }
}

export default DeviceHeartbeatManager;
