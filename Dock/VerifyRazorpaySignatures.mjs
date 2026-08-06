/**
 * Regression harness for the Razorpay signature-verification surface — the
 * three functions that stand between a stranger's HTTP request and a granted
 * entitlement.
 *
 * Run from the Dock directory:
 *     node VerifyRazorpaySignatures.mjs
 *
 * Everything here is pure and in-process: no network, no database, no server.
 * The provider's HMAC functions read their secrets from the environment, so
 * this harness sets its OWN throwaway secrets before loading the module and
 * never touches real credentials.
 *
 * What is asserted, and why each case exists:
 *
 *   1. A genuine signature verifies. The baseline — without it, a verifier
 *      that rejects everything would pass every negative test below.
 *   2. A tampered signature is rejected. The handbook calls this "the
 *      regression test that matters most in the codebase".
 *   3. Non-string signature types (null, [], {}, true, numbers) are rejected
 *      CLEANLY, without throwing. `{}` used to reach Buffer.from and raise a
 *      TypeError, turning a forgery attempt into a 500 instead of a 400.
 *   4. A signature computed over the wrong message — the right shape, valid
 *      HMAC, wrong contents — is rejected. This is the C2 attack: a valid
 *      triple from a different order.
 *   5. Subscription signatures use the REVERSED field order
 *      (paymentId|subscriptionId). A verifier that used the one-time order
 *      would reject every genuine subscription authorisation.
 *   6. Webhook signatures are computed over raw bytes, and a re-serialised
 *      body fails — the D2 failure mode that drives teams to disable
 *      verification under incident pressure.
 *   7. The webhook rotation window accepts the previous secret while it is
 *      configured, and stops accepting it once it is cleared.
 *   8. Boot-time key/environment mode validation (E6) refuses the two silent
 *      money-losing misconfigurations.
 */

import { createRequire } from "module";
import crypto from "crypto";

const require = createRequire(import.meta.url);

// Throwaway credentials, set BEFORE the provider module is loaded because it
// reads the key pair in its constructor. Deliberately not sourced from any env
// file so this harness can never exercise real keys.
const TEST_KEY_SECRET = "harness_key_secret_do_not_use";
const TEST_WEBHOOK_SECRET = "harness_webhook_secret_do_not_use";
const TEST_PREVIOUS_WEBHOOK_SECRET = "harness_previous_webhook_secret";

process.env.RAZORPAY_KEY_ID = "rzp_test_harness";
process.env.RAZORPAY_KEY_SECRET = TEST_KEY_SECRET;
process.env.RAZORPAY_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
delete process.env.RAZORPAY_WEBHOOK_SECRET_PREVIOUS;

const RazorpayPaymentProvider = require("./Globals/Classes/Payments/RazorpayPaymentProvider");
const PaymentProvider = require("./Globals/Classes/Payments/PaymentProvider");
const PaymentEnvironmentValidator = require("./Globals/Classes/Payments/PaymentEnvironmentValidator");
const PaymentProviderFactory = require("./Globals/Classes/Payments/PaymentProviderFactory");
const { paymentProviders } = require("./Globals/Enumerations/PaymentProviders");

const provider = new RazorpayPaymentProvider();

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

async function checkDoesNotThrow(description, action)
{
    try
    {
        const result = await action();
        check(description, result === true);
    }
    catch (thrownError)
    {
        failedCount = failedCount + 1;
        console.error(`  FAIL  ${description} — threw ${thrownError?.name}: ${thrownError?.message}`);
    }
}

function signOrder(orderId, paymentId, secret = TEST_KEY_SECRET)
{
    return crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
}

function signSubscription(paymentId, subscriptionId, secret = TEST_KEY_SECRET)
{
    return crypto.createHmac("sha256", secret).update(`${paymentId}|${subscriptionId}`).digest("hex");
}

