const ZohoRegionConfig = require("../Payments/ZohoRegionConfig");
const ZohoOAuthTokenManager = require("../Payments/ZohoOAuthTokenManager");

/**
 * ZohoInvoiceService
 *
 * Generates a paid invoice in Zoho Invoice for each successful CUSTOMER
 * purchase (credit purchases + paid-deck purchases). Reuses the shared
 * ZohoOAuthTokenManager / ZohoRegionConfig so a single Zoho account, scoped for
 * both Payments and Invoice, backs everything.
 *
 * BEST-EFFORT BY CONTRACT: every public method swallows its own errors and
 * returns a result object — it NEVER throws. Invoicing is downstream of money
 * that has already moved and credits/licenses that have already been granted,
 * so a Zoho Invoice hiccup (bad currency, throttling, org misconfig) must never
 * fail the purchase. Failures are logged for admin triage.
 *
 * Flow per invoice: resolve-or-create the customer contact by email -> create
 * the invoice (single ad-hoc line item) -> record a customer payment so the
 * invoice lands as PAID rather than an open draft.
 */
class ZohoInvoiceService
{
    static INVOICE_API_PATH = "/invoice/v3";
    static ORGANIZATION_HEADER = "X-com-zoho-invoice-organizationid";
    static PAYMENT_MODE = "creditcard";

    static isEnabled()
    {
        const flag = String(process.env.ZOHO_INVOICE_ENABLED || "").toLowerCase();
        const enabled = flag === "1" || flag === "true" || flag === "yes";
        return Boolean(enabled && (process.env.ZOHO_INVOICE_ORGANIZATION_ID || "") && ZohoOAuthTokenManager.isConfigured());
    }

    static #organizationId()
    {
        return process.env.ZOHO_INVOICE_ORGANIZATION_ID || "";
    }

    static #baseUrl()
    {
        return `${ZohoRegionConfig.getApisBaseUrl()}${ZohoInvoiceService.INVOICE_API_PATH}`;
    }

    /**
     * @param {{ email: string, name?: string, amountMinor: number, currency: string,
     *           description: string, referenceNumber?: string }} details
     * @returns {Promise<{ created: boolean, skipped?: boolean, reason?: string,
     *                     invoiceId?: string, invoiceNumber?: string }>}
     */
    static async createPaidInvoice(details)
    {
        try
        {
            if (!ZohoInvoiceService.isEnabled())
            {
                return { created: false, skipped: true, reason: "INVOICING_DISABLED" };
            }

            const email = String(details?.email || "").trim();
            if (!email)
            {
                return { created: false, skipped: true, reason: "NO_BUYER_EMAIL" };
            }

            const amountMajor = (Number(details?.amountMinor) || 0) / 100;
            if (!(amountMajor > 0))
            {
                // Zero-amount (fully discounted / free) acquisitions carry no
                // money to invoice.
                return { created: false, skipped: true, reason: "NON_POSITIVE_AMOUNT" };
            }

            const accessToken = await ZohoOAuthTokenManager.getAccessToken();
            const currency = String(details?.currency || "INR").toUpperCase();
            const description = String(details?.description || "CogniumLearn purchase").slice(0, 500);

            const contactId = await ZohoInvoiceService.#resolveOrCreateContact(accessToken, email, details?.name, currency);
            if (!contactId)
            {
                return { created: false, reason: "CONTACT_RESOLUTION_FAILED" };
            }

            const invoice = await ZohoInvoiceService.#createInvoice(accessToken, contactId, amountMajor, description, details?.referenceNumber);
            if (!invoice)
            {
                return { created: false, reason: "INVOICE_CREATE_FAILED" };
            }

            // Mark it paid. A failure here leaves an open (but valid) invoice —
            // still useful, so we report success of the invoice itself.
            await ZohoInvoiceService.#recordPayment(accessToken, contactId, invoice.invoice_id, amountMajor, details?.referenceNumber);

            return { created: true, invoiceId: invoice.invoice_id, invoiceNumber: invoice.invoice_number };
        }
        catch (invoiceError)
        {
            console.warn(`[ZohoInvoiceService] Invoice generation failed (non-fatal): ${invoiceError?.message || invoiceError}`);
            return { created: false, reason: "EXCEPTION" };
        }
    }

