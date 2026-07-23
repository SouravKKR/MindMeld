import { formatBytes } from "../Globals/UtilityFunctions/FormatBytes.js";
import AiFeatureGate from "../Globals/Classes/AiFeatureGate.js";
import PlanMetadataConstants from "../Globals/Constants/PlanMetadataConstants.js";
import { planTiers } from "../Globals/Enumerations/PlanTiers.js";

/**
 * StorageMeter
 *
 * A read-only two-segment bar that shows how much of the user's plan storage
 * allowance is used, split into the two categories the server bills and caps
 * against: DECKS (synced deck / card / study-material / mock-test content) and
 * UPLOADS (uploaded source files). Both share the single plan cap, so the two
 * segments sit end to end inside one track and the remainder is the free space.
 *
 * The live measurement rides the /GetUser payload as window["storageUsage"]
 * (see HandleGetUser + AuthenticationEvents.refreshUserFromServer). This
 * component is deliberately self-reading: SettingsPage re-renders its rows on
 * every server refresh, so a fresh <storage-meter> instance simply reads the
 * latest window value in connectedCallback — no imperative wiring. When the
 * server value is absent (not yet refreshed this session, or the measurement
 * failed) it shows a "Calculating…" state and still resolves the cap from the
 * client plan constants so the label is never blank.
 */
class StorageMeter extends HTMLElement
{
    static tagName = "storage-meter";

    connectedCallback()
    {
        this.render();
    }

    render()
    {
        const usage = this.#resolveUsage();

        if (!usage.measured)
        {
            this.innerHTML = `
                <div class="storage-meter">
                    <div class="storage-meter-header">
                        <span class="storage-meter-title">Storage</span>
                        <span class="storage-meter-summary storage-meter-summary--pending">Calculating…</span>
                    </div>
                    <div class="storage-meter-track"></div>
                </div>
            `;
            return;
        }

        const limitBytes = Math.max(1, usage.limitBytes);
        const decksPercent = (usage.decksBytes / limitBytes) * 100;
        const uploadsPercent = (usage.uploadsBytes / limitBytes) * 100;

        // Clamp the drawn widths so the two segments never overflow the track,
        // even when the account is over quota (uploads yields to whatever space
        // decks leaves). The numeric labels below still report the true bytes.
        const decksWidth = Math.min(100, decksPercent);
        const uploadsWidth = Math.min(Math.max(0, 100 - decksWidth), uploadsPercent);

        const isOverQuota = usage.totalBytes > usage.limitBytes;
        const freeBytes = Math.max(0, usage.limitBytes - usage.totalBytes);
        const usedPercentLabel = Math.round((usage.totalBytes / limitBytes) * 100);

        const remainderHtml = isOverQuota
            ? `<span class="storage-meter-legend-item storage-meter-legend-over">${formatBytes(usage.totalBytes - usage.limitBytes)} over limit</span>`
            : `<span class="storage-meter-legend-item storage-meter-legend-free">${formatBytes(freeBytes)} free</span>`;

        this.innerHTML = `
            <div class="storage-meter">
                <div class="storage-meter-header">
                    <span class="storage-meter-title">Storage</span>
                    <span class="storage-meter-summary${isOverQuota ? ' storage-meter-summary--over' : ''}">${formatBytes(usage.totalBytes)} of ${formatBytes(usage.limitBytes)} used (${usedPercentLabel}%)</span>
                </div>
                <div class="storage-meter-track${isOverQuota ? ' storage-meter-track--over' : ''}">
                    <div class="storage-meter-fill storage-meter-fill--decks" style="width: ${decksWidth}%"></div>
                    <div class="storage-meter-fill storage-meter-fill--uploads" style="width: ${uploadsWidth}%"></div>
                </div>
                <div class="storage-meter-legend">
                    <span class="storage-meter-legend-item"><span class="storage-meter-swatch storage-meter-swatch--decks"></span>Decks ${formatBytes(usage.decksBytes)}</span>
                    <span class="storage-meter-legend-item"><span class="storage-meter-swatch storage-meter-swatch--uploads"></span>Uploads ${formatBytes(usage.uploadsBytes)}</span>
                    ${remainderHtml}
                </div>
            </div>
        `;
    }

    // Reads the live server measurement when present, falling back to a
    // zero-usage view whose cap still comes from the user's plan so the bar and
    // its label render meaningfully before the first refresh completes.
    #resolveUsage()
    {
        const measured = window["storageUsage"];
        const planLimitBytes = this.#planLimitBytes();

        if (!measured || typeof measured !== "object")
        {
            return { decksBytes: 0, uploadsBytes: 0, totalBytes: 0, limitBytes: planLimitBytes, measured: false };
        }

        const decksBytes = Math.max(0, Number(measured.decksBytes) || 0);
        const uploadsBytes = Math.max(0, Number(measured.uploadsBytes) || 0);
        const serverLimit = Number(measured.limitBytes);
        const limitBytes = Number.isFinite(serverLimit) && serverLimit > 0 ? serverLimit : planLimitBytes;

        return { decksBytes: decksBytes, uploadsBytes: uploadsBytes, totalBytes: decksBytes + uploadsBytes, limitBytes: limitBytes, measured: true };
    }

    // The plan storage cap resolved client-side from the current tier — used
    // only as the fallback denominator when the server measurement (which
    // carries the authoritative limit) is not available.
    #planLimitBytes()
    {
        const currentTier = AiFeatureGate.getCurrentPlanTier();
        for (const tierName of Object.keys(planTiers))
        {
            if (planTiers[tierName] === currentTier)
            {
                const metadata = PlanMetadataConstants[tierName];
                const storageBytes = metadata ? Number(metadata.storageBytes) : 0;
                if (Number.isFinite(storageBytes) && storageBytes > 0)
                {
                    return storageBytes;
                }
            }
        }
        return Number(PlanMetadataConstants.FREE.storageBytes) || 0;
    }
}

customElements.define(StorageMeter.tagName, StorageMeter);
export default StorageMeter;
