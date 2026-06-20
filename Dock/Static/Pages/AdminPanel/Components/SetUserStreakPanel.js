/**
 * Admin testing tool: set or reset any user's login streak by email or id.
 * POSTs to /Admin/Streak/SetUserStreak (admin-gated). The "Show badge
 * celebration on next launch" checkbox leaves the highest earned badge
 * unacknowledged so its celebration (and tier sound) previews on that user's
 * next launch. Mirrors the admin component pattern (form + fetch + status).
 */
class SetUserStreakPanel extends HTMLElement
{
    connectedCallback()
    {
        this.#render();
    }

    #render()
    {
        this.innerHTML =
        `
            <div class="admin-streak-panel">
                <h2 class="admin-panel-add-title">Set / Reset User Streak</h2>
                <p class="admin-panel-add-subtitle">
                    Testing tool. Set a user's streak directly, or reset it. To preview a
                    badge's celebration + sound, set the matching streak value with the
                    checkbox ticked, then reload as that user.
                </p>
                <label class="admin-panel-add-field">
                    <span>User email or id</span>
                    <input type="text" class="admin-streak-user" placeholder="name@example.com" autocomplete="off">
                </label>
                <label class="admin-panel-add-field">
                    <span>Current streak</span>
                    <input type="number" class="admin-streak-current" min="0" value="0">
                </label>
                <label class="admin-panel-add-field">
                    <span>Highest streak (optional — defaults to current)</span>
                    <input type="number" class="admin-streak-longest" min="0">
                </label>
                <label class="admin-panel-add-field">
                    <span>Last active date (optional — defaults to today)</span>
                    <input type="date" class="admin-streak-last-active">
                </label>
                <label class="admin-panel-add-field admin-panel-add-checkbox">
                    <input type="checkbox" class="admin-streak-celebrate">
                    <span>Show badge celebration on next launch (preview)</span>
                </label>
                <div class="admin-panel-add-actions">
                    <button type="button" class="admin-panel-upload admin-streak-set">Set streak</button>
                    <button type="button" class="admin-panel-upload admin-streak-reset">Reset streak</button>
                </div>
                <div class="admin-streak-status" data-role="status"></div>
            </div>
        `;

        this.querySelector(".admin-streak-set").addEventListener("click", () => this.#submit("set"));
        this.querySelector(".admin-streak-reset").addEventListener("click", () => this.#submit("reset"));
    }

    #setStatus(message, isError)
    {
        const statusElement = this.querySelector('[data-role="status"]');
        statusElement.textContent = message;
        statusElement.classList.toggle("admin-streak-status-error", isError === true);
    }

    async #submit(action)
    {
        const userIdentifier = this.querySelector(".admin-streak-user").value.trim();
        if (userIdentifier.length === 0)
        {
            this.#setStatus("Enter a user email or id.", true);
            return;
        }

        const payload = { userIdentifier: userIdentifier, action: action };

        if (action === "set")
        {
            payload.current = Math.max(0, Math.floor(Number(this.querySelector(".admin-streak-current").value) || 0));

            const longestValue = this.querySelector(".admin-streak-longest").value;
            if (longestValue !== "")
            {
                payload.longest = Math.max(0, Math.floor(Number(longestValue) || 0));
            }

            const lastActiveValue = this.querySelector(".admin-streak-last-active").value;
            if (lastActiveValue)
            {
                payload.lastActiveDate = lastActiveValue;
            }

            payload.celebrateOnNextLaunch = this.querySelector(".admin-streak-celebrate").checked;
        }

        const setButton = this.querySelector(".admin-streak-set");
        const resetButton = this.querySelector(".admin-streak-reset");
        setButton.disabled = true;
        resetButton.disabled = true;
        this.#setStatus("Working…", false);

        try
        {
            const response = await fetch("/Admin/Streak/SetUserStreak",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "same-origin",
                body: JSON.stringify(payload)
            });

            const responseJson = await response.json().catch(() => ({}));

            if (!response.ok || !responseJson.success)
            {
                this.#setStatus(responseJson.error || `Request failed (HTTP ${response.status}).`, true);
                return;
            }

            const streak = responseJson.streak;
            this.#setStatus(`Done — current ${streak.current}, highest ${streak.longest}, last active ${streak.lastActiveDate || "—"}, ${streak.earnedBadges.length} badge(s).`, false);
        }
        catch (submitError)
        {
            this.#setStatus(submitError.message || "Request failed.", true);
        }
        finally
        {
            setButton.disabled = false;
            resetButton.disabled = false;
        }
    }
}

customElements.define("set-user-streak-panel", SetUserStreakPanel);
export default SetUserStreakPanel;
