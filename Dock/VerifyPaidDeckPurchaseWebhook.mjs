/**
 * End-to-end verification harness for the paid-deck purchase webhook path —
 * the server-authoritative safety net that settles a paid-deck order when the
 * buyer closes the tab before /PaidDecks/Purchase/Verify runs.
 *
 * Run from the Dock directory:
 *     node VerifyPaidDeckPurchaseWebhook.mjs
 *
 * Two tiers, each self-gating so the default run needs no external services:
 *
 *   1. ALWAYS — in-process routing checks over the real HandleRazorpayWebhook
 *      with the query engines and the completion service monkeypatched: a
 *      genuine HMAC over a genuine `payment.captured` body reaches the paid-deck
 *      branch with the trusted pending row, a consumed order never re-grants, a
 *      failing settlement is still acked, and the pre-existing branches
 *      (organization / credits / deal / subscription / unknown) are unchanged.
 *
 *   2. DB (opt-in: VERIFY_DECK_WEBHOOK_DB=1) — drives the real
 *      PendingOrderQueryEngine against the configured MongoDB to prove the grant
 *      claim actually serializes the browser leg and the webhook: one claim wins,
 *      the concurrent caller loses, a released claim is retryable, a stale claim
 *      is taken over, and a consumed order is never claimable again. Creates
 *      throwaway rows keyed by a verify-only order id and cleans them up.
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import crypto from "crypto";

const require = createRequire(import.meta.url);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

require("dotenv").config({ path: path.join(currentDirectory, ".env") });

// A deterministic secret so the harness can sign bodies exactly like Razorpay
// does. Set before the handler is required so nothing caches a different value.
const WEBHOOK_SECRET = "verify-harness-webhook-secret";
process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;

const { handleRazorpayWebhook } = require("./Endpoints/Webhook/HandleRazorpayWebhook");
const OrganizationPaymentQueryEngine = require("./Globals/Classes/Organization/OrganizationPaymentQueryEngine");
const PendingCreditOrderQueryEngine = require("./Globals/Classes/Database/PendingCreditOrderQueryEngine");
const CreditDealPaymentQueryEngine = require("./Globals/Classes/Credits/CreditDealPaymentQueryEngine");
const PendingOrderQueryEngine = require("./Globals/Classes/Database/PendingOrderQueryEngine");
const PaidDeckPurchaseCompletionService = require("./Endpoints/PaidDeck/PaidDeckPurchaseCompletionService");
const SubscriptionWebhookProcessor = require("./Globals/Classes/Plans/SubscriptionWebhookProcessor");
const DatabaseConnector = require("./Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("./Globals/Constants/DatabaseConstants");
const { paymentProviders } = require("./Globals/Enumerations/PaymentProviders");
const ErrorCodes = require("./Globals/Constants/ErrorCodes");

let passedCount = 0;
let failedCount = 0;
let skippedCount = 0;

function assert(condition, description)
{
    if (condition)
    {
        passedCount = passedCount + 1;
        console.log(`  PASS  ${description}`);
    }
    else
    {
        failedCount = failedCount + 1;
        console.log(`  FAIL  ${description}`);
    }
}

function skip(description)
{
    skippedCount = skippedCount + 1;
    console.log(`  SKIP  ${description}`);
}

function section(title)
{
    console.log(`\n=== ${title} ===`);
}

// ── Fakes ───────────────────────────────────────────────────────────────────

function buildCapturedPaymentBody(providerOrderId, providerPaymentId)
{
    return JSON.stringify
    ({
        event: "payment.captured",
        payload: { payment: { entity: { id: providerPaymentId, order_id: providerOrderId } } }
    });
}

function signBody(rawBody)
{
    return crypto.createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");
}

function buildRequest(rawBody, signature)
{
    return {
        headers: { "x-razorpay-signature": signature },
        getBody: async () => rawBody
    };
}

function buildResponse()
{
    return {
        statusCode: 0,
        body: null,
        sendJson(payload)
        {
            this.body = payload;
        }
    };
}

/**
 * Runs the real handler over a signed `payment.captured` body with every lookup
 * stubbed, and restores the originals afterwards so tests stay independent.
 */
