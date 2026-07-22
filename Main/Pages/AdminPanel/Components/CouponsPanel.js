import AdminListView from "../../../CommonComponents/AdminListView.js";
import DialogBox from "../../../CommonComponents/DialogBox.js";
import ErrorCodes from "../../../Globals/Constants/ErrorCodes.js";
import PlanMetadataConstants from "../../../Globals/Constants/PlanMetadataConstants.js";
import { adminListTypes } from "../../../Globals/Enumerations/AdminListTypes.js";
import { couponBenefitTargets } from "../../../Globals/Enumerations/CouponBenefitTargets.js";
import { couponBenefitKinds } from "../../../Globals/Enumerations/CouponBenefitKinds.js";
import { billingCycleUnits } from "../../../Globals/Enumerations/BillingCycleUnits.js";
import { planTiers } from "../../../Globals/Enumerations/PlanTiers.js";

/**
 * CouponsPanel  <coupons-panel>
 *
 * The Coupons admin tab. One benefit editor (target / kind / value / target
 * plan or deck / durations) feeds two create actions: a single exact code, or a
 * batch from a base (BASE1, BASE2, …). All coupons are listed through the
 * generic AdminListView with enable/disable, delete, and view-redeemers.
 */
class CouponsPanel extends HTMLElement
{
    #listView = null;

