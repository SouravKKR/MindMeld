/**
 * Reliability harness for payment settlement — the handbook's Part 10.3
 * functional matrix, made executable.
 *
 * Run from the Dock directory:
 *     node VerifyPaymentSettlementReliability.mjs
 *
 * The matrix asks what happens when the world misbehaves: the same webhook
 * arrives twice, events arrive out of order, the endpoint was down, two tabs
 * pay the same order at once, the reported amount does not match. Those are the
 * cases that separate "works in a demo" from "correct in production", and none
 * of them was exercised anywhere before this file existed.
 *
 * Why it needs no Mongo. These scenarios live in the interaction between the
 * webhook handler and the database, so testing them normally means a live
 * MongoDB — which makes them the kind of test nobody runs. Instead this harness
 * installs a small in-memory stand-in for the Mongo surface the payment code
 * actually uses (insertOne with unique-index enforcement, findOne, updateOne
 * with $set), and points DatabaseConnector at it. The code under test is the
 * real handler, the real query engines and the real completion services; only
 * the storage is substituted, and it enforces the one property the payment code
 * depends on — unique-index violations.
 *
 * Set VERIFY_SETTLEMENT_REAL_DB=1 to run the same scenarios against the
 * configured MongoDB instead. Everything below is otherwise identical.
 */

import { createRequire } from "module";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

const TEST_WEBHOOK_SECRET = "reliability_harness_webhook_secret";
process.env.RAZORPAY_KEY_ID = "rzp_test_reliability";
process.env.RAZORPAY_KEY_SECRET = "reliability_harness_key_secret";
process.env.RAZORPAY_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
delete process.env.RAZORPAY_WEBHOOK_SECRET_PREVIOUS;

const bUseRealDatabase = String(process.env.VERIFY_SETTLEMENT_REAL_DB || "") === "1";
if (bUseRealDatabase)
{
    require("dotenv").config({ path: path.join(currentDirectory, ".env") });
}

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

// ── In-memory stand-in for the Mongo surface the payment code uses ──────────
//
// Deliberately minimal. It supports exactly the operations the payment path
// performs, and it enforces unique indexes, because unique-index violation IS
// the idempotency mechanism under test. Anything it does not support would be a
// silent false pass, so unsupported operators throw loudly.

function matchesFilter(document, filter)
{
    for (const [field, condition] of Object.entries(filter))
    {
        const value = field.split(".").reduce((carrier, part) => (carrier === undefined || carrier === null ? undefined : carrier[part]), document);

        if (condition !== null && typeof condition === "object" && !(condition instanceof Date) && !Array.isArray(condition))
        {
            for (const [operator, operand] of Object.entries(condition))
            {
                if (operator === "$ne")
                {
                    if (value === operand) return false;
                }
                else if (operator === "$in")
                {
                    if (!operand.includes(value)) return false;
                }
                else if (operator === "$lt")
                {
                    if (!(value < operand)) return false;
                }
                else if (operator === "$exists")
                {
                    if ((value !== undefined) !== operand) return false;
                }
                else if (operator === "$type")
                {
                    if (operand === "string" && typeof value !== "string") return false;
                }
                else
                {
                    throw new Error(`In-memory store does not support operator ${operator}`);
                }
            }
            continue;
        }

        if (value instanceof Date && condition instanceof Date)
        {
            if (value.getTime() !== condition.getTime()) return false;
            continue;
        }

        if (value !== condition) return false;
    }
    return true;
}

function applyUpdate(document, update)
{
    for (const [operator, fields] of Object.entries(update))
    {
        if (operator === "$set")
        {
            for (const [field, value] of Object.entries(fields))
            {
                const parts = field.split(".");
                let target = document;
                for (let index = 0; index < parts.length - 1; index = index + 1)
                {
                    if (target[parts[index]] === undefined) target[parts[index]] = {};
                    target = target[parts[index]];
                }
                target[parts[parts.length - 1]] = value;
            }
        }
        else if (operator === "$inc")
        {
            // Dotted paths matter here: the credit balance lives at
            // "additionalData.credits", and incrementing a literal key with a
            // dot in its name would leave the real balance untouched while
            // every caller still reported success.
            for (const [field, value] of Object.entries(fields))
            {
                const parts = field.split(".");
                let target = document;
                for (let index = 0; index < parts.length - 1; index = index + 1)
                {
                    if (target[parts[index]] === undefined) target[parts[index]] = {};
                    target = target[parts[index]];
                }
                const leaf = parts[parts.length - 1];
                target[leaf] = (Number(target[leaf]) || 0) + value;
            }
        }
        else if (operator === "$setOnInsert")
        {
            // Handled by the caller on insert.
        }
        else
        {
            throw new Error(`In-memory store does not support update operator ${operator}`);
        }
    }
}

