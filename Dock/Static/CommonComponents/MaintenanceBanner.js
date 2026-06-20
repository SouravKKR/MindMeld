import MaintenanceEvents from "../Globals/Events/MaintenanceEvents.js";
import MaintenanceWindow from "../Globals/Model/MaintenanceWindow.js";
import MaintenanceStatusPoller from "../Globals/Classes/MaintenanceStatusPoller.js";

/**
 * MaintenanceBanner
 *
 * Hidden by default. Shows a prominent notice when maintenance is currently
 * active ("Maintenance is going on, check back at <end time>"), or a softer
 * advance notice when a window is upcoming. Driven by MaintenanceStatusPoller
 * via the STATUS_UPDATED window event. The window listener is bound ONCE
 * (class-static guard) and resolves the live banner element at fire time, per
 * the repo's window-listener convention, so repeated HomePage mounts never
 * accumulate dead closures.
 */
class MaintenanceBanner extends HTMLElement
{
    static #bListenerBound = false;

    static #ensureGlobalListener()
    {
        if (MaintenanceBanner.#bListenerBound)
        {
            return;
        }
        MaintenanceBanner.#bListenerBound = true;

        window.addEventListener(MaintenanceEvents.STATUS_UPDATED, (event) =>
        {
            const banner = document.querySelector("maintenance-banner");
            if (banner)
            {
                banner.applyStatus(event.detail);
            }
        });
    }

    connectedCallback()
    {
        this.style.display = "none";

        MaintenanceBanner.#ensureGlobalListener();
        MaintenanceStatusPoller.start();

        // Render immediately from the last known status, if any.
        const lastStatus = MaintenanceStatusPoller.getLastStatus();
        if (lastStatus)
        {
            this.applyStatus(lastStatus);
        }
    }

    /**
     * @param {{active: object|null, upcoming: Array<object>}} status
     */
    applyStatus(status)
    {
        if (!status)
        {
            this.style.display = "none";
            return;
        }

        const activeWindow = status.active ? MaintenanceWindow.fromJson(status.active) : null;
        if (activeWindow !== null)
        {
            this.#renderActive(activeWindow);
            return;
        }

        const upcomingWindows = Array.isArray(status.upcoming)
            ? status.upcoming.map(window => MaintenanceWindow.fromJson(window)).filter(window => window !== null)
            : [];
        if (upcomingWindows.length > 0)
        {
            this.#renderUpcoming(upcomingWindows[0]);
            return;
        }

        this.style.display = "none";
        this.innerHTML = "";
    }

    #renderActive(window)
    {
        const endText = window.getEndDate() ? window.getEndDate().toLocaleString() : "later";
        const detail = window.getMessage() ? ` ${MaintenanceBanner.#escape(window.getMessage())}` : "";
        this.style.display = "";
        this.innerHTML =
        `
            ${MaintenanceBanner.#styleBlock("active")}
            <div class="maintenance-banner-inner maintenance-banner-active">
                <span class="maintenance-banner-text">
                    <strong>Maintenance is going on.</strong> New AI tasks are paused — check back at <strong>${MaintenanceBanner.#escape(endText)}</strong>.${detail}
                </span>
            </div>
        `;
    }

    #renderUpcoming(window)
    {
        const startText = window.getStartDate() ? window.getStartDate().toLocaleString() : "soon";
        const endText = window.getEndDate() ? window.getEndDate().toLocaleString() : "";
        const rangeText = endText ? `${startText} — ${endText}` : startText;
        this.style.display = "";
        this.innerHTML =
        `
            ${MaintenanceBanner.#styleBlock("upcoming")}
            <div class="maintenance-banner-inner maintenance-banner-upcoming">
                <span class="maintenance-banner-text">
                    <strong>Scheduled maintenance:</strong> AI tasks will be paused during <strong>${MaintenanceBanner.#escape(rangeText)}</strong>. Plan your generations accordingly.
                </span>
            </div>
        `;
    }

    static #styleBlock(variant)
    {
        const accentColor = variant === "active" ? "var(--error-color, #c0392b)" : "var(--accent-color)";
        const backgroundColor = variant === "active" ? "var(--error-background-color, rgba(192,57,43,0.12))" : "var(--accent-background-color)";
        return `
            <style>
                maintenance-banner
                {
                    display: block;
                    margin: 12px 16px 0;
                }
                .maintenance-banner-inner
                {
                    display: flex;
                    align-items: center;
                    gap: 14px;
                    flex-wrap: wrap;
                    padding: 12px 16px;
                    border-radius: 10px;
                    background-color: ${backgroundColor};
                    border: 1px solid ${accentColor};
                }
                .maintenance-banner-text
                {
                    flex: 1 1 240px;
                    font-size: 13px;
                    color: var(--primary-text-color);
                    line-height: 1.4;
                }
            </style>
        `;
    }

    static #escape(text)
    {
        const div = document.createElement("div");
        div.textContent = String(text ?? "");
        return div.innerHTML;
    }
}

customElements.define("maintenance-banner", MaintenanceBanner);
export default MaintenanceBanner;
