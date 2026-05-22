/**
 * DeviceLimitReachedError
 *
 * Thrown by AuthenticationQueryEngine.resolveOrCreateDevice when a
 * user attempts to register a new physical device while already
 * sitting at MAX_DEVICES_PER_USER active devices.
 *
 * Carries the current device list on the error so the endpoint
 * handler can return it as the 409 response body — the client uses
 * the list to populate the "sign out a device to make room" dialog.
 */
class DeviceLimitReachedError extends Error
{
    #devices;

    constructor(devices)
    {
        super("DEVICE_LIMIT_REACHED");
        this.name = "DeviceLimitReachedError";
        this.#devices = Array.isArray(devices) ? devices : [];
    }

    getDevices()
    {
        return this.#devices;
    }
}

module.exports = DeviceLimitReachedError;
