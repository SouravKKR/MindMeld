/**
 * Adversarial harness for the payment surface — the handbook's Part 10.5.
 *
 * Run from the Dock directory:
 *     node VerifyPaymentAdversarial.mjs
 *
 * The reliability harness proves the integration WORKS. This one proves it
 * cannot be ABUSED: it plays the attacker rather than the unlucky customer.
 *
 * The written checklist, including the cases that need a browser or a provider
 * dashboard, is Common/Testing/PaymentAdversarialChecklist.md. This file
 * automates the subset that can be driven in-process, so the ones that CAN be
 * regression-tested are, rather than living only in a document nobody re-reads.
 *
 * Like the reliability harness this substitutes an in-memory store for Mongo,
 * so it runs anywhere with no services. The code under test is real.
 *
 * A note on what a passing run means. Each case attempts one specific abuse and
 * asserts it was refused. That is evidence, not proof — it cannot show the
 * absence of a vulnerability, only that these particular doors are shut.
 */

import { createRequire } from "module";
import crypto from "crypto";

const require = createRequire(import.meta.url);

const TEST_WEBHOOK_SECRET = "adversarial_harness_webhook_secret";
process.env.RAZORPAY_KEY_ID = "rzp_test_adversarial";
process.env.RAZORPAY_KEY_SECRET = "adversarial_harness_key_secret";
process.env.RAZORPAY_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;

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

async function checkRefused(description, action)
{
    try
    {
        const refused = await action();
        check(description, refused === true);
    }
    catch (thrownError)
    {
        // A thrown exception is NOT an acceptable refusal on a money endpoint —
        // it surfaces as a 500 and often leaks internals. The attack must be
        // turned away deliberately.
        failedCount = failedCount + 1;
        console.error(`  FAIL  ${description} — threw ${thrownError?.name}: ${thrownError?.message} (a refusal must be deliberate, not an exception)`);
    }
}

