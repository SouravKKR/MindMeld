import { creditDealPaymentModes } from "../../../Globals/Enumerations/CreditDealPaymentModes.js";
import ZohoPaymentsCheckout from "../../../Globals/Classes/Payments/ZohoPaymentsCheckout.js";

/**
 * DealPaymentEditor  (<deal-payment-editor>)
 *
 * Reusable, non-gating payment + invoice attachment for a deal — used by both
 * the periodic-assignment panel and the fixed-grant panel. The admin picks a
 * mode (None / On-spot / Independent), optionally an amount + label, and
 * optionally an invoice file (PDF / image) that can be uploaded now or left for
 * later. The on-spot mode collects through the active payment provider (Zoho
 * Payments today); the ON_SPOT_RAZORPAY enum value is retained for storage
 * compatibility but is provider-agnostic at the call site.
 *
 * After the PRIMARY entity (assignment or grant) exists, the host calls
 * `submitForTarget(targetType, targetId)`: it creates the deal record, runs
 * the in-page checkout when needed, and uploads any chosen invoice. It never
 * blocks the primary action — a payment failure is reported but the assignment
 * / grant stands.
 */
class DealPaymentEditor extends HTMLElement
{
    static #ALLOWED_INVOICE_TYPES = ".pdf,.png,.jpg,.jpeg,.webp,.gif,application/pdf,image/*";