    connectedCallback()
    {
        this.innerHTML = `
            <style>
                coupons-panel { display: block; }
                .coupon-card
                {
                    border-radius: 12px;
                    outline: 1px solid var(--outline-color-subtle);
                    outline-offset: -1px;
                    background-color: var(--secondary-background-color);
                    padding: 16px;
                    margin-bottom: 20px;
                }
                .coupon-card h3 { margin: 0 0 12px; font-size: 15px; }
                .coupon-grid
                {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
                    gap: 12px;
                }
                .coupon-field { display: flex; flex-direction: column; gap: 4px; }
                .coupon-field label { font-size: 12px; color: var(--secondary-text-color); }
                .coupon-field input, .coupon-field select
                {
                    padding: 8px 12px;
                    border-radius: 8px;
                    border: none;
                    outline: 1px solid var(--outline-color);
                    outline-offset: -1px;
                    background-color: var(--tertiary-background-color);
                    color: var(--primary-text-color);
                }
                .coupon-duration { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
                .coupon-actions-row { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 16px; align-items: flex-end; }
                .coupon-create-button
                {
                    padding: 9px 16px;
                    border-radius: 8px;
                    border: none;
                    background: var(--primary-background-gradient);
                    color: var(--primary-text-color);
                    font-weight: 600;
                    cursor: pointer;
                }
                .coupon-result { margin-top: 10px; font-size: 12px; min-height: 16px; }
                .coupon-result-error { color: var(--danger-text-color); }
                .coupon-result-success { color: var(--success-text-color); }
                .coupon-list-heading { margin: 0 0 12px; font-size: 15px; }
            </style>

            <div class="coupon-card">
                <h3>Coupon benefit</h3>
                <div class="coupon-grid">
                    <div class="coupon-field">
                        <label>What it does</label>
                        <select data-role="target">
                            <option value="${couponBenefitTargets.CREDIT_PURCHASE_DISCOUNT}">Discount a credit purchase</option>
                            <option value="${couponBenefitTargets.PLAN_DISCOUNT}">Discount a plan (Razorpay offer)</option>
                            <option value="${couponBenefitTargets.GRANT_CREDITS}">Grant free credits</option>
                            <option value="${couponBenefitTargets.GRANT_FREE_PLAN}">Grant a free plan</option>
                            <option value="${couponBenefitTargets.GRANT_FREE_DECK}">Grant a free deck</option>
                        </select>
                    </div>
                    <div class="coupon-field" data-show="kind">
                        <label>Discount kind</label>
                        <select data-role="kind">
                            <option value="${couponBenefitKinds.PERCENTAGE}">Percentage off</option>
                            <option value="${couponBenefitKinds.FIXED_AMOUNT}">Fixed amount off (minor units)</option>
                            <option value="${couponBenefitKinds.FULL_FREE}">Make it free</option>
                        </select>
                    </div>
                    <div class="coupon-field" data-show="value">
                        <label data-role="value-label">Value</label>
                        <input type="number" data-role="value" min="0" value="0">
                    </div>
                    <div class="coupon-field" data-show="plan">
                        <label>Target plan</label>
                        <select data-role="plan"></select>
                    </div>
                    <div class="coupon-field" data-show="deck">
                        <label>Target deck id</label>
                        <input type="text" data-role="deck" placeholder="deck id">
                    </div>
                    <div class="coupon-field" data-show="offer">
                        <label>Razorpay offer id</label>
                        <input type="text" data-role="offer" placeholder="offer_...">
                    </div>
                    <div class="coupon-field">
                        <label>Max redemptions</label>
                        <input type="number" data-role="max" min="1" value="1">
                    </div>
                    <div class="coupon-field">
                        <label>Redeemable for (0 = no expiry)</label>
                        <div class="coupon-duration">
                            <input type="number" data-role="window-value" min="0" value="0">
                            <select data-role="window-unit">
                                <option value="${billingCycleUnits.DAY}">Days</option>
                                <option value="${billingCycleUnits.MONTH}">Months</option>
                                <option value="${billingCycleUnits.YEAR}">Years</option>
                            </select>
                        </div>
                    </div>
                    <div class="coupon-field" data-show="span">
                        <label>Benefit lasts</label>
                        <div class="coupon-duration">
                            <input type="number" data-role="span-value" min="0" value="1">
                            <select data-role="span-unit">
                                <option value="${billingCycleUnits.DAY}">Days</option>
                                <option value="${billingCycleUnits.MONTH}" selected>Months</option>
                                <option value="${billingCycleUnits.YEAR}">Years</option>
                            </select>
                        </div>
                    </div>
                </div>

                <div class="coupon-actions-row">
                    <div class="coupon-field">
                        <label>Single code</label>
                        <input type="text" data-role="single-code" placeholder="e.g. WELCOME50">
                    </div>
                    <button class="coupon-create-button" data-role="single-create">Create code</button>
                    <div class="coupon-field">
                        <label>Bulk base</label>
                        <input type="text" data-role="bulk-base" placeholder="e.g. LAUNCH">
                    </div>
                    <div class="coupon-field">
                        <label>How many</label>
                        <input type="number" data-role="bulk-count" min="1" value="10">
                    </div>
                    <button class="coupon-create-button" data-role="bulk-create">Create batch</button>
                </div>
                <div class="coupon-result" data-role="result"></div>
            </div>

            <h3 class="coupon-list-heading">Coupons</h3>
            <div data-role="list-host"></div>
        `;

        this.#populatePlanOptions();
        this.#bind();
        this.#applyVisibility();
        this.#mountListView();
    }

    #populatePlanOptions()
    {
        const planSelect = this.querySelector('[data-role="plan"]');
        // Only paid tiers are grantable / discountable.
        for (const tierName of PlanMetadataConstants.ORDER)
        {
            const tierValue = planTiers[tierName];
            if (tierValue === planTiers.FREE)
            {
                continue;
            }
            const option = document.createElement("option");
            option.value = String(tierValue);
            option.textContent = PlanMetadataConstants[tierName].label;
            planSelect.appendChild(option);
        }
    }

