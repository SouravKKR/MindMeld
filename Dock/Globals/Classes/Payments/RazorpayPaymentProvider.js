const crypto = require("crypto");
const PaymentProvider = require("./PaymentProvider");
const SettlementAmountGuard = require("./SettlementAmountGuard");
const { paymentProviders } = require("../../Enumerations/PaymentProviders");
const ErrorCodes = require("../../Constants/ErrorCodes");

class RazorpayPaymentProvider extends PaymentProvider
{
    // Razorpay's maximum page size for a list query. Asking for more is
    // silently clamped, which would make the "short page means last page"
    // paging test wrong, so it is pinned to the documented maximum.
    static PAYMENT_PAGE_SIZE = 100;

    // A hard ceiling on paging so a bad window cannot spin. See
    // fetchPaymentsInWindow.
    static MAXIMUM_PAYMENT_PAGES = 100;

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

    /**
     * Guards every value that reaches a Buffer / HMAC. Rejecting a non-string
     * here is what keeps a client-supplied `{}` or `[]` from throwing out of a
     * verification path as a 500 instead of a clean 400.
     */
    static #isNonEmptyString(value)
    {
        return typeof value === "string" && value.length > 0;
    }

    /**
     * Constant-time comparison of two hex digests, tolerant of a length
     * mismatch (timingSafeEqual throws on unequal lengths).
     */
    static #signaturesMatch(expectedSignature, providedSignature)
    {
        const expectedBuffer = Buffer.from(expectedSignature, "utf8");
        const providedBuffer = Buffer.from(providedSignature, "utf8");

        if (expectedBuffer.length !== providedBuffer.length)
        {
            return false;
        }

        return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
    }

