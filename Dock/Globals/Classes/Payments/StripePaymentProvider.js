const PaymentProvider = require("./PaymentProvider");
const { paymentProviders } = require("../../Enumerations/PaymentProviders");

class StripePaymentProvider extends PaymentProvider
{
    #secretKey;

    constructor()
    {
        super();
        this.#secretKey = process.env.STRIPE_SECRET_KEY || "";
    }

    getProviderEnumValue()
    {
        return paymentProviders.STRIPE;
    }

    isConfigured()
    {
        return Boolean(this.#secretKey);
    }

    async initiateOrder(amountMinor, currency, metadata)
    {
        throw new Error("StripePaymentProvider.initiateOrder() is not yet implemented");
    }

    async verifyPayment(payload)
    {
        throw new Error("StripePaymentProvider.verifyPayment() is not yet implemented");
    }

    async refund(paymentId, amountMinor)
    {
        throw new Error("StripePaymentProvider.refund() is not yet implemented");
    }
}

module.exports = StripePaymentProvider;
