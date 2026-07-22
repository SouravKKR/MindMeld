/**
 * ZohoPaymentsCheckout
 *
 * The single browser-side entry point to the Zoho Payments checkout widget
 * (window.ZPayments, loaded from index.html). Every purchase flow — credits,
 * paid decks, organization create/expand, admin credit deals — drives checkout
 * through here so the widget wiring lives in exactly one place.
 *
 * It takes the `checkoutContext` the server returned from initiateOrder and
 * normalises the widget's response into the SAME provider-agnostic shape the
 * verify endpoints already expect:
 *
 *   { providerOrderId, providerPaymentId, signature }
 *
 * where providerOrderId is the Zoho payments_session_id (authoritative — the
 * server keyed the pending order by it) and providerPaymentId / signature come
 * from the widget.
 *
 * Returns null when the buyer dismisses the widget (Zoho throws err.code
 * "widget_closed"); throws only on a genuine SDK/integration error.
 */
class ZohoPaymentsCheckout
{
    static isAvailable()
    {
        return typeof window.ZPayments === "function";
    }

    /**
     * Opens the widget for a single checkout and resolves once the buyer either
     * completes payment or dismisses it.
     * @param {object} checkoutContext — order.checkoutContext from the server
     * @param {{ description?: string, address?: object }} [overrides]
     * @returns {Promise<{ providerOrderId: string, providerPaymentId: string, signature: string }|null>}
     */
    static async open(checkoutContext, overrides = {})
    {
        if (!checkoutContext || !checkoutContext.paymentsSessionId)
        {
            throw new Error("Zoho checkout context is missing the payment session.");
        }

        if (!ZohoPaymentsCheckout.isAvailable())
        {
            throw new Error("Zoho Payments SDK is not loaded. Include https://static.zohocdn.com/zpay/zpay-js/v1/zpayments.js in your HTML.");
        }

        const config =
        {
            account_id: checkoutContext.accountId,
            domain: checkoutContext.domain,
            otherOptions:
            {
                api_key: checkoutContext.apiKey
            }
        };

        if (checkoutContext.testMode)
        {
            config.otherOptions.is_test_mode = true;
        }

        const instance = new window.ZPayments(config);

        const options =
        {
            amount: checkoutContext.amount,
            currency_code: checkoutContext.currencyCode,
            payments_session_id: checkoutContext.paymentsSessionId,
            currency_symbol: checkoutContext.currencySymbol || checkoutContext.currencyCode,
            business: checkoutContext.business || "CogniumLearn",
            description: overrides.description || checkoutContext.description || "CogniumLearn purchase"
        };

        if (overrides.address)
        {
            options.address = overrides.address;
        }

        try
        {
            const data = await instance.requestPaymentMethod(options);

            return {
                // The session id the server already bound the order to is the
                // source of truth — never trust a different one back from the
                // widget.
                providerOrderId: checkoutContext.paymentsSessionId,
                providerPaymentId: data?.payment_id || "",
                signature: data?.signature || ""
            };
        }
        catch (checkoutError)
        {
            if (checkoutError && checkoutError.code === "widget_closed")
            {
                return null;
            }
            throw checkoutError;
        }
        finally
        {
            // Always tear the widget down so a re-open starts clean.
            try
            {
                await instance.close();
            }
            catch (closeError)
            {
                // Already closed — nothing to do.
            }
        }
    }
}

export default ZohoPaymentsCheckout;