    async initiateOrder(amountMinor, currency, metadata)
    {
        if (!this.isConfigured())
        {
            throw new Error("Razorpay not configured: missing RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET");
        }

        // The receipt is REQUIRED rather than defaulted. It used to fall back to
        // `mm_${Date.now()}`, which quietly made every order unique even when
        // the caller meant to identify one logical purchase — the defect the
        // deterministic receipt exists to remove. A caller that forgets it must
        // fail here, not silently get a timestamp back.
        if (typeof metadata?.receiptId !== "string" || metadata.receiptId.length === 0)
        {
            throw new Error("Razorpay order creation requires a deterministic metadata.receiptId (see CheckoutReceiptIdentifier).");
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
                receipt: metadata.receiptId,
                notes: metadata?.notes || {}
            })
        });

        if (!orderResponse.ok)
        {
            const errorText = await orderResponse.text();
            throw new Error(`Razorpay order creation failed: ${orderResponse.status} ${errorText}`);
        }

        const order = await orderResponse.json();

        // Assert the provider created the order we actually asked for, before
        // anyone can pay against it.
        //
        // This is the one place the two numbers can silently diverge. Callers
        // store their OWN requested amount on the pending row and later settle
        // from it, while the buyer pays whatever Razorpay recorded on the
        // order. If those ever differed — a normalisation rule, a currency the
        // API treats differently, a defect on either side — every downstream
        // control would pass cleanly while the money and the entitlement
        // disagreed. Checking here costs nothing (both values are already in
        // hand) and removes the need for the browser verify leg to re-fetch the
        // payment later just to ask the same question.
        //
        // Throwing rather than returning is deliberate: an order that does not
        // match the request must never reach a checkout, and every caller
        // already turns a thrown creation error into a clean 502.
        const creationComparison = SettlementAmountGuard.compare
        (
            { amountMinor: order.amount, currency: order.currency, providerOrderId: order.id },
            { amountMinor: amountMinor, currency: currency || "INR", providerOrderId: order.id }
        );

        if (!SettlementAmountGuard.permitsSettlement(creationComparison))
        {
            throw new Error(`Razorpay created an order that does not match the request. ${SettlementAmountGuard.describe(creationComparison)}`);
        }

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

    /**
     * The same context initiateOrder returns, rebuilt for an order that already
     * exists. The key id is public (the browser sends it to Razorpay), so this
     * exposes nothing the checkout widget would not receive anyway.
     */
    buildCheckoutContext(order)
    {
        if (!this.isConfigured())
        {
            return null;
        }

        return {
            keyId: this.#keyId,
            orderId: order.providerOrderId,
            amount: order.amountMinor,
            currency: order.currency
        };
    }

    async verifyPayment(payload)
    {
        if (!this.isConfigured())
        {
            throw new Error("Razorpay not configured");
        }

        const { providerOrderId, providerPaymentId, signature } = payload || {};

        // Type BEFORE truthiness. A client-supplied `{}` or `[]` is truthy, and
        // an object reaching Buffer.from below throws a TypeError that surfaces
        // as a 500 instead of a clean rejection. Every field must be a non-empty
        // string before any crypto runs — matching verifyWebhookSignature.
        if (!RazorpayPaymentProvider.#isNonEmptyString(providerOrderId)
            || !RazorpayPaymentProvider.#isNonEmptyString(providerPaymentId)
            || !RazorpayPaymentProvider.#isNonEmptyString(signature))
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
        // Rotating a webhook secret does not retract deliveries already in
        // flight: Razorpay retries a failed event with exponential backoff for
        // 24 hours, and every one of those retries is still signed with the
        // secret that was current when the event was created. Accepting the
        // previous secret for a transition window is what keeps a rotation from
        // silently dropping a day of payment confirmations. Clear
        // RAZORPAY_WEBHOOK_SECRET_PREVIOUS once the window has passed.
        const currentSecret = process.env.RAZORPAY_WEBHOOK_SECRET || "";
        const previousSecret = process.env.RAZORPAY_WEBHOOK_SECRET_PREVIOUS || "";

        if (!currentSecret && !previousSecret)
        {
            return { verified: false, reason: ErrorCodes.WEBHOOK_SECRET_NOT_CONFIGURED };
        }

        if (typeof rawBody !== "string" || !RazorpayPaymentProvider.#isNonEmptyString(signature))
        {
            return { verified: false, reason: ErrorCodes.MISSING_FIELDS };
        }

        // Both candidates are always evaluated — returning early on the current
        // secret would make the response time reveal which secret matched.
        let bMatchedCurrentSecret = false;
        let bMatchedPreviousSecret = false;

        if (currentSecret)
        {
            const expectedCurrent = crypto.createHmac("sha256", currentSecret).update(rawBody).digest("hex");
            bMatchedCurrentSecret = RazorpayPaymentProvider.#signaturesMatch(expectedCurrent, signature);
        }

        if (previousSecret)
        {
            const expectedPrevious = crypto.createHmac("sha256", previousSecret).update(rawBody).digest("hex");
            bMatchedPreviousSecret = RazorpayPaymentProvider.#signaturesMatch(expectedPrevious, signature);
        }

        if (!bMatchedCurrentSecret && !bMatchedPreviousSecret)
        {
            return { verified: false, reason: ErrorCodes.INVALID_SIGNATURE };
        }

        // Surfaced so the caller can record that a rotation window is still
        // being exercised — the signal that the old secret is safe to remove.
        return { verified: true, usedPreviousSecret: bMatchedPreviousSecret && !bMatchedCurrentSecret };
    }

    /**
     * The payments Razorpay recorded against an order, newest first.
     *
     * This is the reconciler's source of truth. Everywhere else in this
     * integration the provider PUSHES (the browser returns a signed triple, the
     * webhook posts an event) and this server reacts. Reconciliation is the one
     * place that has to PULL, because it exists precisely for the case where
     * every push failed — a webhook that never arrived, a buyer who closed the
     * tab, an outage in between. Asking the provider directly is the only way
     * to learn about a payment nobody told us about.
     *
     * Returns an empty list rather than throwing when the order is unknown to
     * Razorpay, so a stale local row cannot stall a sweep over every other one.
     *
     * @param {string} providerOrderId
     * @returns {Promise<Array<object>>} the Razorpay payment entities
     */
    async fetchOrderPayments(providerOrderId)
    {
        if (!this.isConfigured())
        {
            throw new Error("Razorpay not configured");
        }

        if (!RazorpayPaymentProvider.#isNonEmptyString(providerOrderId))
        {
            return [];
        }

        const paymentsResponse = await fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(providerOrderId)}/payments`,
        {
            method: "GET",
            headers:
            {
                "Authorization": this.#basicAuthorizationHeader()
            }
        });

        if (paymentsResponse.status === 400 || paymentsResponse.status === 404)
        {
            // Razorpay does not know this order. Most likely a local row whose
            // remote creation failed after we wrote it, or a row from another
            // environment's key pair. Neither is worth failing the sweep over.
            return [];
        }

        if (!paymentsResponse.ok)
        {
            const errorText = await paymentsResponse.text();
            throw new Error(`Razorpay order payments fetch failed: ${paymentsResponse.status} ${errorText}`);
        }

        const payload = await paymentsResponse.json();
        return Array.isArray(payload?.items) ? payload.items : [];
    }

    /**
     * The single captured payment for an order, or null.
     *
     * An order can carry several payment attempts — a decline followed by a
     * retry is ordinary — so the reconciler must pick the CAPTURED one rather
     * than the most recent. Authorized-but-uncaptured is deliberately not
     * accepted: provisioning on authorized alone is the handbook's C5 defect,
     * and it stays wrong on this path too.
     *
     * @param {string} providerOrderId
     * @returns {Promise<object|null>}
     */
    async fetchCapturedPaymentForOrder(providerOrderId)
    {
        const payments = await this.fetchOrderPayments(providerOrderId);
        return payments.find(payment => payment?.status === "captured") || null;
    }

    /**
     * Every payment Razorpay recorded in a window, paged to exhaustion.
     *
     * Used by the daily reconciliation, which needs the provider's own account
     * of the day rather than a confirmation of orders this server already knows
     * about. That distinction is the whole point: a payment that exists at
     * Razorpay and matches nothing locally is invisible to every other path in
     * this integration, and it is exactly the shape of a settlement this server
     * missed entirely.
     *
     * Razorpay's `from`/`to` are UNIX SECONDS and INCLUSIVE at both ends, so a
     * caller passing a day boundary must not also pass the next day's start, or
     * the boundary second is counted in both days.
     *
     * @param {number} fromEpochSeconds inclusive
     * @param {number} toEpochSeconds inclusive
     * @returns {Promise<Array<object>>}
     */
    async fetchPaymentsInWindow(fromEpochSeconds, toEpochSeconds)
    {
        if (!this.isConfigured())
        {
            throw new Error("Razorpay not configured");
        }

        const collectedPayments = [];
        let skipCount = 0;

        // Bounded so a misconfigured window cannot page forever. 100 pages of
        // 100 is 10,000 payments in a single day — orders of magnitude beyond
        // this product's volume, and the truncation is reported rather than
        // silent.
        for (let pageIndex = 0; pageIndex < RazorpayPaymentProvider.MAXIMUM_PAYMENT_PAGES; pageIndex = pageIndex + 1)
        {
            const requestUrl = `https://api.razorpay.com/v1/payments?from=${fromEpochSeconds}&to=${toEpochSeconds}`
                + `&count=${RazorpayPaymentProvider.PAYMENT_PAGE_SIZE}&skip=${skipCount}`;

            const paymentsResponse = await fetch(requestUrl,
            {
                method: "GET",
                headers:
                {
                    "Authorization": this.#basicAuthorizationHeader()
                }
            });

            if (!paymentsResponse.ok)
            {
                const errorText = await paymentsResponse.text();
                throw new Error(`Razorpay payments window fetch failed: ${paymentsResponse.status} ${errorText}`);
            }

            const payload = await paymentsResponse.json();
            const pageItems = Array.isArray(payload?.items) ? payload.items : [];

            collectedPayments.push(...pageItems);

            if (pageItems.length < RazorpayPaymentProvider.PAYMENT_PAGE_SIZE)
            {
                break;
            }

            skipCount = skipCount + RazorpayPaymentProvider.PAYMENT_PAGE_SIZE;
        }

        return collectedPayments;
    }

    // refund() is deliberately NOT implemented here. This product does not
    // offer refunds, so the base class's refusal is inherited unchanged and no
    // code path in this application can call Razorpay's refund API. Deleting
    // the implementation rather than leaving it unused is the point: an unused
    // working refund method is an invitation for a future caller to wire it up
    // without anyone revisiting the policy. See RefundPolicy.js.

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

        // Same type-before-crypto guard as verifyPayment — see the note there.
        if (!RazorpayPaymentProvider.#isNonEmptyString(providerSubscriptionId)
            || !RazorpayPaymentProvider.#isNonEmptyString(providerPaymentId)
            || !RazorpayPaymentProvider.#isNonEmptyString(signature))
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