    #bind()
    {
        this.querySelector('[data-role="target"]').addEventListener("change", () => this.#applyVisibility());
        this.querySelector('[data-role="single-create"]').addEventListener("click", () => this.#create(false));
        this.querySelector('[data-role="bulk-create"]').addEventListener("click", () => this.#create(true));
    }

    // Shows only the fields that matter for the chosen benefit target.
    #applyVisibility()
    {
        const target = Number(this.querySelector('[data-role="target"]').value);
        const isDiscount = target === couponBenefitTargets.CREDIT_PURCHASE_DISCOUNT || target === couponBenefitTargets.PLAN_DISCOUNT;
        const isPlanTarget = target === couponBenefitTargets.PLAN_DISCOUNT || target === couponBenefitTargets.GRANT_FREE_PLAN;
        const visibility =
        {
            kind: isDiscount,
            value: target === couponBenefitTargets.CREDIT_PURCHASE_DISCOUNT || target === couponBenefitTargets.GRANT_CREDITS || target === couponBenefitTargets.PLAN_DISCOUNT,
            plan: isPlanTarget,
            deck: target === couponBenefitTargets.GRANT_FREE_DECK,
            offer: target === couponBenefitTargets.PLAN_DISCOUNT,
            span: target === couponBenefitTargets.GRANT_FREE_PLAN || target === couponBenefitTargets.GRANT_FREE_DECK
        };
        for (const [key, isVisible] of Object.entries(visibility))
        {
            const element = this.querySelector(`[data-show="${key}"]`);
            if (element)
            {
                element.style.display = isVisible ? "" : "none";
            }
        }
        const valueLabel = this.querySelector('[data-role="value-label"]');
        valueLabel.textContent = target === couponBenefitTargets.GRANT_CREDITS ? "Credits to grant" : "Value";
    }

    #collectBenefitFields()
    {
        // benefitKind only matters for a discount target (the kind <select> is
        // hidden for grants). For a grant, send FIXED_AMOUNT so the stored kind
        // is never a misleading PERCENTAGE that the API would range-check.
        const benefitTarget = Number(this.querySelector('[data-role="target"]').value);
        const targetIsDiscount = benefitTarget === couponBenefitTargets.CREDIT_PURCHASE_DISCOUNT
            || benefitTarget === couponBenefitTargets.PLAN_DISCOUNT;
        return {
            benefitTarget: benefitTarget,
            benefitKind: targetIsDiscount ? Number(this.querySelector('[data-role="kind"]').value) : couponBenefitKinds.FIXED_AMOUNT,
            benefitValue: Number(this.querySelector('[data-role="value"]').value) || 0,
            targetPlanTier: this.querySelector('[data-role="plan"]').value !== "" ? Number(this.querySelector('[data-role="plan"]').value) : null,
            targetDeckId: this.querySelector('[data-role="deck"]').value.trim() || null,
            providerOfferId: this.querySelector('[data-role="offer"]').value.trim() || null,
            maxRedemptions: parseInt(this.querySelector('[data-role="max"]').value, 10),
            redemptionWindowDurationValue: parseInt(this.querySelector('[data-role="window-value"]').value, 10) || 0,
            redemptionWindowDurationUnit: Number(this.querySelector('[data-role="window-unit"]').value),
            benefitSpanValue: parseInt(this.querySelector('[data-role="span-value"]').value, 10) || 0,
            benefitSpanUnit: Number(this.querySelector('[data-role="span-unit"]').value)
        };
    }

    async #create(isBulk)
    {
        const resultElement = this.querySelector('[data-role="result"]');
        const fields = this.#collectBenefitFields();

        if (isNaN(fields.maxRedemptions) || fields.maxRedemptions < 1)
        {
            this.#showResult(resultElement, "Max redemptions must be at least 1.", false);
            return;
        }

        let url;
        let payload;
        if (isBulk)
        {
            const baseString = this.querySelector('[data-role="bulk-base"]').value.trim();
            const count = parseInt(this.querySelector('[data-role="bulk-count"]').value, 10);
            if (baseString.length === 0 || isNaN(count) || count < 1)
            {
                this.#showResult(resultElement, "Enter a base and a count of at least 1.", false);
                return;
            }
            url = "/Admin/Coupons/CreateBulk";
            payload = { ...fields, baseString: baseString, count: count };
        }
        else
        {
            const codeString = this.querySelector('[data-role="single-code"]').value.trim();
            if (codeString.length === 0)
            {
                this.#showResult(resultElement, "Enter a code.", false);
                return;
            }
            url = "/Admin/Coupons/Create";
            payload = { ...fields, codeString: codeString };
        }

        try
        {
            const response = await fetch(url,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify(payload)
            });
            const responseJson = await response.json();
            if (!response.ok || !responseJson.success)
            {
                this.#showResult(resultElement, this.#describeError(responseJson.error), false);
                return;
            }

            if (isBulk)
            {
                const skippedNote = responseJson.skipped.length > 0 ? ` ${responseJson.skipped.length} skipped.` : "";
                this.#showResult(resultElement, `Created ${responseJson.created.length} coupons.${skippedNote}`, true);
            }
            else
            {
                this.#showResult(resultElement, `Created ${responseJson.coupon.codeString}.`, true);
                this.querySelector('[data-role="single-code"]').value = "";
            }
            this.#listView.refresh();
        }
        catch (createError)
        {
            console.error("[CouponsPanel] Create failed:", createError);
            this.#showResult(resultElement, "Request failed.", false);
        }
    }

    #mountListView()
    {
        const host = this.querySelector('[data-role="list-host"]');
        this.#listView = document.createElement("admin-list-view");
        host.appendChild(this.#listView);
        this.#listView.configure
        ({
            listKey: adminListTypes.COUPONS,
            rowActions: (row) =>
            [
                { actionKey: "toggle", label: row.enabled ? "Disable" : "Enable" },
                { actionKey: "redeemers", label: "View redeemers" },
                { actionKey: "delete", label: "Delete" }
            ],
            onRowAction: (actionKey, rowId, row) => this.#handleRowAction(actionKey, rowId, row)
        });
    }

    async #handleRowAction(actionKey, rowId, row)
    {
        if (actionKey === "toggle")
        {
            await this.#postAction("/Admin/Coupons/SetEnabled", { couponId: rowId, enabled: !row.enabled });
        }
        else if (actionKey === "delete")
        {
            const confirmed = await DialogBox.confirm("Delete coupon", `Delete ${row.codeString}? Past redemptions are kept but the code can no longer be used. Benefits already granted are not reversed.`);
            if (confirmed)
            {
                await this.#postAction("/Admin/Coupons/Delete", { couponId: rowId });
            }
        }
        else if (actionKey === "redeemers")
        {
            this.#openRedeemersDialog(rowId, row);
        }
    }

    async #postAction(url, payload)
    {
        try
        {
            const response = await fetch(url,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify(payload)
            });
            if (!response.ok)
            {
                const responseJson = await response.json();
                await DialogBox.alert("Coupon", this.#describeError(responseJson.error));
                return;
            }
            this.#listView.refresh();
        }
        catch (actionError)
        {
            console.error("[CouponsPanel] Action failed:", actionError);
            await DialogBox.alert("Coupon", "Request failed.");
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
            listKey: adminListTypes.COUPON_REDEEMERS,
            requestContext: { couponId: rowId }
        });
    }

    #showResult(element, message, isSuccess)
    {
        element.textContent = message;
        element.className = `coupon-result ${isSuccess ? "coupon-result-success" : "coupon-result-error"}`;
    }

    #describeError(errorCode)
    {
        const messages =
        {
            [ErrorCodes.COUPON_ALREADY_EXISTS]: "That code already exists.",
            [ErrorCodes.INVALID_CODE]: "Invalid code.",
            [ErrorCodes.INVALID_COUNT]: "Invalid count or max redemptions.",
            [ErrorCodes.INVALID_BENEFIT_TARGET]: "Choose what the coupon does.",
            [ErrorCodes.INVALID_BENEFIT_KIND]: "Choose a discount kind.",
            [ErrorCodes.INVALID_BENEFIT_VALUE]: "Enter a valid value (percentage 0–100).",
            [ErrorCodes.INVALID_PLAN_TIER]: "Choose a valid paid plan.",
            [ErrorCodes.INVALID_DURATION_UNIT]: "Choose a duration unit.",
            [ErrorCodes.INVALID_DURATION_VALUE]: "A granted plan needs a benefit duration.",
            [ErrorCodes.MISSING_DECK_ID]: "Enter the deck id to grant.",
            [ErrorCodes.COUPON_NOT_FOUND]: "Coupon not found."
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

customElements.define("coupons-panel", CouponsPanel);
export default CouponsPanel;
