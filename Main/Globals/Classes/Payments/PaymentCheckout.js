import { paymentProviders } from "../../Enumerations/PaymentProviders.js";
import RazorpayCheckout from "./RazorpayCheckout.js";

/**
 * PaymentCheckout
 *
 * Provider-agnostic dispatcher over the browser-side checkout widgets. The
 * server picks the payment provider (DEFAULT_PAYMENT_PROVIDER, or a per-request
 * override) and returns its enum value in every initiate response alongside the
 * provider-specific `checkoutContext`. Every purchase flow hands both to this
 * dispatcher, which routes to the matching widget wrapper — so a purchase flow
 * never hard-codes a single provider and switching providers is a server-side
 * configuration change, mirroring the backend PaymentProviderFactory.
 *
 * Every wrapper exposes the same two-method contract (isAvailable / open) and
 * normalises its widget's response to { providerOrderId, providerPaymentId,
 * signature }, so the flow's verify call is identical regardless of provider.
 */
class PaymentCheckout
{
    static #resolveHandler(providerEnumValue)
    {
        switch (providerEnumValue)
        {
            case paymentProviders.RAZORPAY:
                return RazorpayCheckout;
            default:
                return null;
        }
    }

    /**
     * Whether the browser SDK for the given provider is loaded and ready.
     * @param {number} providerEnumValue — paymentProviders enum member
     * @returns {boolean}
     */
    static isAvailable(providerEnumValue)
    {
        const handler = PaymentCheckout.#resolveHandler(providerEnumValue);
        return handler ? handler.isAvailable() : false;
    }

    /**
     * Opens the checkout widget for the given provider.
     * @param {number} providerEnumValue — paymentProviders enum member
     * @param {object} checkoutContext — order.checkoutContext from the server
     * @param {object} [overrides] — provider-agnostic display overrides (description, etc.)
     * @returns {Promise<{ providerOrderId: string, providerPaymentId: string, signature: string }|null>}
     */
    static async open(providerEnumValue, checkoutContext, overrides = {})
    {
        const handler = PaymentCheckout.#resolveHandler(providerEnumValue);
        if (!handler)
        {
            throw new Error(`No browser checkout handler for payment provider ${providerEnumValue}.`);
        }

        return await handler.open(checkoutContext, overrides);
    }
}

export default PaymentCheckout;
