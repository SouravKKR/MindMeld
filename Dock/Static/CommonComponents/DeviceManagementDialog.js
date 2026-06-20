import DialogBox from "./DialogBox.js";

/**
 * DeviceManagementDialog
 *
 * DialogBox.modal-based device manager. Replaces the now-defunct
 * DeviceManagementPage so the user never leaves their current page to
 * sign a device out. Two entry points:
 *
 *   - DeviceManagementDialog.open() — fetches /Auth/Devices and shows
 *     the full list. Used from ProfileContextMenu's "Manage devices"
 *     entry.
 *   - DeviceManagementDialog.open({ devices, maxDevices }) — when
 *     login returned 409 with a device list already in hand, skip the
 *     refetch and render the supplied list straight away. Used from
 *     PaidDeckBootstrap's DEVICE_LIMIT_REACHED handler.
 *
 * The dialog manages its own refresh after each sign-out so the caller
 * doesn't need to babysit the list.
 */
class DeviceManagementDialog
{
    static #DEVICES_ENDPOINT = "/Auth/Devices";
    static #SIGN_OUT_ENDPOINT = "/Auth/Devices/SignOut";

    static async open(preset)
    {
        const dialog = DialogBox.modal(DeviceManagementDialog.#getShellMarkup());
        const closeButton = dialog.querySelector(".close-button");

        const state =
        {
            devices: [],
            maxDevices: 4,
            offlineGraceDays: 7
        };

        if (preset && Array.isArray(preset.devices))
        {
            state.devices = preset.devices;
            state.maxDevices = preset.maxDevices || state.maxDevices;
            state.offlineGraceDays = preset.offlineGraceDays || state.offlineGraceDays;
            DeviceManagementDialog.#renderList(dialog, state);
        }
        else
        {
            await DeviceManagementDialog.#refresh(dialog, state);
        }

        if (closeButton)
        {
            closeButton.addEventListener("click", () => dialog.close());
        }
    }

    static #getShellMarkup()
    {
        return `
            <div class="device-management-dialog">
                <h2 class="device-management-dialog-title">Your devices</h2>
                <div class="device-management-dialog-summary" data-role="summary"></div>
                <div class="device-management-dialog-list" data-role="list">
                    <div class="device-management-dialog-loading">Loading…</div>
                </div>
            </div>
        `;
    }

    static async #refresh(dialog, state)
    {
        const listElement = dialog.querySelector('[data-role="list"]');
        listElement.innerHTML = `<div class="device-management-dialog-loading">Loading…</div>`;

        try
        {
            const response = await fetch(DeviceManagementDialog.#DEVICES_ENDPOINT);

            if (!response.ok)
            {
                listElement.innerHTML = `<div class="device-management-dialog-error">Failed to load (${response.status}).</div>`;
                return;
            }

            const responseJson = await response.json();
            state.devices = responseJson.devices || [];
            state.maxDevices = responseJson.maxDevices || state.maxDevices;
            state.offlineGraceDays = responseJson.offlineGraceDays || state.offlineGraceDays;

            DeviceManagementDialog.#renderList(dialog, state);
        }
        catch (loadError)
        {
            listElement.innerHTML = `<div class="device-management-dialog-error">${DeviceManagementDialog.#escape(loadError.message)}</div>`;
        }
    }

    static #renderList(dialog, state)
    {
        const summaryElement = dialog.querySelector('[data-role="summary"]');
        const listElement = dialog.querySelector('[data-role="list"]');

        summaryElement.innerHTML = `
            <p>You can be signed in on up to <strong>${state.maxDevices}</strong> devices.</p>
            <p>To free a slot remotely, the target device must have been offline for at least ${state.offlineGraceDays} days. Otherwise sign out from that device directly.</p>
        `;

        if (state.devices.length === 0)
        {
            listElement.innerHTML = `<div class="device-management-dialog-empty">No devices registered.</div>`;
            return;
        }

        listElement.innerHTML = state.devices.map((device, deviceIndex) =>
        {
            const lastSeenLabel = device.lastSeenDate ? new Date(device.lastSeenDate).toLocaleString() : "—";
            const canSignOut = device.canSignOutRemotely === true || device.isCurrent === true;
            const currentDeviceMarker = device.isCurrent ? " (this device)" : "";

            // Multiple browsers on the same physical device now share one
            // Device row, so sessionCount > 1 means "Chrome + Firefox here".
            const sessionCount = typeof device.sessionCount === "number" ? device.sessionCount : 0;
            const sessionCaption = sessionCount > 1
                ? `<br><span class="device-management-dialog-session-caption">${sessionCount} active browser sessions</span>`
                : "";

            return `
                <div class="device-management-dialog-row" data-device-index="${deviceIndex}">
                    <div class="device-management-dialog-name">${DeviceManagementDialog.#escape(device.deviceName)}${currentDeviceMarker}</div>
                    <div class="device-management-dialog-meta">
                        Last seen: ${lastSeenLabel}<br>
                        ${DeviceManagementDialog.#escape(device.userAgent || "")}${sessionCaption}
                    </div>
                    <button class="device-management-dialog-signout" data-device-id="${DeviceManagementDialog.#escape(device.id)}" ${canSignOut ? "" : "disabled"}>
                        ${canSignOut ? "Sign out" : "Active recently"}
                    </button>
                </div>
            `;
        }).join("");

        for (const signOutButton of listElement.querySelectorAll(".device-management-dialog-signout"))
        {
            signOutButton.addEventListener("click", async (clickEvent) =>
            {
                const deviceId = clickEvent.currentTarget.dataset.deviceId;
                await DeviceManagementDialog.#signOutDevice(dialog, state, deviceId);
            });
        }
    }

    static async #signOutDevice(dialog, state, deviceId)
    {
        const confirmed = await DialogBox.confirm("Sign out device", "Are you sure you want to sign this device out?");
        if (!confirmed)
        {
            return;
        }

        const response = await fetch(DeviceManagementDialog.#SIGN_OUT_ENDPOINT,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ deviceId })
        });

        if (response.ok)
        {
            await DialogBox.alert("Signed out", "That device has been signed out.");
            await DeviceManagementDialog.#refresh(dialog, state);
        }
        else
        {
            const responseJson = await response.json().catch(() => ({}));
            await DialogBox.alert("Couldn't sign out", responseJson.error || `HTTP ${response.status}`);
        }
    }

    static #escape(rawValue)
    {
        if (rawValue === null || rawValue === undefined) return "";
        return String(rawValue)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }
}

export default DeviceManagementDialog;
