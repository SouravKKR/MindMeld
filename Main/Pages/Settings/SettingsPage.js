import PageNavigator from '../../Globals/Classes/PageNavigator.js';
import AuthenticationEvents from '../../Globals/Events/AuthenticationEvents.js';
import { settingsMenus } from '../../Globals/Enumerations/SettingsMenus.js';
import { profileSettingKeys } from '../../Globals/Enumerations/ProfileSettingKeys.js';
import { enumerationToTitleCase } from '../../Globals/UtilityFunctions/EnumerationToTitleCase.js';
import { formatCredits } from '../../Globals/UtilityFunctions/FormatCredits.js';
import AllSettings from '../../Globals/Classes/Settings/AllSettings.js';
import SettingFlags from '../../Globals/Constants/SettingFlags.js';
import ErrorCodes from '../../Globals/Constants/ErrorCodes.js';
import DialogBox from '../../CommonComponents/DialogBox.js';
import SyncManager from '../../Globals/Classes/SyncManager.js';
import Persistence from '../../Globals/Classes/Persistence.js';
import LlmTierSelect from '../../CommonComponents/LlmTierSelect.js';
import LanguageSelect from '../../CommonComponents/LanguageSelect.js';
import LocalLlmModelSelect from '../../CommonComponents/LocalLlmModelSelect.js';
import AppearanceSettingsPanel from './Components/AppearanceSettingsPanel.js';
import AudioSettingsPanel from './Components/AudioSettingsPanel.js';
import CreditPurchaseFlow from '../../Globals/Classes/Credits/CreditPurchaseFlow.js';
import StreakBadgeHelper from '../../Globals/Classes/Streak/StreakBadgeHelper.js';
import BadgeGalleryDialog from '../../CommonComponents/BadgeGalleryDialog.js';
import MetricBadgeHelper from '../../Globals/Classes/Metrics/MetricBadgeHelper.js';
import StorageMeter from '../../CommonComponents/StorageMeter.js';
import StorageManagerDialog from '../../CommonComponents/StorageManagerDialog.js';

class SettingsPage extends HTMLElement
{
    #activeTab = settingsMenus.PROFILE;
    #allSettings = new AllSettings();

    // Display-label overrides for settings tabs whose enum key doesn't
    // title-case into the wanted label. The MODEL tab now hosts the model
    // tier AND the Ask AI output language, so it reads "AI" — and the
    // acronym would otherwise render as "Ai" through enumerationToTitleCase.
    static #TAB_LABEL_OVERRIDES =
    {
        MODEL: "AI",
    };

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
        // Paint immediately from the cached user, then pull a fresh copy
        // from the server. Server-owned values (the credit balance above
        // all) change outside this client — generation, AskAI and grading
        // charges land directly in Mongo — so the boot-time snapshot in
        // window["user"] goes stale as soon as anything is charged.
        const cachedUser = window["user"];
        if (cachedUser)
        {
            this.#allSettings.loadFromUser(cachedUser);
        }
        this.#renderContent();

