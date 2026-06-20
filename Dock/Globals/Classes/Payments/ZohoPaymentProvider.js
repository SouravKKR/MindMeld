const crypto = require("crypto");
const PaymentProvider = require("./PaymentProvider");
const ZohoRegionConfig = require("./ZohoRegionConfig");
const ZohoOAuthTokenManager = require("./ZohoOAuthTokenManager");
const { paymentProviders } = require("../../Enumerations/PaymentProviders");
const ErrorCodes = require("../../Constants/ErrorCodes");

/**
 * ZohoPaymentProvider
 *
 * Zoho Payments implementation of the PaymentProvider contract, drop-in
 * compatible with the Razorpay provider so the purchase endpoints, webhook and
 * factory stay provider-agnostic.
 *
 * Amount convention: the whole codebase prices in integer MINOR units
 * (amountMinor), but Zoho's APIs take a DECIMAL major-unit amount (e.g.
 * "100.50"). initiateOrder() converts minor -> major exactly once here; every
 * trusted amount the server records elsewhere stays in minor units.
 *
 * Order identity mapping (so the generic endpoints work unchanged):
 *   providerOrderId   <- Zoho payments_session_id  (created server-side here)
 *   providerPaymentId <- Zoho payment_id           (returned by the widget)
 *
 * Signature note: Zoho signs the widget response over `payment_id|session_id`
 * — the REVERSE field order of Razorpay's `order_id|payment_id`. verifyPayment
 * below concatenates accordingly.
 */
class ZohoPaymentProvider extends PaymentProvider
{
    static API_VERSION_PATH = "/api/v1";
    static SESSION_EXPIRY_SECONDS = 900;
    static BUSINESS_NAME = "MindMeld";

    // Minor-unit minimums are converted with this divisor. Every Zoho-supported
    // currency this deployment sells in is 2-decimal, matching the pricing
    // engine's amountMinor = major * 100 convention.
    static MINOR_UNITS_PER_MAJOR = 100;

    static #CURRENCY_SYMBOLS =
    {
        INR: "₹",
        USD: "$",
        EUR: "€",
        GBP: "£",
        AUD: "A$",
        CAD: "C$",
        JPY: "¥",
        SGD: "S$",
        AED: "د.إ"
    };

    #accountId;
    #apiKey;
    #signingKey;

    constructor()
    {
        super();
        this.#accountId = process.env.ZOHO_PAYMENTS_ACCOUNT_ID || "";
        this.#apiKey = process.env.ZOHO_PAYMENTS_API_KEY || "";
        this.#signingKey = process.env.ZOHO_PAYMENTS_SIGNING_KEY || "";
    }

    getProviderEnumValue()
    {
        return paymentProviders.ZOHO;
    }