const DatabaseConnector = require("./Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("./Globals/Constants/DatabaseConstants");

// Minimal in-memory store. Mirrors the reliability harness; kept local so each
// harness runs standalone.
class Collection
{
    constructor() { this.documents = []; this.uniqueIndexes = []; }
    async createIndex(spec, options = {}) { if (options.unique) this.uniqueIndexes.push(Object.keys(spec)); }
    #match(document, filter)
    {
        for (const [field, condition] of Object.entries(filter))
        {
            const value = field.split(".").reduce((carrier, part) => (carrier ?? {})[part], document);
            if (condition !== null && typeof condition === "object" && !(condition instanceof Date))
            {
                // Mongo query operators reaching this point would mean the
                // application passed an unvalidated object straight into a
                // query — exactly the injection this harness hunts for. Refuse
                // to emulate them so such a bug surfaces as a failure rather
                // than a silent match.
                throw new Error("QUERY_OPERATOR_REACHED_STORE");
            }
            if (value !== condition) return false;
        }
        return true;
    }
    async insertOne(document)
    {
        for (const fields of this.uniqueIndexes)
        {
            if (this.documents.some(existing => fields.every(field => existing[field] === document[field])))
            {
                const duplicate = new Error("E11000 duplicate key"); duplicate.code = 11000; throw duplicate;
            }
        }
        this.documents.push({ ...document });
        return { acknowledged: true };
    }
    async findOne(filter = {}) { const found = this.documents.find(d => this.#match(d, filter)); return found ? { ...found } : null; }
    async updateOne(filter = {}, update = {}, options = {})
    {
        const index = this.documents.findIndex(d => this.#match(d, filter));
        const target = index >= 0 ? this.documents[index] : (options.upsert ? {} : null);
        if (!target) return { matchedCount: 0, modifiedCount: 0 };
        if (index < 0)
        {
            for (const [field, value] of Object.entries(filter)) if (typeof value !== "object") target[field] = value;
            this.documents.push(target);
        }
        for (const [field, value] of Object.entries(update.$set || {}))
        {
            const parts = field.split("."); let node = target;
            for (let i = 0; i < parts.length - 1; i = i + 1) { if (!node[parts[i]]) node[parts[i]] = {}; node = node[parts[i]]; }
            node[parts[parts.length - 1]] = value;
        }
        return { matchedCount: 1, modifiedCount: index >= 0 ? 1 : 0 };
    }
    find() { return { toArray: async () => this.documents.map(d => ({ ...d })), sort: () => ({ toArray: async () => [], limit: () => ({ toArray: async () => [] }) }) }; }
}

class Database
{
    constructor() { this.collections = new Map(); }
    collection(name) { if (!this.collections.has(name)) this.collections.set(name, new Collection()); return this.collections.get(name); }
    async command() { return { ok: 1 }; }
}

const database = new Database();
DatabaseConnector.getDatabase = async () => database;

const Alerts = require("./Globals/Classes/Alerts/Alerts");
let raisedAlerts = [];
Alerts.raise = async (alert) => { raisedAlerts.push(alert); return null; };

const PendingCreditOrderQueryEngine = require("./Globals/Classes/Database/PendingCreditOrderQueryEngine");
const PendingOrderQueryEngine = require("./Globals/Classes/Database/PendingOrderQueryEngine");
const PaymentProvider = require("./Globals/Classes/Payments/PaymentProvider");
const RazorpayPaymentProvider = require("./Globals/Classes/Payments/RazorpayPaymentProvider");
const SettlementAmountGuard = require("./Globals/Classes/Payments/SettlementAmountGuard");
const { handleRazorpayWebhook } = require("./Endpoints/Webhook/HandleRazorpayWebhook");

const provider = new RazorpayPaymentProvider();

function signBody(rawBody) { return crypto.createHmac("sha256", TEST_WEBHOOK_SECRET).update(rawBody).digest("hex"); }

async function deliverWebhook(rawBody, { eventId, signature } = {})
{
    const request =
    {
        headers: { "x-razorpay-signature": signature !== undefined ? signature : signBody(rawBody), "x-razorpay-event-id": eventId },
        getBody: async () => rawBody
    };
    let status = null; let body = null;
    const response =
    {
        set statusCode(value) { status = value; }, get statusCode() { return status; },
        sendJson: (payload) => { body = payload; },
        sendStatusCode: (value) => { status = value; }
    };
    await handleRazorpayWebhook(request, response);
    return { statusCode: status, body: body };
}

async function run()
{
    console.log("\nT — Tampering");
    {
        // The order-creation handlers derive the amount from a server catalogue.
        // The strongest available in-process assertion is that the chargeable
        // band refuses everything an attacker would supply as a quantity.
        const hostileQuantities = [-1, 0, 1.5, 1e12, Number.MAX_SAFE_INTEGER, Number.NaN, Infinity, "49900", null, {}];
        let allRefused = true;
        for (const quantity of hostileQuantities)
        {
            if (PaymentProvider.isChargeableAmount(quantity)) { allRefused = false; console.error(`        (accepted ${String(quantity)})`); }
        }
        check("T3 every hostile amount is refused by the chargeable band", allRefused === true);
        check("T3 a legitimate amount still passes", PaymentProvider.isChargeableAmount(49900) === true);
    }

    console.log("\nF — Forgery and replay");
    {
        const orderId = "order_adversarial";
        const paymentId = "pay_adversarial";
        const genuine = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest("hex");

        await checkRefused("F1 an invented signature is refused", async () =>
            (await provider.verifyPayment({ providerOrderId: orderId, providerPaymentId: paymentId, signature: "deadbeef".repeat(8) })).verified === false);

        await checkRefused("F2 a valid triple from ANOTHER order is refused (C2)", async () =>
        {
            const otherSignature = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET).update(`order_cheap|${paymentId}`).digest("hex");
            return (await provider.verifyPayment({ providerOrderId: orderId, providerPaymentId: paymentId, signature: otherSignature })).verified === false;
        });

        check("F1 the genuine signature still verifies (the test is not vacuous)",
            (await provider.verifyPayment({ providerOrderId: orderId, providerPaymentId: paymentId, signature: genuine })).verified === true);

        for (const hostile of [null, undefined, [], {}, true, 0, { toString: () => genuine }])
        {
            await checkRefused(`F5 signature ${JSON.stringify(hostile) ?? String(hostile)} is refused without throwing`, async () =>
                (await provider.verifyPayment({ providerOrderId: orderId, providerPaymentId: paymentId, signature: hostile })).verified === false);
        }
    }

    console.log("\nI — Injection through payment identifiers");
    {
        // A Mongo operator smuggled in as an order id must never reach the
        // store. The in-memory collection throws if one does, so a regression
        // fails loudly instead of silently matching an arbitrary row.
        const operatorPayloads = [{ $ne: null }, { $gt: "" }, { $regex: ".*" }, ["order_x"], { $where: "1==1" }];
        for (const payload of operatorPayloads)
        {
            await checkRefused(`I1 ${JSON.stringify(payload)} as an order id returns nothing`, async () =>
                (await PendingCreditOrderQueryEngine.getByOrderId(payload)) === null);
            await checkRefused(`I1 ${JSON.stringify(payload)} as a deck order id returns nothing`, async () =>
                (await PendingOrderQueryEngine.getByOrderId(payload)) === null);
        }
    }

    console.log("\nW — Webhook abuse");
    {
        raisedAlerts = [];
        await PendingCreditOrderQueryEngine.createPendingCreditOrder
        ({
            providerOrderId: "order_webhook_abuse", userId: "user-adv", credits: 100,
            amountMinor: 49900, currency: "INR", region: "INDIA", unitPrice: 4.99, discountPercent: 0, paymentProvider: 0
        });

        const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_abuse", order_id: "order_webhook_abuse", amount: 1, currency: "INR" } } } });

        const forged = await deliverWebhook(body, { eventId: "evt_forged", signature: "0".repeat(64) });
        check("W1 an unsigned/forged webhook settles nothing", forged.body?.reason === "INVALID_SIGNATURE");

        const underpaid = await deliverWebhook(body, { eventId: "evt_underpaid" });
        check("W3 a signed webhook claiming ₹0.01 for a ₹499 order is refused (C4)", underpaid.body?.reason === "AMOUNT_MISMATCH");
        check("W3 ...and the order is NOT consumed",
            (await PendingCreditOrderQueryEngine.getByOrderId("order_webhook_abuse"))?.status === "PENDING");
        check("W3 ...and an alert names the discrepancy",
            raisedAlerts.some(alert => alert.title.includes("amount does not match")));

        const escalated = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_esc", order_id: "order_webhook_abuse", amount: 9999900, currency: "INR" } } } });
        const overpaid = await deliverWebhook(escalated, { eventId: "evt_overpaid" });
        check("W3 an INFLATED amount is refused just as firmly as a deflated one", overpaid.body?.reason === "AMOUNT_MISMATCH");
    }

    console.log("\nB — Business logic");
    {
        // A8: what the buyer is provisioned for must come from the frozen order,
        // never from a live re-read. Mutating the pending row's deck list after
        // creation is the closest in-process analogue of changing the cart in
        // another tab, and settlement must ignore anything not on the order.
        await PendingOrderQueryEngine.createPendingOrder
        ({ providerOrderId: "order_cart", userId: "user-adv", deckIds: ["deck-cheap"], amountMinor: 10000, currency: "INR", region: "INDIA", paymentProvider: 0 });

        const stored = await PendingOrderQueryEngine.getByOrderId("order_cart");
        check("B1 the order froze the deck list at creation", Array.isArray(stored.deckIds) && stored.deckIds.length === 1 && stored.deckIds[0] === "deck-cheap");
        check("B1 the order froze the amount at creation", stored.amountMinor === 10000);

        // The settlement guard must reject a payment for a DIFFERENT amount than
        // the frozen one, which is what an upgraded cart would produce.
        const upgraded = SettlementAmountGuard.compare(
            { amountMinor: 500000, currency: "INR", providerOrderId: "order_cart" },
            { amountMinor: stored.amountMinor, currency: stored.currency, providerOrderId: "order_cart" });
        check("B1 paying an upgraded price against the frozen order is a mismatch", upgraded.matched === false);
    }

    console.log("\nS — Secrets and configuration");
    {
        const RazorpayProviderClass = RazorpayPaymentProvider;
        const instance = new RazorpayProviderClass();
        const serialised = JSON.stringify(instance);
        check("S1 the provider does not serialise its secrets",
            !serialised.includes(process.env.RAZORPAY_KEY_SECRET) && !serialised.includes(TEST_WEBHOOK_SECRET));
        check("S1 only the public key id is exposed", instance.getPublicKeyId() === "rzp_test_adversarial");

        const inspected = Object.keys(instance).join(",");
        check("S1 no secret is reachable as an own enumerable property", !inspected.toLowerCase().includes("secret"));
    }

    console.log(`\n${passedCount} passed, ${failedCount} failed.`);
    if (failedCount > 0)
    {
        console.error("\nAn adversarial case succeeded where it should have been refused. Do not ship.");
        process.exit(1);
    }
    console.log("All adversarial payment cases were refused as expected.");
    console.log("Cases needing a browser, a server or the provider dashboard remain in");
    console.log("Common/Testing/PaymentAdversarialChecklist.md — this harness is a subset, not the whole checklist.");
}

run().catch((harnessError) =>
{
    console.error("Harness crashed:", harnessError);
    process.exit(1);
});
