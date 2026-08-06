const PaymentProvider = require("./PaymentProvider");
const { paymentProviders } = require("../../Enumerations/PaymentProviders");

class PaypalPaymentProvider extends PaymentProvider
{
    #clientId;
    #clientSecret;

    constructor()
    {
        super();
        this.#clientId = process.env.PAYPAL_CLIENT_ID || "";
        this.#clientSecret = process.env.PAYPAL_CLIENT_SECRET || "";
    }

    getProviderEnumValue()
    {
        return paymentProviders.PAYPAL;
    }

    isConfigured()
    {
        return Boolean(this.#clientId && this.#clientSecret);
    }

    async initiateOrder(amountMinor, currency, metadata)
    {
        throw new Error("PaypalPaymentProvider.initiateOrder() is not yet implemented");
    }

    async verifyPayment(payload)
    {
        throw new Error("PaypalPaymentProvider.verifyPayment() is not yet implemented");
    }

    // refund() is deliberately NOT implemented. This product does not offer
    // refunds; the base class refuses for every provider. See RefundPolicy.js.
}

module.exports = PaypalPaymentProvider;