    isConfigured()
    {
        // initiateOrder needs the account id + OAuth (server) and the widget
        // needs the api key (client). The signing/webhook keys are only used at
        // verification time and degrade with a clear reason if absent.
        return Boolean(this.#accountId && this.#apiKey && ZohoOAuthTokenManager.isConfigured());
    }

    getPublicKeyId()
    {
        return this.#apiKey;
    }

    static #toMajorAmountString(amountMinor)
    {
        const minor = Number(amountMinor) || 0;
        return (minor / ZohoPaymentProvider.MINOR_UNITS_PER_MAJOR).toFixed(2);
    }

    static #currencySymbolFor(currency)
    {
        const code = String(currency || "").toUpperCase();
        return ZohoPaymentProvider.#CURRENCY_SYMBOLS[code] || code;
    }

    /**
     * Builds the Zoho meta_data array (max 5 string key/value pairs) from the
     * order notes so the values echo back on the payment object and webhook for
     * reconciliation / traceability.
     */
    static #buildMetaData(notes)
    {
        if (!notes || typeof notes !== "object")
        {
            return [];
        }

        const metaData = [];
        for (const [key, value] of Object.entries(notes))
        {
            if (metaData.length >= 5)
            {
                break;
            }
            metaData.push({ key: String(key).slice(0, 20), value: String(value).slice(0, 500) });
        }
        return metaData;
    }

    async initiateOrder(amountMinor, currency, metadata)
    {
        if (!this.isConfigured())
        {
            throw new Error("Zoho Payments not configured: missing ZOHO_PAYMENTS_ACCOUNT_ID, ZOHO_PAYMENTS_API_KEY or ZOHO OAuth credentials");
        }

        const accessToken = await ZohoOAuthTokenManager.getAccessToken();
        const amountMajor = ZohoPaymentProvider.#toMajorAmountString(amountMinor);
        const resolvedCurrency = currency || "INR";
        const description = String(metadata?.description || "MindMeld purchase").slice(0, 500);

        const requestBody =
        {
            amount: amountMajor,
            currency: resolvedCurrency,
            description: description,
            reference_number: String(metadata?.receiptId || `mm_${Date.now()}`).slice(0, 50),
            expires_in: ZohoPaymentProvider.SESSION_EXPIRY_SECONDS,
            meta_data: ZohoPaymentProvider.#buildMetaData(metadata?.notes)
        };

        const sessionUrl = `${ZohoRegionConfig.getPaymentsBaseUrl()}${ZohoPaymentProvider.API_VERSION_PATH}/paymentsessions?account_id=${encodeURIComponent(this.#accountId)}`;

        const sessionResponse = await fetch(sessionUrl,
        {
            method: "POST",
            headers:
            {
                "Content-Type": "application/json",
                "Authorization": `Zoho-oauthtoken ${accessToken}`
            },
            body: JSON.stringify(requestBody)
        });

        const responseText = await sessionResponse.text();
        let sessionJson = null;
        try
        {
            sessionJson = JSON.parse(responseText);
        }
        catch (parseError)
        {
            throw new Error(`Zoho payment session creation returned non-JSON: ${sessionResponse.status} ${responseText}`);
        }

        const paymentsSession = sessionJson?.payments_session;
        const paymentsSessionId = paymentsSession?.payments_session_id;
        if (!sessionResponse.ok || !paymentsSessionId)
        {
            const errorMessage = sessionJson?.message || responseText;
            throw new Error(`Zoho payment session creation failed: ${sessionResponse.status} ${errorMessage}`);
        }

        return {
            providerOrderId: paymentsSessionId,
            amountMinor: Number(amountMinor) || 0,
            currency: resolvedCurrency,
            // Everything the browser checkout widget (window.ZPayments) needs.
            // `apiKey` is the publishable key — safe to expose client-side.
            checkoutContext:
            {
                provider: "ZOHO",
                accountId: this.#accountId,
                apiKey: this.#apiKey,
                domain: ZohoRegionConfig.getWidgetDomain(),
                paymentsSessionId: paymentsSessionId,
                amount: amountMajor,
                currencyCode: resolvedCurrency,
                currencySymbol: ZohoPaymentProvider.#currencySymbolFor(resolvedCurrency),
                business: ZohoPaymentProvider.BUSINESS_NAME,
                description: description,
                testMode: ZohoPaymentProvider.#isTestMode()
            }
        };
    }

    static #isTestMode()
    {
        const value = String(process.env.ZOHO_PAYMENTS_TEST_MODE || "").toLowerCase();
        return value === "1" || value === "true" || value === "yes";
    }

    async verifyPayment(payload)
    {
        const { providerOrderId, providerPaymentId, signature } = payload || {};

        if (!providerOrderId || !providerPaymentId || !signature)
        {
            return { verified: false, reason: ErrorCodes.MISSING_FIELDS };
        }

        if (!this.#signingKey)
        {
            return { verified: false, reason: ErrorCodes.SIGNATURE_KEY_NOT_CONFIGURED };
        }

        // Zoho signs `payment_id|payments_session_id` with the Developer-Space
        // signing key. providerPaymentId == payment_id, providerOrderId ==
        // payments_session_id.
        const expectedSignature = crypto
            .createHmac("sha256", this.#signingKey)
            .update(`${providerPaymentId}|${providerOrderId}`)
            .digest("hex");

        const expectedBuffer = Buffer.from(expectedSignature, "utf8");
        const signatureBuffer = Buffer.from(String(signature), "utf8");

        if (expectedBuffer.length !== signatureBuffer.length)
        {
            return { verified: false, reason: ErrorCodes.SIGNATURE_LENGTH_MISMATCH };
        }

        const verified = crypto.timingSafeEqual(expectedBuffer, signatureBuffer);

        return { verified: verified, providerOrderId: providerOrderId, providerPaymentId: providerPaymentId };
    }

    /**
     * Verifies an inbound Zoho webhook. Zoho sends an `X-Zoho-Webhook-Signature`
     * header of the form `t=<unixMillis>,v=<hex>`, where v = HMAC-SHA256 of
     * `<t>.<rawBody>` keyed by the webhook signing secret. The handler MUST pass
     * the EXACT raw bytes — a JSON.parse/stringify round-trip changes whitespace
     * and breaks the HMAC.
     */
    verifyWebhookSignature(rawBody, signatureHeader)
    {
        const webhookSecret = process.env.ZOHO_PAYMENTS_WEBHOOK_SECRET || "";
        if (!webhookSecret)
        {
            return { verified: false, reason: ErrorCodes.WEBHOOK_SECRET_NOT_CONFIGURED };
        }

        if (typeof rawBody !== "string" || typeof signatureHeader !== "string" || signatureHeader.length === 0)
        {
            return { verified: false, reason: ErrorCodes.MISSING_FIELDS };
        }

        const parsed = ZohoPaymentProvider.#parseWebhookSignatureHeader(signatureHeader);
        if (!parsed.timestamp || !parsed.signature)
        {
            return { verified: false, reason: ErrorCodes.INVALID_SIGNATURE };
        }

        const expectedSignature = crypto
            .createHmac("sha256", webhookSecret)
            .update(`${parsed.timestamp}.${rawBody}`)
            .digest("hex");

        const expectedBuffer = Buffer.from(expectedSignature, "utf8");
        const signatureBuffer = Buffer.from(parsed.signature, "utf8");

        if (expectedBuffer.length !== signatureBuffer.length)
        {
            return { verified: false, reason: ErrorCodes.SIGNATURE_LENGTH_MISMATCH };
        }

        const verified = crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
        return { verified: verified };
    }

    static #parseWebhookSignatureHeader(signatureHeader)
    {
        let timestamp = "";
        let signature = "";

        for (const part of String(signatureHeader).split(","))
        {
            const separatorIndex = part.indexOf("=");
            if (separatorIndex === -1)
            {
                continue;
            }
            const key = part.slice(0, separatorIndex).trim();
            const value = part.slice(separatorIndex + 1).trim();
            if (key === "t")
            {
                timestamp = value;
            }
            else if (key === "v")
            {
                signature = value;
            }
        }

        return { timestamp: timestamp, signature: signature };
    }

    async refund(paymentId, amountMinor)
    {
        if (!this.isConfigured())
        {
            throw new Error("Zoho Payments not configured");
        }

        const accessToken = await ZohoOAuthTokenManager.getAccessToken();
        const refundUrl = `${ZohoRegionConfig.getPaymentsBaseUrl()}${ZohoPaymentProvider.API_VERSION_PATH}/refunds?account_id=${encodeURIComponent(this.#accountId)}`;

        const refundResponse = await fetch(refundUrl,
        {
            method: "POST",
            headers:
            {
                "Content-Type": "application/json",
                "Authorization": `Zoho-oauthtoken ${accessToken}`
            },
            body: JSON.stringify
            ({
                payment_id: paymentId,
                amount: ZohoPaymentProvider.#toMajorAmountString(amountMinor)
            })
        });

        const responseText = await refundResponse.text();
        let refundJson = null;
        try
        {
            refundJson = JSON.parse(responseText);
        }
        catch (parseError)
        {
            throw new Error(`Zoho refund returned non-JSON: ${refundResponse.status} ${responseText}`);
        }

        if (!refundResponse.ok)
        {
            const errorMessage = refundJson?.message || responseText;
            throw new Error(`Zoho refund failed: ${refundResponse.status} ${errorMessage}`);
        }

        return refundJson;
    }
}

module.exports = ZohoPaymentProvider;