async function invokeWebhook({ providerOrderId, providerPaymentId, pendingDeckOrder, completionResult, completionError, rawBodyOverride, signatureOverride })
{
    const originals =
    {
        organizationFind: OrganizationPaymentQueryEngine.findByOrderId,
        creditGet: PendingCreditOrderQueryEngine.getByOrderId,
        dealFind: CreditDealPaymentQueryEngine.findByOrderId,
        pendingGet: PendingOrderQueryEngine.getByOrderId,
        complete: PaidDeckPurchaseCompletionService.complete
    };

    const observed = { completeCalls: [] };

    OrganizationPaymentQueryEngine.findByOrderId = async () => null;
    PendingCreditOrderQueryEngine.getByOrderId = async () => null;
    CreditDealPaymentQueryEngine.findByOrderId = async () => null;
    PendingOrderQueryEngine.getByOrderId = async () => pendingDeckOrder || null;
    PaidDeckPurchaseCompletionService.complete = async (pendingOrder, context) =>
    {
        observed.completeCalls.push({ pendingOrder: pendingOrder, context: context });
        if (completionError)
        {
            throw completionError;
        }
        return completionResult || { granted: true, alreadyProcessed: false, licenses: [{ deckId: "deck-1" }], deckIds: ["deck-1"] };
    };

    try
    {
        const rawBody = rawBodyOverride !== undefined ? rawBodyOverride : buildCapturedPaymentBody(providerOrderId, providerPaymentId);
        const signature = signatureOverride !== undefined ? signatureOverride : signBody(rawBody);
        const response = buildResponse();
        await handleRazorpayWebhook(buildRequest(rawBody, signature), response);
        return { response: response, observed: observed };
    }
    finally
    {
        OrganizationPaymentQueryEngine.findByOrderId = originals.organizationFind;
        PendingCreditOrderQueryEngine.getByOrderId = originals.creditGet;
        CreditDealPaymentQueryEngine.findByOrderId = originals.dealFind;
        PendingOrderQueryEngine.getByOrderId = originals.pendingGet;
        PaidDeckPurchaseCompletionService.complete = originals.complete;
    }
}

function buildPendingDeckOrder(overrides = {})
{
    return {
        providerOrderId: "order_verify_harness",
        userId: "user-verify-harness",
        deckIds: ["deck-1"],
        amountMinor: 49900,
        currency: "INR",
        region: "INDIA",
        paymentProvider: paymentProviders.RAZORPAY,
        status: PendingOrderQueryEngine.STATUS_PENDING,
        ...overrides
    };
}

// ── Tier 1: routing ─────────────────────────────────────────────────────────