    static async #zohoRequest(accessToken, method, path, body)
    {
        const response = await fetch(`${ZohoInvoiceService.#baseUrl()}${path}`,
        {
            method: method,
            headers:
            {
                "Content-Type": "application/json",
                "Authorization": `Zoho-oauthtoken ${accessToken}`,
                [ZohoInvoiceService.ORGANIZATION_HEADER]: ZohoInvoiceService.#organizationId()
            },
            body: body ? JSON.stringify(body) : undefined
        });

        const responseText = await response.text();
        let json = null;
        try
        {
            json = JSON.parse(responseText);
        }
        catch (parseError)
        {
            json = null;
        }

        return { ok: response.ok, status: response.status, json: json, text: responseText };
    }

    static async #resolveOrCreateContact(accessToken, email, name, currency)
    {
        // Search first so repeat buyers reuse their contact instead of stacking
        // duplicates.
        const lookup = await ZohoInvoiceService.#zohoRequest(accessToken, "GET", `/contacts?email=${encodeURIComponent(email)}`, null);
        const existing = lookup.ok && Array.isArray(lookup.json?.contacts) ? lookup.json.contacts[0] : null;
        if (existing && existing.contact_id)
        {
            return existing.contact_id;
        }

        const createBody =
        {
            contact_name: String(name || email).slice(0, 200),
            currency_code: currency,
            contact_persons:
            [
                { email: email, first_name: String(name || email).slice(0, 100), is_primary_contact: true }
            ]
        };

        const created = await ZohoInvoiceService.#zohoRequest(accessToken, "POST", "/contacts", createBody);
        if (!created.ok || !created.json?.contact?.contact_id)
        {
            console.warn(`[ZohoInvoiceService] Contact create failed: ${created.status} ${created.text}`);
            return null;
        }

        return created.json.contact.contact_id;
    }

    static #todayDateString()
    {
        // Zoho expects yyyy-mm-dd in the org's locale; UTC date is acceptable
        // and stable across the server's timezone.
        const now = new Date();
        const year = now.getUTCFullYear();
        const month = String(now.getUTCMonth() + 1).padStart(2, "0");
        const day = String(now.getUTCDate()).padStart(2, "0");
        return `${year}-${month}-${day}`;
    }

    static async #createInvoice(accessToken, contactId, amountMajor, description, referenceNumber)
    {
        // No currency_code on the invoice: Zoho derives invoice currency from the
        // customer contact, and passing a mismatching code is rejected. A single
        // ad-hoc line item (name + rate + quantity) avoids needing an item
        // catalog.
        const invoiceBody =
        {
            customer_id: contactId,
            date: ZohoInvoiceService.#todayDateString(),
            reference_number: String(referenceNumber || "").slice(0, 50),
            line_items:
            [
                { name: description.slice(0, 200), description: description, rate: amountMajor, quantity: 1 }
            ]
        };

        const created = await ZohoInvoiceService.#zohoRequest(accessToken, "POST", "/invoices?send=false", invoiceBody);
        if (!created.ok || !created.json?.invoice?.invoice_id)
        {
            console.warn(`[ZohoInvoiceService] Invoice create failed: ${created.status} ${created.text}`);
            return null;
        }

        return created.json.invoice;
    }

    static async #recordPayment(accessToken, contactId, invoiceId, amountMajor, referenceNumber)
    {
        const paymentBody =
        {
            customer_id: contactId,
            payment_mode: ZohoInvoiceService.PAYMENT_MODE,
            amount: amountMajor,
            date: ZohoInvoiceService.#todayDateString(),
            reference_number: String(referenceNumber || "").slice(0, 100),
            invoices:
            [
                { invoice_id: invoiceId, amount_applied: amountMajor }
            ]
        };

        const recorded = await ZohoInvoiceService.#zohoRequest(accessToken, "POST", "/customerpayments", paymentBody);
        if (!recorded.ok)
        {
            console.warn(`[ZohoInvoiceService] Payment record failed for invoice ${invoiceId}: ${recorded.status} ${recorded.text}`);
            return false;
        }

        return true;
    }
}

module.exports = ZohoInvoiceService;
