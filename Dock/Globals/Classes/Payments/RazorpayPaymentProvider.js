const crypto = require("crypto");
const PaymentProvider = require("./PaymentProvider");
const { paymentProviders } = require("../../Enumerations/PaymentProviders");
const ErrorCodes = require("../../Constants/ErrorCodes");

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

    supportsRecurringSubscriptions()
    {
        return true;
    }

    #basicAuthorizationHeader()
    {
        return "Basic " + Buffer.from(`${this.#keyId}:${this.#keySecret}`).toString("base64");
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
            return { verified: false, reason: ErrorCodes.MISSING_FIELDS };
        }

        const expectedSignature = crypto
            .createHmac("sha256", this.#keySecret)
            .update(`${providerOrderId}|${providerPaymentId}`)
            .digest("hex");

        const expectedBuffer = Buffer.from(expectedSignature, "utf8");
        const signatureBuffer = Buffer.from(signature, "utf8");

        if (expectedBuffer.length !== signatureBuffer.length)
        {
            return { verified: false, reason: ErrorCodes.SIGNATURE_LENGTH_MISMATCH };
        }

        const verified = crypto.timingSafeEqual(expectedBuffer, signatureBuffer);

        return { verified: verified, providerOrderId: providerOrderId, providerPaymentId: providerPaymentId };
    }

    verifyWebhookSignature(rawBody, signature)
    {
        // Razorpay signs webhook deliveries with HMAC-SHA256 of the raw
        // request body using a webhook-specific secret (NOT the API key
        // secret used by verifyPayment above). The handler MUST capture
        // the raw bytes — JSON.parse-then-stringify changes whitespace
        // and breaks the signature.
        const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || "";
        if (!webhookSecret)
        {
            return { verified: false, reason: ErrorCodes.WEBHOOK_SECRET_NOT_CONFIGURED };
        }

        if (typeof rawBody !== "string" || typeof signature !== "string" || signature.length === 0)
        {
            return { verified: false, reason: ErrorCodes.MISSING_FIELDS };
        }

        const expectedSignature = crypto
            .createHmac("sha256", webhookSecret)
            .update(rawBody)
            .digest("hex");

        const expectedBuffer = Buffer.from(expectedSignature, "utf8");
        const signatureBuffer = Buffer.from(signature, "utf8");

        if (expectedBuffer.length !== signatureBuffer.length)
        {
            return { verified: false, reason: ErrorCodes.SIGNATURE_LENGTH_MISMATCH };
        }

        const verified = crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
        return { verified: verified };
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

    // ── Recurring subscriptions (auto-debit mandate) ──────────────────────────
    //
    // These implement supportsRecurringSubscriptions() === true. The flow is:
    // createPlan (once per tier+currency, cached in RazorpayPlanRegistry) →
    // createSubscription (per user; returns a shortUrl the browser opens to
    // authorize the e-mandate) → recurring `subscription.charged` webhooks drive
    // credit grants + entitlement extension. verifySubscriptionPayment confirms
    // the authorization transaction on the browser return leg.

    /**
     * Creates a Razorpay Plan (the recurring price template). One plan per
     * (tier, currency); the registry caches the returned id.
     * @param {{planTier: number, currency: string, amountMinor: number, period?: string, interval?: number, planName?: string, notes?: object}} options
     * @returns {Promise<{providerPlanId: string}>}
     */
    async createPlan(options)
    {
        if (!this.isConfigured())
        {
            throw new Error("Razorpay not configured");
        }

        const { currency, amountMinor, period, interval, planName, notes } = options || {};

        const planResponse = await fetch("https://api.razorpay.com/v1/plans",
        {
            method: "POST",
            headers:
            {
                "Content-Type": "application/json",
                "Authorization": this.#basicAuthorizationHeader()
            },
            body: JSON.stringify
            ({
                period: period || "monthly",
                interval: interval || 1,
                item:
                {
                    name: planName || "CogniumLearn plan",
                    amount: amountMinor,
                    currency: currency || "INR"
                },
                notes: notes || {}
            })
        });

        if (!planResponse.ok)
        {
            const errorText = await planResponse.text();
            throw new Error(`Razorpay plan creation failed: ${planResponse.status} ${errorText}`);
        }

        const plan = await planResponse.json();
        return { providerPlanId: plan.id };
    }

    /**
     * Creates a subscription for a user against a plan. The returned shortUrl is
     * the Razorpay-hosted page where the buyer authorizes the auto-debit mandate.
     * @param {{providerPlanId: string, totalCount?: number, customerNotify?: boolean, notes?: object, offerId?: string}} options
     * @returns {Promise<{providerSubscriptionId: string, shortUrl: string, status: string}>}
     */
    async createSubscription(options)
    {
        if (!this.isConfigured())
        {
            throw new Error("Razorpay not configured");
        }

        const { providerPlanId, totalCount, customerNotify, notes, offerId } = options || {};
        if (!providerPlanId)
        {
            throw new Error("Razorpay createSubscription requires providerPlanId");
        }

        const requestBody =
        {
            plan_id: providerPlanId,
            // Number of billing cycles before the subscription completes. A
            // large default approximates "until cancelled" (Razorpay requires
            // a finite count); 120 monthly cycles is ten years.
            total_count: totalCount || 120,
            customer_notify: customerNotify === false ? 0 : 1,
            notes: notes || {}
        };
        // A PLAN_DISCOUNT coupon carries a Razorpay Offer id — the native way to
        // discount an auto-debit subscription. Passed through when present.
        if (typeof offerId === "string" && offerId.length > 0)
        {
            requestBody.offer_id = offerId;
        }

        const subscriptionResponse = await fetch("https://api.razorpay.com/v1/subscriptions",
        {
            method: "POST",
            headers:
            {
                "Content-Type": "application/json",
                "Authorization": this.#basicAuthorizationHeader()
            },
            body: JSON.stringify(requestBody)
        });

        if (!subscriptionResponse.ok)
        {
            const errorText = await subscriptionResponse.text();
            throw new Error(`Razorpay subscription creation failed: ${subscriptionResponse.status} ${errorText}`);
        }

        const subscription = await subscriptionResponse.json();
        return {
            providerSubscriptionId: subscription.id,
            shortUrl: subscription.short_url,
            status: subscription.status
        };
    }

    /**
     * Verifies the subscription authorization signature returned to the browser.
     * NOTE the field order is REVERSED from verifyPayment: Razorpay signs
     * `${paymentId}|${subscriptionId}` for subscriptions (vs `${orderId}|${paymentId}`
     * for one-time orders), so this is a distinct method.
     * @param {{providerSubscriptionId: string, providerPaymentId: string, signature: string}} payload
     * @returns {Promise<{verified: boolean, reason?: string, providerSubscriptionId?: string, providerPaymentId?: string}>}
     */
    async verifySubscriptionPayment(payload)
    {
        if (!this.isConfigured())
        {
            throw new Error("Razorpay not configured");
        }

        const { providerSubscriptionId, providerPaymentId, signature } = payload || {};

        if (!providerSubscriptionId || !providerPaymentId || !signature)
        {
            return { verified: false, reason: ErrorCodes.MISSING_FIELDS };
        }

        const expectedSignature = crypto
            .createHmac("sha256", this.#keySecret)
            .update(`${providerPaymentId}|${providerSubscriptionId}`)
            .digest("hex");

        const expectedBuffer = Buffer.from(expectedSignature, "utf8");
        const signatureBuffer = Buffer.from(signature, "utf8");

        if (expectedBuffer.length !== signatureBuffer.length)
        {
            return { verified: false, reason: ErrorCodes.SIGNATURE_LENGTH_MISMATCH };
        }

        const verified = crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
        return { verified: verified, providerSubscriptionId: providerSubscriptionId, providerPaymentId: providerPaymentId };
    }

    /**
     * Cancels a subscription — immediately, or at the end of the current paid
     * cycle when cancelAtCycleEnd is true (used for downgrade-at-period-end).
     * @param {string} providerSubscriptionId
     * @param {boolean} cancelAtCycleEnd
     * @returns {Promise<object>} the Razorpay subscription entity
     */
    async cancelSubscription(providerSubscriptionId, cancelAtCycleEnd)
    {
        if (!this.isConfigured())
        {
            throw new Error("Razorpay not configured");
        }
        if (!providerSubscriptionId)
        {
            throw new Error("Razorpay cancelSubscription requires providerSubscriptionId");
        }

        const cancelResponse = await fetch(`https://api.razorpay.com/v1/subscriptions/${providerSubscriptionId}/cancel`,
        {
            method: "POST",
            headers:
            {
                "Content-Type": "application/json",
                "Authorization": this.#basicAuthorizationHeader()
            },
            body: JSON.stringify({ cancel_at_cycle_end: cancelAtCycleEnd ? 1 : 0 })
        });

        if (!cancelResponse.ok)
        {
            const errorText = await cancelResponse.text();
            throw new Error(`Razorpay subscription cancel failed: ${cancelResponse.status} ${errorText}`);
        }

        return await cancelResponse.json();
    }

    /**
     * Fetches the current state of a subscription (used to reconcile
     * current_end / status out of band from the webhook).
     * @param {string} providerSubscriptionId
     * @returns {Promise<object>} the Razorpay subscription entity
     */
    async fetchSubscription(providerSubscriptionId)
    {
        if (!this.isConfigured())
        {
            throw new Error("Razorpay not configured");
        }

        const fetchResponse = await fetch(`https://api.razorpay.com/v1/subscriptions/${providerSubscriptionId}`,
        {
            method: "GET",
            headers:
            {
                "Authorization": this.#basicAuthorizationHeader()
            }
        });

        if (!fetchResponse.ok)
        {
            const errorText = await fetchResponse.text();
            throw new Error(`Razorpay subscription fetch failed: ${fetchResponse.status} ${errorText}`);
        }

        return await fetchResponse.json();
    }
}

module.exports = RazorpayPaymentProvider;
