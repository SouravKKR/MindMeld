/**
 * RazorpayCheckout
 *
 * The single browser-side entry point to the Razorpay Checkout widget
 * (window.Razorpay, loaded from index.html). Every purchase flow — credits,
 * paid decks, organization create/expand, admin credit deals — drives Razorpay
 * checkout through here so the widget wiring lives in exactly one place.
 *
 * It takes the `checkoutContext` the server returned from
 * RazorpayPaymentProvider.initiateOrder ({ keyId, orderId, amount, currency })
 * and normalises the widget's response into the SAME provider-agnostic shape the
 * verify endpoints already expect:
 *
 *   { providerOrderId, providerPaymentId, signature }
 *
 * where providerOrderId is the Razorpay order id the server keyed the pending
 * order by (authoritative — never trust a different one back from the widget)
 * and providerPaymentId / signature come from the successful payment response
 * (razorpay_payment_id / razorpay_signature). The server verifies the signature
 * as HMAC-SHA256("<orderId>|<paymentId>", keySecret), matching what Razorpay
 * signs, so these three fields are all Verify needs.
 *
 * Returns null when the buyer dismisses the widget; throws only on a genuine
 * SDK/integration error (missing SDK or malformed context).
 */
class RazorpayCheckout
{
    static isAvailable()
    {
        return typeof window.Razorpay === "function";
    }

    /**
     * Opens the widget for a single checkout and resolves once the buyer either
     * completes payment or dismisses it.
     * @param {object} checkoutContext — order.checkoutContext from the server
     * @param {{ description?: string, business?: string, prefill?: object, theme?: object }} [overrides]
     * @returns {Promise<{ providerOrderId: string, providerPaymentId: string, signature: string }|null>}
     */
    static async open(checkoutContext, overrides = {})
    {
        if (!checkoutContext || !checkoutContext.orderId || !checkoutContext.keyId)
        {
            throw new Error("Razorpay checkout context is missing the order id or key.");
        }

        if (!RazorpayCheckout.isAvailable())
        {
            throw new Error("Razorpay Checkout SDK is not loaded. Include https://checkout.razorpay.com/v1/checkout.js in your HTML.");
        }

        return await new Promise((resolve, reject) =>
        {
            // The widget calls the success handler and the dismiss handler on
            // separate paths; a guard makes sure whichever fires first is the
            // one and only settlement of this promise.
            let hasSettled = false;

            const settleWith = (value) =>
            {
                if (hasSettled)
                {
                    return;
                }
                hasSettled = true;
                resolve(value);
            };

            const options =
            {
                key: checkoutContext.keyId,
                order_id: checkoutContext.orderId,
                amount: checkoutContext.amount,
                currency: checkoutContext.currency,
                name: overrides.business || "CogniumLearn",
                description: overrides.description || "CogniumLearn purchase",
                handler: (paymentResponse) =>
                {
                    settleWith
                    ({
                        // The order id the server already bound the order to is
                        // the source of truth — never trust a different one back
                        // from the widget.
                        providerOrderId: checkoutContext.orderId,
                        providerPaymentId: paymentResponse?.razorpay_payment_id || "",
                        signature: paymentResponse?.razorpay_signature || ""
                    });
                },
                modal:
                {
                    // Buyer closed the widget without paying.
                    ondismiss: () => settleWith(null)
                }
            };

            if (overrides.prefill)
            {
                options.prefill = overrides.prefill;
            }

            if (overrides.theme)
            {
                options.theme = overrides.theme;
            }

            let instance;
            try
            {
                instance = new window.Razorpay(options);
            }
            catch (constructionError)
            {
                if (!hasSettled)
                {
                    hasSettled = true;
                    reject(constructionError);
                }
                return;
            }

            // A declined/failed attempt is logged for diagnostics but does not
            // settle here: Razorpay keeps the widget open so the buyer can
            // retry, and the eventual close resolves null via ondismiss.
            instance.on("payment.failed", (failureResponse) =>
            {
                console.warn("[RazorpayCheckout] payment.failed:", failureResponse?.error?.description || failureResponse);
            });

            instance.open();
        });
    }
}

export default RazorpayCheckout;
