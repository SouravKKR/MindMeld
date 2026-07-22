const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const RazorpayPlanRecord = require("./RazorpayPlanRecord");
const PaymentProviderFactory = require("./PaymentProviderFactory");
const PlanMetadata = require("../Plans/PlanMetadata");
const { paymentProviders } = require("../../Enumerations/PaymentProviders");
const { planTiers } = require("../../Enumerations/PlanTiers");
const ErrorCodes = require("../../Constants/ErrorCodes");

// Lazily creates and caches a Razorpay Plan per (tier, currency). The unique
// (planTier, currency) index makes creation idempotent under concurrency: if
// two requests race, the loser's insert hits a duplicate-key error and re-reads
// the winner's row. Mirrors the PaymentProviderFactory cache idiom, but
// persisted (a Razorpay Plan id must survive restarts and be reused forever).

class RazorpayPlanRegistry
{
    static #DUPLICATE_KEY_ERROR_CODE = 11000;
    static #indexEnsured = false;

    static async #getCollection()
    {
        const collection = (await DatabaseConnector.getDatabase())
            .collection(DatabaseConstants.RAZORPAY_PLAN_REGISTRY_COLLECTION);
        if (!RazorpayPlanRegistry.#indexEnsured)
        {
            await collection.createIndex({ planTier: 1, currency: 1 }, { unique: true });
            RazorpayPlanRegistry.#indexEnsured = true;
        }
        return collection;
    }

    /**
     * Returns the Razorpay Plan id for a (tier, currency), creating it once if
     * it does not yet exist.
     * @param {number} planTier — planTiers value (must be a paid tier)
     * @param {string} currency — ISO currency code
     * @returns {Promise<{providerPlanId: string}>}
     * @throws {Error} tagged with an ErrorCodes reason when the tier is FREE,
     *   has no configured price in the currency, or the provider is unavailable.
     */
    static async getOrCreatePlanId(planTier, currency)
    {
        const numericTier = Number(planTier);
        const normalizedCurrency = String(currency || "").toUpperCase();

        if (numericTier === planTiers.FREE || !PlanMetadata.isPaidTier(numericTier))
        {
            throw RazorpayPlanRegistry.#taggedError(ErrorCodes.INVALID_PLAN_TIER);
        }

        const amountMinor = PlanMetadata.getPriceMinor(numericTier, normalizedCurrency);
        if (typeof amountMinor !== "number" || amountMinor <= 0)
        {
            throw RazorpayPlanRegistry.#taggedError(ErrorCodes.SUBSCRIPTION_NOT_CONFIGURED);
        }

        const collection = await RazorpayPlanRegistry.#getCollection();

        const existing = await collection.findOne({ planTier: numericTier, currency: normalizedCurrency });
        if (existing && existing.providerPlanId)
        {
            return { providerPlanId: existing.providerPlanId };
        }

        const provider = PaymentProviderFactory.getProvider(paymentProviders.RAZORPAY);
        if (!provider || !provider.isConfigured() || !provider.supportsRecurringSubscriptions())
        {
            throw RazorpayPlanRegistry.#taggedError(ErrorCodes.SUBSCRIPTION_NOT_CONFIGURED);
        }

        const created = await provider.createPlan
        ({
            planTier: numericTier,
            currency: normalizedCurrency,
            amountMinor: amountMinor,
            period: PlanMetadata.getRazorpayPeriod(numericTier),
            interval: PlanMetadata.getRazorpayInterval(numericTier),
            planName: `CogniumLearn ${PlanMetadata.getLabel(numericTier)}`,
            notes: { planTier: String(numericTier), currency: normalizedCurrency }
        });

        const record = new RazorpayPlanRecord
        ({
            planTier: numericTier,
            currency: normalizedCurrency,
            providerPlanId: created.providerPlanId,
            amountMinor: amountMinor,
            createdAt: new Date()
        });

        try
        {
            await collection.insertOne(record.toJson());
            return { providerPlanId: created.providerPlanId };
        }
        catch (insertError)
        {
            // A concurrent caller created the same (tier, currency) plan first.
            // Re-read and return the winner's id. (The extra Razorpay plan we
            // just created is harmless and unused.)
            if (insertError && insertError.code === RazorpayPlanRegistry.#DUPLICATE_KEY_ERROR_CODE)
            {
                const winner = await collection.findOne({ planTier: numericTier, currency: normalizedCurrency });
                if (winner && winner.providerPlanId)
                {
                    return { providerPlanId: winner.providerPlanId };
                }
            }
            throw insertError;
        }
    }

    static #taggedError(reason)
    {
        const error = new Error(reason);
        error.reason = reason;
        return error;
    }
}

module.exports = RazorpayPlanRegistry;