class InMemoryCollection
{
    constructor(name)
    {
        this.name = name;
        this.documents = [];
        this.uniqueIndexes = [];
    }

    async createIndex(specification, options = {})
    {
        if (options.unique)
        {
            this.uniqueIndexes.push({ fields: Object.keys(specification), partial: options.partialFilterExpression || null });
        }
    }

    #assertUnique(candidate)
    {
        for (const index of this.uniqueIndexes)
        {
            if (index.partial && !matchesFilter(candidate, index.partial)) continue;
            const conflict = this.documents.some((existing) =>
            {
                if (index.partial && !matchesFilter(existing, index.partial)) return false;
                return index.fields.every(field => existing[field] === candidate[field]);
            });
            if (conflict)
            {
                const duplicateError = new Error(`E11000 duplicate key error on ${index.fields.join(",")}`);
                duplicateError.code = 11000;
                throw duplicateError;
            }
        }
    }

    async insertOne(document)
    {
        const stored = JSON.parse(JSON.stringify(document, (key, value) => value));
        // Preserve Date instances that JSON round-tripping would flatten.
        for (const [field, value] of Object.entries(document))
        {
            if (value instanceof Date) stored[field] = value;
        }
        this.#assertUnique(stored);
        this.documents.push(stored);
        return { insertedId: stored.id || stored._id || null, acknowledged: true };
    }

    async findOne(filter = {}, options = {})
    {
        const found = this.documents.find(document => matchesFilter(document, filter));
        return found ? { ...found } : null;
    }

    async updateOne(filter = {}, update = {}, options = {})
    {
        const index = this.documents.findIndex(document => matchesFilter(document, filter));
        if (index >= 0)
        {
            applyUpdate(this.documents[index], update);
            return { matchedCount: 1, modifiedCount: 1, upsertedId: null, acknowledged: true };
        }
        if (options.upsert)
        {
            const inserted = {};
            for (const [field, value] of Object.entries(filter))
            {
                if (typeof value !== "object" || value === null) inserted[field] = value;
            }
            applyUpdate(inserted, update);
            if (update.$setOnInsert) Object.assign(inserted, update.$setOnInsert);
            this.documents.push(inserted);
            return { matchedCount: 0, modifiedCount: 0, upsertedId: inserted.id || null, acknowledged: true };
        }
        return { matchedCount: 0, modifiedCount: 0, upsertedId: null, acknowledged: true };
    }

    async findOneAndUpdate(filter = {}, update = {}, options = {})
    {
        const index = this.documents.findIndex(document => matchesFilter(document, filter));
        if (index < 0) return options.includeResultMetadata ? { value: null } : null;
        const before = { ...this.documents[index] };
        applyUpdate(this.documents[index], update);
        const value = options.returnDocument === "after" ? { ...this.documents[index] } : before;
        return options.includeResultMetadata ? { value: value } : value;
    }

    async deleteOne(filter = {})
    {
        const index = this.documents.findIndex(document => matchesFilter(document, filter));
        if (index >= 0)
        {
            this.documents.splice(index, 1);
            return { deletedCount: 1 };
        }
        return { deletedCount: 0 };
    }

    async deleteMany(filter = {})
    {
        const before = this.documents.length;
        this.documents = this.documents.filter(document => !matchesFilter(document, filter));
        return { deletedCount: before - this.documents.length };
    }

    find(filter = {})
    {
        const results = this.documents.filter(document => matchesFilter(document, filter)).map(document => ({ ...document }));
        return {
            toArray: async () => results,
            sort: () => ({ toArray: async () => results, limit: () => ({ toArray: async () => results }) }),
            limit: () => ({ toArray: async () => results })
        };
    }

    async countDocuments(filter = {})
    {
        return this.documents.filter(document => matchesFilter(document, filter)).length;
    }
}

class InMemoryDatabase
{
    constructor()
    {
        this.collections = new Map();
    }

    collection(name)
    {
        if (!this.collections.has(name)) this.collections.set(name, new InMemoryCollection(name));
        return this.collections.get(name);
    }

    async command()
    {
        return { ok: 1 };
    }
}

