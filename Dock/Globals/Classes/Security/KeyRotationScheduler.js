const KeyManagementService = require("./KeyManagementService");

class KeyRotationScheduler
{
    static #ROTATION_INTERVAL_MILLISECONDS = 24 * 60 * 60 * 1000;
    static #intervalHandle = null;

    static start()
    {
        if (KeyRotationScheduler.#intervalHandle !== null)
        {
            return;
        }

        KeyRotationScheduler.#intervalHandle = setInterval
        (
            KeyRotationScheduler.#tick,
            KeyRotationScheduler.#ROTATION_INTERVAL_MILLISECONDS
        );
    }

    static stop()
    {
        if (KeyRotationScheduler.#intervalHandle === null)
        {
            return;
        }

        clearInterval(KeyRotationScheduler.#intervalHandle);
        KeyRotationScheduler.#intervalHandle = null;
    }

    static async #tick()
    {
        if (!KeyManagementService.isReady())
        {
            return;
        }

        try
        {
            await KeyManagementService.rotateAllOverdueKeys();
        }
        catch (rotationError)
        {
            console.error("[KeyRotationScheduler] Periodic rotation failed:", rotationError);
        }
    }
}

module.exports = KeyRotationScheduler;
