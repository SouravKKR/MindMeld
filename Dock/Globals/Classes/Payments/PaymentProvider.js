class PaymentProvider
{
    getProviderEnumValue()
    {
        throw new Error("PaymentProvider.getProviderEnumValue() must be implemented by subclass");
    }

    isConfigured()
    {
        throw new Error("PaymentProvider.isConfigured() must be implemented by subclass");
    }

    async initiateOrder(amountMinor, currency, metadata)
    {
        throw new Error("PaymentProvider.initiateOrder() must be implemented by subclass");
    }

    async verifyPayment(payload)
    {
        throw new Error("PaymentProvider.verifyPayment() must be implemented by subclass");
    }

    async refund(paymentId, amountMinor)
    {
        throw new Error("PaymentProvider.refund() must be implemented by subclass");
    }
}

module.exports = PaymentProvider;