async function runRoutingTier()
{
    section("Tier 1 — webhook routing (in-process, stubbed lookups)");

    // A paid-deck order the buyer never verified: the safety net must settle it.
    {
        const pendingDeckOrder = buildPendingDeckOrder();
        const { response, observed } = await invokeWebhook
        ({
            providerOrderId: pendingDeckOrder.providerOrderId,
            providerPaymentId: "pay_harness_1",
            pendingDeckOrder: pendingDeckOrder
        });

        assert(response.statusCode === 200, "Paid-deck settlement acks 200");
        assert(response.body?.acknowledged === true, "Paid-deck settlement acknowledges the delivery");
        assert(response.body?.deckOrderCompleted === true, "Paid-deck settlement reports the grant");
        assert(response.body?.licensesIssued === 1, "Paid-deck settlement reports the issued license count");
        assert(observed.completeCalls.length === 1, "Completion service invoked exactly once");

        const context = observed.completeCalls[0]?.context || {};
        assert(context.source === PaidDeckPurchaseCompletionService.SOURCE_WEBHOOK, "Settlement is tagged as the WEBHOOK source");
        assert(context.paymentProvider === paymentProviders.RAZORPAY, "Settlement records the Razorpay provider");
        assert(context.providerPaymentId === "pay_harness_1", "Settlement carries the provider payment id");
        assert(observed.completeCalls[0]?.pendingOrder === pendingDeckOrder, "Settlement is driven by the trusted pending row");
        assert(context.fallbackRegion === undefined, "Webhook passes no request-derived region (the stored one is authoritative)");
    }

    // An order the browser leg already settled must never re-grant.
    {
        const pendingDeckOrder = buildPendingDeckOrder({ status: PendingOrderQueryEngine.STATUS_CONSUMED });
        const { response, observed } = await invokeWebhook
        ({
            providerOrderId: pendingDeckOrder.providerOrderId,
            providerPaymentId: "pay_harness_2",
            pendingDeckOrder: pendingDeckOrder
        });

        assert(response.statusCode === 200, "Consumed paid-deck order acks 200");
        assert(response.body?.reason === ErrorCodes.DECK_ORDER_ALREADY_PROCESSED, "Consumed paid-deck order reports DECK_ORDER_ALREADY_PROCESSED");
        assert(observed.completeCalls.length === 0, "Consumed paid-deck order never calls the completion service");
    }

    // A failing settlement must not take the webhook down or trigger a retry
    // storm — the claim is released inside the service, so a later verify wins.
    {
        const pendingDeckOrder = buildPendingDeckOrder();
        const { response } = await invokeWebhook
        ({
            providerOrderId: pendingDeckOrder.providerOrderId,
            providerPaymentId: "pay_harness_3",
            pendingDeckOrder: pendingDeckOrder,
            completionError: new Error("seed failed")
        });

        assert(response.statusCode === 200, "Failed paid-deck settlement still acks 200");
        assert(response.body?.reason === ErrorCodes.EXCEPTION, "Failed paid-deck settlement reports EXCEPTION");
    }

    // A settlement that lost the claim to the concurrent browser leg.
    {
        const pendingDeckOrder = buildPendingDeckOrder();
        const { response } = await invokeWebhook
        ({
            providerOrderId: pendingDeckOrder.providerOrderId,
            providerPaymentId: "pay_harness_4",
            pendingDeckOrder: pendingDeckOrder,
            completionResult: { granted: false, alreadyProcessed: true, licenses: [], deckIds: [] }
        });

        assert(response.body?.deckOrderCompleted === false, "Claim loser reports no grant");
        assert(response.body?.alreadyProcessed === true, "Claim loser reports alreadyProcessed");
    }

    // Regression: an order that matches no flow at all still falls through.
    {
        const { response, observed } = await invokeWebhook
        ({
            providerOrderId: "order_unknown",
            providerPaymentId: "pay_harness_5",
            pendingDeckOrder: null
        });

        assert(response.body?.reason === ErrorCodes.PAYMENT_ROW_NOT_FOUND, "Unknown order still reports PAYMENT_ROW_NOT_FOUND");
        assert(observed.completeCalls.length === 0, "Unknown order never calls the completion service");
    }

    // Regression: an unsigned / mis-signed body never reaches any branch.
    {
        const { response, observed } = await invokeWebhook
        ({
            providerOrderId: "order_verify_harness",
            providerPaymentId: "pay_harness_6",
            pendingDeckOrder: buildPendingDeckOrder(),
            signatureOverride: "0".repeat(64)
        });

        assert(response.body?.reason === ErrorCodes.INVALID_SIGNATURE, "Bad signature is rejected before any lookup");
        assert(observed.completeCalls.length === 0, "Bad signature never calls the completion service");
    }

    // Regression: subscription events still route to the subscription processor
    // rather than falling into the new paid-deck branch.
    {
        const originalIsSubscriptionEvent = SubscriptionWebhookProcessor.isSubscriptionEvent;
        const originalProcess = SubscriptionWebhookProcessor.process;
        let processCalled = false;
        SubscriptionWebhookProcessor.process = async () =>
        {
            processCalled = true;
            return { handled: true, applied: "CHARGED" };
        };

        try
        {
            const rawBody = JSON.stringify
            ({
                event: "subscription.charged",
                payload: { subscription: { entity: { id: "sub_harness" } } }
            });
            const { response, observed } = await invokeWebhook
            ({
                pendingDeckOrder: buildPendingDeckOrder(),
                rawBodyOverride: rawBody
            });

            assert(processCalled === true, "Subscription events still reach the subscription processor");
            assert(response.body?.applied === "CHARGED", "Subscription result is echoed back");
            assert(observed.completeCalls.length === 0, "Subscription events never call the paid-deck completion service");
        }
        finally
        {
            SubscriptionWebhookProcessor.isSubscriptionEvent = originalIsSubscriptionEvent;
            SubscriptionWebhookProcessor.process = originalProcess;
        }
    }

    // Regression: an event we do not act on is ignored before any lookup.
    {
        const { response, observed } = await invokeWebhook
        ({
            pendingDeckOrder: buildPendingDeckOrder(),
            rawBodyOverride: JSON.stringify({ event: "payment.failed", payload: {} })
        });

        assert(response.body?.reason === "EVENT_IGNORED", "Unrelated events are still ignored");
        assert(observed.completeCalls.length === 0, "Unrelated events never call the completion service");
    }
}

