import AdminListView from "../../../CommonComponents/AdminListView.js";
import DialogBox from "../../../CommonComponents/DialogBox.js";
import ErrorCodes from "../../../Globals/Constants/ErrorCodes.js";
import { adminListTypes } from "../../../Globals/Enumerations/AdminListTypes.js";

/**
 * PromoCodesPanel  <promo-codes-panel>
 *
 * The PROMO_CODES sub-section of the admin Credits tab. Lets the admin mint a
 * single exact code or a batch from a base (BASE1, BASE2, …), then lists all
 * codes (with live used / remaining counts) through the generic AdminListView.
 * Each row can be enabled/disabled, deleted, or drilled into to see exactly
 * who redeemed it.
 */
class PromoCodesPanel extends HTMLElement
{
    #listView = null;

    connectedCallback()
    {
        this.innerHTML = `
            <style>
                promo-codes-panel { display: block; }

                .promo-create-grid
                {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
                    gap: 16px;
                    margin-bottom: 24px;
                }

                .promo-create-card
                {
                    border-radius: 12px;
                    outline: 1px solid var(--outline-color-subtle);
                    outline-offset: -1px;
                    background-color: var(--secondary-background-color);
                    padding: 16px;
                }

                .promo-create-card h3
                {
                    margin: 0 0 4px;
                    font-size: 15px;
                }

                .promo-create-card p
                {
                    margin: 0 0 12px;
                    font-size: 12px;
                    color: var(--secondary-text-color);
                }

                .promo-field
                {
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                    margin-bottom: 10px;
                }

                .promo-field label
                {
                    font-size: 12px;
                    color: var(--secondary-text-color);
                }

                .promo-field input
                {
                    padding: 8px 12px;
                    border-radius: 8px;
                    border: none;
                    outline: 1px solid var(--outline-color);
                    outline-offset: -1px;
                    background-color: var(--tertiary-background-color);
                    color: var(--primary-text-color);
                }

                .promo-create-button
                {
                    padding: 9px 16px;
                    border-radius: 8px;
                    border: none;
                    background: var(--primary-background-gradient);
                    color: var(--primary-text-color);
                    font-weight: 600;
                    cursor: pointer;
                }

                .promo-result
                {
                    margin-top: 10px;
                    font-size: 12px;
                    min-height: 16px;
                }

                .promo-result-error { color: var(--danger-text-color); }
                .promo-result-success { color: var(--success-text-color); }

                .promo-list-heading
                {
                    margin: 0 0 12px;
                    font-size: 15px;
                }
            </style>

            <div class="promo-create-grid">
                <div class="promo-create-card">
                    <h3>Create a single code</h3>
                    <p>The exact code you type becomes the promo code (stored uppercase).</p>
                    <div class="promo-field">
                        <label>Code</label>
                        <input type="text" data-role="single-code" placeholder="e.g. WELCOME">
                    </div>
                    <div class="promo-field">
                        <label>Max redemptions</label>
                        <input type="number" data-role="single-max" min="1" value="1">
                    </div>
                    <button class="promo-create-button" data-role="single-create">Create code</button>
                    <div class="promo-result" data-role="single-result"></div>
                </div>

                <div class="promo-create-card">
                    <h3>Create multiple codes</h3>
                    <p>A base with the count appended: base "LAUNCH", count 3 → LAUNCH1, LAUNCH2, LAUNCH3.</p>
                    <div class="promo-field">
                        <label>Base</label>
                        <input type="text" data-role="bulk-base" placeholder="e.g. LAUNCH">
                    </div>
                    <div class="promo-field">
                        <label>How many codes</label>
                        <input type="number" data-role="bulk-count" min="1" value="10">
                    </div>
                    <div class="promo-field">
                        <label>Max redemptions (each)</label>
                        <input type="number" data-role="bulk-max" min="1" value="1">
                    </div>
                    <button class="promo-create-button" data-role="bulk-create">Create codes</button>
                    <div class="promo-result" data-role="bulk-result"></div>
                </div>
            </div>

            <h3 class="promo-list-heading">Promo codes</h3>
            <div data-role="list-host"></div>
        `;

        this.#bindCreateForms();
        this.#mountListView();
    }

    #bindCreateForms()
    {
        this.querySelector('[data-role="single-create"]').addEventListener("click", () => this.#createSingle());
        this.querySelector('[data-role="bulk-create"]').addEventListener("click", () => this.#createBulk());
    }

    #mountListView()
    {
        const host = this.querySelector('[data-role="list-host"]');
        this.#listView = document.createElement("admin-list-view");
        host.appendChild(this.#listView);

        this.#listView.configure
        ({
            listKey: adminListTypes.PROMO_CODES,
            rowActions: (row) =>
            [
                { actionKey: "toggle", label: row.enabled ? "Disable" : "Enable" },
                { actionKey: "redeemers", label: "View redeemers" },
                { actionKey: "delete", label: "Delete" }
            ],
            onRowAction: (actionKey, rowId, row) => this.#handleRowAction(actionKey, rowId, row)
        });
    }

    async #createSingle()
    {
        const codeInput = this.querySelector('[data-role="single-code"]');
        const maxInput = this.querySelector('[data-role="single-max"]');
        const resultElement = this.querySelector('[data-role="single-result"]');

        const codeString = codeInput.value.trim();
        const maxRedemptions = parseInt(maxInput.value, 10);

        if (codeString.length === 0)
        {
            this.#showResult(resultElement, "Enter a code.", false);
            return;
        }

        if (isNaN(maxRedemptions) || maxRedemptions < 1)
        {
            this.#showResult(resultElement, "Max redemptions must be at least 1.", false);
            return;
        }

        try
        {
            const response = await fetch("/Admin/Credits/Promo/Create",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ codeString: codeString, maxRedemptions: maxRedemptions })
            });

            const responseJson = await response.json();
            if (!response.ok || !responseJson.success)
            {
                this.#showResult(resultElement, this.#describeError(responseJson.error), false);
                return;
            }

            this.#showResult(resultElement, `Created ${responseJson.promoCode.codeString}.`, true);
            codeInput.value = "";
            this.#listView.refresh();
        }
        catch (createError)
        {
            console.error("[PromoCodesPanel] Single create failed:", createError);
            this.#showResult(resultElement, "Request failed.", false);
        }
    }