const DatabaseConnector = require("./Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("./Globals/Constants/DatabaseConstants");

let inMemoryDatabase = new InMemoryDatabase();
if (!bUseRealDatabase)
{
    DatabaseConnector.getDatabase = async () => inMemoryDatabase;
}

// Alerts are asserted on, so capture them rather than writing them anywhere.
const Alerts = require("./Globals/Classes/Alerts/Alerts");
let raisedAlerts = [];
Alerts.raise = async (alert) => { raisedAlerts.push(alert); return null; };

const { handleRazorpayWebhook } = require("./Endpoints/Webhook/HandleRazorpayWebhook");
const PendingCreditOrderQueryEngine = require("./Globals/Classes/Database/PendingCreditOrderQueryEngine");
const SettlementAmountGuard = require("./Globals/Classes/Payments/SettlementAmountGuard");

// ── Test doubles for the Packetron request / response pair ─────────────────

function signBody(rawBody)
{
    return crypto.createHmac("sha256", TEST_WEBHOOK_SECRET).update(rawBody).digest("hex");
}

function makeCapturedEvent({ orderId, paymentId, amountMinor, currency = "INR", eventName = "payment.captured" })
{
    return JSON.stringify
    ({
        event: eventName,
        payload: { payment: { entity: { id: paymentId, order_id: orderId, amount: amountMinor, currency: currency, status: "captured" } } }
    });
}

async function deliverWebhook(rawBody, { eventId, signature } = {})
{
    const request =
    {
        headers:
        {
            "x-razorpay-signature": signature !== undefined ? signature : signBody(rawBody),
            "x-razorpay-event-id": eventId
        },
        getBody: async () => rawBody
    };

    let capturedStatus = null;
    let capturedJson = null;
    const response =
    {
        set statusCode(value) { capturedStatus = value; },
        get statusCode() { return capturedStatus; },
        sendJson: (payload) => { capturedJson = payload; },
        sendStatusCode: (value) => { capturedStatus = value; }
    };

    await handleRazorpayWebhook(request, response);
    return { statusCode: capturedStatus, body: capturedJson };
}

const BUYER_USER_ID = "user-reliability";

/**
 * CreditLedger.grant refuses to credit a user that does not exist, returning
 * applied:false / rejected:true. A harness that skipped this would exercise the
 * rejection path while appearing to test the happy path, so the buyer is seeded
 * explicitly and their balance is asserted afterwards.
 */
async function seedBuyer(userId = BUYER_USER_ID)
{
    const usersCollection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.USERS_COLLECTION);
    await usersCollection.updateOne
    (
        { id: userId },
        { $set: { id: userId, displayName: "Reliability Harness", additionalData: { email: "harness@example.invalid", credits: 0 } } },
        { upsert: true }
    );
}

async function buyerBalance(userId = BUYER_USER_ID)
{
    const usersCollection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.USERS_COLLECTION);
    const user = await usersCollection.findOne({ id: userId });
    return user?.additionalData?.credits ?? null;
}

async function seedCreditOrder({ orderId, userId = BUYER_USER_ID, credits = 100, amountMinor = 49900, currency = "INR" })
{
    await seedBuyer(userId);
    await PendingCreditOrderQueryEngine.createPendingCreditOrder
    ({
        providerOrderId: orderId,
        userId: userId,
        credits: credits,
        amountMinor: amountMinor,
        currency: currency,
        region: "INDIA",
        unitPrice: 4.99,
        discountPercent: 0,
        paymentProvider: 1
    });
}

function creditTransactionCount(referenceKey)
{
    const collection = inMemoryDatabase.collections.get(DatabaseConstants.CREDIT_TRANSACTIONS_COLLECTION);
    if (!collection) return 0;
    return collection.documents.filter(document => document.referenceKey === referenceKey).length;
}

/**
 * Clears data WITHOUT discarding collections, because the query engines cache
 * "indexes ensured" in a private static and would never rebuild them on a fresh
 * database object. Replacing the store between cases would therefore silently
 * drop the unique indexes that ARE the idempotency mechanism under test — the
 * concurrency case would pass for the wrong reason.
 */
async function resetWorld()
{
    for (const collection of inMemoryDatabase.collections.values())
    {
        collection.documents = [];
    }
    raisedAlerts = [];
    await ensureLedgerIndexes();
}

