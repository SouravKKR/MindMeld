import DeviceHeartbeatManager from "./Authentication/DeviceHeartbeatManager.js";
import PaidDeckLicenseSyncer from "./Syncing/PaidDeckLicenseSyncer.js";
import DeviceManagementDialog from "../../CommonComponents/DeviceManagementDialog.js";

/**
 * PaidDeckBootstrap
 *
 * Top-level wiring for the paid-deck subsystem. Installs the heartbeat
 * manager + license syncer once at app load, and listens for the
 * DEVICE_LIMIT_REACHED event so it can pop the DeviceManagementDialog
 * with the response payload pre-filled.
 *
 * Imported by index.html so it side-effects on script load — no
 * explicit boot call needed elsewhere.
 */
class PaidDeckBootstrap
{
    static
    {
        DeviceHeartbeatManager.install();
        PaidDeckLicenseSyncer.install();

        window.addEventListener("DEVICE_LIMIT_REACHED", (event) =>
        {
            DeviceManagementDialog.open
            ({
                devices: event.detail?.devices || [],
                maxDevices: event.detail?.maxDevices
            });
        });
    }
}

export default PaidDeckBootstrap;