        const freshUser = await AuthenticationEvents.refreshUserFromServer();
        if (freshUser)
        {
            this.#allSettings.loadFromUser(freshUser);

            // Only row-based tabs display user-derived values. The Model
            // and Appearance tabs own live controls (tier select, color
            // pickers) that a late re-render would tear down mid-use.
            if (this.#activeTab !== settingsMenus.MODEL && this.#activeTab !== settingsMenus.APPEARANCE && this.#activeTab !== settingsMenus.AUDIO)
            {
                this.#renderContent();
            }
        }
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
            const label = SettingsPage.#TAB_LABEL_OVERRIDES[key] ?? enumerationToTitleCase(key);
            return `<button class="settings-tab-button ${isActive ? 'active' : ''}" data-tab="${settingsMenus[key]}">${label}</button>`;
        }).join('');
        this.querySelector('.settings-sidebar').innerHTML = tabsHtml;

        if (this.#activeTab === settingsMenus.MODEL)
        {
            this.#renderModelTabContent();
        }
        else if (this.#activeTab === settingsMenus.APPEARANCE)
        {
            this.#renderAppearanceTabContent();
        }
        else if (this.#activeTab === settingsMenus.AUDIO)
        {
            this.#renderAudioTabContent();
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
                : isCredits
                    ? formatCredits(rawValue)
                    : (rawValue ?? '—');

            const ctaLabel = setting.getAdditionalData()?.callToActionLabel ?? 'Action';
            const ctaHtml = hasCallToAction
                ? `<button class="settings-cta-button" data-setting-key="${setting.getKey()}">${ctaLabel}</button>`
                : '';

            const refreshHtml = isCredits
                ? `<button class="settings-refresh-button" type="button" title="Fetch the latest values from the server">&#x21bb; Refresh</button>`
                : '';

            return `
                <div class="settings-row ${isCredits ? 'credits-row' : ''}">
                    <span class="settings-row-label">${label}</span>
                    <span class="settings-row-value">${displayValue}</span>
                    ${refreshHtml}
                    ${ctaHtml}
                </div>
            `;
        }).join('');

        // Storage usage sits right below the credit balance on the Profile tab —
        // both are server-owned account meters the user checks in one place. The
        // <storage-meter> is self-reading (window["storageUsage"], refreshed via
        // /GetUser), so re-rendering the rows after a server refresh repaints it.
        const storageMeterHtml = this.#activeTab === settingsMenus.PROFILE
            ? `
                <div class="settings-storage-section">
                    <${StorageMeter.tagName}></${StorageMeter.tagName}>
                    <div class="settings-storage-actions">
                        <button class="settings-storage-manage-button" type="button">Manage</button>
                    </div>
                </div>
            `
            : '';

        const streakAndBadgesHtml = this.#activeTab === settingsMenus.PROFILE
            ? this.#renderStreakAndBadgesHtml()
            : '';

        const achievementsHtml = this.#activeTab === settingsMenus.PROFILE
            ? this.#renderAchievementsAndLeaderboardHtml()
            : '';

        const promoRedeemHtml = this.#activeTab === settingsMenus.PROFILE
            ? `
                <div class="settings-promo-redeem">
                    <h3 class="settings-promo-redeem-title">Redeem a promo code</h3>
                    <div class="settings-promo-redeem-row">
                        <input class="settings-promo-redeem-input" type="text" placeholder="Enter promo code" autocomplete="off">
                        <button class="settings-promo-redeem-button" type="button">Redeem</button>
                    </div>
                    <div class="settings-promo-redeem-result" data-role="promo-result"></div>
                </div>
            `
            : '';

        const dangerZoneHtml = this.#activeTab === settingsMenus.PROFILE
            ? `
                <div class="settings-danger-zone">
                    <h3 class="settings-danger-zone-title">Danger Zone</h3>
                    <div class="settings-danger-zone-row">
                        <div class="settings-danger-zone-description">
                            <strong>Clear all server data</strong>
                            <span>Permanently deletes every deck, card, study material, mock test and sync record for your account from CogniumLearn's servers. Other devices will lose this data on next sync. Your account stays active.</span>
                        </div>
                        <button class="settings-clear-server-data-button" type="button">Clear All Server Data</button>
                    </div>
                    <div class="settings-danger-zone-row">
                        <div class="settings-danger-zone-description">
                            <strong>Delete account</strong>
                            <span>Permanently deletes your CogniumLearn account and every record tied to it — decks, cards, study materials, mock tests and sync history — and signs you out of every device. <strong>You will lose everything, including all paid content: purchased decks, their licenses and your access are revoked with no refund and cannot be recovered.</strong> This is irreversible and cannot be undone.</span>
                        </div>
                        <button class="settings-delete-account-button" type="button">Delete Account</button>
                    </div>
                </div>
            `
            : '';

        this.querySelector('.settings-content').innerHTML = rowsHtml + storageMeterHtml + promoRedeemHtml + streakAndBadgesHtml + achievementsHtml + dangerZoneHtml;

        const promoRedeemButton = this.querySelector('.settings-promo-redeem-button');
        if(promoRedeemButton)
        {
            promoRedeemButton.addEventListener('click', () => this.#handleRedeemPromoClick());
            const promoRedeemInput = this.querySelector('.settings-promo-redeem-input');
            promoRedeemInput.addEventListener('keydown', (keyEvent) =>
            {
                if (keyEvent.key === 'Enter')
                {
                    this.#handleRedeemPromoClick();
                }
            });
        }

        const clearServerDataButton = this.querySelector('.settings-clear-server-data-button');
        if(clearServerDataButton)
        {
            clearServerDataButton.addEventListener('click', () => this.#handleClearServerDataClick());
        }

        const deleteAccountButton = this.querySelector('.settings-delete-account-button');
        if(deleteAccountButton)
        {
            deleteAccountButton.addEventListener('click', () => this.#handleDeleteAccountClick());
        }

        const refreshButton = this.querySelector('.settings-refresh-button');
        if(refreshButton)
        {
            refreshButton.addEventListener('click', () => this.#handleRefreshClick(refreshButton));
        }

        const storageManageButton = this.querySelector('.settings-storage-manage-button');
        if(storageManageButton)
        {
            storageManageButton.addEventListener('click', () => StorageManagerDialog.show(() => this.#refreshStorageMeter()));
        }

        for (const callToActionButton of this.querySelectorAll('.settings-cta-button'))
        {
            if (parseInt(callToActionButton.dataset.settingKey, 10) === profileSettingKeys.CREDITS)
            {
                callToActionButton.addEventListener('click', () => this.#handleBuyCreditsClick());
            }
        }

        const viewBadgesButton = this.querySelector('.streak-view-badges-button');
        if (viewBadgesButton)
        {
            viewBadgesButton.addEventListener('click', () => BadgeGalleryDialog.show());
        }

        for (const achievementButton of this.querySelectorAll('.achievement-view-badges-button'))
        {
            achievementButton.addEventListener('click', () =>
            {
                BadgeGalleryDialog.showMetricCategory(achievementButton.dataset.category, achievementButton.dataset.title);
            });
        }

        if (this.#activeTab === settingsMenus.PROFILE)
        {
            this.#loadLeaderboardCard();
        }
    }

    #renderAchievementsAndLeaderboardHtml()
    {
        const metrics = MetricBadgeHelper.getMetrics(window["user"]);

        const categoryRowsHtml = MetricBadgeHelper.getCategories().map((category) =>
        {
            const title = enumerationToTitleCase(category);
            const earnedCount = MetricBadgeHelper.getEarnedThresholds(metrics, category).size;
            const totalCount = MetricBadgeHelper.getBadgeList(category).length;
            const countLabel = MetricBadgeHelper.formatCount(metrics, category);
            return `
                <div class="achievement-row">
                    <span class="achievement-row-label">${title}</span>
                    <span class="achievement-row-count">${countLabel} · ${earnedCount}/${totalCount} badges</span>
                    <button class="settings-cta-button achievement-view-badges-button" data-category="${category}" data-title="${title}">View Badges</button>
                </div>
            `;
        }).join('');

        return `
            <div class="settings-achievements-section">
                <h3 class="settings-streak-title">Achievements &amp; Leaderboard</h3>
                <div class="leaderboard-card" data-role="leaderboard-card">
                    <div class="leaderboard-loading">Loading your ranking…</div>
                </div>
                <div class="achievement-rows">${categoryRowsHtml}</div>
            </div>
        `;
    }

    async #loadLeaderboardCard()
    {
        const card = this.querySelector('[data-role="leaderboard-card"]');
        if (!card)
        {
            return;
        }

        let standing;
        try
        {
            const response = await fetch("/Leaderboard/Me", { credentials: "include" });
            if (!response.ok)
            {
                card.innerHTML = `<div class="leaderboard-error">Couldn't load your ranking right now.</div>`;
                return;
            }
            standing = await response.json();
        }
        catch (leaderboardError)
        {
            card.innerHTML = `<div class="leaderboard-error">Couldn't load your ranking right now.</div>`;
            return;
        }

        const topPercent = Number.isFinite(standing.topPercent) ? standing.topPercent : 100;
        const score = Number.isFinite(standing.score) ? standing.score : 0;
        const worldRankHtml = standing.inTopThousand && Number.isFinite(standing.rank)
            ? `<div class="leaderboard-world-rank">🌍 #${standing.rank} in the world</div>`
            : '';

        card.innerHTML = `
            <div class="leaderboard-top-percent">You're in the <strong>top ${topPercent}%</strong> of learners</div>
            ${worldRankHtml}
            <div class="leaderboard-xp">${score} XP</div>
        `;
    }

    #renderStreakAndBadgesHtml()
    {
        const streakState = StreakBadgeHelper.getStreakState(window["user"]);
        const earnedThresholds = StreakBadgeHelper.getEarnedThresholds(streakState);
        const definitions = StreakBadgeHelper.getBadgeDefinitions();

        const dayWord = streakState.current === 1 ? "day" : "days";

        const nextBadge = StreakBadgeHelper.getNextBadge(streakState.current);
        let nextBadgeHtml;
        if (nextBadge)
        {
            const daysAway = nextBadge.streak - streakState.current;
            const daysAwayWord = daysAway === 1 ? "day" : "days";
            // Progress from the previously cleared threshold toward the next one.
            const previousThreshold = definitions
                .filter((definition) => definition.streak <= streakState.current)
                .reduce((highest, definition) => Math.max(highest, definition.streak), 0);
            const span = Math.max(1, nextBadge.streak - previousThreshold);
            const progressPercent = Math.min(100, Math.max(0, Math.round(((streakState.current - previousThreshold) / span) * 100)));
            nextBadgeHtml = `
                <div class="streak-next-badge">
                    <div class="streak-next-badge-label">Next badge: <strong>${nextBadge.name}</strong> in ${daysAway} ${daysAwayWord}</div>
                    <div class="streak-next-progress-track"><div class="streak-next-progress-fill" style="width:${progressPercent}%"></div></div>
                </div>
            `;
        }
        else
        {
            nextBadgeHtml = `<div class="streak-next-badge"><div class="streak-next-badge-label">Every badge earned — legendary. 🎉</div></div>`;
        }

        // When a recoverable lapse is pending for today, prompt the user to
        // study their way back to the prior streak (see StreakManager recovery).
        let recoveryHtml = '';
        const pendingRecovery = streakState.pendingRecovery;
        if (pendingRecovery && pendingRecovery.priorStreak > 0 && pendingRecovery.recoveryDate === StreakBadgeHelper.todayUtcDateString())
        {
            const cardWord = pendingRecovery.requiredCards === 1 ? "card" : "cards";
            recoveryHtml = `
                <div class="streak-recovery-note">
                    ⚠️ Your <strong>${pendingRecovery.priorStreak}</strong>-day streak is at risk. Study <strong>${pendingRecovery.requiredCards}</strong> ${cardWord} today to win it back.
                </div>
            `;
        }

        const earnedCount = earnedThresholds.size;

        return `
            <div class="settings-streak-section">
                <h3 class="settings-streak-title">Streak &amp; Badges</h3>
                <div class="streak-hero">
                    <div class="streak-flame">🔥</div>
                    <div class="streak-hero-numbers">
                        <div class="streak-current">${streakState.current}<span class="streak-current-unit"> ${dayWord}</span></div>
                        <div class="streak-current-caption">Current streak</div>
                    </div>
                    <div class="streak-longest">
                        <div class="streak-longest-value">${streakState.longest}</div>
                        <div class="streak-longest-caption">Highest</div>
                    </div>
                </div>
                ${recoveryHtml}
                ${nextBadgeHtml}
                <div class="streak-badges-summary">
                    <span class="streak-badges-count">${earnedCount} / ${definitions.length} badges earned</span>
                    <button class="settings-cta-button streak-view-badges-button" type="button">View Badges</button>
                </div>
            </div>
        `;
    }

    async #handleBuyCreditsClick()
    {
        const purchased = await CreditPurchaseFlow.run();
        if (purchased)
        {
            // The flow already refreshed window["user"]; repaint the rows so
            // the credits row shows the new balance immediately.
            await this.#loadAndRender();
        }
    }

    async #handleRedeemPromoClick()
    {
        const promoRedeemInput = this.querySelector('.settings-promo-redeem-input');
        const promoRedeemButton = this.querySelector('.settings-promo-redeem-button');
        const resultElement = this.querySelector('[data-role="promo-result"]');

        const codeString = promoRedeemInput.value.trim();
        if (codeString.length === 0)
        {
            resultElement.textContent = "Enter a promo code.";
            resultElement.className = "settings-promo-redeem-result settings-promo-redeem-error";
            return;
        }

        promoRedeemButton.disabled = true;
        resultElement.textContent = "Redeeming…";
        resultElement.className = "settings-promo-redeem-result";

        try
        {
            const response = await fetch("/Profile/RedeemPromoCode",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ codeString: codeString })
            });

            const responseJson = await response.json();

            if (!response.ok || !responseJson.success)
            {
                promoRedeemButton.disabled = false;
                resultElement.textContent = this.#describePromoError(responseJson.error);
                resultElement.className = "settings-promo-redeem-result settings-promo-redeem-error";
                return;
            }

            // Pull the new balance from the server and repaint so the credits
            // row reflects the granted credits immediately.
            const freshUser = await AuthenticationEvents.refreshUserFromServer();
            if (freshUser)
            {
                this.#allSettings.loadFromUser(freshUser);
            }

            this.#renderContent();
            const newResultElement = this.querySelector('[data-role="promo-result"]');
            if (newResultElement)
            {
                newResultElement.textContent = `Redeemed! ${formatCredits(responseJson.creditsGranted)} credits added.`;
                newResultElement.className = "settings-promo-redeem-result settings-promo-redeem-success";
            }
        }
        catch (redeemError)
        {
            console.error("[SettingsPage] Promo redeem failed:", redeemError);
            promoRedeemButton.disabled = false;
            resultElement.textContent = "Could not reach the server. Please try again later.";
            resultElement.className = "settings-promo-redeem-result settings-promo-redeem-error";
        }
    }

    #describePromoError(errorCode)
    {
        const messages =
        {
            [ErrorCodes.PROMO_CODE_NOT_FOUND]: "That promo code does not exist.",
            [ErrorCodes.PROMO_CODE_DISABLED]: "That promo code is no longer active.",
            [ErrorCodes.PROMO_CODE_EXHAUSTED]: "That promo code has been fully redeemed.",
            [ErrorCodes.PROMO_CODE_ALREADY_REDEEMED]: "You have already redeemed this code.",
            [ErrorCodes.INVALID_CODE]: "Enter a valid promo code."
        };
        return messages[errorCode] || "Could not redeem that code.";
    }

    // Re-pull the server-measured storage usage and repaint the meter after the
    // manage dialog deletes something. Uploads free space immediately server-side;
    // deck deletions land via the debounced sync, so the meter may lag a moment
    // for decks while the sync completes — the tree itself updates instantly.
    async #refreshStorageMeter()
    {
        await AuthenticationEvents.refreshUserFromServer();
        const storageMeter = this.querySelector(StorageMeter.tagName);
        if (storageMeter && typeof storageMeter.render === 'function')
        {
            storageMeter.render();
        }
    }

    async #handleRefreshClick(refreshButton)
    {
        refreshButton.disabled = true;
        refreshButton.textContent = "Refreshing…";

        const freshUser = await AuthenticationEvents.refreshUserFromServer();

        if (!freshUser)
        {
            refreshButton.disabled = false;
            refreshButton.innerHTML = "&#x21bb; Refresh";
            await DialogBox.alert("Refresh Failed", "Could not reach the server. The values shown may be out of date.");
            return;
        }

        this.#allSettings.loadFromUser(freshUser);
        this.#renderContent();
    }

    #renderAudioTabContent()
    {
        // The Audio tab embeds its own panel (toggle + volume slider + test),
        // which owns live controls — like the Model and Appearance tabs.
        this.querySelector('.settings-content').innerHTML = `
            <audio-settings-panel></audio-settings-panel>
        `;
    }

    #renderAppearanceTabContent()
    {
        // The Appearance tab embeds its own panel component directly. Inputs
        // here are too heterogeneous (color pickers, gradient editor, font
        // dropdown, zoom slider) for the uniform UserSetting row layout.
        this.querySelector('.settings-content').innerHTML = `
            <appearance-settings-panel></appearance-settings-panel>
        `;
    }

    #renderModelTabContent()
    {
        // The "AI" tab. Two labelled rows, each holding a self-managing
        // select: the model tier (<llm-tier-select> → PreferredModelTier)
        // which Free model runs on this device (<local-llm-model-select> →
        // PreferredLocalLlmModel; hides itself unless the hardware can run more
        // than one), and the Ask AI output language (<language-select> →
        // PreferredAskAiLanguage). Both components own their own
        // persistence and cross-component sync (window-level
        // PREFERRED_TIER_CHANGED / PREFERRED_ASK_AI_LANGUAGE_CHANGED
        // events), so picking either here updates the Study text-selection
        // menu and bottom panel live without any explicit wiring on this
        // page.
        this.querySelector('.settings-content').innerHTML = `
            <div class="settings-row settings-model-row">
                <span class="settings-row-label">Model</span>
                <span class="settings-row-value">
                    <llm-tier-select></llm-tier-select>
                </span>
            </div>
            <div class="settings-row settings-local-model-row">
                <span class="settings-row-label">Free model</span>
                <span class="settings-row-value">
                    <local-llm-model-select></local-llm-model-select>
                </span>
            </div>
            <div class="settings-row settings-language-row">
                <span class="settings-row-label">Ask AI language</span>
                <span class="settings-row-value">
                    <language-select></language-select>
                </span>
            </div>
        `;
    }

    async #handleClearServerDataClick()
    {
        const confirmed = await DialogBox.confirm
        (
            "Permanently delete all your server data?",
            "This wipes every deck, card, study material, mock test and sync record for your account from CogniumLearn's servers. Other devices will lose this data on next sync. Your account itself stays active. This cannot be undone."
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

    async #handleDeleteAccountClick()
    {
        const confirmed = await DialogBox.confirm
        (
            "Permanently delete your account?",
            "WARNING: You will lose EVERYTHING. This deletes your CogniumLearn account and every record tied to it — decks, cards, study materials, mock tests and sync history — from CogniumLearn's servers, and signs you out of every device.<br><br>This INCLUDES all paid content: any decks you have purchased, their licenses and your access to them will be permanently revoked. You will NOT be refunded and you will NOT be able to recover or re-download purchased content. This is irreversible and cannot be undone."
        );

        if(!confirmed)
        {
            return;
        }

        // Typed confirmation — the user must spell out the exact phrase before
        // the irreversible delete fires. A plain OK/Cancel is too easy to
        // dismiss by reflex for an action this destructive.
        const typedConfirmation = await DialogBox.prompt
        (
            "Type DELETE MY ACCOUNT to confirm",
            "Enter the phrase DELETE MY ACCOUNT (uppercase) to permanently delete your account."
        );

        if(typedConfirmation !== "DELETE MY ACCOUNT")
        {
            await DialogBox.alert("Cancelled", "Confirmation text did not match. Your account was not deleted.");
            return;
        }

        try
        {
            const deleteResponse = await fetch("/Auth/DeleteAccount", { method: "POST", credentials: "same-origin" });

            if(!deleteResponse.ok)
            {
                await DialogBox.alert("Failed", `Server returned ${deleteResponse.status}. Your account may not have been deleted. Please try again later.`);
                return;
            }
        }
        catch(networkError)
        {
            console.error("[SettingsPage] Delete account request failed:", networkError);
            await DialogBox.alert("Failed", "Could not reach the server. Your account was not deleted. Please try again later.");
            return;
        }

        // The account and its sessions are gone server-side and the sessionId
        // cookie has been cleared. Wipe this device's local copy too so no
        // orphaned decks/progress linger, then hard-reload — the next boot
        // lands on the sign-in screen because the cookie is dead.
        try
        {
            await Persistence.reset();
        }
        catch(resetError)
        {
            console.error("[SettingsPage] Local data wipe after account deletion failed:", resetError);
        }

        try
        {
            sessionStorage.clear();
        }
        catch(storageError)
        {
            console.error("[SettingsPage] sessionStorage clear after account deletion failed:", storageError);
        }

        await DialogBox.alert("Account deleted", "Your account and all associated data have been permanently deleted. You will now be signed out.");

        window.location.reload();
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
