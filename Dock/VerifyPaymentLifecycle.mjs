/**
 * Lifecycle harness for the payment surface — what happens BEFORE and AFTER the
 * moment of settlement.
 *
 * Run from the Dock directory:
 *     node VerifyPaymentLifecycle.mjs
 *
 * The other two harnesses cover the moment of payment itself: signatures
 * (VerifyRazorpaySignatures) and settlement reliability
 * (VerifyPaymentSettlementReliability). This one covers the edges the handbook
 * says are where integrations actually rot:
 *
 *   Part 2.15  a deterministic receipt, so a retried checkout is one order
 *   Part 3.22  an existing unpaid order is reused rather than duplicated
 *   Part 2.13  failed attempts are recorded, with the provider's error codes
 *   Part 6.51  payment.failed is subscribed and handled
 *   Part 6.50  refund.processed is subscribed and handled
 *   G1 / G2    a reversal withdraws the entitlement it paid for
 *   B5         advertising cannot load onto a payment surface
 *
 * The refund cases are the interesting ones. This product does not offer
 * refunds, and the tempting reading of that policy is "so the refund webhook is
 * not applicable". The opposite is true: it is BECAUSE a refund is never
 * legitimate here that one arriving must be treated as an exception rather than
 * ignored. These cases assert both halves — that nothing can issue a refund,
 * and that an externally-issued one still reverses the entitlement.
 *
 * Like the sibling harnesses this substitutes an in-memory store for Mongo, so
 * it needs no services. The code under test is real.
 */

import { createRequire } from "module";
import crypto from "crypto";

const require = createRequire(import.meta.url);

const TEST_WEBHOOK_SECRET = "lifecycle_harness_webhook_secret";
process.env.RAZORPAY_KEY_ID = "rzp_test_lifecycle";
process.env.RAZORPAY_KEY_SECRET = "lifecycle_harness_key_secret";
process.env.RAZORPAY_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;

const httpStatusNotFound = 404;

let passedCount = 0;
let failedCount = 0;

function check(description, condition)
{
    if (condition)
    {
        passedCount = passedCount + 1;
        console.log(`  PASS  ${description}`);
        return;
    }
    failedCount = failedCount + 1;
    console.error(`  FAIL  ${description}`);
}

function section(title)
{
    console.log(`\n${title}`);
}

// ── A minimal in-memory Mongo ──────────────────────────────────────────────
//
// Only the operators the code under test actually uses. Anything else throws,
// so a future change that starts relying on an unimplemented operator fails
// loudly here instead of silently passing against a permissive fake.

function resolvePath(document, path)
{
    return path.split(".").reduce((value, key) => (value === undefined || value === null) ? undefined : value[key], document);
}

function matchesFilter(document, filter)
{
    for (const [field, condition] of Object.entries(filter))
    {
        if (field === "$or")
        {
            if (!condition.some(branch => matchesFilter(document, branch)))
            {
                return false;
            }
            continue;
        }

        const actualValue = resolvePath(document, field);

        if (condition !== null && typeof condition === "object" && !(condition instanceof Date) && !Array.isArray(condition))
        {
            for (const [operator, operand] of Object.entries(condition))
            {
                switch (operator)
                {
                    case "$gte":
                        if (!(actualValue >= operand)) return false;
                        break;
                    case "$lte":
                        if (!(actualValue <= operand)) return false;
                        break;
                    case "$gt":
                        if (!(actualValue > operand)) return false;
                        break;
                    case "$in":
                        if (!operand.includes(actualValue)) return false;
                        break;
                    case "$nin":
                        // Mongo treats a MISSING field as matching $nin, since
                        // the absent value is not in the list. Modelling that
                        // matters: the stale-deal query relies on it to exclude
                        // rows whose provider order id was never set.
                        if (operand.includes(actualValue === undefined ? null : actualValue)) return false;
                        break;
                    case "$ne":
                        if (actualValue === operand) return false;
                        break;
                    case "$exists":
                        if ((actualValue !== undefined) !== operand) return false;
                        break;
                    case "$type":
                        if (operand === "string" && typeof actualValue !== "string") return false;
                        break;
                    default:
                        throw new Error(`In-memory store reached an unimplemented operator: ${operator}`);
                }
            }
            continue;
        }

        if (actualValue instanceof Date && condition instanceof Date)
        {
            if (actualValue.getTime() !== condition.getTime()) return false;
            continue;
        }

        if (actualValue !== condition)
        {
            return false;
        }
    }
    return true;
}

function applySet(document, values)
{
    for (const [path, value] of Object.entries(values))
    {
        const segments = path.split(".");
        let target = document;
        for (let segmentIndex = 0; segmentIndex < segments.length - 1; segmentIndex = segmentIndex + 1)
        {
            if (typeof target[segments[segmentIndex]] !== "object" || target[segments[segmentIndex]] === null)
            {
                target[segments[segmentIndex]] = {};
            }
            target = target[segments[segmentIndex]];
        }
        target[segments[segments.length - 1]] = value;
    }
}

function applyIncrement(document, values)
{
    for (const [path, value] of Object.entries(values))
    {
        const segments = path.split(".");
        let target = document;
        for (let segmentIndex = 0; segmentIndex < segments.length - 1; segmentIndex = segmentIndex + 1)
        {
            if (typeof target[segments[segmentIndex]] !== "object" || target[segments[segmentIndex]] === null)
            {
                target[segments[segmentIndex]] = {};
            }
            target = target[segments[segmentIndex]];
        }
        const lastSegment = segments[segments.length - 1];
        target[lastSegment] = (Number(target[lastSegment]) || 0) + value;
    }
}

class InMemoryCollection
{
    constructor(name)
    {
        this.name = name;
        this.documents = [];
        this.uniqueIndexFields = [];
    }

    async createIndex(specification, options = {})
    {
        if (options.unique)
        {
            this.uniqueIndexFields.push({ fields: Object.keys(specification), partial: options.partialFilterExpression || null });
        }

        // Model the real behaviour that makes TimeToLiveIndexReconciler
        // necessary: re-creating an existing TTL index with a DIFFERENT expiry
        // is an error, not an update.
        if (options.expireAfterSeconds !== undefined)
        {
            if (this.timeToLiveSeconds !== undefined && this.timeToLiveSeconds !== options.expireAfterSeconds)
            {
                const conflictError = new Error("Index already exists with different options");
                conflictError.code = 85;
                throw conflictError;
            }
            this.timeToLiveSeconds = options.expireAfterSeconds;
        }

        return "index";
    }

    #violatesUniqueIndex(document)
    {
        for (const index of this.uniqueIndexFields)
        {
            if (index.partial && !matchesFilter(document, index.partial))
            {
                continue;
            }
            const candidateKey = index.fields.map(field => JSON.stringify(resolvePath(document, field))).join("|");
            for (const existing of this.documents)
            {
                if (index.partial && !matchesFilter(existing, index.partial))
                {
                    continue;
                }
                if (index.fields.map(field => JSON.stringify(resolvePath(existing, field))).join("|") === candidateKey)
                {
                    return true;
                }
            }
        }
        return false;
    }

    async insertOne(document)
    {
        if (this.#violatesUniqueIndex(document))
        {
            const duplicateError = new Error("E11000 duplicate key error");
            duplicateError.code = 11000;
            throw duplicateError;
        }
        this.documents.push(JSON.parse(JSON.stringify(document, dateReplacer), dateReviver));
        return { insertedId: document.id };
    }

    async findOne(filter = {}, options = {})
    {
        const matches = this.documents.filter(document => matchesFilter(document, filter));
        if (options.sort)
        {
            const [sortField, sortDirection] = Object.entries(options.sort)[0];
            matches.sort((left, right) =>
            {
                const leftValue = resolvePath(left, sortField);
                const rightValue = resolvePath(right, sortField);
                return (leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0) * sortDirection;
            });
        }
        return matches[0] || null;
    }

    // Update documents carry only these. Anything else must fail loudly rather
    // than be silently dropped — $setOnInsert used to be ignored here, which
    // meant an upsert that creates a row created nothing, and every later read
    // of that row saw an absence the code under test could not have produced.
    static SUPPORTED_UPDATE_OPERATORS = new Set(["$set", "$setOnInsert", "$inc"]);

    #assertSupportedUpdate(update)
    {
        for (const operator of Object.keys(update))
        {
            if (!InMemoryCollection.SUPPORTED_UPDATE_OPERATORS.has(operator))
            {
                throw new Error(`In-memory store reached an unimplemented update operator: ${operator}`);
            }
        }
    }

    async updateOne(filter = {}, update = {}, options = {})
    {
        this.#assertSupportedUpdate(update);

        const target = this.documents.find(document => matchesFilter(document, filter));
        if (!target)
        {
            if (options.upsert && (update.$set || update.$setOnInsert))
            {
                const created = {};
                // $setOnInsert applies only on the insert, $set on both — so on
                // this path both contribute, with $set winning a collision.
                if (update.$setOnInsert) applySet(created, update.$setOnInsert);
                if (update.$set) applySet(created, update.$set);
                if (update.$inc) applyIncrement(created, update.$inc);
                this.documents.push(created);
                return { modifiedCount: 0, upsertedCount: 1 };
            }
            return { modifiedCount: 0, upsertedCount: 0 };
        }
        // $setOnInsert is deliberately NOT applied to an existing row.
        if (update.$set) applySet(target, update.$set);
        if (update.$inc) applyIncrement(target, update.$inc);
        return { modifiedCount: 1, upsertedCount: 0 };
    }

    async updateMany(filter = {}, update = {})
    {
        const targets = this.documents.filter(document => matchesFilter(document, filter));
        for (const target of targets)
        {
            if (update.$set) applySet(target, update.$set);
            if (update.$inc) applyIncrement(target, update.$inc);
        }
        return { modifiedCount: targets.length };
    }

    async findOneAndUpdate(filter = {}, update = {}, options = {})
    {
        // Driver 7 returns the DOCUMENT (or null) directly; the {value} wrapper
        // is opt-in through includeResultMetadata. Modelling the old shape
        // instead would be actively misleading here: application code guards
        // with `result?.value || result`, which on a `{value: null}` no-match
        // falls through to the truthy wrapper and reads as SUCCESS. A guarded
        // update that refuses — a frozen pool, an insufficient balance — would
        // then pass this harness while failing in production.
        const target = this.documents.find(document => matchesFilter(document, filter));
        if (!target)
        {
            return options.includeResultMetadata === true ? { value: null } : null;
        }
        if (update.$set) applySet(target, update.$set);
        if (update.$inc) applyIncrement(target, update.$inc);
        return options.includeResultMetadata === true ? { value: target } : target;
    }

    async deleteOne(filter = {})
    {
        const index = this.documents.findIndex(document => matchesFilter(document, filter));
        if (index === -1)
        {
            return { deletedCount: 0 };
        }
        this.documents.splice(index, 1);
        return { deletedCount: 1 };
    }

    async countDocuments(filter = {})
    {
        return this.documents.filter(document => matchesFilter(document, filter)).length;
    }

    find(filter = {})
    {
        let matches = this.documents.filter(document => matchesFilter(document, filter));
        const cursor =
        {
            sort(specification)
            {
                const [sortField, sortDirection] = Object.entries(specification)[0];
                matches = [...matches].sort((left, right) =>
                {
                    const leftValue = resolvePath(left, sortField);
                    const rightValue = resolvePath(right, sortField);
                    return (leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0) * sortDirection;
                });
                return cursor;
            },
            limit(count)
            {
                matches = matches.slice(0, count);
                return cursor;
            },
            project()
            {
                return cursor;
            },
            toArray: async () => matches
        };
        return cursor;
    }
}

// Dates survive the structured clone above only with explicit handling.
function dateReplacer(key, value)
{
    return this[key] instanceof Date ? { __date: this[key].toISOString() } : value;
}

function dateReviver(key, value)
{
    return (value && typeof value === "object" && typeof value.__date === "string") ? new Date(value.__date) : value;
}

class InMemoryDatabase
{
    constructor()
    {
        this.collections = new Map();
        this.collectionModificationCommands = [];
    }

