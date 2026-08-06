const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const PendingCreditOrderQueryEngine = require("../Database/PendingCreditOrderQueryEngine");
const PendingOrderQueryEngine = require("../Database/PendingOrderQueryEngine");
const CreditDealPaymentQueryEngine = require("../Credits/CreditDealPaymentQueryEngine");
const CreditLedger = require("../Credits/CreditLedger");
const OrganizationCreditLedger = require("../Organization/OrganizationCreditLedger");
const RefundPolicy = require("./RefundPolicy");
const Alerts = require("../Alerts/Alerts");
const { creditTransactionTypes } = require("../../Enumerations/CreditTransactionTypes");
const { creditDealPaymentStatuses } = require("../../Enumerations/CreditDealPaymentStatuses");
const { creditDealTargetTypes } = require("../../Enumerations/CreditDealTargetTypes");
const { deckLicenseStatuses } = require("../../Enumerations/DeckLicenseStatuses");
const { purchaseStatuses } = require("../../Enumerations/PurchaseStatuses");

/**
 * PaymentReversalService
 *
 * Withdraws the entitlement a payment bought, when that payment is reversed.
 *
 * This product does not issue refunds (see RefundPolicy), so reaching this
 * class always means something happened OUTSIDE the application: a chargeback,
 * a bank reversal, or a manual refund from the provider dashboard. That framing
 * drives every decision below — this is exception handling, not a lifecycle
 * step, and it errs towards making noise rather than towards silently tidying
 * up.
 *
 * ── The reversal itself ───────────────────────────────────────────────────
 *
 * Credits are clawed back to a floor of zero, never below. The alternative — a
 * negative balance — would mean a user who spent legitimately-granted credits
 * before the reversal arrives is left unable to use the product until they top
 * up an invisible debt they were never told about. Clawing back what remains
 * and ALERTING on the shortfall puts the decision in front of a human, which is
 * where a "they spent it and took the money back" case belongs. The shortfall
 * is recorded precisely, so nothing is lost by not automating it. An
 * organization's pool follows exactly the same rule through
 * OrganizationCreditLedger.clawBack — an institute is no more able to operate
 * over a hidden debt than a person is.
 *
 * ── What can be attributed ────────────────────────────────────────────────
 *
 * All FOUR flows that take money: a credit top-up, a paid-deck basket, an
 * organization credit deal and a subscription charge. A refund this service
 * cannot attribute to any of them reverses nothing and alerts, which is the
 * correct floor — but it is a floor, not an outcome, so a flow that reaches
 * only the alert would be a gap rather than a design.
 *
 * The first three are attributed by ORDER id, because this server created the
 * order. A subscription charge is not: Razorpay raises it against the mandate
 * on its own schedule, so the only identifier the refund and the grant share is
 * the PAYMENT id — which is exactly what the grant's referenceKey embeds
 * (`subscription:<subscriptionId>:<paymentId>`). Attribution therefore tries
 * the payment id as well as the order id, and a refund carrying no order id at
 * all is no longer an immediate dead end.
 *
 * A reversed subscription charge does stop the NEXT renewal on its own. What it
 * does not do on its own is take back the credits the reversed cycle already
 * granted, or shorten the access that cycle paid for. That is this service's
 * job, and doing it is the difference between "the money went back" and "the
 * entitlement went back".
 *
 * Deck licenses are REVOKED rather than EXPIRED. The two are different facts:
 * expired means the term the buyer paid for ran out, revoked means the purchase
 * was undone. Collapsing them would misreport the reason in support tooling and
 * in the buyer's own library.
 *
 * ── Idempotency ───────────────────────────────────────────────────────────
 *
 * A provider retries a refund webhook exactly as it retries a payment one, so
 * every write here is keyed on the refund id: the ledger clawback through its
 * referenceKey, the licence and purchase updates through status-scoped
 * conditions that match only rows not already reversed, and the reversal record
 * itself through a unique index. Reversing twice would double-charge a user for
 * one chargeback.
 */
class PaymentReversalService
{
    static REFERENCE_KEY_PREFIX = "paymentReversal:";

    // The floor itself lives in CreditLedger.clawBack and
    // OrganizationCreditLedger.clawBack, which enforce it atomically inside
    // their update filters. It is not passed in from here: a caller-supplied
    // floor would be a caller-forgettable floor, and "credits are never taken
    // below zero" is a ledger rule rather than a reversal preference.

    static #COLLECTION_NAME = DatabaseConstants.PAYMENT_REVERSALS_COLLECTION;

