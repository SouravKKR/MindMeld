const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");


/**
 * GET /PaidDecks/Purchases/Invoice?purchaseId={id}
 *
 * Returns an HTML invoice for the requester's own purchase. The page
 * links its own print stylesheet (Dock/Static/Invoices/Invoice.css) so
 * the user can hit Ctrl+P → "Save as PDF" to download.
 *
 * Ownership: 404 (NOT 403) if the purchase doesn't belong to the
 * requester — leaks no information about whether the id exists for
 * another user.
 *
 * jsPDF is available client-side as a richer alternative (already
 * loaded for mock tests) — the activity entry's "Download invoice"
 * button could be switched to client-side PDF generation later
 * without server changes.
 */
class GetPurchaseInvoiceEndpoint
{
    static async handle(request, response)
    {
        const session = request.session;
        if (!session)
        {
            response.sendStatusCode(httpStatus.UNAUTHORIZED);
            return;
        }

        const params = await request.getQueryParams();
        const purchaseId = params["purchaseId"] || params["purchaseid"];

        if (!purchaseId)
        {
            response.sendStatusCode(httpStatus.BAD_REQUEST);
            return;
        }

        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            response.sendStatusCode(httpStatus.SERVICE_UNAVAILABLE);
            return;
        }

        const purchase = await database
            .collection(DatabaseConstants.PURCHASES_COLLECTION)
            .findOne({ id: purchaseId, userId: session.getUserId() }, { projection: { _id: 0 } });

        if (!purchase)
        {
            response.sendStatusCode(httpStatus.NOT_FOUND);
            return;
        }

        const deck = await database
            .collection(DatabaseConstants.PAID_DECKS_COLLECTION)
            .findOne({ id: purchase.deckId }, { projection: { _id: 0, title: 1, sellerId: 1 } });

        const user = await database
            .collection(DatabaseConstants.USERS_COLLECTION)
            .findOne({ id: session.getUserId() }, { projection: { _id: 0, displayName: 1, additionalData: 1 } });

        const invoiceHtml = GetPurchaseInvoiceEndpoint.#renderInvoice(purchase, deck, user);

        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.write(invoiceHtml);
        response.end();
    }

    static #renderInvoice(purchase, deck, user)
    {
        const buyerName = (user && user.displayName) ? user.displayName : "Customer";
        const buyerEmail = (user && user.additionalData && user.additionalData.email) ? user.additionalData.email : "";
        const deckTitle = (deck && deck.title) ? deck.title : "Paid Deck";
        const currency = purchase.currency || "INR";
        const amountMajor = ((purchase.amountMinor || 0) / 100).toFixed(2);
        const purchaseDate = new Date(purchase.purchaseDate || Date.now()).toISOString().substring(0, 10);
        const escapedDeckTitle = GetPurchaseInvoiceEndpoint.#escapeHtml(deckTitle);
        const escapedBuyerName = GetPurchaseInvoiceEndpoint.#escapeHtml(buyerName);
        const escapedBuyerEmail = GetPurchaseInvoiceEndpoint.#escapeHtml(buyerEmail);
        const escapedPurchaseId = GetPurchaseInvoiceEndpoint.#escapeHtml(purchase.id);
        const escapedProviderOrderId = GetPurchaseInvoiceEndpoint.#escapeHtml(purchase.providerOrderId || "");
        const escapedProviderPaymentId = GetPurchaseInvoiceEndpoint.#escapeHtml(purchase.providerPaymentId || "");
        const escapedRegion = GetPurchaseInvoiceEndpoint.#escapeHtml(purchase.region || "GLOBAL");

        return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>Invoice ${escapedPurchaseId}</title>
    <link rel="stylesheet" href="/Invoices/Invoice.css">
</head>
<body>
    <main class="invoice">
        <header class="invoice-header">
            <div class="invoice-brand">CogniumLearn</div>
            <div class="invoice-meta">
                <div><span class="invoice-meta-label">Invoice</span> #${escapedPurchaseId}</div>
                <div><span class="invoice-meta-label">Date</span> ${purchaseDate}</div>
            </div>
        </header>

        <section class="invoice-parties">
            <div>
                <h3>Billed to</h3>
                <div>${escapedBuyerName}</div>
                <div>${escapedBuyerEmail}</div>
            </div>
            <div>
                <h3>From</h3>
                <div>CogniumLearn</div>
                <div>An AI-powered spaced repetition platform</div>
            </div>
        </section>

        <table class="invoice-table">
            <thead>
                <tr>
                    <th>Description</th>
                    <th>Region</th>
                    <th class="invoice-amount">Amount</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td>${escapedDeckTitle}</td>
                    <td>${escapedRegion}</td>
                    <td class="invoice-amount">${currency} ${amountMajor}</td>
                </tr>
            </tbody>
            <tfoot>
                <tr>
                    <td colspan="2">Total</td>
                    <td class="invoice-amount"><strong>${currency} ${amountMajor}</strong></td>
                </tr>
            </tfoot>
        </table>

        <section class="invoice-payment">
            <h3>Payment</h3>
            <div><span class="invoice-meta-label">Provider order</span> ${escapedProviderOrderId}</div>
            <div><span class="invoice-meta-label">Provider payment</span> ${escapedProviderPaymentId}</div>
        </section>

        <footer class="invoice-footer">
            Use your browser's Print dialog (Ctrl+P / Cmd+P) and choose
            "Save as PDF" to download a copy of this invoice.
        </footer>
    </main>
</body>
</html>
`;
    }

    static #escapeHtml(rawString)
    {
        if (rawString === null || rawString === undefined)
        {
            return "";
        }
        return String(rawString)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }
}

async function getPurchaseInvoice(request, response)
{
    await GetPurchaseInvoiceEndpoint.handle(request, response);
}

module.exports = { getPurchaseInvoice };
