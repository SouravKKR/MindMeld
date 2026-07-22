/**
 * PlanFeaturesPanel  <plan-features-panel>
 *
 * The "Plans" admin tab: a tier × AI-feature matrix that dictates which plan
 * unlocks which feature. Loads the effective matrix (admin override or the
 * built-in defaults) from /Admin/Plans/Features/Get, lets the admin toggle each
 * cell, and saves the whole matrix. The server (PlanEntitlementGate) enforces
 * it; this is the single place to change access without a redeploy.
 */
class PlanFeaturesPanel extends HTMLElement
{
    #tiers = [];
    #tierLabels = {};
    #allFeatures = [];
    #matrix = {};

    connectedCallback()
    {
        this.innerHTML = `
            <style>
                plan-features-panel { display: block; }
                .plan-features-intro { font-size: 13px; color: var(--secondary-text-color); margin: 0 0 16px; }
                .plan-features-table { width: 100%; border-collapse: collapse; }
                .plan-features-table th, .plan-features-table td
                {
                    padding: 10px 12px;
                    text-align: center;
                    border-bottom: 1px solid var(--outline-color-subtle);
                }
                .plan-features-table th:first-child, .plan-features-table td:first-child
                {
                    text-align: left;
                    font-weight: 600;
                }
                .plan-features-save
                {
                    margin-top: 16px;
                    padding: 9px 20px;
                    border-radius: 8px;
                    border: none;
                    background: var(--primary-background-gradient);
                    color: var(--primary-text-color);
                    font-weight: 600;
                    cursor: pointer;
                }
                .plan-features-status { margin-left: 12px; font-size: 12px; }
            </style>
            <p class="plan-features-intro">Tick which AI features each plan tier unlocks. Storage, device and credit allowances are fixed per tier; only feature access is editable here.</p>
            <div data-role="table-host"><div class="admin-panel-loading">Loading…</div></div>
            <div>
                <button class="plan-features-save" data-role="save">Save</button>
                <span class="plan-features-status" data-role="status"></span>
            </div>
        `;

        this.querySelector('[data-role="save"]').addEventListener("click", () => this.#save());
        this.#load();
    }

    #humanizeFeature(featureName)
    {
        return String(featureName)
            .toLowerCase()
            .split("_")
            .map(word => word.length > 0 ? word[0].toUpperCase() + word.slice(1) : word)
            .join(" ")
            .replace("Ai", "AI");
    }

    async #load()
    {
        try
        {
            const response = await fetch("/Admin/Plans/Features/Get", { credentials: "include" });
            const responseJson = await response.json();
            this.#tiers = responseJson.tiers || [];
            this.#tierLabels = responseJson.tierLabels || {};
            this.#allFeatures = responseJson.allFeatures || [];
            this.#matrix = {};
            for (const tierName of this.#tiers)
            {
                this.#matrix[tierName] = new Set(responseJson.featureAccessByTierName?.[tierName] || []);
            }
            this.#renderTable();
        }
        catch (loadError)
        {
            console.error("[PlanFeaturesPanel] Load failed:", loadError);
            this.querySelector('[data-role="table-host"]').innerHTML = `<div class="plan-features-status">Failed to load.</div>`;
        }
    }

    #renderTable()
    {
        const headerCells = this.#tiers.map(tierName => `<th>${this.#tierLabels[tierName] || tierName}</th>`).join("");
        const rows = this.#allFeatures.map(featureName =>
        {
            const cells = this.#tiers.map(tierName =>
            {
                const checked = this.#matrix[tierName].has(featureName) ? "checked" : "";
                return `<td><input type="checkbox" data-tier="${tierName}" data-feature="${featureName}" ${checked}></td>`;
            }).join("");
            return `<tr><td>${this.#humanizeFeature(featureName)}</td>${cells}</tr>`;
        }).join("");

        this.querySelector('[data-role="table-host"]').innerHTML = `
            <table class="plan-features-table">
                <thead><tr><th>Feature</th>${headerCells}</tr></thead>
                <tbody>${rows}</tbody>
            </table>
        `;

        for (const checkbox of this.querySelectorAll('input[type="checkbox"]'))
        {
            checkbox.addEventListener("change", (changeEvent) =>
            {
                const tierName = changeEvent.currentTarget.dataset.tier;
                const featureName = changeEvent.currentTarget.dataset.feature;
                if (changeEvent.currentTarget.checked)
                {
                    this.#matrix[tierName].add(featureName);
                }
                else
                {
                    this.#matrix[tierName].delete(featureName);
                }
            });
        }
    }

    async #save()
    {
        const statusElement = this.querySelector('[data-role="status"]');
        const featureAccessByTierName = {};
        for (const tierName of this.#tiers)
        {
            featureAccessByTierName[tierName] = Array.from(this.#matrix[tierName]);
        }

        try
        {
            const response = await fetch("/Admin/Plans/Features/Save",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ featureAccessByTierName: featureAccessByTierName })
            });
            const responseJson = await response.json();
            statusElement.textContent = (response.ok && responseJson.success) ? "Saved." : "Save failed.";
        }
        catch (saveError)
        {
            console.error("[PlanFeaturesPanel] Save failed:", saveError);
            statusElement.textContent = "Request failed.";
        }
    }
}

customElements.define("plan-features-panel", PlanFeaturesPanel);
export default PlanFeaturesPanel;