    static #indexesEnsured = false;

    static buildReferenceKey(refundId)
    {
        return `${PaymentReversalService.REFERENCE_KEY_PREFIX}${refundId}`;
    }

    static async #getCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return null;
        }

        const collection = database.collection(PaymentReversalService.#COLLECTION_NAME);

        if (!PaymentReversalService.#indexesEnsured)
        {
            try
            {
                await collection.createIndex({ refundId: 1 }, { unique: true });
                // Both id shapes are looked up on the provisioning hot path by
                // hasReversalForPayment / hasReversalForOrder, so neither may
                // be a collection scan.
                await collection.createIndex({ providerPaymentId: 1 });
                await collection.createIndex({ providerOrderId: 1 });
                PaymentReversalService.#indexesEnsured = true;
            }
            catch (indexError)
            {
                console.error("[PaymentReversalService] Failed to ensure indexes:", indexError);
            }
        }

        return collection;
    }

    /**
     * Reverses whatever the given payment bought.
     *
     * @param {{refundId: string, providerPaymentId: string, providerOrderId: string, amountMinor: number, currency: string, eventName: string}} reversal
     * @returns {Promise<{reversed: boolean, flow: string, creditsClawedBack: number, creditShortfall: number, licensesRevoked: number}>}
     */
    static async reverse({ refundId, providerPaymentId, providerOrderId, amountMinor, currency, eventName } = {})
    {
        const outcome =
        {
            reversed: false,
            flow: "UNKNOWN",
            creditsClawedBack: 0,
            creditShortfall: 0,
            licensesRevoked: 0,
            entitlementRolledBack: false,
            organizationId: ""
        };

        const hasOrderId = typeof providerOrderId === "string" && providerOrderId.length > 0;

        // The three order-created flows first, because an order id identifies
        // them exactly and cheaply.
        const creditOrder = hasOrderId ? await PendingCreditOrderQueryEngine.getByOrderId(providerOrderId) : null;
        if (creditOrder)
        {
            outcome.flow = "CREDIT_PURCHASE";
            const clawback = await PaymentReversalService.#clawBackCredits(creditOrder, refundId, providerPaymentId);
            outcome.creditsClawedBack = clawback.clawedBack;
            outcome.creditShortfall = clawback.shortfall;
            outcome.reversed = true;
        }
        else
        {
            const deckOrder = hasOrderId ? await PendingOrderQueryEngine.getByOrderId(providerOrderId) : null;
            if (deckOrder)
            {
                outcome.flow = "PAID_DECK_PURCHASE";
                outcome.licensesRevoked = await PaymentReversalService.#revokeDeckLicenses(deckOrder, providerOrderId);
                outcome.reversed = true;
            }
            else
            {
                // An organization credit deal. Attributed after the other two
                // order flows because it is the rarest, and the most expensive
                // to get wrong: a pool block is the largest single amount this
                // product sells, so a reversal that only alerted would leave an
                // institute holding the largest quantity of credits anyone can
                // hold without having paid for them.
                const dealPayment = hasOrderId ? await CreditDealPaymentQueryEngine.findByOrderId(providerOrderId) : null;
                if (dealPayment && dealPayment.getTargetType() === creditDealTargetTypes.ORGANIZATION_CREDIT_POOL)
                {
                    outcome.flow = "ORGANIZATION_CREDIT_DEAL";
                    outcome.organizationId = dealPayment.getTargetId() || "";
                    const poolClawback = await PaymentReversalService.#clawBackOrganizationCredits(dealPayment, refundId, providerPaymentId);
                    outcome.creditsClawedBack = poolClawback.clawedBack;
                    outcome.creditShortfall = poolClawback.shortfall;
                    outcome.reversed = true;
                }
                else
                {
                    // A subscription charge. Last, and keyed on the PAYMENT id
                    // rather than the order id, because Razorpay raises the
                    // charge itself — there is no order of ours behind it. This
                    // branch is also the reason a missing order id no longer
                    // short-circuits the whole method.
                    const subscriptionReversal = await PaymentReversalService.#reverseSubscriptionCharge(providerPaymentId, refundId);
                    if (subscriptionReversal.attributed)
                    {
                        outcome.flow = "SUBSCRIPTION_CHARGE";
                        outcome.creditsClawedBack = subscriptionReversal.clawedBack;
                        outcome.creditShortfall = subscriptionReversal.shortfall;
                        outcome.entitlementRolledBack = subscriptionReversal.entitlementRolledBack;
                        outcome.reversed = true;
                    }
                }
            }
        }

        // Nothing matched. Alert rather than guess — attributing a reversal to
        // the wrong purchase would revoke a different customer's access.
        if (!outcome.reversed)
        {
            await PaymentReversalService.#raiseUnattributableAlert(refundId, providerPaymentId, eventName);
        }

        // Recorded even when nothing could be attributed, and deliberately so:
        // this row is the durable marker the provisioning paths check before
        // granting (see hasReversalForPayment). A refund that arrives BEFORE
        // the charge it reverses has been provisioned finds nothing to reverse
        // — and without this row, the charge that lands moments later would
        // cheerfully grant credits for money that has already gone back.
        await PaymentReversalService.#record({ refundId, providerPaymentId, providerOrderId, amountMinor, currency, eventName, outcome });

        if (outcome.reversed)
        {
            // The unattributable case has already raised its own, louder alert;
            // a second one saying "flow: UNKNOWN, nothing reversed" would only
            // dilute it.
            await PaymentReversalService.#raiseReversalAlert({ refundId, providerPaymentId, providerOrderId, amountMinor, currency, outcome });
        }

        return outcome;
    }

    /**
     * Removes the granted credits, down to the floor.
     *
     * Delegated to CreditLedger.clawBack rather than to a read-then-charge here.
     * The difference is not stylistic: reading the balance and then issuing a
     * floor-guarded charge lets a spend land in between, at which point the
     * guarded update matches nothing, the referenceKey is consumed by the
     * rejected claim, and the reversal recovers zero — permanently, because
     * every redelivery of the refund webhook then returns alreadyApplied. The
     * ledger re-derives the recoverable amount inside a bounded compare-and-set
     * loop instead, which is the same rule the organization pool has always
     * used. The unique referenceKey still makes a redelivered refund a no-op.
     */
    static async #clawBackCredits(creditOrder, refundId, providerPaymentId)
    {
        const grantedCredits = Number(creditOrder.credits) || 0;
        if (grantedCredits <= 0)
        {
            return { clawedBack: 0, shortfall: 0 };
        }

        // Was this order ever actually granted? A refund can arrive before the
        // capture has been provisioned — the pending order row exists from
        // checkout, so it is findable long before any credits are handed out.
        // Clawing back on the strength of the ORDER rather than the GRANT would
        // take credits the buyer earned or bought elsewhere, to reverse a grant
        // that never happened. When it has not been granted, the reversal row
        // written by the caller is the whole remedy: the completion services
        // check it and refuse to grant afterwards.
        const CreditPurchaseCompletionService = require("../Credits/CreditPurchaseCompletionService");
        const wasGranted = await PaymentReversalService.#wasLedgerEntryApplied
        (
            DatabaseConstants.CREDIT_TRANSACTIONS_COLLECTION,
            CreditPurchaseCompletionService.buildReferenceKey(creditOrder.providerOrderId)
        );

        if (!wasGranted)
        {
            return { clawedBack: 0, shortfall: 0 };
        }

        const clawbackResult = await CreditLedger.clawBack
        (
            creditOrder.userId,
            grantedCredits,
            PaymentReversalService.buildReferenceKey(refundId),
            {
                providerOrderId: creditOrder.providerOrderId,
                providerPaymentId: providerPaymentId || "",
                refundId: refundId,
                grantedCredits: grantedCredits,
                reason: "PAYMENT_REVERSED"
            }
        );

        if (clawbackResult.alreadyApplied === true)
        {
            // A redelivered refund event. The first delivery already took the
            // credits; taking them again would punish the user twice.
            return { clawedBack: 0, shortfall: 0 };
        }

        return { clawedBack: clawbackResult.clawedBack, shortfall: clawbackResult.shortfall };
    }

    /**
     * Reverses a refunded subscription charge: takes back that cycle's credits
     * and rolls the entitlement back to where the cycle started.
     *
     * The attribution runs off the ledger row rather than off any subscription
     * table, because the ledger is the only record that ties a Razorpay payment
     * id to a specific grant of a specific size. Its referenceKey is
     * `subscription:<subscriptionId>:<paymentId>` and its metadata carries both
     * halves, so one indexed lookup answers "which user, which subscription,
     * how many credits" without guessing.
     *
     * A charge that has NOT been provisioned yet is attributed to nothing here
     * and returns attributed=false. That is not a failure: the reversal row is
     * still written by the caller, and PlanSubscriptionService checks for it
     * before granting, so the pair converges whichever way round they arrive.
     *
     * @returns {Promise<{attributed: boolean, clawedBack: number, shortfall: number, entitlementRolledBack: boolean}>}
     */
    static async #reverseSubscriptionCharge(providerPaymentId, refundId)
    {
        const notAttributed = { attributed: false, clawedBack: 0, shortfall: 0, entitlementRolledBack: false };

        if (typeof providerPaymentId !== "string" || providerPaymentId.length === 0)
        {
            return notAttributed;
        }

        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return notAttributed;
        }

        const subscriptionGrant = await database
            .collection(DatabaseConstants.CREDIT_TRANSACTIONS_COLLECTION)
            .findOne
            ({
                type: creditTransactionTypes.SUBSCRIPTION_GRANT,
                "metadata.providerPaymentId": providerPaymentId
            });

        if (!subscriptionGrant)
        {
            return notAttributed;
        }

        const grantedCredits = Math.abs(Number(subscriptionGrant.amount) || 0);
        const userId = subscriptionGrant.userId;
        const providerSubscriptionId = subscriptionGrant?.metadata?.providerSubscriptionId || "";

        let clawback = { clawedBack: 0, shortfall: 0 };
        if (grantedCredits > 0 && userId)
        {
            clawback = await CreditLedger.clawBack
            (
                userId,
                grantedCredits,
                PaymentReversalService.buildReferenceKey(refundId),
                {
                    providerSubscriptionId: providerSubscriptionId,
                    providerPaymentId: providerPaymentId,
                    refundId: refundId,
                    grantedCredits: grantedCredits,
                    reason: "PAYMENT_REVERSED"
                }
            );
        }

        // The credits are only half of it. The cycle also bought ACCESS, and
        // leaving planExpiresAt where the charge pushed it would mean a
        // customer who took their money back keeps a paid plan until the period
        // they no longer paid for runs out.
        let entitlementRolledBack = false;
        if (providerSubscriptionId.length > 0)
        {
            const UserSubscriptionQueryEngine = require("../Database/UserSubscriptionQueryEngine");
            const PlanSubscriptionService = require("../Plans/PlanSubscriptionService");

            const subscription = await UserSubscriptionQueryEngine.getByProviderSubscriptionId(providerSubscriptionId);
            if (subscription)
            {
                const rollbackResult = await PlanSubscriptionService.applyChargeReversal(subscription);
                entitlementRolledBack = rollbackResult.applied === true;
            }
        }

        return {
            attributed: true,
            clawedBack: clawback.alreadyApplied === true ? 0 : clawback.clawedBack,
            shortfall: clawback.alreadyApplied === true ? 0 : clawback.shortfall,
            entitlementRolledBack: entitlementRolledBack
        };
    }

    /**
     * Whether a ledger claim with this reference key ended up APPLIED.
     *
     * Shared by both clawback paths so "did we actually hand this out?" is one
     * question with one answer, asked of the ledger — the only record that
     * knows, since every other row (the pending order, the deal) exists from
     * checkout time regardless of whether anything was ever granted.
     */
    static async #wasLedgerEntryApplied(collectionName, referenceKey)
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return false;
        }

        const ledgerEntry = await database
            .collection(collectionName)
            .findOne({ referenceKey: referenceKey, status: CreditLedger.TRANSACTION_STATUS_APPLIED });

        return ledgerEntry !== null && ledgerEntry !== undefined;
    }

    /**
     * Whether a reversal has already been recorded for a provider order.
     *
     * The order-keyed twin of hasReversalForPayment, read by the three
     * order-created completion services before they grant. Without it, a refund
     * that lands before its capture is provisioned reverses nothing (there is
     * nothing yet to reverse) and the settlement that follows grants in full —
     * leaving the account paid, refunded and provisioned, which is the exact
     * state this pair of checks exists to make unreachable.
     *
     * @param {string} providerOrderId
     * @returns {Promise<boolean>}
     */
    static async hasReversalForOrder(providerOrderId)
    {
        if (typeof providerOrderId !== "string" || providerOrderId.length === 0)
        {
            return false;
        }

        const collection = await PaymentReversalService.#getCollection();
        if (!collection)
        {
            return false;
        }

        const existingReversal = await collection.findOne({ providerOrderId: providerOrderId });
        return existingReversal !== null && existingReversal !== undefined;
    }

    /**
     * Whether a reversal has already been recorded for a provider payment.
     *
     * Read by the provisioning paths BEFORE they grant, which is what makes a
     * refund landing mid-provisioning converge: without it the two events race,
     * and the order "refund first, charge second" ends with an account that is
     * paid, refunded and fully provisioned. Keyed on the payment id because
     * that is the identifier both events share.
     *
     * @param {string} providerPaymentId
     * @returns {Promise<boolean>}
     */
    static async hasReversalForPayment(providerPaymentId)
    {
        if (typeof providerPaymentId !== "string" || providerPaymentId.length === 0)
        {
            return false;
        }

        const collection = await PaymentReversalService.#getCollection();
        if (!collection)
        {
            // No database means no answer. Reporting "not reversed" is the
            // honest default: the grant paths already tolerate a duplicate
            // reversal far better than they tolerate a withheld grant.
            return false;
        }

        const existingReversal = await collection.findOne({ providerPaymentId: providerPaymentId });
        return existingReversal !== null && existingReversal !== undefined;
    }

    /**
     * Removes a reversed block of credits from an organization's pool.
     *
     * The mirror of #clawBackCredits, and it must behave the same way for the
     * same reason: an institute that has already distributed the credits cannot
     * be pushed into a negative pool over a debt nobody told them about, so what
     * cannot be recovered is reported as a shortfall for a human rather than
     * forced through. OrganizationCreditLedger.clawBack carries the floor, the
     * frozen-pool exemption and the idempotency key.
     *
     * The deal is also marked REFUNDED so the admin list and the spend report
     * stop showing it as money received.
     */
    static async #clawBackOrganizationCredits(dealPayment, refundId, providerPaymentId)
    {
        const organizationId = dealPayment.getTargetId();
        const purchasedCredits = Number(dealPayment.getAdditionalData()?.credits) || 0;

        if (!organizationId || purchasedCredits <= 0)
        {
            return { clawedBack: 0, shortfall: 0 };
        }

        // Same rule as the personal clawback: reverse the GRANT, not the deal
        // row. A deal exists from the moment an admin drafts it, so a refund
        // arriving before the pool was credited would otherwise empty a pool
        // the institute filled with a different purchase.
        const wasCredited = await PaymentReversalService.#wasLedgerEntryApplied
        (
            DatabaseConstants.ORGANIZATION_CREDIT_TRANSACTIONS_COLLECTION,
            `orgDeal:${dealPayment.getId()}`
        );

        if (!wasCredited)
        {
            await PaymentReversalService.#markDealRefunded(dealPayment.getProviderOrderId());
            return { clawedBack: 0, shortfall: 0 };
        }

        const clawbackResult = await OrganizationCreditLedger.clawBack
        (
            organizationId,
            purchasedCredits,
            PaymentReversalService.buildReferenceKey(refundId),
            {
                dealId: dealPayment.getId(),
                providerOrderId: dealPayment.getProviderOrderId(),
                providerPaymentId: providerPaymentId || "",
                refundId: refundId,
                purchasedCredits: purchasedCredits,
                reason: "PAYMENT_REVERSED"
            }
        );

        if (clawbackResult.alreadyApplied === true)
        {
            // A redelivered refund event. The first delivery already took the
            // credits; taking them again would charge the institute twice for
            // one chargeback.
            return { clawedBack: 0, shortfall: 0 };
        }

        await PaymentReversalService.#markDealRefunded(dealPayment.getProviderOrderId());

        return { clawedBack: clawbackResult.clawedBack, shortfall: clawbackResult.shortfall };
    }

    /**
     * Flips a captured deal to REFUNDED. Status-scoped so a redelivery matches
     * nothing rather than rewriting a row twice.
     */
    static async #markDealRefunded(providerOrderId)
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database || typeof providerOrderId !== "string" || providerOrderId.length === 0)
        {
            return;
        }

        await database
            .collection(DatabaseConstants.CREDIT_DEAL_PAYMENTS_COLLECTION)
            .updateOne
            (
                { providerOrderId: providerOrderId, status: creditDealPaymentStatuses.CAPTURED },
                { $set: { status: creditDealPaymentStatuses.REFUNDED, refundedAt: new Date() } }
            );
    }

    /**
     * Revokes every licence issued for the reversed order and marks its
     * purchase rows refunded. Scoped to ACTIVE licences so a redelivery cannot
     * re-revoke, and to the exact deck ids the order was created for.
     */
    static async #revokeDeckLicenses(deckOrder, providerOrderId)
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return 0;
        }

        const deckIds = Array.isArray(deckOrder.deckIds) ? deckOrder.deckIds : [];
        if (deckIds.length === 0)
        {
            return 0;
        }

        const nowIsoString = new Date().toISOString();

        const revocationResult = await database
            .collection(DatabaseConstants.DECK_LICENSES_COLLECTION)
            .updateMany
            (
                {
                    userId: deckOrder.userId,
                    deckId: { $in: deckIds },
                    status: deckLicenseStatuses.ACTIVE
                },
                { $set: { status: deckLicenseStatuses.REVOKED, rotatedAt: nowIsoString } }
            );

        await database
            .collection(DatabaseConstants.PURCHASES_COLLECTION)
            .updateMany
            (
                { userId: deckOrder.userId, providerOrderId: providerOrderId, status: purchaseStatuses.COMPLETED },
                { $set: { status: purchaseStatuses.REFUNDED, refundedAt: new Date() } }
            );

        return revocationResult.modifiedCount || 0;
    }

    static async #record({ refundId, providerPaymentId, providerOrderId, amountMinor, currency, eventName, outcome })
    {
        const collection = await PaymentReversalService.#getCollection();
        if (!collection)
        {
            return;
        }

        try
        {
            await collection.insertOne
            ({
                refundId: typeof refundId === "string" ? refundId : "",
                providerPaymentId: providerPaymentId || "",
                providerOrderId: providerOrderId || "",
                amountMinor: Number(amountMinor) || 0,
                currency: typeof currency === "string" ? currency : "",
                eventName: typeof eventName === "string" ? eventName : "",
                flow: outcome.flow,
                reversed: outcome.reversed === true,
                creditsClawedBack: outcome.creditsClawedBack,
                creditShortfall: outcome.creditShortfall,
                licensesRevoked: outcome.licensesRevoked,
                entitlementRolledBack: outcome.entitlementRolledBack === true,
                reversedAt: new Date()
            });
        }
        catch (insertError)
        {
            // A duplicate refundId is the expected outcome of a redelivery, not
            // an error worth surfacing.
            if (insertError?.code !== 11000)
            {
                console.error("[PaymentReversalService] Failed to record the reversal:", insertError);
            }
        }
    }

    static async #raiseReversalAlert({ refundId, providerPaymentId, providerOrderId, amountMinor, currency, outcome })
    {
        const shortfallSentence = outcome.creditShortfall > 0
            ? ` ${outcome.creditShortfall} credits had already been SPENT and could not be recovered — this is a real loss and needs a decision.`
            : "";

        const entitlementSentence = outcome.flow === "SUBSCRIPTION_CHARGE"
            ? ` Plan entitlement ${outcome.entitlementRolledBack ? "was rolled back to the start of the reversed cycle" : "could NOT be rolled back — check the subscription by hand"}.`
            : "";

        await Alerts.raise
        ({
            severity: Alerts.SEVERITY.ERROR,
            source: "PAYMENT_REVERSAL",
            title: "A payment was refunded or charged back",
            message: `${RefundPolicy.describeRefusal()} Refund ${refundId} reversed ${amountMinor} ${currency} for order ${providerOrderId || "(none — subscription charge)"} (${outcome.flow}). Credits clawed back: ${outcome.creditsClawedBack}; licences revoked: ${outcome.licensesRevoked}.${entitlementSentence}${shortfallSentence}`,
            metadata:
            {
                refundId: refundId,
                providerOrderId: providerOrderId,
                providerPaymentId: providerPaymentId,
                flow: outcome.flow,
                organizationId: outcome.organizationId || "",
                creditsClawedBack: outcome.creditsClawedBack,
                creditShortfall: outcome.creditShortfall,
                licensesRevoked: outcome.licensesRevoked,
                entitlementRolledBack: outcome.entitlementRolledBack === true
            }
        });
    }

    static async #raiseUnattributableAlert(refundId, providerPaymentId, eventName)
    {
        await Alerts.raise
        ({
            severity: Alerts.SEVERITY.ERROR,
            source: "PAYMENT_REVERSAL",
            title: "A refund arrived that could not be attributed to an order",
            message: `Refund ${refundId} (${eventName}) carried no order id, so the entitlement it paid for could not be identified and NOTHING was reversed. Check the provider dashboard for payment ${providerPaymentId}.`,
            metadata: { refundId: refundId, providerPaymentId: providerPaymentId, event: eventName }
        });
    }
}

module.exports = PaymentReversalService;
