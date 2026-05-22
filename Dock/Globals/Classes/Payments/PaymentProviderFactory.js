const RazorpayPaymentProvider = require("./RazorpayPaymentProvider");
const StripePaymentProvider = require("./StripePaymentProvider");
const PaypalPaymentProvider = require("./PaypalPaymentProvider");
const { paymentProviders } = require("../../Enumerations/PaymentProviders");

class PaymentProviderFactory
{
    static #cache = new Map();

    static getProvider(providerEnumValue)
    {
        if (PaymentProviderFactory.#cache.has(providerEnumValue))
        {
            return PaymentProviderFactory.#cache.get(providerEnumValue);
        }

        let provider = null;

        switch (providerEnumValue)
        {
            case paymentProviders.RAZORPAY:
                provider = new RazorpayPaymentProvider();
                break;
            case paymentProviders.STRIPE:
                provider = new StripePaymentProvider();
                break;
            case paymentProviders.PAYPAL:
                provider = new PaypalPaymentProvider();
                break;
            default:
                throw new Error(`Unknown payment provider: ${providerEnumValue}`);
        }

        PaymentProviderFactory.#cache.set(providerEnumValue, provider);
        return provider;
    }

    static getDefaultProvider()
    {
        const configuredName = (process.env.DEFAULT_PAYMENT_PROVIDER || "RAZORPAY").toUpperCase();
        const enumValue = paymentProviders[configuredName];

        if (enumValue === undefined)
        {
            return PaymentProviderFactory.getProvider(paymentProviders.RAZORPAY);
        }

        return PaymentProviderFactory.getProvider(enumValue);
    }

    static listAvailableProviders()
    {
        const available = [];

        for (const [name, enumValue] of Object.entries(paymentProviders))
        {
            try
            {
                const provider = PaymentProviderFactory.getProvider(enumValue);
                if (provider.isConfigured())
                {
                    available.push({ name: name, enumValue: enumValue });
                }
            }
            catch (factoryError)
            {
                continue;
            }
        }

        return available;
    }
}

module.exports = PaymentProviderFactory;
