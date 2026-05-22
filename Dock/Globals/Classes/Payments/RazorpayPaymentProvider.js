const crypto = require("crypto");
const PaymentProvider = require("./PaymentProvider");
const { paymentProviders } = require("../../Enumerations/PaymentProviders");

class RazorpayPaymentProvider extends PaymentProvider
{
    #keyId;
    #keySecret;

    constructor()
    {
        super();
        this.#keyId = process.env.RAZORPAY_KEY_ID || "";
        this.#keySecret = process.env.RAZORPAY_KEY_SECRET || "";
    }

    getProviderEnumValue()
    {
        return paymentProviders.RAZORPAY;
    }

    isConfigured()
    {
        return Boolean(this.#keyId && this.#keySecret);
    }

    getPublicKeyId()
    {
        return this.#keyId;
    }

    async initiateOrder(amountMinor, currency, metadata)
    {
        if (!this.isConfigured())
        {
            throw new Error("Razorpay not configured: missing RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET");
        }

        const orderResponse = await fetch("https://api.razorpay.com/v1/orders",
        {
            method: "POST",
            headers:
            {
                "Content-Type": "application/json",
                "Authorization": "Basic " + Buffer.from(`${this.#keyId}:${this.#keySecret}`).toString("base64")
            },
            body: JSON.stringify
            ({
                amount: amountMinor,
                currency: currency || "INR",
                receipt: metadata?.receiptId || `mm_${Date.now()}`,
                notes: metadata?.notes || {}
            })
        });

        if (!orderResponse.ok)
        {
            const errorText = await orderResponse.text();
            throw new Error(`Razorpay order creation failed: ${orderResponse.status} ${errorText}`);
        }

        const order = await orderResponse.json();

        return {
            providerOrderId: order.id,
            amountMinor: order.amount,
            currency: order.currency,
            checkoutContext:
            {
                keyId: this.#keyId,
                orderId: order.id,
                amount: order.amount,
                currency: order.currency
            }
        };
    }

    async verifyPayment(payload)
    {
        if (!this.isConfigured())
        {
            throw new Error("Razorpay not configured");
        }

        const { providerOrderId, providerPaymentId, signature } = payload || {};

        if (!providerOrderId || !providerPaymentId || !signature)
        {
            return { verified: false, reason: "MISSING_FIELDS" };
        }

        const expectedSignature = crypto
            .createHmac("sha256", this.#keySecret)
            .update(`${providerOrderId}|${providerPaymentId}`)
            .digest("hex");

        const expectedBuffer = Buffer.from(expectedSignature, "utf8");
        const signatureBuffer = Buffer.from(signature, "utf8");

        if (expectedBuffer.length !== signatureBuffer.length)
        {
            return { verified: false, reason: "SIGNATURE_LENGTH_MISMATCH" };
        }

        const verified = crypto.timingSafeEqual(expectedBuffer, signatureBuffer);

        return { verified: verified, providerOrderId: providerOrderId, providerPaymentId: providerPaymentId };
    }

    async refund(paymentId, amountMinor)
    {
        if (!this.isConfigured())
        {
            throw new Error("Razorpay not configured");
        }

        const refundResponse = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}/refund`,
        {
            method: "POST",
            headers:
            {
                "Content-Type": "application/json",
                "Authorization": "Basic " + Buffer.from(`${this.#keyId}:${this.#keySecret}`).toString("base64")
            },
            body: JSON.stringify({ amount: amountMinor })
        });

        if (!refundResponse.ok)
        {
            const errorText = await refundResponse.text();
            throw new Error(`Razorpay refund failed: ${refundResponse.status} ${errorText}`);
        }

        return await refundResponse.json();
    }
}

module.exports = RazorpayPaymentProvider;