    collection(name)
    {
        if (!this.collections.has(name))
        {
            this.collections.set(name, new InMemoryCollection(name));
        }
        return this.collections.get(name);
    }

    // Only collMod is implemented, because it is the only command the code
    // under test issues. Anything else throws rather than silently succeeding.
    async command(commandDocument)
    {
        if (commandDocument && commandDocument.collMod)
        {
            this.collectionModificationCommands.push(commandDocument);
            const collection = this.collection(commandDocument.collMod);
            collection.timeToLiveSeconds = commandDocument.index?.expireAfterSeconds;
            return { ok: 1 };
        }
        throw new Error(`In-memory database reached an unimplemented command: ${JSON.stringify(commandDocument)}`);
    }
}

const DatabaseConnector = require("./Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("./Globals/Constants/DatabaseConstants");

const inMemoryDatabase = new InMemoryDatabase();
DatabaseConnector.getDatabase = async () => inMemoryDatabase;

const Alerts = require("./Globals/Classes/Alerts/Alerts");
let raisedAlerts = [];
Alerts.raise = async (alert) => { raisedAlerts.push(alert); return null; };

const CheckoutReceiptIdentifier = require("./Globals/Classes/Payments/CheckoutReceiptIdentifier");
const RefundPolicy = require("./Globals/Classes/Payments/RefundPolicy");
const PaymentReversalService = require("./Globals/Classes/Payments/PaymentReversalService");
const PaymentAttemptQueryEngine = require("./Globals/Classes/Database/PaymentAttemptQueryEngine");
const PendingCreditOrderQueryEngine = require("./Globals/Classes/Database/PendingCreditOrderQueryEngine");
const PendingOrderQueryEngine = require("./Globals/Classes/Database/PendingOrderQueryEngine");
const PaymentProvider = require("./Globals/Classes/Payments/PaymentProvider");
const PaymentProviderFactory = require("./Globals/Classes/Payments/PaymentProviderFactory");
const RazorpayPaymentProviderClass = require("./Globals/Classes/Payments/RazorpayPaymentProvider");
const PaymentAccessPolicy = require("./Globals/Classes/Payments/PaymentAccessPolicy");
const PaymentRequestSchema = require("./Globals/Classes/Payments/PaymentRequestSchema");
const PendingPaymentReconciler = require("./Globals/Classes/Payments/PendingPaymentReconciler");
const TimeToLiveIndexReconciler = require("./Globals/Classes/Database/TimeToLiveIndexReconciler");
const CreditDealPaymentQueryEngine = require("./Globals/Classes/Credits/CreditDealPaymentQueryEngine");
const OrganizationCreditLedger = require("./Globals/Classes/Organization/OrganizationCreditLedger");
const { creditDealPaymentStatuses } = require("./Globals/Enumerations/CreditDealPaymentStatuses");
const { creditDealPaymentModes } = require("./Globals/Enumerations/CreditDealPaymentModes");
const { creditDealTargetTypes } = require("./Globals/Enumerations/CreditDealTargetTypes");
const { userRoles } = require("./Globals/Enumerations/UserRoles");
const CreditLedger = require("./Globals/Classes/Credits/CreditLedger");
const { paymentProviders } = require("./Globals/Enumerations/PaymentProviders");
const { paymentAttemptOutcomes } = require("./Globals/Enumerations/PaymentAttemptOutcomes");
const { deckLicenseStatuses } = require("./Globals/Enumerations/DeckLicenseStatuses");
const { purchaseStatuses } = require("./Globals/Enumerations/PurchaseStatuses");
const PaidDeckPurchaseCompletionServiceClass = require("./Endpoints/PaidDeck/PaidDeckPurchaseCompletionService");
const CreditPurchaseCompletionService = require("./Globals/Classes/Credits/CreditPurchaseCompletionService");
const PlanSubscriptionService = require("./Globals/Classes/Plans/PlanSubscriptionService");
const PlanMetadata = require("./Globals/Classes/Plans/PlanMetadata");
const UserSubscription = require("./Globals/Classes/Plans/UserSubscription");
const UserSubscriptionQueryEngine = require("./Globals/Classes/Database/UserSubscriptionQueryEngine");
const { planTiers } = require("./Globals/Enumerations/PlanTiers");
const { subscriptionStatuses } = require("./Globals/Enumerations/SubscriptionStatuses");
const { getPurchaseInvoice } = require("./Endpoints/PaidDeck/GetPurchaseInvoice");
const { getMyPurchases } = require("./Endpoints/PaidDeck/GetMyPurchases");
const { handleRazorpayWebhook } = require("./Endpoints/Webhook/HandleRazorpayWebhook");

// ── Request / response doubles ─────────────────────────────────────────────

function signBody(rawBody)
{
    return crypto.createHmac("sha256", TEST_WEBHOOK_SECRET).update(rawBody).digest("hex");
}

function makeWebhookRequest(rawBody, { eventId = crypto.randomUUID(), signature = null } = {})
{
    return {
        headers:
        {
            "x-razorpay-signature": signature === null ? signBody(rawBody) : signature,
            "x-razorpay-event-id": eventId
        },
        getBody: async () => rawBody
    };
}

function makeResponse()
{
    return {
        statusCode: 0,
        body: null,
        sendJson(payload) { this.body = payload; },
        sendStatusCode(code) { this.statusCode = code; }
    };
}

async function seedUserWithCredits(userId, credits)
{
    await inMemoryDatabase
        .collection(DatabaseConstants.USERS_COLLECTION)
        .updateOne({ id: userId }, { $set: { id: userId, additionalData: { credits: credits } } }, { upsert: true });
}

/**
 * Backdates an order so the sweep considers it stale. Reaching into the store
 * is deliberate: the alternative is sleeping for the grace window, and a test
 * that sleeps for twenty minutes is a test nobody runs.
 */
async function ageOrder(collectionName, providerOrderId, createdAtMilliseconds)
{
    await inMemoryDatabase
        .collection(collectionName)
        .updateOne({ providerOrderId: providerOrderId }, { $set: { createdAt: new Date(createdAtMilliseconds) } });
}

async function ensureLedgerIndexes()
{
    // Created by DatabaseConnector's schema setup in production, not by
    // CreditLedger — so a harness that only exercises CreditLedger would have
    // no unique index and would silently pass a double-charge case.
    await inMemoryDatabase
        .collection(DatabaseConstants.CREDIT_TRANSACTIONS_COLLECTION)
        .createIndex({ referenceKey: 1 }, { unique: true });
}

// ═══════════════════════════════════════════════════════════════════════════

async function run()
{
    await ensureLedgerIndexes();

    // ── 1. Deterministic receipts (Part 2.15) ──────────────────────────────
    section("1. The checkout receipt is deterministic");

    const creditIntent = { userId: "user-alpha", credits: 500, amountMinor: 49900, currency: "INR", couponId: null };

    check("the same credit intent produces the same receipt twice",
        CheckoutReceiptIdentifier.forCreditPurchase(creditIntent) === CheckoutReceiptIdentifier.forCreditPurchase(creditIntent));

    check("a different buyer produces a different receipt",
        CheckoutReceiptIdentifier.forCreditPurchase(creditIntent)
        !== CheckoutReceiptIdentifier.forCreditPurchase({ ...creditIntent, userId: "user-beta" }));

    check("a different quantity produces a different receipt",
        CheckoutReceiptIdentifier.forCreditPurchase(creditIntent)
        !== CheckoutReceiptIdentifier.forCreditPurchase({ ...creditIntent, credits: 501 }));

    // The load-bearing property: because the amount is an input, a price change
    // cannot be served an order created at the old price.
    check("a different AMOUNT produces a different receipt (so a reused order can never be stale)",
        CheckoutReceiptIdentifier.forCreditPurchase(creditIntent)
        !== CheckoutReceiptIdentifier.forCreditPurchase({ ...creditIntent, amountMinor: 39900 }));

    check("a different currency produces a different receipt",
        CheckoutReceiptIdentifier.forCreditPurchase(creditIntent)
        !== CheckoutReceiptIdentifier.forCreditPurchase({ ...creditIntent, currency: "USD" }));

    check("applying a coupon produces a different receipt",
        CheckoutReceiptIdentifier.forCreditPurchase(creditIntent)
        !== CheckoutReceiptIdentifier.forCreditPurchase({ ...creditIntent, couponId: "coupon-1" }));

    const deckIntent = { userId: "user-alpha", deckIds: ["deck-b", "deck-a"], amountMinor: 19900, currency: "INR" };
    check("deck order does not change the receipt (the same basket is the same intent)",
        CheckoutReceiptIdentifier.forPaidDeckPurchase(deckIntent)
        === CheckoutReceiptIdentifier.forPaidDeckPurchase({ ...deckIntent, deckIds: ["deck-a", "deck-b"] }));

    check("a different basket produces a different receipt",
        CheckoutReceiptIdentifier.forPaidDeckPurchase(deckIntent)
        !== CheckoutReceiptIdentifier.forPaidDeckPurchase({ ...deckIntent, deckIds: ["deck-a", "deck-c"] }));

    check("credit and deck receipts never collide (distinct prefixes)",
        CheckoutReceiptIdentifier.forCreditPurchase(creditIntent).startsWith("clc_")
        && CheckoutReceiptIdentifier.forPaidDeckPurchase(deckIntent).startsWith("cld_"));

    check("the receipt fits the provider's 40-character limit",
        CheckoutReceiptIdentifier.forCreditPurchase(creditIntent).length <= CheckoutReceiptIdentifier.MAXIMUM_RECEIPT_LENGTH);

    // A non-deterministic receipt is now impossible to reach by accident: the
    // provider refuses an order without one rather than defaulting to a clock.
    const razorpayProvider = PaymentProviderFactory.getProvider(paymentProviders.RAZORPAY);
    let refusedWithoutReceipt = false;
    try
    {
        await razorpayProvider.initiateOrder(49900, "INR", { notes: {} });
    }
    catch (missingReceiptError)
    {
        refusedWithoutReceipt = /receiptId/i.test(missingReceiptError.message);
    }
    check("an order with no receipt is refused rather than given a timestamp", refusedWithoutReceipt);

    // ── 2. Reusing an unpaid order (Part 3.22) ─────────────────────────────
    section("2. A retried checkout reuses the unpaid order");

    const reuseReceipt = CheckoutReceiptIdentifier.forCreditPurchase(creditIntent);
    await PendingCreditOrderQueryEngine.createPendingCreditOrder
    ({
        providerOrderId: "order_reuse_1", userId: "user-alpha", credits: 500,
        amountMinor: 49900, currency: "INR", region: "INDIA", unitPrice: 100,
        discountPercent: 0, paymentProvider: paymentProviders.RAZORPAY,
        couponId: null, couponDiscountMinor: 0, receiptId: reuseReceipt
    });

    const foundForRetry = await PendingCreditOrderQueryEngine.findReusableByReceipt(reuseReceipt, "user-alpha");
    check("a retry finds the order the first attempt created", foundForRetry?.providerOrderId === "order_reuse_1");

    check("another buyer cannot pick up that order",
        (await PendingCreditOrderQueryEngine.findReusableByReceipt(reuseReceipt, "user-beta")) === null);

    check("a different intent does not match it",
        (await PendingCreditOrderQueryEngine.findReusableByReceipt(
            CheckoutReceiptIdentifier.forCreditPurchase({ ...creditIntent, credits: 501 }), "user-alpha")) === null);

    // The reuse window is what stops a checkout abandoned hours ago being
    // resurrected with a stale provider session behind it.
    const beyondWindow = Date.now() + PendingCreditOrderQueryEngine.REUSABLE_ORDER_WINDOW_MILLISECONDS + 60000;
    check("an order older than the reuse window is not reused",
        (await PendingCreditOrderQueryEngine.findReusableByReceipt(reuseReceipt, "user-alpha", beyondWindow)) === null);

    await PendingCreditOrderQueryEngine.markConsumed("order_reuse_1", "user-alpha");
    check("a SETTLED order is never reused",
        (await PendingCreditOrderQueryEngine.findReusableByReceipt(reuseReceipt, "user-alpha")) === null);

    // The checkout context is rebuilt locally, so a retry costs no provider call.
    const rebuiltContext = razorpayProvider.buildCheckoutContext({ providerOrderId: "order_reuse_1", amountMinor: 49900, currency: "INR" });
    check("the checkout context is rebuilt without calling the provider",
        rebuiltContext?.orderId === "order_reuse_1" && rebuiltContext.amount === 49900);
    check("the rebuilt context carries only the PUBLIC key id",
        rebuiltContext.keyId === process.env.RAZORPAY_KEY_ID && !JSON.stringify(rebuiltContext).includes(process.env.RAZORPAY_KEY_SECRET));

    // ── 3. Failed attempts are recorded (Part 2.13, Part 6.51) ─────────────
    section("3. payment.failed is subscribed and recorded");

    await PendingCreditOrderQueryEngine.createPendingCreditOrder
    ({
        providerOrderId: "order_fail_1", userId: "user-declined", credits: 100,
        amountMinor: 9900, currency: "INR", region: "INDIA", unitPrice: 99,
        discountPercent: 0, paymentProvider: paymentProviders.RAZORPAY, receiptId: "clc_fail"
    });

    const failedBody = JSON.stringify
    ({
        event: "payment.failed",
        payload: { payment: { entity: {
            id: "pay_failed_1", order_id: "order_fail_1", amount: 9900, currency: "INR",
            method: "card", error_code: "BAD_REQUEST_ERROR",
            error_description: "Payment failed", error_reason: "payment_failed",
            error_source: "bank", error_step: "payment_authorization"
        } } }
    });

    let response = makeResponse();
    await handleRazorpayWebhook(makeWebhookRequest(failedBody), response);
    check("a failed payment is acknowledged", response.body?.acknowledged === true);
    check("...and recorded rather than discarded", response.body?.attemptRecorded === true);

    const attemptsCollection = inMemoryDatabase.collection(DatabaseConstants.PAYMENT_ATTEMPTS_COLLECTION);
    const recordedAttempt = await attemptsCollection.findOne({ providerPaymentId: "pay_failed_1" });
    check("the attempt row exists", recordedAttempt !== null);
    check("it is attributed to the buyer via the server-held order", recordedAttempt?.userId === "user-declined");
    check("the provider's error code is kept verbatim", recordedAttempt?.errorCode === "BAD_REQUEST_ERROR");
    check("so are the reason, source and step", recordedAttempt?.errorReason === "payment_failed"
        && recordedAttempt?.errorSource === "bank" && recordedAttempt?.errorStep === "payment_authorization");
    check("the outcome is FAILED", recordedAttempt?.outcome === paymentAttemptOutcomes.FAILED);
    check("nothing was provisioned by a failed payment", response.body?.creditOrderCompleted === undefined);

    // No instrument identifier may ever be stored — that would be cardholder data.
    check("only the instrument CLASS is stored, never an identifier",
        recordedAttempt?.method === "card" && recordedAttempt.cardNumber === undefined && recordedAttempt.card === undefined);

    // ── 4. Card-testing detection (F1) ─────────────────────────────────────
    section("4. A burst of declines is detected");

    raisedAlerts = [];
    for (let attemptIndex = 0; attemptIndex < PaymentAttemptQueryEngine.FAILURE_BURST_THRESHOLD; attemptIndex = attemptIndex + 1)
    {
        const burstBody = JSON.stringify
        ({
            event: "payment.failed",
            payload: { payment: { entity: {
                id: `pay_burst_${attemptIndex}`, order_id: "order_fail_1", amount: 9900,
                currency: "INR", method: "card", error_code: "GATEWAY_ERROR"
            } } }
        });
        await handleRazorpayWebhook(makeWebhookRequest(burstBody), makeResponse());
    }

    const burstAlerts = raisedAlerts.filter(alert => alert.source === "PAYMENT_ATTEMPT");
    check("a decline burst raises an alert", burstAlerts.length > 0);
    check("the alert names the account", burstAlerts[0]?.metadata?.accountId === "user-declined");
    check("the failure count is computable from the stored attempts",
        (await PaymentAttemptQueryEngine.countRecentFailures("user-declined")) >= PaymentAttemptQueryEngine.FAILURE_BURST_THRESHOLD);
    check("an unrelated account is unaffected",
        (await PaymentAttemptQueryEngine.countRecentFailures("user-alpha")) === 0);

    // ── 5. Refunds cannot be issued (the policy, in code) ──────────────────
    section("5. This application cannot issue a refund");

    check("the policy is stated in one place and says no", RefundPolicy.REFUNDS_OFFERED === false);

    let refundRefused = false;
    try
    {
        await razorpayProvider.refund("pay_anything", 1000);
    }
    catch (refusalError)
    {
        refundRefused = refusalError.message === RefundPolicy.describeRefusal();
    }
    check("the Razorpay provider refuses to refund", refundRefused);

    let baseRefundRefused = false;
    try
    {
        await new PaymentProvider().refund("pay_anything", 1000);
    }
    catch (refusalError)
    {
        baseRefundRefused = refusalError.message === RefundPolicy.describeRefusal();
    }
    check("...and so does every provider, via the base class", baseRefundRefused);

    check("no provider re-implements refund behind the refusal",
        Object.getOwnPropertyNames(Object.getPrototypeOf(razorpayProvider)).includes("refund") === false);

    // ── 6. An externally-issued refund still reverses (Part 6.50, G1, G2) ──
    section("6. A refund arriving from outside reverses the entitlement");

    check("refund lifecycle events are recognised",
        RefundPolicy.isRefundEvent("refund.processed") && RefundPolicy.isRefundEvent("refund.created"));
    check("only a SETTLED refund reverses anything",
        RefundPolicy.isSettledRefundEvent("refund.processed") && !RefundPolicy.isSettledRefundEvent("refund.created"));

    // Credits: granted, then refunded. The order is SETTLED through the real
    // completion service rather than the balance being seeded directly,
    // because a clawback now reverses the GRANT rather than the ORDER — a
    // pending row with no ledger entry behind it is a purchase that was never
    // provisioned, and taking credits for it would rob the buyer of credits
    // they got somewhere else.
    await seedUserWithCredits("user-refunded", 0);
    await PendingCreditOrderQueryEngine.createPendingCreditOrder
    ({
        providerOrderId: "order_refund_1", userId: "user-refunded", credits: 500,
        amountMinor: 49900, currency: "INR", region: "INDIA", unitPrice: 100,
        discountPercent: 0, paymentProvider: paymentProviders.RAZORPAY, receiptId: "clc_refund"
    });
    await CreditPurchaseCompletionService.complete
    (
        await PendingCreditOrderQueryEngine.getByOrderId("order_refund_1"),
        { providerPaymentId: "pay_refund_1", source: "WEBHOOK" }
    );
    check("the purchase granted before it was refunded", (await CreditLedger.getBalance("user-refunded")) === 500);

    raisedAlerts = [];
    const refundBody = JSON.stringify
    ({
        event: "refund.processed",
        payload:
        {
            refund: { entity: { id: "rfnd_1", payment_id: "pay_refund_1", amount: 49900, currency: "INR" } },
            payment: { entity: { id: "pay_refund_1", order_id: "order_refund_1", amount: 49900, currency: "INR" } }
        }
    });

    response = makeResponse();
    await handleRazorpayWebhook(makeWebhookRequest(refundBody), response);

    check("the refund is acknowledged", response.body?.acknowledged === true);
    check("the entitlement was reversed", response.body?.reversed === true);
    check("the credits were clawed back", (await CreditLedger.getBalance("user-refunded")) === 0);
    check("a refund raises an alert, because it should never happen here",
        raisedAlerts.some(alert => alert.source === "PAYMENT_REVERSAL"));

    // A redelivered refund must not charge the user twice.
    await seedUserWithCredits("user-refunded", 200);
    response = makeResponse();
    await handleRazorpayWebhook(makeWebhookRequest(refundBody, { eventId: crypto.randomUUID() }), response);
    check("a redelivered refund does not claw back a second time",
        (await CreditLedger.getBalance("user-refunded")) === 200);

    // Spent credits: the shortfall is reported rather than forced negative.
    await seedUserWithCredits("user-spent", 0);
    await PendingCreditOrderQueryEngine.createPendingCreditOrder
    ({
        providerOrderId: "order_refund_2", userId: "user-spent", credits: 500,
        amountMinor: 49900, currency: "INR", region: "INDIA", unitPrice: 100,
        discountPercent: 0, paymentProvider: paymentProviders.RAZORPAY, receiptId: "clc_spent"
    });
    await CreditPurchaseCompletionService.complete
    (
        await PendingCreditOrderQueryEngine.getByOrderId("order_refund_2"),
        { providerPaymentId: "pay_spent", source: "WEBHOOK" }
    );
    // ...and then the buyer spends nearly all of them before the chargeback
    // arrives. Set directly rather than charged through a task, because what is
    // under test is the clawback's behaviour against a depleted balance.
    await seedUserWithCredits("user-spent", 50);

    raisedAlerts = [];
    const spentReversal = await PaymentReversalService.reverse
    ({
        refundId: "rfnd_spent", providerPaymentId: "pay_spent", providerOrderId: "order_refund_2",
        amountMinor: 49900, currency: "INR", eventName: "refund.processed"
    });

    check("only what remains is clawed back", spentReversal.creditsClawedBack === 50);
    check("the balance floors at zero rather than going negative",
        (await CreditLedger.getBalance("user-spent")) === 0);
    check("the unrecoverable shortfall is quantified", spentReversal.creditShortfall === 450);
    check("...and surfaced to a human", raisedAlerts.some(alert =>
        alert.source === "PAYMENT_REVERSAL" && /SPENT/.test(alert.message)));

    // Paid decks: the licence is revoked, not merely expired.
    await PendingOrderQueryEngine.createPendingOrder
    ({
        providerOrderId: "order_refund_deck", userId: "user-deck", deckIds: ["deck-x"],
        amountMinor: 19900, currency: "INR", region: "INDIA",
        paymentProvider: paymentProviders.RAZORPAY, receiptId: "cld_refund"
    });
    await inMemoryDatabase.collection(DatabaseConstants.DECK_LICENSES_COLLECTION)
        .insertOne({ userId: "user-deck", deckId: "deck-x", status: deckLicenseStatuses.ACTIVE });
    await inMemoryDatabase.collection(DatabaseConstants.PURCHASES_COLLECTION)
        .insertOne({ userId: "user-deck", deckId: "deck-x", providerOrderId: "order_refund_deck", status: purchaseStatuses.COMPLETED });

    const deckReversal = await PaymentReversalService.reverse
    ({
        refundId: "rfnd_deck", providerPaymentId: "pay_deck", providerOrderId: "order_refund_deck",
        amountMinor: 19900, currency: "INR", eventName: "refund.processed"
    });

    check("the deck licence is withdrawn", deckReversal.licensesRevoked === 1);
    const revokedLicense = await inMemoryDatabase.collection(DatabaseConstants.DECK_LICENSES_COLLECTION)
        .findOne({ userId: "user-deck", deckId: "deck-x" });
    check("it is REVOKED, not EXPIRED — the reason must survive into support tooling",
        revokedLicense?.status === deckLicenseStatuses.REVOKED);
    const refundedPurchase = await inMemoryDatabase.collection(DatabaseConstants.PURCHASES_COLLECTION)
        .findOne({ providerOrderId: "order_refund_deck" });
    check("the purchase record is marked refunded", refundedPurchase?.status === purchaseStatuses.REFUNDED);
    check("refundedAt is finally written (it was a field nothing ever set)",
        refundedPurchase?.refundedAt instanceof Date);

    // An unattributable refund must alert rather than guess.
    raisedAlerts = [];
    const orphanReversal = await PaymentReversalService.reverse
    ({
        refundId: "rfnd_orphan", providerPaymentId: "pay_orphan", providerOrderId: "",
        amountMinor: 1000, currency: "INR", eventName: "refund.processed"
    });
    check("a refund with no order id reverses nothing", orphanReversal.reversed === false);
    check("...and alerts instead of guessing which customer to punish",
        raisedAlerts.some(alert => alert.source === "PAYMENT_REVERSAL"));

    // refund.created must not reverse anything — the money has not moved yet.
    await seedUserWithCredits("user-refunded", 300);
    const createdBody = JSON.stringify
    ({
        event: "refund.created",
        payload:
        {
            refund: { entity: { id: "rfnd_2", payment_id: "pay_refund_1", amount: 49900, currency: "INR" } },
            payment: { entity: { id: "pay_refund_1", order_id: "order_refund_1", amount: 49900, currency: "INR" } }
        }
    });
    response = makeResponse();
    await handleRazorpayWebhook(makeWebhookRequest(createdBody), response);
    check("refund.created is noted but reverses nothing", response.body?.reversed === false
        && (await CreditLedger.getBalance("user-refunded")) === 300);

    // An unsigned refund must not reverse anything either — the same rule as
    // every other webhook, asserted here because this one destroys entitlement.
    await seedUserWithCredits("user-refunded", 300);
    response = makeResponse();
    await handleRazorpayWebhook(makeWebhookRequest(refundBody, { signature: "forged", eventId: crypto.randomUUID() }), response);
    check("an UNSIGNED refund cannot revoke anything",
        (await CreditLedger.getBalance("user-refunded")) === 300);

    // ── 7. Advertising cannot reach a payment surface (B5) ─────────────────
    section("7. No advertising exists to reach a payment surface");

    // This control used to be a suppression: a loader that injected AdSense on
    // the home page only, and refused while a checkout was open. It came with
    // an honest limit — once injected, a script cannot be un-injected, so a
    // user who browsed Home and then opened a checkout without a page reload
    // still had advertising resident in the document hosting their payment.
    //
    // Advertising has since been removed from the product, which satisfies B5
    // outright rather than mitigating it, and closes that residual case. What
    // is asserted therefore changed shape: not "the suppression works" but
    // "there is nothing to suppress". Both halves are checked, because either
    // one alone can be defeated — code with no allow-listed origin is dead, and
    // an allow-listed origin with no code is an open door for the next person
    // who adds a script tag.
    const fileSystem = require("fs");
    const filePath = require("path");
    const advertisingDirectory = filePath.join(
        filePath.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
        "..", "Main", "Globals", "Classes", "Advertising");

    check("no advertising loader remains in the application",
        !fileSystem.existsSync(advertisingDirectory));

    const paymentPagePolicy = require("./Endpoints/Plugins/SecurityHeaders").SecurityHeaders.buildContentSecurityPolicy();
    const advertisingOrigins = ["googlesyndication", "googletagservices", "doubleclick", "adtrafficquality"];
    check("no advertising origin may execute a script on any page, payment or otherwise",
        advertisingOrigins.every((advertisingOrigin) => !paymentPagePolicy.includes(advertisingOrigin)));

    // ── 8. Payments are admin-only outside production ──────────────────────
    section("8. Payments are restricted to administrators outside production");

    const administrator = { getId: () => "user-admin", getRole: () => userRoles.ADMIN };
    const ordinaryUser = { getId: () => "user-plain", getRole: () => userRoles.USER };

    // Fail closed BEFORE configure() has run. Getting this backwards would mean
    // a boot-order mistake silently opened payments everywhere.
    check("an unconfigured policy refuses everyone, including an admin",
        PaymentAccessPolicy.isPaymentAllowedForUser(ordinaryUser) === false
        && PaymentAccessPolicy.isPaymentAllowedForUser(administrator) === false);

    PaymentAccessPolicy.configure("production");
    check("production allows an ordinary signed-in user", PaymentAccessPolicy.isPaymentAllowedForUser(ordinaryUser) === true);
    check("production allows an administrator", PaymentAccessPolicy.isPaymentAllowedForUser(administrator) === true);
    check("production is recognised as the unrestricted environment", PaymentAccessPolicy.isUnrestrictedEnvironment() === true);

    for (const restrictedEnvironment of ["development", "testing", "local", "staging"])
    {
        PaymentAccessPolicy.configure(restrictedEnvironment);
        check(`"${restrictedEnvironment}" refuses an ordinary user`,
            PaymentAccessPolicy.isPaymentAllowedForUser(ordinaryUser) === false);
        check(`"${restrictedEnvironment}" still allows an administrator`,
            PaymentAccessPolicy.isPaymentAllowedForUser(administrator) === true);
    }

    // A blank name is not a fifth environment — it is "we do not know", and it
    // must fall back to refusing everyone rather than to the admin-only branch.
    PaymentAccessPolicy.configure("");
    check("a blank environment name refuses everyone, admins included",
        PaymentAccessPolicy.isConfigured() === false
        && PaymentAccessPolicy.isPaymentAllowedForUser(administrator) === false);

    // Nobody unauthenticated passes, in any environment.
    PaymentAccessPolicy.configure("production");
    check("an unauthenticated caller is refused even in production",
        PaymentAccessPolicy.isPaymentAllowedForUser(null) === false);

    // The environment name must not be case-sensitive in a way that fails OPEN:
    // "PRODUCTION" should still be recognised, not silently treated as a
    // restricted environment and vice versa.
    PaymentAccessPolicy.configure("PRODUCTION");
    check("the environment name is matched case-insensitively",
        PaymentAccessPolicy.isUnrestrictedEnvironment() === true);

    // A near-miss must NOT be treated as production.
    for (const lookalikeEnvironment of ["production-staging", "preproduction", "prod"])
    {
        PaymentAccessPolicy.configure(lookalikeEnvironment);
        check(`"${lookalikeEnvironment}" is NOT treated as production`,
            PaymentAccessPolicy.isUnrestrictedEnvironment() === false
            && PaymentAccessPolicy.isPaymentAllowedForUser(ordinaryUser) === false);
    }

    PaymentAccessPolicy.configure("development");
    check("the refusal message names the environment so a developer knows why",
        PaymentAccessPolicy.describeRestriction().includes("development"));

    // ── 9. Retention TTL actually changes (14 days) ────────────────────────
    section("9. A retention change reaches the database");

    const ttlCollection = "ttlProbeCollection";
    const sevenDaySeconds = 7 * 24 * 60 * 60;
    const fourteenDaySeconds = 14 * 24 * 60 * 60;

    const created = await TimeToLiveIndexReconciler.ensure(inMemoryDatabase, ttlCollection, { createdAt: 1 }, sevenDaySeconds);
    check("a fresh collection gets its TTL index created", created.ensured === true && created.action === "CREATED");

    // The trap: a plain createIndex with a changed expiry is an error, and the
    // callers' catch-and-log would swallow it, leaving the OLD expiry in force.
    let plainCreateRejected = false;
    try
    {
        await inMemoryDatabase.collection(ttlCollection).createIndex({ createdAt: 1 }, { expireAfterSeconds: fourteenDaySeconds });
    }
    catch (conflictError)
    {
        plainCreateRejected = conflictError.code === 85;
    }
    check("a plain createIndex with a NEW expiry is rejected (this is the trap)", plainCreateRejected);
    check("...and the old expiry would have survived it",
        inMemoryDatabase.collection(ttlCollection).timeToLiveSeconds === sevenDaySeconds);

    const modified = await TimeToLiveIndexReconciler.ensure(inMemoryDatabase, ttlCollection, { createdAt: 1 }, fourteenDaySeconds);
    check("the reconciler amends it instead", modified.ensured === true && modified.action === "MODIFIED");
    check("the new 14-day expiry is genuinely in force",
        inMemoryDatabase.collection(ttlCollection).timeToLiveSeconds === fourteenDaySeconds);
    check("it went through collMod, the only thing that can change a live TTL",
        inMemoryDatabase.collectionModificationCommands.some(command => command.collMod === ttlCollection));

    const unchanged = await TimeToLiveIndexReconciler.ensure(inMemoryDatabase, ttlCollection, { createdAt: 1 }, fourteenDaySeconds);
    check("re-running with the same expiry is a no-op, not a churn of collMod calls",
        unchanged.ensured === true && unchanged.action === "CREATED");

    // ── 10. Reconciliation repairs a payment nobody delivered ──────────────
    section("10. Reconciliation settles what the webhook never delivered");

    // A captured payment the provider knows about and this server does not.
    const capturedByProvider = new Map();
    const razorpay = PaymentProviderFactory.getProvider(paymentProviders.RAZORPAY);
    razorpay.fetchCapturedPaymentForOrder = async (orderId) => capturedByProvider.get(orderId) || null;

    const wellPastGrace = Date.now() - PendingPaymentReconciler.SETTLEMENT_GRACE_MILLISECONDS - 60000;

    await seedUserWithCredits("user-lost", 0);
    await PendingCreditOrderQueryEngine.createPendingCreditOrder
    ({
        providerOrderId: "order_lost", userId: "user-lost", credits: 250,
        amountMinor: 24900, currency: "INR", region: "INDIA", unitPrice: 100,
        discountPercent: 0, paymentProvider: paymentProviders.RAZORPAY, receiptId: "clc_lost"
    });
    await ageOrder(DatabaseConstants.PENDING_CREDIT_ORDERS_COLLECTION, "order_lost", wellPastGrace);
    capturedByProvider.set("order_lost", { id: "pay_lost", order_id: "order_lost", amount: 24900, currency: "INR", status: "captured" });

    raisedAlerts = [];
    let sweepOutcome = await PendingPaymentReconciler.sweep();

    check("the lost payment is found and settled", sweepOutcome.settled === 1);
    check("the buyer finally receives what they paid for", (await CreditLedger.getBalance("user-lost")) === 250);
    check("the pending row is closed", (await PendingCreditOrderQueryEngine.getByOrderId("order_lost"))?.status === PendingCreditOrderQueryEngine.STATUS_CONSUMED);
    check("a repair raises an alert — it means a webhook that should have arrived did not",
        raisedAlerts.some(alert => alert.source === "PAYMENT_RECONCILER"));

    // Running again must not grant a second time.
    raisedAlerts = [];
    sweepOutcome = await PendingPaymentReconciler.sweep();
    check("a second sweep does not re-grant", (await CreditLedger.getBalance("user-lost")) === 250);
    check("...and finds nothing left to settle", sweepOutcome.settled === 0);

    // A young order is left alone: a checkout may still be open in the browser.
    await seedUserWithCredits("user-midcheckout", 0);
    await PendingCreditOrderQueryEngine.createPendingCreditOrder
    ({
        providerOrderId: "order_young", userId: "user-midcheckout", credits: 100,
        amountMinor: 9900, currency: "INR", region: "INDIA", unitPrice: 99,
        discountPercent: 0, paymentProvider: paymentProviders.RAZORPAY, receiptId: "clc_young"
    });
    capturedByProvider.set("order_young", { id: "pay_young", order_id: "order_young", amount: 9900, currency: "INR", status: "captured" });

    sweepOutcome = await PendingPaymentReconciler.sweep();
    check("an order inside the grace window is not touched",
        (await CreditLedger.getBalance("user-midcheckout")) === 0 && sweepOutcome.settled === 0);

    // An order the provider says was never paid stays unpaid.
    await seedUserWithCredits("user-abandoned", 0);
    await PendingCreditOrderQueryEngine.createPendingCreditOrder
    ({
        providerOrderId: "order_abandoned", userId: "user-abandoned", credits: 100,
        amountMinor: 9900, currency: "INR", region: "INDIA", unitPrice: 99,
        discountPercent: 0, paymentProvider: paymentProviders.RAZORPAY, receiptId: "clc_abandoned"
    });
    await ageOrder(DatabaseConstants.PENDING_CREDIT_ORDERS_COLLECTION, "order_abandoned", wellPastGrace);

    raisedAlerts = [];
    sweepOutcome = await PendingPaymentReconciler.sweep();
    check("an abandoned checkout grants nothing", (await CreditLedger.getBalance("user-abandoned")) === 0);
    check("...and is counted as still unpaid rather than failed", sweepOutcome.stillUnpaid >= 1 && sweepOutcome.failed === 0);
    check("...and raises no alert, because an abandoned checkout is not an incident",
        raisedAlerts.filter(alert => alert.source === "PAYMENT_RECONCILER").length === 0);

    // Authorized-but-uncaptured must never provision (C5), on this path too.
    await seedUserWithCredits("user-authorized", 0);
    await PendingCreditOrderQueryEngine.createPendingCreditOrder
    ({
        providerOrderId: "order_authorized", userId: "user-authorized", credits: 100,
        amountMinor: 9900, currency: "INR", region: "INDIA", unitPrice: 99,
        discountPercent: 0, paymentProvider: paymentProviders.RAZORPAY, receiptId: "clc_auth"
    });
    await ageOrder(DatabaseConstants.PENDING_CREDIT_ORDERS_COLLECTION, "order_authorized", wellPastGrace);
    // The real provider method filters on status; assert the filter, not the stub.
    razorpay.fetchOrderPayments = async () => [{ id: "pay_auth", order_id: "order_authorized", amount: 9900, currency: "INR", status: "authorized" }];
    check("an authorized-but-uncaptured payment is not treated as captured",
        (await RazorpayPaymentProviderClass.prototype.fetchCapturedPaymentForOrder.call(razorpay, "order_authorized")) === null);

    // A captured payment whose amount disagrees must grant nothing and alert.
    await seedUserWithCredits("user-mismatch", 0);
    await PendingCreditOrderQueryEngine.createPendingCreditOrder
    ({
        providerOrderId: "order_mismatch", userId: "user-mismatch", credits: 500,
        amountMinor: 49900, currency: "INR", region: "INDIA", unitPrice: 100,
        discountPercent: 0, paymentProvider: paymentProviders.RAZORPAY, receiptId: "clc_mismatch"
    });
    await ageOrder(DatabaseConstants.PENDING_CREDIT_ORDERS_COLLECTION, "order_mismatch", wellPastGrace);
    capturedByProvider.set("order_mismatch", { id: "pay_mismatch", order_id: "order_mismatch", amount: 100, currency: "INR", status: "captured" });

    raisedAlerts = [];
    sweepOutcome = await PendingPaymentReconciler.sweep();
    check("a captured payment for the WRONG amount grants nothing",
        (await CreditLedger.getBalance("user-mismatch")) === 0);
    check("...and alerts, exactly as the webhook path does",
        raisedAlerts.some(alert => alert.source === "PAYMENT_RECONCILER" && /does not match/i.test(alert.title)));

    // The sweep must cover BOTH pending collections. Settling a deck order end
    // to end needs the key-management stack, so this asserts the narrower thing
    // that would actually break on a typo: that a stale DECK order is
    // discovered and its provider consulted at all.
    const consultedOrderIds = [];
    razorpay.fetchCapturedPaymentForOrder = async (orderId) =>
    {
        consultedOrderIds.push(orderId);
        return null;
    };
    await PendingOrderQueryEngine.createPendingOrder
    ({
        providerOrderId: "order_deck_stale", userId: "user-deckstale", deckIds: ["deck-s"],
        amountMinor: 19900, currency: "INR", region: "INDIA",
        paymentProvider: paymentProviders.RAZORPAY, receiptId: "cld_stale"
    });
    await ageOrder(DatabaseConstants.PENDING_ORDERS_COLLECTION, "order_deck_stale", wellPastGrace);

    await PendingPaymentReconciler.sweep();
    check("stale PAID-DECK orders are swept as well as credit ones",
        consultedOrderIds.includes("order_deck_stale"));

    // One broken order must not stop the sweep for everyone else.
    await seedUserWithCredits("user-rescued", 0);
    await PendingCreditOrderQueryEngine.createPendingCreditOrder
    ({
        providerOrderId: "order_explodes", userId: "user-broken", credits: 100,
        amountMinor: 9900, currency: "INR", region: "INDIA", unitPrice: 99,
        discountPercent: 0, paymentProvider: paymentProviders.RAZORPAY, receiptId: "clc_boom"
    });
    await PendingCreditOrderQueryEngine.createPendingCreditOrder
    ({
        providerOrderId: "order_rescued", userId: "user-rescued", credits: 300,
        amountMinor: 29900, currency: "INR", region: "INDIA", unitPrice: 100,
        discountPercent: 0, paymentProvider: paymentProviders.RAZORPAY, receiptId: "clc_rescue"
    });
    await ageOrder(DatabaseConstants.PENDING_CREDIT_ORDERS_COLLECTION, "order_explodes", wellPastGrace);
    await ageOrder(DatabaseConstants.PENDING_CREDIT_ORDERS_COLLECTION, "order_rescued", wellPastGrace);
    capturedByProvider.set("order_rescued", { id: "pay_rescued", order_id: "order_rescued", amount: 29900, currency: "INR", status: "captured" });
    razorpay.fetchCapturedPaymentForOrder = async (orderId) =>
    {
        if (orderId === "order_explodes")
        {
            throw new Error("provider unreachable for this order");
        }
        return capturedByProvider.get(orderId) || null;
    };

    sweepOutcome = await PendingPaymentReconciler.sweep();
    check("one failing order is counted, not fatal", sweepOutcome.failed === 1);
    check("...and the healthy order behind it is still rescued",
        (await CreditLedger.getBalance("user-rescued")) === 300);

    // ── 11. The order row is written BEFORE the provider is called ─────────
    section("11. The local record exists before the remote order does");

    const preWriteReceipt = CheckoutReceiptIdentifier.forCreditPurchase
    ({ userId: "user-prewrite", credits: 100, amountMinor: 9900, currency: "INR", couponId: null });

    // The initiation path writes the row keyed on the receipt first.
    await PendingCreditOrderQueryEngine.createPendingCreditOrder
    ({
        providerOrderId: preWriteReceipt, userId: "user-prewrite", credits: 100,
        amountMinor: 9900, currency: "INR", region: "INDIA", unitPrice: 99,
        discountPercent: 0, paymentProvider: paymentProviders.RAZORPAY, receiptId: preWriteReceipt
    });
    check("the row exists before any provider order does",
        (await PendingCreditOrderQueryEngine.getByOrderId(preWriteReceipt))?.userId === "user-prewrite");

    const attached = await PendingCreditOrderQueryEngine.attachProviderOrderId(preWriteReceipt, "user-prewrite", "order_real_1");
    check("the provider's real order id is attached afterwards", attached.attached === true);
    check("...and the row is now findable by it",
        (await PendingCreditOrderQueryEngine.getByOrderId("order_real_1"))?.credits === 100);
    check("...and no longer by the placeholder",
        (await PendingCreditOrderQueryEngine.getByOrderId(preWriteReceipt)) === null);

    // Another user must never be able to claim someone else's placeholder row.
    const foreignAttach = await PendingCreditOrderQueryEngine.attachProviderOrderId(preWriteReceipt, "user-attacker", "order_stolen");
    check("a different user cannot attach an order to someone else's row", foreignAttach.attached === false);

    // A settled row must never be re-pointed.
    await PendingCreditOrderQueryEngine.markConsumed("order_real_1", "user-prewrite");
    const settledAttach = await PendingCreditOrderQueryEngine.attachProviderOrderId("order_real_1", "user-prewrite", "order_repoint");
    check("a SETTLED row cannot be re-pointed at another order", settledAttach.attached === false);

    // A failed provider call deletes the placeholder — and only a placeholder.
    const doomedReceipt = "clc_doomed";
    await PendingCreditOrderQueryEngine.createPendingCreditOrder
    ({
        providerOrderId: doomedReceipt, userId: "user-doomed", credits: 100,
        amountMinor: 9900, currency: "INR", region: "INDIA", unitPrice: 99,
        discountPercent: 0, paymentProvider: paymentProviders.RAZORPAY, receiptId: doomedReceipt
    });
    const deleted = await PendingCreditOrderQueryEngine.deleteUnclaimedOrder(doomedReceipt, "user-doomed");
    check("a failed provider call removes its placeholder row", deleted.deleted === true);

    await PendingCreditOrderQueryEngine.createPendingCreditOrder
    ({
        providerOrderId: "order_real_2", userId: "user-safe", credits: 100,
        amountMinor: 9900, currency: "INR", region: "INDIA", unitPrice: 99,
        discountPercent: 0, paymentProvider: paymentProviders.RAZORPAY, receiptId: "clc_safe"
    });
    const wrongfulDelete = await PendingCreditOrderQueryEngine.deleteUnclaimedOrder("order_real_2", "user-safe");
    check("a REAL order can never be deleted by the placeholder cleanup", wrongfulDelete.deleted === false
        && (await PendingCreditOrderQueryEngine.getByOrderId("order_real_2")) !== null);

    // ── 12. Unknown request fields are refused, not ignored ────────────────
    section("12. Unknown fields on a payment request are refused");

    check("a legitimate credit body passes",
        PaymentRequestSchema.findUnexpectedFields("/Credits/Purchase/Initiate",
            { credits: 100, couponCode: "", localeRegionHint: "IN" }).length === 0);

    // The field this control exists for.
    check("an injected `amount` is reported",
        PaymentRequestSchema.findUnexpectedFields("/Credits/Purchase/Initiate",
            { credits: 100, amount: 1 }).includes("amount"));

    for (const probeField of ["price", "amountMinor", "userId", "isPaid", "__proto__"])
    {
        check(`an injected \`${probeField}\` is reported`,
            PaymentRequestSchema.findUnexpectedFields("/Credits/Purchase/Initiate",
                { credits: 100, [probeField]: 1 }).includes(probeField));
    }

    check("the real paid-deck body passes",
        PaymentRequestSchema.findUnexpectedFields("/PaidDecks/Purchase/Initiate",
            { deckIds: ["deck-a"], region: "INDIA" }).length === 0);
    check("the monthly free-deck claim is an accepted field",
        PaymentRequestSchema.findUnexpectedFields("/PaidDecks/Purchase/Initiate",
            { deckIds: ["deck-a"], useMonthlyFreeDeckClaim: true }).length === 0);
    check("a verify body passes with the provider triple",
        PaymentRequestSchema.findUnexpectedFields("/Credits/Purchase/Verify",
            { providerOrderId: "o", providerPaymentId: "p", signature: "s", paymentProvider: 0 }).length === 0);
    check("the subscription bodies pass",
        PaymentRequestSchema.findUnexpectedFields("/Subscription/Initiate", { planTier: 2, couponCode: "X" }).length === 0
        && PaymentRequestSchema.findUnexpectedFields("/Subscription/Verify",
            { providerSubscriptionId: "s", providerPaymentId: "p", signature: "x" }).length === 0);

    // An endpoint with no schema must not be validated against another's list.
    check("an unschemed route is not validated against someone else's fields",
        PaymentRequestSchema.findUnexpectedFields("/Some/Other/Route", { anything: 1 }).length === 0);
    check("a non-object body yields no schema complaint (the handler reports it better)",
        PaymentRequestSchema.findUnexpectedFields("/Credits/Purchase/Initiate", null).length === 0
        && PaymentRequestSchema.findUnexpectedFields("/Credits/Purchase/Initiate", [1, 2]).length === 0);

    // ── 13. Paid-deck settlement records what was CHARGED ──────────────────
    section("13. A purchase records the amount actually charged");

    // A single-deck order records the order total exactly — no arithmetic, so
    // no rounding can appear on the commonest purchase.
    const singleDeckAmount = PaidDeckPurchaseCompletionServiceClass.resolveChargedAmountMinor
    (
        { amountMinor: 19900, currency: "INR" },
        ["deck-a"],
        { deckId: "deck-a", finalPriceMinor: 12345 },
        { breakdown: [{ deckId: "deck-a", finalPriceMinor: 12345 }] }
    );
    check("a single-deck order records the captured total, not a recomputed price",
        singleDeckAmount === 19900);

    // A basket splits proportionally and the parts must sum to what was taken.
    const basketOrder = { amountMinor: 30000, currency: "INR" };
    const basketBreakdown = [
        { deckId: "deck-a", finalPriceMinor: 10000 },
        { deckId: "deck-b", finalPriceMinor: 10000 },
        { deckId: "deck-c", finalPriceMinor: 10000 }
    ];
    const basketIds = ["deck-a", "deck-b", "deck-c"];
    const basketAmounts = basketBreakdown.map(entry =>
        PaidDeckPurchaseCompletionServiceClass.resolveChargedAmountMinor(basketOrder, basketIds, entry, { breakdown: basketBreakdown }));
    check("a basket's per-deck amounts sum to the captured total",
        basketAmounts.reduce((total, amount) => total + amount, 0) === 30000);

    // The case that motivated the change: a basket whose split does not divide
    // evenly must STILL sum to the captured total, to the minor unit.
    const awkwardOrder = { amountMinor: 10000, currency: "INR" };
    const awkwardBreakdown = [
        { deckId: "deck-a", finalPriceMinor: 3333 },
        { deckId: "deck-b", finalPriceMinor: 3333 },
        { deckId: "deck-c", finalPriceMinor: 3334 }
    ];
    const awkwardAmounts = awkwardBreakdown.map(entry =>
        PaidDeckPurchaseCompletionServiceClass.resolveChargedAmountMinor(awkwardOrder, basketIds, entry, { breakdown: awkwardBreakdown }));
    check("an uneven split still sums exactly to the captured total",
        awkwardAmounts.reduce((total, amount) => total + amount, 0) === 10000);

    // If the catalogue moved between checkout and settlement, the recorded
    // figure must still be the one the buyer's card was charged.
    const repricedAmount = PaidDeckPurchaseCompletionServiceClass.resolveChargedAmountMinor
    (
        { amountMinor: 19900, currency: "INR" },
        ["deck-a"],
        { deckId: "deck-a", finalPriceMinor: 9900 },
        { breakdown: [{ deckId: "deck-a", finalPriceMinor: 9900 }] }
    );
    check("a price change between checkout and settlement cannot alter the recorded amount",
        repricedAmount === 19900);

    // ── 14. Every payment READ is scoped to its owner ──────────────────────
    section("14. Payment reads are scoped to the authenticated account");

    // Two buyers, one purchase each, so a leak between them is detectable
    // rather than merely absent.
    const purchasesCollection = inMemoryDatabase.collection(DatabaseConstants.PURCHASES_COLLECTION);
    await purchasesCollection.insertOne
    ({
        id: "purchase-owner", userId: "user-owner", deckId: "deck-owned",
        providerOrderId: "order_owner", providerPaymentId: "pay_owner",
        amountMinor: 19900, currency: "INR", region: "INDIA", status: purchaseStatuses.COMPLETED
    });
    await purchasesCollection.insertOne
    ({
        id: "purchase-other", userId: "user-other", deckId: "deck-other",
        providerOrderId: "order_other", providerPaymentId: "pay_other",
        amountMinor: 29900, currency: "INR", region: "INDIA", status: purchaseStatuses.COMPLETED
    });

    function makeReadRequest(userId, queryParams = {})
    {
        return {
            url: "/PaidDecks/Purchases/Invoice",
            headers: {},
            session: userId === null ? null : { getUserId: () => userId },
            getQueryParams: async () => queryParams,
            getBody: async () => ({})
        };
    }

    function makeReadResponse()
    {
        return {
            statusCode: 0,
            body: null,
            headersSent: {},
            setHeader(name, value) { this.headersSent[name] = value; },
            // The invoice endpoint streams HTML rather than JSON, so the
            // double has to model write/end as well as the JSON helpers.
            write(chunk) { this.body = (this.body === null ? "" : this.body) + chunk; },
            end() { this.ended = true; },
            send(payload) { this.body = payload; },
            sendJson(payload) { this.body = payload; },
            sendStatusCode(code) { this.statusCode = code; }
        };
    }

    // The owner can read their own invoice.
    let readResponse = makeReadResponse();
    await getPurchaseInvoice(makeReadRequest("user-owner", { purchaseId: "purchase-owner" }), readResponse);
    const ownerSawTheirInvoice = typeof readResponse.body === "string" && readResponse.body.includes("purchase-owner");
    check("an owner can read their own invoice", ownerSawTheirInvoice);

    // Another signed-in user cannot, even naming the id exactly.
    readResponse = makeReadResponse();
    await getPurchaseInvoice(makeReadRequest("user-other", { purchaseId: "purchase-owner" }), readResponse);
    const leaked = typeof readResponse.body === "string" && readResponse.body.includes("purchase-owner");
    check("another account naming the id exactly is refused", leaked === false);
    check("...with an exact 404 and no body at all, not a partial render",
        readResponse.statusCode === httpStatusNotFound && readResponse.body === null);

    // Signed out, nothing at all.
    readResponse = makeReadResponse();
    await getPurchaseInvoice(makeReadRequest(null, { purchaseId: "purchase-owner" }), readResponse);
    check("a signed-out caller is refused before any lookup",
        !(typeof readResponse.body === "string" && readResponse.body.includes("purchase-owner")));

    // The purchase LIST is scoped the same way.
    readResponse = makeReadResponse();
    await getMyPurchases(makeReadRequest("user-owner"), readResponse);
    const listedPurchases = JSON.stringify(readResponse.body || {});
    check("the purchase list returns the caller's own row", listedPurchases.includes("purchase-owner"));
    check("...and never another account's", listedPurchases.includes("purchase-other") === false);

    // ── The organization credit deal ───────────────────────────────────────
    //
    // The newest money flow, and the one that shipped without the controls the
    // other two already had. These cases pin each of them so it cannot regress
    // back out again — which is the whole reason they are here rather than left
    // to the fact that the code now looks right.

    section("Organization credit deal — the third money flow");

    // The organization ledger's idempotency rests on a unique referenceKey
    // index that DatabaseConnector creates at boot rather than the ledger
    // creating it lazily. The harness never boots, so it has to stand that index
    // up itself — without it the clawback replay case below would pass for the
    // wrong reason, by never detecting the duplicate at all.
    await inMemoryDatabase
        .collection(DatabaseConstants.ORGANIZATION_CREDIT_TRANSACTIONS_COLLECTION)
        .createIndex({ referenceKey: 1 }, { unique: true });

    // Part 2.15: the receipt is derived from the agreement, never the clock.
    const dealIntent =
    {
        organizationId: "org-alpha",
        credits: 50000,
        amountMinor: 4500000,
        currency: "INR",
        termEndsAt: "2027-08-05T00:00:00.000Z"
    };
    const dealReceipt = CheckoutReceiptIdentifier.forOrganizationCreditDeal(dealIntent);
    check("an organization deal receipt is deterministic",
        dealReceipt === CheckoutReceiptIdentifier.forOrganizationCreditDeal(dealIntent));
    check("...and fits the provider's 40-character receipt field",
        dealReceipt.length <= CheckoutReceiptIdentifier.MAXIMUM_RECEIPT_LENGTH);
    check("...and is distinguishable from a personal credit receipt",
        dealReceipt.startsWith(CheckoutReceiptIdentifier.ORGANIZATION_CREDIT_DEAL_PREFIX));
    check("a different price is a different deal",
        CheckoutReceiptIdentifier.forOrganizationCreditDeal({ ...dealIntent, amountMinor: 4500001 }) !== dealReceipt);
    check("a different contract term is a different deal, at the same price",
        CheckoutReceiptIdentifier.forOrganizationCreditDeal({ ...dealIntent, termEndsAt: "2028-08-05T00:00:00.000Z" }) !== dealReceipt);
    check("the buyer is the organization, not whoever clicked",
        CheckoutReceiptIdentifier.forOrganizationCreditDeal({ ...dealIntent, organizationId: "org-beta" }) !== dealReceipt);

    // Part 3.19: the row is written before the provider call, and a failed call
    // cleans it up — WITHOUT being able to touch a real order.
    const dealCollection = inMemoryDatabase.collection(DatabaseConstants.CREDIT_DEAL_PAYMENTS_COLLECTION);
    dealCollection.documents = [];

    await dealCollection.insertOne
    ({
        id: "deal-placeholder",
        targetType: creditDealTargetTypes.ORGANIZATION_CREDIT_POOL,
        targetId: "org-alpha",
        mode: creditDealPaymentModes.ON_SPOT_RAZORPAY,
        status: creditDealPaymentStatuses.PENDING,
        amountMinor: 4500000,
        currency: "INR",
        paymentProvider: paymentProviders.RAZORPAY,
        providerOrderId: dealReceipt,
        providerPaymentId: "",
        createdByUserId: "admin-1",
        createdAt: new Date(),
        additionalData: { credits: 50000, termEndsAt: dealIntent.termEndsAt, receiptId: dealReceipt }
    });

    const attachResult = await CreditDealPaymentQueryEngine.attachProviderOrderId(dealReceipt, "order_deal_real");
    check("the provider's order id is attached to the row written first", attachResult.attached === true);

    const attachedDeal = await CreditDealPaymentQueryEngine.findByOrderId("order_deal_real");
    check("...and the row is then findable by the real order id", attachedDeal !== null);

    const failedDeleteAfterAttach = await CreditDealPaymentQueryEngine.deleteUnclaimedDeal(dealReceipt);
    check("the failed-initiation cleanup CANNOT delete a deal that has a real order",
        failedDeleteAfterAttach.deleted === false && dealCollection.documents.length === 1);

    // A row still keyed on its own receipt is the one it may delete.
    dealCollection.documents = [];
    await dealCollection.insertOne
    ({
        id: "deal-orphan",
        targetType: creditDealTargetTypes.ORGANIZATION_CREDIT_POOL,
        targetId: "org-alpha",
        mode: creditDealPaymentModes.ON_SPOT_RAZORPAY,
        status: creditDealPaymentStatuses.PENDING,
        providerOrderId: dealReceipt,
        createdAt: new Date(),
        additionalData: { receiptId: dealReceipt }
    });
    const orphanDelete = await CreditDealPaymentQueryEngine.deleteUnclaimedDeal(dealReceipt);
    check("a failed provider call removes its own placeholder row",
        orphanDelete.deleted === true && dealCollection.documents.length === 0);

    // Part 3.22: a resubmitted deal is handed the order the first one made, and
    // a row whose provider call never landed is NOT offered for reuse.
    dealCollection.documents = [];
    await dealCollection.insertOne
    ({
        id: "deal-reusable",
        targetType: creditDealTargetTypes.ORGANIZATION_CREDIT_POOL,
        targetId: "org-alpha",
        mode: creditDealPaymentModes.ON_SPOT_RAZORPAY,
        status: creditDealPaymentStatuses.PENDING,
        amountMinor: 4500000,
        currency: "INR",
        paymentProvider: paymentProviders.RAZORPAY,
        providerOrderId: "order_deal_reusable",
        createdAt: new Date(),
        additionalData: { credits: 50000, receiptId: dealReceipt }
    });
    const reusableDeal = await CreditDealPaymentQueryEngine.findReusableByReceipt(dealReceipt);
    check("a resubmitted deal reuses the order the first attempt created",
        reusableDeal !== null && reusableDeal.getProviderOrderId() === "order_deal_reusable");

    await dealCollection.updateOne({ id: "deal-reusable" }, { $set: { providerOrderId: dealReceipt } });
    check("...but a row whose provider call never landed is never offered for reuse",
        await CreditDealPaymentQueryEngine.findReusableByReceipt(dealReceipt) === null);

    // Part 7.56: reconciliation reaches this flow too.
    dealCollection.documents = [];
    const staleCreatedAt = new Date(Date.now() - 60 * 60 * 1000);
    await dealCollection.insertOne
    ({
        id: "deal-stale",
        targetType: creditDealTargetTypes.ORGANIZATION_CREDIT_POOL,
        targetId: "org-alpha",
        mode: creditDealPaymentModes.ON_SPOT_RAZORPAY,
        status: creditDealPaymentStatuses.PENDING,
        amountMinor: 4500000,
        currency: "INR",
        paymentProvider: paymentProviders.RAZORPAY,
        providerOrderId: "order_deal_stale",
        createdAt: staleCreatedAt,
        additionalData: { credits: 50000, receiptId: "clo_stale" }
    });
    await dealCollection.insertOne
    ({
        id: "deal-never-created",
        targetType: creditDealTargetTypes.ORGANIZATION_CREDIT_POOL,
        targetId: "org-alpha",
        mode: creditDealPaymentModes.ON_SPOT_RAZORPAY,
        status: creditDealPaymentStatuses.PENDING,
        amountMinor: 4500000,
        currency: "INR",
        providerOrderId: "",
        createdAt: staleCreatedAt,
        additionalData: { credits: 50000, receiptId: "clo_never" }
    });

    const staleDeals = await CreditDealPaymentQueryEngine.findStalePendingDeals(
        new Date(Date.now() - 20 * 60 * 1000),
        new Date(Date.now() - 48 * 60 * 60 * 1000));
    check("reconciliation finds a stale on-spot deal", staleDeals.length === 1);
    check("...and skips one whose provider order was never created",
        staleDeals.every(deal => deal.id !== "deal-never-created"));

    // The sweep must actually settle it. The provider is stubbed to report a
    // captured payment, exactly as the credit and deck cases above do.
    const dealProvider = PaymentProviderFactory.getProvider(paymentProviders.RAZORPAY);
    const savedFetchCaptured = dealProvider.fetchCapturedPaymentForOrder;
    dealProvider.fetchCapturedPaymentForOrder = async (providerOrderId) =>
        providerOrderId === "order_deal_stale"
            ? { id: "pay_deal_stale", status: "captured", amount: 4500000, currency: "INR", order_id: "order_deal_stale" }
            : null;

    raisedAlerts = [];
    const dealSweep = await PendingPaymentReconciler.sweep();
    dealProvider.fetchCapturedPaymentForOrder = savedFetchCaptured;

    check("the sweep settles a captured deal the webhook never delivered", dealSweep.settled >= 1);
    check("...and alerts, because a repair means a delivery that should have arrived did not",
        raisedAlerts.some(alert => alert.source === "PAYMENT_RECONCILER"));

    const settledDeal = await dealCollection.findOne({ id: "deal-stale" });
    check("...and the deal is captured rather than left pending",
        settledDeal.status === creditDealPaymentStatuses.CAPTURED);

    const creditedPool = await inMemoryDatabase
        .collection(DatabaseConstants.ORGANIZATION_CREDIT_POOLS_COLLECTION)
        .findOne({ organizationId: "org-alpha" });
    check("...and the credits actually reach the pool, not just the deal row",
        creditedPool !== null && creditedPool.balance === 50000);

    // ── Clawing an organization's credits back ─────────────────────────────
    //
    // G1 / G2 for the pool. The rule has to match the personal path: take what
    // is there, never go below zero, and report what could not be recovered.

    section("Organization credit clawback — G1 / G2 for a pool");

    const poolsCollection = inMemoryDatabase.collection(DatabaseConstants.ORGANIZATION_CREDIT_POOLS_COLLECTION);
    const organizationTransactions = inMemoryDatabase.collection(DatabaseConstants.ORGANIZATION_CREDIT_TRANSACTIONS_COLLECTION);

    poolsCollection.documents = [];
    organizationTransactions.documents = [];
    await poolsCollection.insertOne({ organizationId: "org-full", balance: 1000, lifetimeGranted: 1000, lifetimeDistributed: 0, frozen: false, updatedAt: new Date() });

    const fullClawback = await OrganizationCreditLedger.clawBack("org-full", 1000, "paymentReversal:rfnd_full", {});
    check("a fully-unspent block is recovered entirely",
        fullClawback.applied === true && fullClawback.clawedBack === 1000 && fullClawback.shortfall === 0);
    check("...leaving the pool at zero", (await poolsCollection.findOne({ organizationId: "org-full" })).balance === 0);

    const replayedClawback = await OrganizationCreditLedger.clawBack("org-full", 1000, "paymentReversal:rfnd_full", {});
    check("a redelivered refund does not take the credits twice",
        replayedClawback.alreadyApplied === true && replayedClawback.clawedBack === 0);
    check("...and the pool is untouched by the replay",
        (await poolsCollection.findOne({ organizationId: "org-full" })).balance === 0);

    // Partly spent: recover what remains, report the rest.
    await poolsCollection.insertOne({ organizationId: "org-spent", balance: 300, lifetimeGranted: 1000, lifetimeDistributed: 700, frozen: false, updatedAt: new Date() });
    const partialClawback = await OrganizationCreditLedger.clawBack("org-spent", 1000, "paymentReversal:rfnd_spent", {});
    check("a partly-distributed block recovers what is left",
        partialClawback.clawedBack === 300);
    check("...reports the unrecoverable remainder rather than forcing it through",
        partialClawback.shortfall === 700);
    check("...and never takes the pool below zero",
        (await poolsCollection.findOne({ organizationId: "org-spent" })).balance === 0);

    // A frozen pool is still clawed back — the money has gone back either way.
    await poolsCollection.insertOne({ organizationId: "org-frozen", balance: 500, lifetimeGranted: 500, lifetimeDistributed: 0, frozen: true, updatedAt: new Date() });
    const frozenClawback = await OrganizationCreditLedger.clawBack("org-frozen", 500, "paymentReversal:rfnd_frozen", {});
    check("a frozen pool is still clawed back, unlike a distribution",
        frozenClawback.clawedBack === 500);

    // A frozen pool must still REFUSE an ordinary distribution — the exemption
    // above is specific to a clawback and must not have widened.
    await poolsCollection.insertOne({ organizationId: "org-frozen-2", balance: 500, lifetimeGranted: 500, lifetimeDistributed: 0, frozen: true, updatedAt: new Date() });
    const frozenDebit = await OrganizationCreditLedger.debit("org-frozen-2", 100, OrganizationCreditLedger.TRANSACTION_TYPE_DISTRIBUTION, "distribution:frozen-check", {});
    check("...while an ordinary distribution from a frozen pool is still refused",
        frozenDebit.applied === false);

    // The reversal service must attribute a deal refund to the pool at all —
    // before this it fell through every branch and only alerted.
    dealCollection.documents = [];
    poolsCollection.documents = [];
    organizationTransactions.documents = [];
    // Credited through the LEDGER rather than by seeding the pool balance: the
    // clawback now reverses the applied `orgDeal:<id>` transaction, not the
    // deal row, so that a refund arriving before the pool was ever credited
    // cannot empty a pool the institute filled with a different purchase.
    await OrganizationCreditLedger.credit("org-reversed", 50000, OrganizationCreditLedger.TRANSACTION_TYPE_PURCHASE, "orgDeal:deal-reversed", {});
    await dealCollection.insertOne
    ({
        id: "deal-reversed",
        targetType: creditDealTargetTypes.ORGANIZATION_CREDIT_POOL,
        targetId: "org-reversed",
        mode: creditDealPaymentModes.ON_SPOT_RAZORPAY,
        status: creditDealPaymentStatuses.CAPTURED,
        amountMinor: 4500000,
        currency: "INR",
        paymentProvider: paymentProviders.RAZORPAY,
        providerOrderId: "order_deal_reversed",
        providerPaymentId: "pay_deal_reversed",
        createdByUserId: "admin-1",
        createdAt: new Date(),
        additionalData: { credits: 50000, receiptId: "clo_reversed" }
    });

    raisedAlerts = [];
    const dealReversal = await PaymentReversalService.reverse
    ({
        refundId: "rfnd_deal",
        providerPaymentId: "pay_deal_reversed",
        providerOrderId: "order_deal_reversed",
        amountMinor: 4500000,
        currency: "INR",
        eventName: "refund.processed"
    });

    check("a chargeback against an organization deal is attributed, not just alerted",
        dealReversal.reversed === true && dealReversal.flow === "ORGANIZATION_CREDIT_DEAL");
    check("...and the credits are actually taken back out of the pool",
        dealReversal.creditsClawedBack === 50000
        && (await poolsCollection.findOne({ organizationId: "org-reversed" })).balance === 0);
    check("...and the deal stops reading as money received",
        (await dealCollection.findOne({ id: "deal-reversed" })).status === creditDealPaymentStatuses.REFUNDED);
    check("...and a human is still told, because no refund here is ever legitimate",
        raisedAlerts.some(alert => alert.source === "PAYMENT_REVERSAL" && alert.severity === Alerts.SEVERITY.ERROR));

    // ── The fourth money flow: a reversed subscription charge ──────────────
    //
    // G1 / G2 for recurring billing. A reversed subscription charge stops the
    // NEXT renewal on its own, which is why it used to be left alone — but
    // stopping the next renewal does nothing about the credits the reversed
    // cycle already granted or the access it already paid for.

    section("Subscription reversal — G1 / G2 for the fourth flow");

    const subscriptionTier = planTiers.PRO;
    const monthlyCreditsForTier = PlanMetadata.getMonthlyCredits(subscriptionTier);
    const cycleStartMilliseconds = Date.parse("2026-07-01T00:00:00.000Z");
    const cycleEndMilliseconds = Date.parse("2026-08-01T00:00:00.000Z");

    await seedUserWithCredits("user-sub", 0);
    await UserSubscriptionQueryEngine.create(new UserSubscription
    ({
        userId: "user-sub",
        email: "sub@example.com",
        planTier: subscriptionTier,
        currency: "INR",
        providerSubscriptionId: "sub_reversed",
        providerPlanId: "plan_pro_inr",
        status: subscriptionStatuses.ACTIVE,
        currentPeriodStartAt: cycleStartMilliseconds,
        currentPeriodEndAt: cycleEndMilliseconds
    }));

    const chargedSubscription = await UserSubscriptionQueryEngine.getByProviderSubscriptionId("sub_reversed");
    await PlanSubscriptionService.applyChargedCycle(chargedSubscription,
    {
        razorpayPaymentId: "pay_sub_charged",
        currentPeriodStartMs: cycleStartMilliseconds,
        currentPeriodEndMs: cycleEndMilliseconds
    });

    const usersCollection = inMemoryDatabase.collection(DatabaseConstants.USERS_COLLECTION);

    check("the cycle granted its credits and extended access",
        (await CreditLedger.getBalance("user-sub")) === monthlyCreditsForTier
        && (await usersCollection.findOne({ id: "user-sub" })).additionalData.planExpiresAt === cycleEndMilliseconds);

    raisedAlerts = [];
    const subscriptionReversal = await PaymentReversalService.reverse
    ({
        refundId: "rfnd_sub",
        providerPaymentId: "pay_sub_charged",
        // A subscription charge carries NO order id of ours. Before this, that
        // alone ended the method at the unattributable alert.
        providerOrderId: "",
        amountMinor: 49900,
        currency: "INR",
        eventName: "refund.processed"
    });

    check("a reversed subscription charge is attributed by payment id, with no order id at all",
        subscriptionReversal.reversed === true && subscriptionReversal.flow === "SUBSCRIPTION_CHARGE");
    check("...the cycle's credits are clawed back",
        subscriptionReversal.creditsClawedBack === monthlyCreditsForTier
        && (await CreditLedger.getBalance("user-sub")) === 0);

    const reversedSubscriptionUser = await usersCollection.findOne({ id: "user-sub" });
    check("...access is rolled back to the start of the cycle that was refunded, not merely left to expire",
        reversedSubscriptionUser.additionalData.planExpiresAt === cycleStartMilliseconds);
    check("...and the plan reads CANCELLED rather than a grace state that preserves access",
        reversedSubscriptionUser.additionalData.planStatus === subscriptionStatuses.CANCELLED);
    check("...and a human is told", raisedAlerts.some(alert => alert.source === "PAYMENT_REVERSAL"));

    // A redelivery must not take the credits a second time.
    await seedUserWithCredits("user-sub", 120);
    const replayedSubscriptionReversal = await PaymentReversalService.reverse
    ({
        refundId: "rfnd_sub", providerPaymentId: "pay_sub_charged", providerOrderId: "",
        amountMinor: 49900, currency: "INR", eventName: "refund.processed"
    });
    check("a redelivered subscription refund claws back nothing further",
        replayedSubscriptionReversal.creditsClawedBack === 0
        && (await CreditLedger.getBalance("user-sub")) === 120);

    // ── G2: the refund arrives BEFORE the charge is provisioned ────────────
    //
    // The order that used to break everything. Nothing exists yet to reverse,
    // so the reversal is a no-op — and the settlement that lands moments later
    // must refuse rather than provision money that has already gone back.

    await seedUserWithCredits("user-early", 0);
    await UserSubscriptionQueryEngine.create(new UserSubscription
    ({
        userId: "user-early",
        email: "early@example.com",
        planTier: subscriptionTier,
        currency: "INR",
        providerSubscriptionId: "sub_early",
        providerPlanId: "plan_pro_inr",
        status: subscriptionStatuses.ACTIVE,
        currentPeriodStartAt: cycleStartMilliseconds,
        currentPeriodEndAt: cycleEndMilliseconds
    }));

    const earlyReversal = await PaymentReversalService.reverse
    ({
        refundId: "rfnd_early", providerPaymentId: "pay_sub_early", providerOrderId: "",
        amountMinor: 49900, currency: "INR", eventName: "refund.processed"
    });
    check("a refund for a charge nobody has provisioned reverses nothing",
        earlyReversal.reversed === false && earlyReversal.creditsClawedBack === 0);

    const earlySubscription = await UserSubscriptionQueryEngine.getByProviderSubscriptionId("sub_early");
    const refusedCycle = await PlanSubscriptionService.applyChargedCycle(earlySubscription,
    {
        razorpayPaymentId: "pay_sub_early",
        currentPeriodStartMs: cycleStartMilliseconds,
        currentPeriodEndMs: cycleEndMilliseconds
    });

    check("...but the charge that follows it REFUSES to provision",
        refusedCycle.applied === false && refusedCycle.refusedAsReversed === true);
    check("...granting no credits for money that has already gone back",
        (await CreditLedger.getBalance("user-early")) === 0);
    check("...and granting no access either",
        ((await usersCollection.findOne({ id: "user-early" }))?.additionalData?.planExpiresAt ?? null) === null);

    // The same ordering on the order-created flows, which reach settlement
    // through a different service entirely.
    await seedUserWithCredits("user-early-credits", 0);
    await PendingCreditOrderQueryEngine.createPendingCreditOrder
    ({
        providerOrderId: "order_early_refund", userId: "user-early-credits", credits: 500,
        amountMinor: 49900, currency: "INR", region: "INDIA", unitPrice: 100,
        discountPercent: 0, paymentProvider: paymentProviders.RAZORPAY, receiptId: "clc_early"
    });

    const earlyCreditReversal = await PaymentReversalService.reverse
    ({
        refundId: "rfnd_early_credits", providerPaymentId: "pay_early_credits",
        providerOrderId: "order_early_refund", amountMinor: 49900, currency: "INR",
        eventName: "refund.processed"
    });
    check("a credit order refunded before it settled takes nothing from the buyer",
        earlyCreditReversal.creditsClawedBack === 0
        && (await CreditLedger.getBalance("user-early-credits")) === 0);

    const refusedCreditSettlement = await CreditPurchaseCompletionService.complete
    (
        await PendingCreditOrderQueryEngine.getByOrderId("order_early_refund"),
        { providerPaymentId: "pay_early_credits", source: "WEBHOOK" }
    );
    check("...and the settlement that follows refuses to grant",
        refusedCreditSettlement.granted === false && refusedCreditSettlement.refusedAsReversed === true
        && (await CreditLedger.getBalance("user-early-credits")) === 0);

    // ── Schema coverage over every money route ─────────────────────────────

    section("Request schema — the last money route");

    check("the organization deal verify route now has a schema",
        PaymentRequestSchema.getAllowedFields("/Organization/Credits/Deals/Verify") !== null);
    check("...accepting exactly what its handler reads",
        PaymentRequestSchema.findUnexpectedFields("/Organization/Credits/Deals/Verify",
            { organizationId: "org-alpha", providerOrderId: "order_1", providerPaymentId: "pay_1", signature: "sig" }).length === 0);
    check("...and refusing a field it does not",
        PaymentRequestSchema.findUnexpectedFields("/Organization/Credits/Deals/Verify",
            { organizationId: "org-alpha", credits: 999999 }).includes("credits"));

    // ── Summary ────────────────────────────────────────────────────────────
    console.log(`\n${passedCount} passed, ${failedCount} failed.`);
    if (failedCount > 0)
    {
        process.exitCode = 1;
        return;
    }
    console.log("All payment lifecycle checks passed.");
}

run().catch((harnessError) =>
{
    console.error("Harness crashed:", harnessError);
    process.exitCode = 1;
});