    connectedCallback()
    {
        this.innerHTML = `
            <style>
                deal-payment-editor { display: block; }
                .deal-editor-grid
                {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
                    gap: 12px 16px;
                }
                .deal-editor-field
                {
                    display: flex;
                    flex-direction: column;
                    gap: 6px;
                    min-width: 0;
                    font-size: 11px;
                    text-transform: uppercase;
                    letter-spacing: 0.04em;
                    color: var(--secondary-text-color);
                }
                .deal-editor-input, .deal-editor-select
                {
                    width: 100%;
                    box-sizing: border-box;
                    padding: 8px 10px;
                    border-radius: 6px;
                    border: none;
                    outline: 1px solid var(--outline-color);
                    outline-offset: -1px;
                    background-color: var(--tertiary-background-color);
                    color: var(--primary-text-color);
                    font-family: inherit;
                    font-size: 13px;
                    text-transform: none;
                    letter-spacing: normal;
                }
                .deal-editor-hint
                {
                    font-size: 12px;
                    color: var(--secondary-text-color);
                    text-transform: none;
                    letter-spacing: normal;
                    margin-top: 6px;
                }
                .deal-editor-field[hidden] { display: none; }
            </style>

            <div class="deal-editor-grid">
                <label class="deal-editor-field">Payment record
                    <select class="deal-editor-select" data-field="mode">
                        <option value="${creditDealPaymentModes.NONE}" selected>None — don't record a payment</option>
                        <option value="${creditDealPaymentModes.ON_SPOT_RAZORPAY}">On-spot — collect via Zoho now</option>
                        <option value="${creditDealPaymentModes.INDEPENDENT}">Independent — record an offline payment</option>
                    </select>
                </label>
                <label class="deal-editor-field" data-role="label-field" hidden>Label (optional)
                    <input class="deal-editor-input" type="text" maxlength="256" data-field="label" placeholder="e.g. Acme annual deal">
                </label>
                <label class="deal-editor-field" data-role="amount-field" hidden>Amount
                    <input class="deal-editor-input" type="number" step="any" min="0" data-field="amount" placeholder="e.g. 5000">
                </label>
                <label class="deal-editor-field" data-role="currency-field" hidden>Currency
                    <input class="deal-editor-input" type="text" maxlength="8" data-field="currency" value="INR">
                </label>
                <label class="deal-editor-field" data-role="invoice-field" hidden>Invoice file (optional, upload now or later)
                    <input class="deal-editor-input" type="file" data-field="invoice" accept="${DealPaymentEditor.#ALLOWED_INVOICE_TYPES}">
                </label>
            </div>
            <div class="deal-editor-hint" data-role="deal-hint" hidden>Recording a payment is bookkeeping only — it never blocks the assignment or grant. You can attach or replace the invoice later from the management list.</div>
        `;

        this.querySelector('[data-field="mode"]').addEventListener("change", () => this.#applyMode());
        this.#applyMode();
    }

    #applyMode()
    {
        // NONE records nothing, so only the mode dropdown is relevant. A real
        // payment mode (on-spot / independent) reveals the label, amount,
        // currency, and the optional invoice attachment.
        const mode = Number(this.querySelector('[data-field="mode"]').value);
        const recordsPayment = mode === creditDealPaymentModes.ON_SPOT_RAZORPAY || mode === creditDealPaymentModes.INDEPENDENT;
        this.querySelector('[data-role="label-field"]').hidden = !recordsPayment;
        this.querySelector('[data-role="amount-field"]').hidden = !recordsPayment;
        this.querySelector('[data-role="currency-field"]').hidden = !recordsPayment;
        this.querySelector('[data-role="invoice-field"]').hidden = !recordsPayment;
        this.querySelector('[data-role="deal-hint"]').hidden = !recordsPayment;
    }

    /** Resets the editor to its default (None) state. */
    reset()
    {
        const modeSelect = this.querySelector('[data-field="mode"]');
        if (modeSelect)
        {
            modeSelect.value = String(creditDealPaymentModes.NONE);
        }
        const label = this.querySelector('[data-field="label"]');
        const amount = this.querySelector('[data-field="amount"]');
        const invoice = this.querySelector('[data-field="invoice"]');
        if (label) label.value = "";
        if (amount) amount.value = "";
        if (invoice) invoice.value = "";
        this.#applyMode();
    }

    /**
     * Creates the deal record for an existing target, runs the in-page checkout
     * if required, and uploads any chosen invoice. Returns a result summary;
     * never throws (errors are captured in the result).
     * @param {number} targetType — CreditDealTargetTypes value
     * @param {string} targetId
     * @returns {Promise<{ recorded: boolean, captured?: boolean, invoiceUploaded?: boolean, error?: string }>}
     */
    async submitForTarget(targetType, targetId)
    {
        const mode = Number(this.querySelector('[data-field="mode"]').value);
        const label = this.querySelector('[data-field="label"]').value.trim();
        const currency = (this.querySelector('[data-field="currency"]').value || "INR").trim().toUpperCase();
        const amountMajor = parseFloat(this.querySelector('[data-field="amount"]').value);
        const invoiceInput = this.querySelector('[data-field="invoice"]');
        const invoiceFile = invoiceInput && invoiceInput.files && invoiceInput.files[0];

        // Nothing to record at all.
        if (mode === creditDealPaymentModes.NONE && !invoiceFile)
        {
            return { recorded: false };
        }

        const amountMinor = isFinite(amountMajor) && amountMajor > 0 ? Math.round(amountMajor * 100) : 0;

        if (mode === creditDealPaymentModes.ON_SPOT_RAZORPAY && amountMinor <= 0)
        {
            return { recorded: false, error: "Enter a positive amount for an on-spot payment." };
        }

        let createJson;
        try
        {
            const createResponse = await fetch("/Admin/Credits/Deals/Create", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ targetType: targetType, targetId: targetId, label: label, mode: mode, amountMinor: amountMinor, currency: currency })
            });
            createJson = await createResponse.json().catch(() => ({}));
            if (!createResponse.ok)
            {
                return { recorded: false, error: createJson.error || `Deal create failed (HTTP ${createResponse.status}).` };
            }
        }
        catch (createError)
        {
            return { recorded: false, error: createError.message };
        }

        const deal = createJson.deal;
        const result = { recorded: true, captured: false, invoiceUploaded: false };

        // In-page checkout for an on-spot deal (Zoho Payments).
        if (mode === creditDealPaymentModes.ON_SPOT_RAZORPAY && createJson.checkoutContext)
        {
            try
            {
                const checkoutResult = await ZohoPaymentsCheckout.open(createJson.checkoutContext, { description: label || "MindMeld credit deal" });
                if (checkoutResult)
                {
                    const verifyResponse = await fetch("/Admin/Credits/Deals/VerifyPayment", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            providerOrderId: checkoutResult.providerOrderId,
                            providerPaymentId: checkoutResult.providerPaymentId,
                            signature: checkoutResult.signature
                        })
                    });
                    const verifyJson = await verifyResponse.json().catch(() => ({}));
                    result.captured = verifyResponse.ok && verifyJson.success === true;
                    if (!result.captured)
                    {
                        result.error = verifyJson.error || "Payment verification failed — the webhook will capture it if the payment went through.";
                    }
                }
                else
                {
                    result.error = "Payment dialog was dismissed — the deal was recorded as pending.";
                }
            }
            catch (checkoutError)
            {
                result.error = checkoutError.message;
            }
        }

        // Upload the invoice (any mode), if one was chosen.
        if (invoiceFile && deal && deal.id)
        {
            try
            {
                const metadata = { dealId: deal.id, fileName: invoiceFile.name, mimeType: invoiceFile.type };
                const formData = new FormData();
                formData.append("file", invoiceFile);
                const uploadResponse = await fetch(`/Admin/Credits/Deals/UploadInvoice?metadata=${encodeURIComponent(JSON.stringify(metadata))}`, {
                    method: "POST",
                    body: formData
                });
                const uploadJson = await uploadResponse.json().catch(() => ({}));
                result.invoiceUploaded = uploadResponse.ok && uploadJson.success === true;
                if (!result.invoiceUploaded)
                {
                    result.error = uploadJson.error || "Invoice upload failed.";
                }
            }
            catch (uploadError)
            {
                result.error = uploadError.message;
            }
        }

        return result;
    }
}

customElements.define("deal-payment-editor", DealPaymentEditor);
export default DealPaymentEditor;