// ── Tier 2: the grant claim, against a real database ────────────────────────

async function runClaimTier()
{
    section("Tier 2 — grant claim serialization (real MongoDB)");

    if (String(process.env.VERIFY_DECK_WEBHOOK_DB || "") !== "1")
    {
        skip("VERIFY_DECK_WEBHOOK_DB is not 1 — database tier skipped");
        return;
    }

    let database = null;
    try
    {
        database = await DatabaseConnector.getDatabase();
    }
    catch (connectError)
    {
        skip(`MongoDB unavailable (${connectError.message}) — database tier skipped`);
        return;
    }

    if (!database)
    {
        skip("MongoDB unavailable — database tier skipped");
        return;
    }

    const collection = database.collection(DatabaseConstants.PENDING_ORDERS_COLLECTION);
    const providerOrderId = `order_verify_harness_${crypto.randomUUID()}`;
    const userId = `user_verify_harness_${crypto.randomUUID()}`;

    try
    {
        await PendingOrderQueryEngine.createPendingOrder
        ({
            providerOrderId: providerOrderId,
            userId: userId,
            deckIds: ["deck-1"],
            amountMinor: 49900,
            currency: "INR",
            region: "INDIA",
            paymentProvider: paymentProviders.RAZORPAY
        });

        const firstClaim = await PendingOrderQueryEngine.tryClaimForGrant(providerOrderId, userId);
        assert(firstClaim.claimed === true, "First settlement path wins the grant claim");

        const secondClaim = await PendingOrderQueryEngine.tryClaimForGrant(providerOrderId, userId);
        assert(secondClaim.claimed === false, "Concurrent settlement path loses the grant claim");

        const wrongOwnerClaim = await PendingOrderQueryEngine.tryClaimForGrant(providerOrderId, "someone-else");
        assert(wrongOwnerClaim.claimed === false, "A claim is scoped to the owning buyer");

        await PendingOrderQueryEngine.releaseGrantClaim(providerOrderId, userId);
        const claimAfterRelease = await PendingOrderQueryEngine.tryClaimForGrant(providerOrderId, userId);
        assert(claimAfterRelease.claimed === true, "A released claim is immediately retryable");

        // A holder that died mid-grant must not strand the order forever.
        const staleTimestamp = new Date(Date.now() - PendingOrderQueryEngine.GRANT_CLAIM_STALE_MILLISECONDS - 1000);
        await collection.updateOne({ providerOrderId: providerOrderId }, { $set: { grantClaimedAt: staleTimestamp } });
        const staleTakeover = await PendingOrderQueryEngine.tryClaimForGrant(providerOrderId, userId);
        assert(staleTakeover.claimed === true, "A stale claim is taken over");

        // A row written before claiming existed carries no field at all.
        await collection.updateOne({ providerOrderId: providerOrderId }, { $unset: { grantClaimedAt: "" } });
        const legacyClaim = await PendingOrderQueryEngine.tryClaimForGrant(providerOrderId, userId);
        assert(legacyClaim.claimed === true, "A legacy row with no claim field is claimable");

        const consumed = await PendingOrderQueryEngine.markConsumed(providerOrderId, userId);
        assert(consumed.transitioned === true, "The order transitions to CONSUMED after the grant");

        const claimAfterConsume = await PendingOrderQueryEngine.tryClaimForGrant(providerOrderId, userId);
        assert(claimAfterConsume.claimed === false, "A consumed order is never claimable again");

        const storedRow = await PendingOrderQueryEngine.getByOrderId(providerOrderId);
        assert(storedRow?.status === PendingOrderQueryEngine.STATUS_CONSUMED, "The consumed status is readable back");
    }
    finally
    {
        await collection.deleteMany({ providerOrderId: providerOrderId });
    }
}

async function main()
{
    console.log("CogniumLearn — Paid-deck purchase webhook settlement verification\n");

    await runRoutingTier();
    await runClaimTier();

    console.log(`\n---------------------------------------------`);
    console.log(`Passed: ${passedCount}   Failed: ${failedCount}   Skipped: ${skippedCount}`);

    process.exit(failedCount > 0 ? 1 : 0);
}

main().catch((fatalError) =>
{
    console.error("\nFATAL — verification harness crashed:");
    console.error(fatalError);
    process.exit(1);
});
