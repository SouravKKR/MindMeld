import PageNavigator from '../../Globals/Classes/PageNavigator.js';
import { settingsMenus } from '../../Globals/Enumerations/SettingsMenus.js';
import { profileSettingKeys } from '../../Globals/Enumerations/ProfileSettingKeys.js';
import { enumerationToTitleCase } from '../../Globals/UtilityFunctions/EnumerationToTitleCase.js';
import AllSettings from '../../Globals/Classes/Settings/AllSettings.js';
import SettingFlags from '../../Globals/Constants/SettingFlags.js';
import DialogBox from '../../CommonComponents/DialogBox.js';
import SyncManager from '../../Globals/Classes/SyncManager.js';
import LlmTierSelect from '../../CommonComponents/LlmTierSelect.js';

class SettingsPage extends HTMLElement
{
    #activeTab = settingsMenus.PROFILE;
    #allSettings = new AllSettings();

    initialize({ activeTab = settingsMenus.PROFILE } = {})
    {
        this.#activeTab = activeTab;
    }

    async onPageResumed()
    {
        await this.#loadAndRender();
    }

    async #loadAndRender()
    {
        const user = window["user"];
        if (user)
        {
            this.#allSettings.loadFromUser(user);
        }
        this.#renderContent();
    }

    #settingLabel(key)
    {
        const numericKey = parseInt(key, 10);
        const entry = Object.entries(profileSettingKeys).find(([, v]) => v === numericKey);
        return entry ? enumerationToTitleCase(entry[0]) : String(key);
    }