/**
 * The unique referenceKey index on creditTransactions is created by
 * DatabaseConnector's schema setup, not by CreditLedger, so a harness that only
 * exercises the query engines would run without it. It is load-bearing for
 * grant idempotency, so it is created explicitly here to mirror production.
 */
async function ensureLedgerIndexes()
{
    const database = await DatabaseConnector.getDatabase();
    await database.collection(DatabaseConstants.CREDIT_TRANSACTIONS_COLLECTION)
        .createIndex({ referenceKey: 1 }, { unique: true });
    await database.collection(DatabaseConstants.USERS_COLLECTION)
        .createIndex({ id: 1 }, { unique: true });
}

// ── The matrix ─────────────────────────────────────────────────────────────

async function run()
{
    console.log(bUseRealDatabase
        ? "\nRunning against the CONFIGURED MongoDB (VERIFY_SETTLEMENT_REAL_DB=1)."
        : "\nRunning against the in-memory store. Set VERIFY_SETTLEMENT_REAL_DB=1 for a real MongoDB run.");

    await ensureLedgerIndexes();

    console.log("\n1. Amount guard — the comparison rules in isolation (C4)");
    {
        const matched = SettlementAmountGuard.compare(
            { amountMinor: 49900, currency: "INR", providerOrderId: "order_1" },
            { amountMinor: 49900, currency: "INR", providerOrderId: "order_1" });
        check("identical values match", matched.matched === true && matched.comparable === true);

        const underpaid = SettlementAmountGuard.compare(
            { amountMinor: 100, currency: "INR", providerOrderId: "order_1" },
            { amountMinor: 49900, currency: "INR", providerOrderId: "order_1" });
        check("a lower amount is a mismatch", underpaid.matched === false);
        check("...and settlement is refused", SettlementAmountGuard.permitsSettlement(underpaid) === false);

        const wrongCurrency = SettlementAmountGuard.compare(
            { amountMinor: 49900, currency: "IDR", providerOrderId: "order_1" },
            { amountMinor: 49900, currency: "INR", providerOrderId: "order_1" });
        check("a substituted currency is a mismatch (A2)", wrongCurrency.matched === false);

        const caseInsensitive = SettlementAmountGuard.compare(
            { amountMinor: 49900, currency: "inr", providerOrderId: "order_1" },
            { amountMinor: 49900, currency: "INR", providerOrderId: "order_1" });
        check("currency comparison is case-insensitive", caseInsensitive.matched === true);

        const wrongOrder = SettlementAmountGuard.compare(
            { amountMinor: 49900, currency: "INR", providerOrderId: "order_OTHER" },
            { amountMinor: 49900, currency: "INR", providerOrderId: "order_1" });
        check("a payment belonging to another order is a mismatch", wrongOrder.matched === false);

        const absent = SettlementAmountGuard.compare({}, { amountMinor: 49900, currency: "INR", providerOrderId: "order_1" });
        check("an event carrying no comparable field is not a mismatch", absent.outcome === SettlementAmountGuard.OUTCOME_NOT_COMPARABLE);
        check("...and still permits settlement", SettlementAmountGuard.permitsSettlement(absent) === true);

        const offByOne = SettlementAmountGuard.compare(
            { amountMinor: 49899, currency: "INR", providerOrderId: "order_1" },
            { amountMinor: 49900, currency: "INR", providerOrderId: "order_1" });
        check("a one-paise difference is a mismatch (no tolerance)", offByOne.matched === false);
    }

    console.log("\n2. Happy path — a captured payment settles exactly once");
    {
        await resetWorld();
        await seedCreditOrder({ orderId: "order_happy" });
        const body = makeCapturedEvent({ orderId: "order_happy", paymentId: "pay_happy", amountMinor: 49900 });
        const result = await deliverWebhook(body, { eventId: "evt_happy" });

        check("the delivery is acknowledged", result.statusCode === 200);
        check("the credit order is reported settled", result.body?.creditOrderCompleted === true);
        check("exactly one ledger transaction exists", creditTransactionCount("creditPurchase:order_happy") === 1);
        check("the buyer's balance increased by exactly the ordered credits", (await buyerBalance()) === 100);
        check("the order is marked CONSUMED",
            (await PendingCreditOrderQueryEngine.getByOrderId("order_happy"))?.status === "CONSUMED");
        check("no alert was raised on the happy path", raisedAlerts.length === 0);
    }

    console.log("\n3. Same webhook delivered twice — provisioned once");
    {
        await resetWorld();
        await seedCreditOrder({ orderId: "order_dup" });
        const body = makeCapturedEvent({ orderId: "order_dup", paymentId: "pay_dup", amountMinor: 49900 });

        const first = await deliverWebhook(body, { eventId: "evt_dup" });
        const second = await deliverWebhook(body, { eventId: "evt_dup" });

        check("the first delivery settles", first.body?.creditOrderCompleted === true);
        check("the second is recognised as already processed",
            second.body?.reason === "WEBHOOK_EVENT_ALREADY_PROCESSED");
        check("only one ledger transaction exists", creditTransactionCount("creditPurchase:order_dup") === 1);
        check("the buyer was credited once", (await buyerBalance()) === 100);
    }

    console.log("\n4. Redelivery with NO event id — the gate fails open, downstream still holds");
    {
        await resetWorld();
        await seedCreditOrder({ orderId: "order_noid" });
        const body = makeCapturedEvent({ orderId: "order_noid", paymentId: "pay_noid", amountMinor: 49900 });

        const first = await deliverWebhook(body, { eventId: undefined });
        const second = await deliverWebhook(body, { eventId: undefined });

        check("the first delivery settles without an event id", first.body?.creditOrderCompleted === true);
        check("the second is caught by the CONSUMED status, not the event gate",
            second.body?.reason === "CREDIT_ORDER_ALREADY_PROCESSED");
        check("still only one ledger transaction", creditTransactionCount("creditPurchase:order_noid") === 1);
        check("the buyer was credited once", (await buyerBalance()) === 100);
    }

    console.log("\n5. Two deliveries racing — concurrent settlement grants once");
    {
        await resetWorld();
        await seedCreditOrder({ orderId: "order_race" });
        const body = makeCapturedEvent({ orderId: "order_race", paymentId: "pay_race", amountMinor: 49900 });

        const [resultA, resultB] = await Promise.all([
            deliverWebhook(body, { eventId: "evt_race_a" }),
            deliverWebhook(body, { eventId: "evt_race_b" })
        ]);

        check("both deliveries are acknowledged", resultA.statusCode === 200 && resultB.statusCode === 200);
        check("exactly one ledger transaction exists despite the race",
            creditTransactionCount("creditPurchase:order_race") === 1);
        check("the buyer was credited ONCE, not twice", (await buyerBalance()) === 100);
    }

    console.log("\n6. Out-of-order delivery — captured before authorized");
    {
        await resetWorld();
        await seedCreditOrder({ orderId: "order_order" });

        const authorized = makeCapturedEvent({ orderId: "order_order", paymentId: "pay_order", amountMinor: 49900, eventName: "payment.authorized" });
        const captured = makeCapturedEvent({ orderId: "order_order", paymentId: "pay_order", amountMinor: 49900 });

        const capturedFirst = await deliverWebhook(captured, { eventId: "evt_cap" });
        const authorizedAfter = await deliverWebhook(authorized, { eventId: "evt_auth" });

        check("captured settles even though authorized has not arrived", capturedFirst.body?.creditOrderCompleted === true);
        check("the later authorized event is ignored without error", authorizedAfter.body?.reason === "EVENT_IGNORED");
        check("no double grant from the ordering", creditTransactionCount("creditPurchase:order_order") === 1);
    }

    console.log("\n7. Amount mismatch — nothing is granted and an alert is raised (C4)");
    {
        await resetWorld();
        await seedCreditOrder({ orderId: "order_mismatch", amountMinor: 49900 });
        const body = makeCapturedEvent({ orderId: "order_mismatch", paymentId: "pay_mismatch", amountMinor: 100 });

        const result = await deliverWebhook(body, { eventId: "evt_mismatch" });

        check("the delivery is acknowledged so the provider stops retrying", result.statusCode === 200);
        check("settlement is refused with AMOUNT_MISMATCH", result.body?.reason === "AMOUNT_MISMATCH");
        check("NO credits were granted", creditTransactionCount("creditPurchase:order_mismatch") === 0);
        check("the buyer's balance is untouched", (await buyerBalance()) === 0);
        check("the order is still PENDING, not consumed",
            (await PendingCreditOrderQueryEngine.getByOrderId("order_mismatch"))?.status === "PENDING");
        check("an alert was raised", raisedAlerts.some(alert => alert.title.includes("amount does not match")));
        check("the alert names the flow and both amounts",
            raisedAlerts.some(alert => alert.message.includes("49900") && alert.message.includes("100")));
    }

    console.log("\n8. Currency substitution at settlement is refused (A2)");
    {
        await resetWorld();
        await seedCreditOrder({ orderId: "order_currency", amountMinor: 49900, currency: "INR" });
        const body = makeCapturedEvent({ orderId: "order_currency", paymentId: "pay_currency", amountMinor: 49900, currency: "IDR" });

        const result = await deliverWebhook(body, { eventId: "evt_currency" });
        check("settlement is refused", result.body?.reason === "AMOUNT_MISMATCH");
        check("no credits granted", creditTransactionCount("creditPurchase:order_currency") === 0);
    }

    console.log("\n9. Unknown order — acknowledged, nothing granted, alert raised (B8)");
    {
        await resetWorld();
        const body = makeCapturedEvent({ orderId: "order_unknown", paymentId: "pay_unknown", amountMinor: 49900 });
        const result = await deliverWebhook(body, { eventId: "evt_unknown" });

        check("the delivery is acknowledged", result.statusCode === 200);
        check("the reason is PAYMENT_ROW_NOT_FOUND", result.body?.reason === "PAYMENT_ROW_NOT_FOUND");
        check("an alert was raised for the unaccounted payment",
            raisedAlerts.some(alert => alert.title.includes("no matching local order")));
    }

    console.log("\n10. Hostile and malformed deliveries settle nothing");
    {
        await resetWorld();
        await seedCreditOrder({ orderId: "order_hostile" });
        const body = makeCapturedEvent({ orderId: "order_hostile", paymentId: "pay_hostile", amountMinor: 49900 });

        const badSignature = await deliverWebhook(body, { eventId: "evt_bad", signature: "deadbeef" });
        check("a bad signature settles nothing", badSignature.body?.reason === "INVALID_SIGNATURE");
        check("...and grants nothing", creditTransactionCount("creditPurchase:order_hostile") === 0);
        check("...and raises a signature alert",
            raisedAlerts.some(alert => alert.title.includes("signature verification failed")));

        const emptyBody = await deliverWebhook("", { eventId: "evt_empty" });
        check("an empty body is acknowledged and settles nothing", emptyBody.body?.reason === "EMPTY_BODY");

        const malformed = await deliverWebhook("{not json", { eventId: "evt_malformed" });
        check("a malformed body is acknowledged and settles nothing", malformed.body?.reason === "INVALID_BODY");

        const unknownEvent = await deliverWebhook(JSON.stringify({ event: "payment.dispute.created" }), { eventId: "evt_unknown_type" });
        check("an unknown event type returns 200 without crashing", unknownEvent.statusCode === 200 && unknownEvent.body?.reason === "EVENT_IGNORED");

        const prototypePollution = JSON.stringify
        ({
            event: "payment.captured",
            __proto__: { polluted: true },
            payload: { payment: { entity: { id: "pay_p", order_id: "order_hostile", amount: 49900, currency: "INR", constructor: { prototype: { polluted: true } } } } }
        });
        await deliverWebhook(prototypePollution, { eventId: "evt_proto" });
        check("a __proto__ payload does not pollute Object.prototype", ({}).polluted === undefined);
    }

    console.log("\n11. Recovery — an order left PENDING by an outage can still be settled");
    {
        await resetWorld();
        await seedCreditOrder({ orderId: "order_outage" });
        const body = makeCapturedEvent({ orderId: "order_outage", paymentId: "pay_outage", amountMinor: 49900 });

        // Simulate the endpoint having been down: the event was never delivered,
        // so the order sits PENDING. A later redelivery (or a reconciliation
        // sweep calling the same completion service) must settle it.
        const pendingBefore = await PendingCreditOrderQueryEngine.getByOrderId("order_outage");
        check("the order is PENDING before recovery", pendingBefore?.status === "PENDING");

        const recovered = await deliverWebhook(body, { eventId: "evt_outage_replay" });
        check("the replayed delivery settles it", recovered.body?.creditOrderCompleted === true);
        check("exactly one grant results", creditTransactionCount("creditPurchase:order_outage") === 1);
    }

    console.log(`\n${passedCount} passed, ${failedCount} failed.`);
    if (failedCount > 0)
    {
        console.error("\nSettlement reliability regressions detected. Do not ship.");
        process.exit(1);
    }
    console.log("All payment settlement reliability checks passed.");
}

run().catch((harnessError) =>
{
    console.error("Harness crashed:", harnessError);
    process.exit(1);
});
