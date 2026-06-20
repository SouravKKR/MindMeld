import DialogBox from "../../../CommonComponents/DialogBox.js";
import RegionMetadata from "../RegionMetadata.js";
import { formatCredits } from "../../UtilityFunctions/FormatCredits.js";

/**
 * CreditPurchaseDialog
 *
 * The Buy Credits picker: admin-configured packs (with their server-computed
 * discounted prices) plus a custom quantity field. The totals shown here are
 * display-only — the server reprices at Initiate, and exact-match pack
 * discounts guarantee a clicked pack and a typed identical quantity charge
 * the same amount.
 *
 * Resolves { credits } when the buyer confirms, or null on cancel/close.
 */
class CreditPurchaseDialog
{
    static async show(options)
    {
        if (!options || options.available !== true)
        {
            await DialogBox.alert("Buy Credits", "Credit purchases aren't available yet. Please check back later.");
            return null;
        }

        const minimumCredits = Math.max(options.minimumPurchaseCredits || 1, options.minimumCreditsForCharge || 1, 1);
        const packs = Array.isArray(options.packs) ? options.packs.filter(pack => pack.credits >= minimumCredits) : [];
        const initialCredits = packs.length > 0 ? packs[0].credits : minimumCredits;

        const balanceValue = window["user"]?.getAdditionalData()?.credits;
        const balanceLine = typeof balanceValue === "number"
            ? `<div class="credit-purchase-balance">Current balance: <strong>${formatCredits(balanceValue)}</strong> credits</div>`
            : "";

        // When the buyer's regional currency could not be used (missing FX
        // rate), the server quotes in the base currency instead — say so.
        const regionalCurrency = RegionMetadata.getDisplayCurrency(options.region);
        const baseFallbackNote = regionalCurrency !== options.currency
            ? `<div class="credit-purchase-note">Prices in ${CreditPurchaseDialog.#escape(regionalCurrency)} are unavailable right now, so you'll be charged in ${CreditPurchaseDialog.#escape(options.currency)}.</div>`
            : "";

        const packsHtml = packs.length > 0
            ? `<div class="credit-purchase-packs">
                ${packs.map(pack => `
                    <button type="button" class="credit-purchase-pack" data-pack-credits="${pack.credits}">
                        <span class="credit-purchase-pack-credits">${pack.credits} credits</span>
                        <span class="credit-purchase-pack-price">${CreditPurchaseDialog.#escape(pack.currency)} ${(pack.amountMinor / 100).toFixed(2)}</span>
                        ${pack.discountPercent > 0 ? `<span class="credit-purchase-pack-badge">Save ${pack.discountPercent}%</span>` : ""}
                    </button>
                `).join("")}
            </div>`
            : "";

        const dialogHtml = `
            <style>
                .credit-purchase-title { font-size: 17px; font-weight: 700; margin-bottom: 4px; }
                .credit-purchase-balance { font-size: 13px; color: var(--secondary-text-color); margin-bottom: 14px; }
                .credit-purchase-note
                {
                    font-size: 12.5px;
                    color: var(--secondary-text-color);
                    background-color: var(--tertiary-background-color);
                    border-radius: 6px;
                    padding: 8px 10px;
                    margin-bottom: 12px;
                }
                .credit-purchase-packs
                {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
                    gap: 10px;
                    margin-bottom: 16px;
                }
                .credit-purchase-pack
                {
                    position: relative;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 4px;
                    padding: 14px 10px 12px;
                    border: none;
                    border-radius: 10px;
                    outline: 1px solid var(--outline-color);
                    outline-offset: -1px;
                    background-color: var(--secondary-background-color);
                    color: var(--primary-text-color);
                    cursor: pointer;
                }
                .credit-purchase-pack:hover { background-color: var(--tertiary-background-color); }
                .credit-purchase-pack.selected
                {
                    outline: 2px solid transparent;
                    background: var(--primary-background-gradient);
                }
                .credit-purchase-pack-credits { font-weight: 700; font-size: 14px; }
                .credit-purchase-pack-price { font-size: 12.5px; opacity: 0.85; }
                .credit-purchase-pack-badge
                {
                    position: absolute;
                    top: -8px;
                    right: -6px;
                    padding: 2px 8px;
                    border-radius: 999px;
                    background-color: var(--accent-color);
                    color: var(--primary-background-color);
                    font-size: 10.5px;
                    font-weight: 700;
                }
                .credit-purchase-custom
                {
                    display: flex;
                    align-items: flex-end;
                    gap: 12px;
                    margin-bottom: 14px;
                }
                .credit-purchase-custom label
                {
                    display: flex;
                    flex-direction: column;
                    gap: 6px;
                    font-size: 11px;
                    text-transform: uppercase;
                    letter-spacing: 0.04em;
                    color: var(--secondary-text-color);
                }
                .credit-purchase-quantity
                {
                    width: 140px;
                    padding: 9px 10px;
                    border: none;
                    border-radius: 6px;
                    outline: 1px solid var(--outline-color);
                    outline-offset: -1px;
                    background-color: var(--tertiary-background-color);
                    color: var(--primary-text-color);
                    font-size: 14px;
                }
                .credit-purchase-total { font-size: 15px; margin-bottom: 6px; }
                .credit-purchase-total strong { font-size: 17px; }
                .credit-purchase-hint { font-size: 12px; color: var(--danger-text-color); min-height: 16px; margin-bottom: 10px; }
                .credit-purchase-actions { display: flex; gap: 12px; justify-content: flex-end; }
                .credit-purchase-pay
                {
                    padding: 10px 22px;
                    border: none;
                    border-radius: 8px;
                    background: var(--primary-background-gradient);
                    color: var(--primary-text-color);
                    font-weight: 600;
                    font-size: 14px;
                    cursor: pointer;
                }
                .credit-purchase-pay:disabled { opacity: 0.45; cursor: not-allowed; }
                .credit-purchase-cancel
                {
                    padding: 10px 18px;
                    border: none;
                    border-radius: 8px;
                    outline: 1px solid var(--outline-color-strong);
                    outline-offset: -1px;
                    background: transparent;
                    color: var(--primary-text-color);
                    font-size: 14px;
                    cursor: pointer;
                }
            </style>
            <div class="credit-purchase-title">Buy Credits</div>
            ${balanceLine}
            ${baseFallbackNote}
            ${packsHtml}
            <div class="credit-purchase-custom">
                <label>Credits
                    <input class="credit-purchase-quantity" type="number" step="1" min="${minimumCredits}" value="${initialCredits}">
                </label>
                <div class="credit-purchase-total" data-role="total"></div>
            </div>
            <div class="credit-purchase-hint" data-role="hint"></div>
            <div class="credit-purchase-actions">
                <button type="button" class="credit-purchase-cancel">Cancel</button>
                <button type="button" class="credit-purchase-pay" data-role="pay"></button>
            </div>
        `;

        return await new Promise((resolve) =>
        {
            const dialog = DialogBox.modal(dialogHtml);
            const quantityInput = dialog.querySelector(".credit-purchase-quantity");
            const totalLabel = dialog.querySelector('[data-role="total"]');
            const hintLabel = dialog.querySelector('[data-role="hint"]');
            const payButton = dialog.querySelector('[data-role="pay"]');
            let settled = false;

            const settle = (result) =>
            {
                if (settled)
                {
                    return;
                }
                settled = true;
                resolve(result);
            };

            const evaluateSelection = () =>
            {
                const quantity = parseFloat(quantityInput.value);
                const isValidQuantity = Number.isInteger(quantity) && quantity >= minimumCredits;

                for (const packButton of dialog.querySelectorAll(".credit-purchase-pack"))
                {
                    packButton.classList.toggle("selected", Number(packButton.dataset.packCredits) === quantity);
                }

                if (!isValidQuantity)
                {
                    totalLabel.innerHTML = "";
                    payButton.disabled = true;
                    payButton.textContent = "Pay";
                    hintLabel.textContent = `Enter a whole number of at least ${minimumCredits} credits.`;
                    return;
                }

                // A quantity matching a pack uses the pack's server-computed
                // (discounted) price; anything else is quantity × unit price.
                const matchingPack = packs.find(pack => pack.credits === quantity);
                const totalAmount = matchingPack
                    ? matchingPack.amountMinor / 100
                    : quantity * options.unitPrice;

                totalLabel.innerHTML = `Total: <strong>${CreditPurchaseDialog.#escape(options.currency)} ${totalAmount.toFixed(2)}</strong>`;
                hintLabel.textContent = "";
                payButton.disabled = false;
                payButton.textContent = `Pay ${options.currency} ${totalAmount.toFixed(2)}`;
            };

            for (const packButton of dialog.querySelectorAll(".credit-purchase-pack"))
            {
                packButton.addEventListener("click", () =>
                {
                    quantityInput.value = packButton.dataset.packCredits;
                    evaluateSelection();
                });
            }

            quantityInput.addEventListener("input", evaluateSelection);

            payButton.addEventListener("click", () =>
            {
                const quantity = parseFloat(quantityInput.value);
                if (!Number.isInteger(quantity) || quantity < minimumCredits)
                {
                    return;
                }
                settle({ credits: quantity });
                dialog.close();
            });

            dialog.querySelector(".credit-purchase-cancel").addEventListener("click", () =>
            {
                settle(null);
                dialog.close();
            });

            // The modal's auto-injected close button removes the dialog —
            // treat it as a cancel.
            dialog.querySelector(".close-button").addEventListener("click", () => settle(null));

            evaluateSelection();
        });
    }

    static #escape(text)
    {
        const div = document.createElement("div");
        div.textContent = String(text ?? "");
        return div.innerHTML;
    }
}

export default CreditPurchaseDialog;