    #renderContent()
    {
        const tabKeys = Object.keys(settingsMenus);
        const tabsHtml = tabKeys.map(key =>
        {
            const isActive = settingsMenus[key] === this.#activeTab;
            return `<button class="settings-tab-button ${isActive ? 'active' : ''}" data-tab="${settingsMenus[key]}">${enumerationToTitleCase(key)}</button>`;
        }).join('');
        this.querySelector('.settings-sidebar').innerHTML = tabsHtml;

        if (this.#activeTab === settingsMenus.MODEL)
        {
            this.#renderModelTabContent();
        }
        else
        {
            this.#renderRowBasedTabContent();
        }

        this.querySelectorAll('.settings-tab-button').forEach(tabButton =>
        {
            tabButton.addEventListener('click', () =>
            {
                this.#activeTab = parseInt(tabButton.dataset.tab);
                this.#renderContent();
            });
        });
    }

    #renderRowBasedTabContent()
    {
        const activeSettings = this.#allSettings.getSettings(this.#activeTab);
        const settings = activeSettings ? activeSettings.getSettings() : [];

        const rowsHtml = settings.map(setting =>
        {
            const flags = setting.getFlags() ?? 0;
            const isCredits = parseInt(setting.getKey(), 10) === profileSettingKeys.CREDITS;
            const hasCallToAction = (flags & SettingFlags.CALL_TO_ACTION) !== 0;
            const label = this.#settingLabel(setting.getKey());
            const rawValue = setting.getValue() ?? setting.getDefaultValue();
            const displayValue = rawValue instanceof Date
                ? rawValue.toLocaleDateString()
                : (rawValue ?? '—');

            const ctaLabel = setting.getAdditionalData()?.callToActionLabel ?? 'Action';
            const ctaHtml = hasCallToAction
                ? `<button class="settings-cta-button" data-setting-key="${setting.getKey()}">${ctaLabel}</button>`
                : '';

            return `
                <div class="settings-row ${isCredits ? 'credits-row' : ''}">
                    <span class="settings-row-label">${label}</span>
                    <span class="settings-row-value">${displayValue}</span>
                    ${ctaHtml}
                </div>
            `;
        }).join('');

        const dangerZoneHtml = this.#activeTab === settingsMenus.PROFILE
            ? `
                <div class="settings-danger-zone">
                    <h3 class="settings-danger-zone-title">Danger Zone</h3>
                    <div class="settings-danger-zone-row">
                        <div class="settings-danger-zone-description">
                            <strong>Clear all server data</strong>
                            <span>Permanently deletes every deck, card, study material, mock test and sync record for your account from MindMeld's servers. Other devices will lose this data on next sync. Your account stays active.</span>
                        </div>
                        <button class="settings-clear-server-data-button" type="button">Clear All Server Data</button>
                    </div>
                </div>
            `
            : '';

        this.querySelector('.settings-content').innerHTML = rowsHtml + dangerZoneHtml;

        const clearServerDataButton = this.querySelector('.settings-clear-server-data-button');
        if(clearServerDataButton)
        {
            clearServerDataButton.addEventListener('click', () => this.#handleClearServerDataClick());
        }
    }

    #renderModelTabContent()
    {
        // Single labelled row with the live tier select as its
        // control. The select component owns persistence, cross-
        // component sync (window-level PREFERRED_TIER_CHANGED event),
        // and its own "Free unavailable — …" status line. Picking a
        // tier here updates the Study text-selection menu and the
        // bottom panel without any explicit wiring on this page.
        this.querySelector('.settings-content').innerHTML = `
            <div class="settings-row settings-model-row">
                <span class="settings-row-label">Model</span>
                <span class="settings-row-value">
                    <llm-tier-select></llm-tier-select>
                </span>
            </div>
        `;
    }

    async #handleClearServerDataClick()
    {
        const confirmed = await DialogBox.confirm
        (
            "Permanently delete all your server data?",
            "This wipes every deck, card, study material, mock test and sync record for your account from MindMeld's servers. Other devices will lose this data on next sync. Your account itself stays active. This cannot be undone."
        );

        if(!confirmed)
        {
            return;
        }

        const typedConfirmation = await DialogBox.prompt
        (
            "Type DELETE to confirm",
            "Enter the word DELETE (uppercase) to permanently clear your server data."
        );

        if(typedConfirmation !== "DELETE")
        {
            await DialogBox.alert("Cancelled", "Confirmation text did not match. No data was deleted.");
            return;
        }

        try
        {
            const wipeResponse = await fetch("/Profile/ClearUserData", { method: "POST", credentials: "same-origin" });

            if(!wipeResponse.ok)
            {
                await DialogBox.alert("Failed", `Server returned ${wipeResponse.status}. No data may have been cleared. Please try again later.`);
                return;
            }

            // Server is now empty for this user. Force the device to pull
            // the (now empty) snapshot so the local tree mirrors the server
            // immediately — without this, every subsequent push would just
            // re-upload the same data we asked the server to forget. We pass
            // bDiscardPendingChanges so the in-flight-import safeguard
            // doesn't bail on stale entries that the server no longer has.
            try
            {
                await SyncManager.forcePullFromServer({ bDiscardPendingChanges: true });
            }
            catch(syncError)
            {
                console.error("[SettingsPage] Forced post-clear sync failed:", syncError);
                await DialogBox.alert("Cleared (sync pending)", "Your server data has been deleted, but pulling the empty state to this device failed. Please trigger a Force Pull manually or refresh the app.");
                return;
            }

            await DialogBox.alert("Cleared", "Your server data has been deleted and this device now mirrors the empty state.");
        }
        catch(networkError)
        {
            console.error("[SettingsPage] Clear server data request failed:", networkError);
            await DialogBox.alert("Failed", "Could not reach the server. No data may have been cleared. Please try again later.");
        }
    }

    connectedCallback()
    {
        this.setAttribute('page', '');

        if(!window["user"])
        {
            // Belt-and-braces — OptionsSidebar already gates the click, but a
            // direct PageNavigator.open call from elsewhere could still land
            // here. Bounce back and tell the user why.
            DialogBox.alert("Sign in required", "You must be signed in to view settings.");
            PageNavigator.back();
            return;
        }

        this.innerHTML =
        `
            <header-component title="Settings"></header-component>
            <div class="settings-layout">
                <div class="settings-sidebar"></div>
                <div class="settings-content"></div>
            </div>
        `;

        this.#loadAndRender();
    }
}

customElements.define('settings-page', SettingsPage);
export default SettingsPage;