    async #createBulk()
    {
        const baseInput = this.querySelector('[data-role="bulk-base"]');
        const countInput = this.querySelector('[data-role="bulk-count"]');
        const maxInput = this.querySelector('[data-role="bulk-max"]');
        const resultElement = this.querySelector('[data-role="bulk-result"]');

        const baseString = baseInput.value.trim();
        const count = parseInt(countInput.value, 10);
        const maxRedemptions = parseInt(maxInput.value, 10);

        if (baseString.length === 0)
        {
            this.#showResult(resultElement, "Enter a base.", false);
            return;
        }

        if (isNaN(count) || count < 1)
        {
            this.#showResult(resultElement, "Count must be at least 1.", false);
            return;
        }

        if (isNaN(maxRedemptions) || maxRedemptions < 1)
        {
            this.#showResult(resultElement, "Max redemptions must be at least 1.", false);
            return;
        }

        try
        {
            const response = await fetch("/Admin/Credits/Promo/CreateBulk",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ baseString: baseString, count: count, maxRedemptions: maxRedemptions })
            });

            const responseJson = await response.json();
            if (!response.ok || !responseJson.success)
            {
                this.#showResult(resultElement, this.#describeError(responseJson.error), false);
                return;
            }

            const createdCount = responseJson.created.length;
            const skippedCount = responseJson.skipped.length;
            const skippedNote = skippedCount > 0 ? ` ${skippedCount} skipped (already existed).` : "";
            this.#showResult(resultElement, `Created ${createdCount} code${createdCount === 1 ? "" : "s"}.${skippedNote}`, true);
            this.#listView.refresh();
        }
        catch (createError)
        {
            console.error("[PromoCodesPanel] Bulk create failed:", createError);
            this.#showResult(resultElement, "Request failed.", false);
        }
    }

    async #handleRowAction(actionKey, rowId, row)
    {
        if (actionKey === "toggle")
        {
            await this.#toggleEnabled(rowId, row);
        }
        else if (actionKey === "delete")
        {
            await this.#deleteCode(rowId, row);
        }
        else if (actionKey === "redeemers")
        {
            this.#openRedeemersDialog(rowId, row);
        }
    }

    async #toggleEnabled(rowId, row)
    {
        try
        {
            const response = await fetch("/Admin/Credits/Promo/SetEnabled",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ promoCodeId: rowId, enabled: !row.enabled })
            });

            if (!response.ok)
            {
                const responseJson = await response.json();
                await DialogBox.alert("Promo code", this.#describeError(responseJson.error));
                return;
            }

            this.#listView.refresh();
        }
        catch (toggleError)
        {
            console.error("[PromoCodesPanel] Toggle failed:", toggleError);
            await DialogBox.alert("Promo code", "Request failed.");
        }
    }

    async #deleteCode(rowId, row)
    {
        const confirmed = await DialogBox.confirm("Delete promo code", `Delete ${row.codeString}? Past redemptions are kept but the code can no longer be used. Credits already granted are not reversed.`);
        if (!confirmed)
        {
            return;
        }

        try
        {
            const response = await fetch("/Admin/Credits/Promo/Delete",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ promoCodeId: rowId })
            });

            if (!response.ok)
            {
                const responseJson = await response.json();
                await DialogBox.alert("Promo code", this.#describeError(responseJson.error));
                return;
            }

            this.#listView.refresh();
        }
        catch (deleteError)
        {
            console.error("[PromoCodesPanel] Delete failed:", deleteError);
            await DialogBox.alert("Promo code", "Request failed.");
        }
    }

    #openRedeemersDialog(rowId, row)
    {
        const dialog = DialogBox.modal(`
            <div class="title-section">Redeemers of ${this.#escapeHtml(row.codeString)}</div>
            <div data-role="redeemers-host" style="min-width:min(640px, 80vw); margin-top:12px;"></div>
        `);

        const host = dialog.querySelector('[data-role="redeemers-host"]');
        const redeemersListView = document.createElement("admin-list-view");
        host.appendChild(redeemersListView);
        redeemersListView.configure
        ({
            listKey: adminListTypes.PROMO_CODE_REDEEMERS,
            requestContext: { promoCodeId: rowId }
        });
    }

    #showResult(element, message, isSuccess)
    {
        element.textContent = message;
        element.className = `promo-result ${isSuccess ? "promo-result-success" : "promo-result-error"}`;
    }

    #describeError(errorCode)
    {
        const messages =
        {
            [ErrorCodes.PROMO_CODE_ALREADY_EXISTS]: "That code already exists.",
            [ErrorCodes.INVALID_CODE]: "Invalid code.",
            [ErrorCodes.INVALID_COUNT]: "Invalid count or max redemptions.",
            [ErrorCodes.PROMO_CODE_NOT_FOUND]: "Promo code not found."
        };
        return messages[errorCode] || "Something went wrong.";
    }

    #escapeHtml(value)
    {
        return String(value === null || value === undefined ? "" : value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }
}

customElements.define("promo-codes-panel", PromoCodesPanel);
export default PromoCodesPanel;