function signBody(rawBody, secret)
{
    return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

async function run()
{
    const orderId = "order_HarnessOrder001";
    const paymentId = "pay_HarnessPayment001";
    const subscriptionId = "sub_HarnessSubscription001";

    console.log("\n1. Payment signature — genuine value verifies");
    {
        const result = await provider.verifyPayment
        ({
            providerOrderId: orderId,
            providerPaymentId: paymentId,
            signature: signOrder(orderId, paymentId)
        });
        check("a correctly signed triple verifies", result.verified === true);
    }

    console.log("\n2. Payment signature — tampering is rejected");
    {
        const genuine = signOrder(orderId, paymentId);
        // Flip the last hex character, preserving length so the length check
        // cannot be what rejects it — the HMAC comparison must do the work.
        const flippedFinalCharacter = genuine.slice(-1) === "a" ? "b" : "a";
        const tampered = genuine.slice(0, -1) + flippedFinalCharacter;

        const tamperedResult = await provider.verifyPayment
        ({ providerOrderId: orderId, providerPaymentId: paymentId, signature: tampered });
        check("a single flipped byte is rejected", tamperedResult.verified === false);

        const truncatedResult = await provider.verifyPayment
        ({ providerOrderId: orderId, providerPaymentId: paymentId, signature: genuine.slice(0, 32) });
        check("a truncated signature is rejected", truncatedResult.verified === false);

        const foreignSecretResult = await provider.verifyPayment
        ({ providerOrderId: orderId, providerPaymentId: paymentId, signature: signOrder(orderId, paymentId, "a-different-secret") });
        check("a signature made with another secret is rejected", foreignSecretResult.verified === false);
    }

    console.log("\n3. Payment signature — hostile types are rejected without throwing");
    {
        const hostileValues = [null, undefined, [], {}, true, 12345, { toString: () => "x" }];
        for (const hostileValue of hostileValues)
        {
            const label = JSON.stringify(hostileValue) ?? String(hostileValue);
            await checkDoesNotThrow
            (
                `signature ${label} is rejected cleanly`,
                async () =>
                {
                    const result = await provider.verifyPayment
                    ({ providerOrderId: orderId, providerPaymentId: paymentId, signature: hostileValue });
                    return result.verified === false;
                }
            );
        }

        await checkDoesNotThrow("a non-string order id is rejected cleanly", async () =>
        {
            const result = await provider.verifyPayment
            ({ providerOrderId: { $ne: null }, providerPaymentId: paymentId, signature: signOrder(orderId, paymentId) });
            return result.verified === false;
        });
    }

    console.log("\n4. Payment signature — a valid triple from another order is rejected (C2)");
    {
        const otherOrderId = "order_HarnessOrder002";
        const otherOrderSignature = signOrder(otherOrderId, paymentId);
        const result = await provider.verifyPayment
        ({ providerOrderId: orderId, providerPaymentId: paymentId, signature: otherOrderSignature });
        check("a signature valid for a DIFFERENT order does not verify against this one", result.verified === false);
    }

    console.log("\n5. Subscription signature — reversed field order");
    {
        const genuine = await provider.verifySubscriptionPayment
        ({ providerSubscriptionId: subscriptionId, providerPaymentId: paymentId, signature: signSubscription(paymentId, subscriptionId) });
        check("paymentId|subscriptionId verifies", genuine.verified === true);

        const wrongOrder = await provider.verifySubscriptionPayment
        ({ providerSubscriptionId: subscriptionId, providerPaymentId: paymentId, signature: signOrder(subscriptionId, paymentId) });
        check("the one-time field order does NOT verify as a subscription", wrongOrder.verified === false);

        await checkDoesNotThrow("a hostile subscription signature type is rejected cleanly", async () =>
        {
            const result = await provider.verifySubscriptionPayment
            ({ providerSubscriptionId: subscriptionId, providerPaymentId: paymentId, signature: {} });
            return result.verified === false;
        });
    }

    console.log("\n6. Webhook signature — raw bytes, not a re-serialisation (D2)");
    {
        // Key order and spacing here are deliberately NOT what JSON.stringify
        // would produce for the parsed object, which is exactly the real-world
        // difference between a provider's bytes and our own.
        const rawBody = '{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_x","amount":49900}}}}';
        const genuineResult = provider.verifyWebhookSignature(rawBody, signBody(rawBody, TEST_WEBHOOK_SECRET));
        check("a signature over the raw body verifies", genuineResult.verified === true);

        const reSerialised = JSON.stringify(JSON.parse(rawBody).payload);
        const reSerialisedResult = provider.verifyWebhookSignature(reSerialised, signBody(rawBody, TEST_WEBHOOK_SECRET));
        check("a re-serialised body does NOT verify against the original signature", reSerialisedResult.verified === false);

        const foreignResult = provider.verifyWebhookSignature(rawBody, signBody(rawBody, "some-other-webhook-secret"));
        check("a body signed with another secret is rejected", foreignResult.verified === false);

        for (const hostileValue of [null, undefined, [], {}, true])
        {
            const label = JSON.stringify(hostileValue) ?? String(hostileValue);
            await checkDoesNotThrow(`webhook signature ${label} is rejected cleanly`, async () =>
            {
                return provider.verifyWebhookSignature(rawBody, hostileValue).verified === false;
            });
        }
    }

    console.log("\n7. Webhook signature — secret rotation window");
    {
        const rawBody = '{"event":"payment.captured"}';
        const previousSecretSignature = signBody(rawBody, TEST_PREVIOUS_WEBHOOK_SECRET);

        const beforeRotation = provider.verifyWebhookSignature(rawBody, previousSecretSignature);
        check("with no previous secret configured, an old-secret delivery is rejected", beforeRotation.verified === false);

        process.env.RAZORPAY_WEBHOOK_SECRET_PREVIOUS = TEST_PREVIOUS_WEBHOOK_SECRET;
        const duringRotation = provider.verifyWebhookSignature(rawBody, previousSecretSignature);
        check("during the window, an old-secret delivery verifies", duringRotation.verified === true);
        check("and is flagged as having used the previous secret", duringRotation.usedPreviousSecret === true);

        const currentDuringRotation = provider.verifyWebhookSignature(rawBody, signBody(rawBody, TEST_WEBHOOK_SECRET));
        check("the current secret still verifies during the window", currentDuringRotation.verified === true);
        check("and is not flagged as previous-secret", currentDuringRotation.usedPreviousSecret === false);

        delete process.env.RAZORPAY_WEBHOOK_SECRET_PREVIOUS;
        const afterRotation = provider.verifyWebhookSignature(rawBody, previousSecretSignature);
        check("once the window is closed, the old secret is rejected again", afterRotation.verified === false);
    }

    console.log("\n8. Chargeable-amount band (A3)");
    {
        check("a normal amount is chargeable", PaymentProvider.isChargeableAmount(49900) === true);
        check("zero is refused", PaymentProvider.isChargeableAmount(0) === false);
        check("a negative amount is refused", PaymentProvider.isChargeableAmount(-500) === false);
        check("a fractional amount is refused", PaymentProvider.isChargeableAmount(499.5) === false);
        check("below the provider minimum is refused", PaymentProvider.isChargeableAmount(99) === false);
        check("an absurd amount is refused", PaymentProvider.isChargeableAmount(1e12) === false);
        check("a non-number is refused", PaymentProvider.isChargeableAmount("49900") === false);
        check("NaN is refused", PaymentProvider.isChargeableAmount(Number.NaN) === false);
    }

    console.log("\n9. Key mode versus environment (E6), and retired-provider handling");
    {
        // A deployed node is identified by the tmpfs secrets directory it
        // renders into; a developer machine never sets it. The strict
        // live-key requirement applies only on the former, so that the
        // documented local `npm run production` workflow — which deliberately
        // runs test keys under the "production" environment name — still boots.
        const DEPLOYED = { COGNIUMLEARN_SECRETS_DIRECTORY: "/run/cogniumlearn" };

        const testKeyOnProductionNode = PaymentEnvironmentValidator.validate("production",
            { ...DEPLOYED, RAZORPAY_KEY_ID: "rzp_test_abc" });
        check("a TEST key on a deployed production node is fatal", testKeyOnProductionNode.ok === false);

        const testKeyLocalProductionRun = PaymentEnvironmentValidator.validate("production",
            { RAZORPAY_KEY_ID: "rzp_test_abc" });
        check("a TEST key in a LOCAL production-mode run is allowed", testKeyLocalProductionRun.ok === true);
        check("...and says so, rather than passing silently",
            testKeyLocalProductionRun.problems.some(problem => problem.message.includes("LOCAL production-mode run")));

        const liveKeyInDevelopment = PaymentEnvironmentValidator.validate("development", { RAZORPAY_KEY_ID: "rzp_live_abc" });
        check("a LIVE key outside production is fatal", liveKeyInDevelopment.ok === false);

        const liveKeyOnLaptop = PaymentEnvironmentValidator.validate("production", { RAZORPAY_KEY_ID: "rzp_live_abc" });
        check("a LIVE key in a local production-mode run is STILL fatal", liveKeyOnLaptop.ok === false);

        const liveKeyOnProductionNode = PaymentEnvironmentValidator.validate("production",
            { ...DEPLOYED, RAZORPAY_KEY_ID: "rzp_live_abc" });
        check("a LIVE key on a deployed production node is accepted", liveKeyOnProductionNode.ok === true);

        const testKeyLocally = PaymentEnvironmentValidator.validate("local", { RAZORPAY_KEY_ID: "rzp_test_abc" });
        check("a TEST key locally is accepted", testKeyLocally.ok === true);

        const unconfigured = PaymentEnvironmentValidator.validate("production", { ...DEPLOYED });
        check("an environment with no Razorpay key is not blocked", unconfigured.ok === true);

        // Razorpay is the only provider, so a retired provider enum must fail
        // loudly and specifically rather than silently resolving to something.
        const retired = PaymentProviderFactory.isRetiredProvider(paymentProviders.ZOHO);
        check("the ZOHO enum is recognised as a retired provider", retired === true);

        let retiredThrew = false;
        let retiredMessage = "";
        try { PaymentProviderFactory.getProvider(paymentProviders.ZOHO); }
        catch (retiredError) { retiredThrew = true; retiredMessage = retiredError.message; }
        check("asking for a retired provider throws", retiredThrew === true);
        check("...with a message naming the provider, not \"Unknown payment provider\"",
            retiredMessage.includes("Zoho") && !retiredMessage.includes("Unknown payment provider"));

        check("Razorpay still resolves normally",
            PaymentProviderFactory.getProvider(paymentProviders.RAZORPAY) !== null);
    }

    console.log(`\n${passedCount} passed, ${failedCount} failed.`);
    if (failedCount > 0)
    {
        console.error("\nSignature verification regressions detected. Do not ship.");
        process.exit(1);
    }
    console.log("All Razorpay signature and payment-configuration checks passed.");
}

run().catch((harnessError) =>
{
    console.error("Harness crashed:", harnessError);
    process.exit(1);
});
