const RazorpayPaymentProvider = require("./RazorpayPaymentProvider");
const StripePaymentProvider = require("./StripePaymentProvider");
const PaypalPaymentProvider = require("./PaypalPaymentProvider");
const { paymentProviders } = require("../../Enumerations/PaymentProviders");

class PaymentProviderFactory
{
    static #cache = new Map();

    // Providers that were once integrated and have since been removed. Their
    // enum members are deliberately KEPT (see Common/Enumerations/PaymentProviders.json)
    // so historical rows in pendingOrders, pendingCreditOrders, purchases and
    // creditDealPayments stay correctly attributed in invoices, revenue figures
    // and admin lists — renumbering or reusing a retired value would silently
    // re-label old money as a different provider.
    //
    // Asking for one is a distinct failure from asking for a value that never
    // existed, so it gets its own message rather than "Unknown payment
    // provider": the caller is holding a real historical record, not a bug.
    static RETIRED_PROVIDER_ENUM_VALUES = new Map
    ([
        [paymentProviders.ZOHO, "Zoho Payments was removed from this application. Historical Zoho records remain readable, but no new Zoho payment can be created or verified."]
    ]);

    static isRetiredProvider(providerEnumValue)
    {
        return PaymentProviderFactory.RETIRED_PROVIDER_ENUM_VALUES.has(providerEnumValue);
    }

    static getProvider(providerEnumValue)
    {
        if (PaymentProviderFactory.#cache.has(providerEnumValue))
        {
            return PaymentProviderFactory.#cache.get(providerEnumValue);
        }

        if (PaymentProviderFactory.isRetiredProvider(providerEnumValue))
        {
            throw new Error(PaymentProviderFactory.RETIRED_PROVIDER_ENUM_VALUES.get(providerEnumValue));
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
