const PaymentProviderFactory = require("../../Globals/Classes/Payments/PaymentProviderFactory");
const PendingCreditOrderQueryEngine = require("../../Globals/Classes/Database/PendingCreditOrderQueryEngine");
const CreditPurchaseCompletionService = require("../../Globals/Classes/Credits/CreditPurchaseCompletionService");
const CreditDealPaymentQueryEngine = require("../../Globals/Classes/Credits/CreditDealPaymentQueryEngine");
const OrganizationCreditDealCompletionService = require("../../Globals/Classes/Organization/OrganizationCreditDealCompletionService");
const PendingOrderQueryEngine = require("../../Globals/Classes/Database/PendingOrderQueryEngine");
const PaidDeckPurchaseCompletionService = require("../PaidDeck/PaidDeckPurchaseCompletionService");
const SubscriptionWebhookProcessor = require("../../Globals/Classes/Plans/SubscriptionWebhookProcessor");
const WebhookEventQueryEngine = require("../../Globals/Classes/Database/WebhookEventQueryEngine");
const PaymentAttemptQueryEngine = require("../../Globals/Classes/Database/PaymentAttemptQueryEngine");
const SettlementAmountGuard = require("../../Globals/Classes/Payments/SettlementAmountGuard");
const PaymentReversalService = require("../../Globals/Classes/Payments/PaymentReversalService");
const RefundPolicy = require("../../Globals/Classes/Payments/RefundPolicy");
const Alerts = require("../../Globals/Classes/Alerts/Alerts");
const { paymentAttemptOutcomes } = require("../../Globals/Enumerations/PaymentAttemptOutcomes");
const { paymentProviders } = require("../../Globals/Enumerations/PaymentProviders");
const { creditDealTargetTypes } = require("../../Globals/Enumerations/CreditDealTargetTypes");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

// The largest webhook body this endpoint will hash. Razorpay's own events are a
// few kilobytes; 256 KB leaves an enormous margin for a future event shape while
// still bounding the work an unauthenticated caller can request.
const MAXIMUM_WEBHOOK_BODY_CHARACTERS = 256 * 1024;


/**
 * Asserts that what Razorpay says was paid matches what this server recorded as
 * owed, before any entitlement is granted (C4). A mismatch means either an
 * attack or a serious pricing defect, so it alerts loudly and settles nothing;
 * the payment is still acked so Razorpay stops retrying an event that would
 * fail identically until the underlying fault is fixed.
 *
 * Returns true when settlement may proceed.
 */
async function assertReportedAmountMatchesOrder(paymentEntity, expected, context)
{
    const comparison = SettlementAmountGuard.compare
    (
        {
            amountMinor: paymentEntity?.amount,
            currency: paymentEntity?.currency,
            providerOrderId: paymentEntity?.order_id
        },
        expected
    );

    if (SettlementAmountGuard.permitsSettlement(comparison))
    {
        return true;
    }

    await Alerts.raise
    ({
        severity: Alerts.SEVERITY.ERROR,
        source: "RAZORPAY_WEBHOOK",
        title: "Razorpay payment amount does not match the recorded order",
        message: `Settlement was REFUSED for ${context.flow} order ${expected.providerOrderId}. ${SettlementAmountGuard.describe(comparison)}. A mismatch here is either an attack or a pricing defect — nothing was granted, and the payment needs manual review before it can be settled.`,
        metadata:
        {
            flow: context.flow,
            providerOrderId: expected.providerOrderId,
            providerPaymentId: context.providerPaymentId || "",
            mismatches: comparison.mismatches
        }
    });

    return false;
}

/**
 * Which buyer an order belongs to, whichever flow created it. A payment attempt
 * carries no session, so the only way to attribute a decline to an account is
 * through the server-held order row — the same record every settlement path
 * already trusts.
 *
 * Returns an empty string when the order belongs to no known flow, which is
 * itself informative: an attempt against an unknown order is the failed-payment
 * counterpart of the captured-payment-with-no-local-order case below.
 */
async function resolveBuyerIdForOrder(providerOrderId)
{
    const creditOrder = await PendingCreditOrderQueryEngine.getByOrderId(providerOrderId);
    if (creditOrder)
    {
        return creditOrder.userId || "";
    }

    const deckOrder = await PendingOrderQueryEngine.getByOrderId(providerOrderId);
    if (deckOrder)
    {
        return deckOrder.userId || "";
    }

    // An admin credit deal. Attributed to the administrator who created it,
    // which is the only person in that flow — an organization cannot itself
    // produce a decline burst, but the account driving its checkout can, and
    // without this lookup a failed deal payment recorded an empty buyer and
    // could not feed the card-testing detector at all.
    const dealPayment = await CreditDealPaymentQueryEngine.findByOrderId(providerOrderId);
    if (dealPayment)
    {
        return dealPayment.getCreatedByUserId() || "";
    }

    return "";
}

/**
 * Records one payment attempt and, for a failure, checks whether this buyer's
 * recent declines amount to a card-testing burst.
 *
 * Deliberately best-effort: a diagnostic write must never change whether the
 * webhook acks, so every failure here is swallowed. The provider's error fields
 * are stored verbatim — Razorpay's own taxonomy is what a support case will be
 * argued in months later, and paraphrasing it loses that.
 */
async function recordPaymentAttempt(paymentEntity, outcome)
{
    try
    {
        const providerOrderId = paymentEntity?.order_id || "";
        const userId = providerOrderId ? await resolveBuyerIdForOrder(providerOrderId) : "";

        await PaymentAttemptQueryEngine.record
        ({
            userId: userId,
            providerOrderId: providerOrderId,
            providerPaymentId: paymentEntity?.id || "",
            outcome: outcome,
            amountMinor: paymentEntity?.amount,
            currency: paymentEntity?.currency,
            method: paymentEntity?.method,
            errorCode: paymentEntity?.error_code,
            errorDescription: paymentEntity?.error_description,
            errorReason: paymentEntity?.error_reason,
            errorSource: paymentEntity?.error_source,
            errorStep: paymentEntity?.error_step
        });

        if (outcome !== paymentAttemptOutcomes.FAILED || !userId)
        {
            return;
        }

        const recentFailureCount = await PaymentAttemptQueryEngine.countRecentFailures(userId);
        if (!PaymentAttemptQueryEngine.isFailureBurst(recentFailureCount))
        {
            return;
        }

        await Alerts.raise
        ({
            severity: Alerts.SEVERITY.WARNING,
            source: "PAYMENT_ATTEMPT",
            title: "A burst of failed payments on one account",
            message: `Account ${userId} has produced ${recentFailureCount} failed payment attempts within ${PaymentAttemptQueryEngine.FAILURE_BURST_WINDOW_MILLISECONDS / 60000} minutes. That is the shape of card testing (F1); it is also what a buyer with a genuinely failing card looks like, so check the decline reasons before acting.`,
            metadata: { accountId: userId, recentFailureCount: recentFailureCount, lastErrorCode: paymentEntity?.error_code || "" }
        });
    }
    catch (attemptError)
    {
        console.error(`[HandleRazorpayWebhook] Failed to record a payment attempt: ${attemptError?.message || attemptError}`);
    }
}

/**
 * Razorpay webhook handler — UNAUTHED (signed by Razorpay via HMAC of
 * the raw request body). Registered with PLAIN_TEXT_BODY so we can run
 * the HMAC over the exact bytes Razorpay signed instead of a re-
 * serialised JSON.
 *
 * Completes three payment flows: credit purchases, admin credit-deal
 * payments and paid-deck purchases. Each is ALSO completed by the
 * buyer's browser on its own verify endpoint — this webhook is the
 * safety net for buyers who pay and then close the tab before Verify
 * runs. Credits and paid decks share their completion service with the
 * browser leg (CreditPurchaseCompletionService /
 * PaidDeckPurchaseCompletionService) so the two paths cannot diverge:
 * whichever arrives first settles and the other becomes a no-op.
 *
 * Organizations are deliberately absent: creating one is free, so there
 * is no organization order for a provider to settle.
 *
 * Idempotent at two levels. In FRONT, WebhookEventQueryEngine.claim
 * records the delivery and short-circuits a redelivery already seen,
 * keyed on the x-razorpay-event-id header. That gate fails OPEN (no
 * database, or no event id from the provider), so BEHIND it the
 * per-flow guards remain the real guarantee: the credit branch's
 * CONSUMED status / duplicate referenceKey, and the paid-deck branch's
 * CONSUMED status and — against a concurrent browser verify — the
 * pending order's atomic grant claim.
 *
 * Acks 200 even on benign errors (signature mismatch, unknown order)
 * — returning a 4xx would cause Razorpay to keep retrying. Because a
 * 200 also makes those failures look successful in Razorpay's own
 * dashboard, the two that must never pass silently raise an admin
 * alert instead of only a console line: a signature failure (a forgery
 * attempt or a wrong webhook secret) and a captured payment with no
 * matching local order (a cloned checkout, or a lost order row).
 *
 * Every settlement branch first asserts that the amount, currency and
 * order id the provider reported match the server's own record
 * (assertReportedAmountMatchesOrder, C4). A mismatch grants nothing and
 * alerts — it means either an attack or a pricing defect, and both need
 * a human before any entitlement is issued.
 */
async function handleRazorpayWebhook(request, response)
{
    const rawBody = await request.getBody();
    const signature = request.headers["x-razorpay-signature"];

    if (typeof rawBody !== "string" || rawBody.length === 0)
    {
        response.statusCode = httpStatus.OK;
        response.sendJson({ acknowledged: true, reason: ErrorCodes.EMPTY_BODY });
        return;
    }

    // Size check BEFORE the HMAC (D4). An unauthenticated caller should not be
    // able to choose how much hashing this endpoint does on their behalf, and
    // the ordering is the whole control: verifying first would mean the work
    // has already happened by the time the body is judged too large.
    //
    // The limit is generous against a real payment event — the largest Razorpay
    // sends is a few kilobytes — so nothing legitimate approaches it. An
    // oversized body is refused rather than acked as handled, because unlike a
    // bad signature there is no chance it is a genuine delivery worth
    // suppressing a retry for.
    if (rawBody.length > MAXIMUM_WEBHOOK_BODY_CHARACTERS)
    {
        console.warn(`[HandleRazorpayWebhook] Refused a ${rawBody.length}-character body before verification (limit ${MAXIMUM_WEBHOOK_BODY_CHARACTERS}).`);
        response.statusCode = httpStatus.PAYLOAD_TOO_LARGE;
        response.sendJson({ error: ErrorCodes.PAYLOAD_TOO_LARGE });
        return;
    }

    const provider = PaymentProviderFactory.getProvider(paymentProviders.RAZORPAY);
    const verification = provider.verifyWebhookSignature(rawBody, signature);
    if (!verification.verified)
    {
        // A signature failure is either a forgery attempt (D1) or a
        // misconfigured secret — and because we ack 200 to stop the provider
        // retrying, the provider's own dashboard shows this as a SUCCESSFUL
        // delivery. Without an alert here the failure is invisible on both
        // sides. Deduped by (source, title) so a flood produces one growing row.
        await Alerts.raise
        ({
            severity: Alerts.SEVERITY.ERROR,
            source: "RAZORPAY_WEBHOOK",
            title: "Razorpay webhook signature verification failed",
            message: `A webhook delivery was rejected: ${verification.reason}. This is either a forged request or a webhook-secret misconfiguration; if payments are not settling, check RAZORPAY_WEBHOOK_SECRET first.`,
            metadata: { reason: verification.reason }
        });
        response.statusCode = httpStatus.OK;
        response.sendJson({ acknowledged: true, reason: ErrorCodes.INVALID_SIGNATURE });
        return;
    }

    let payload = null;
    try
    {
        payload = JSON.parse(rawBody);
    }
    catch (parseError)
    {
        console.warn(`[HandleRazorpayWebhook] Failed to parse JSON body: ${parseError.message}`);
        response.statusCode = httpStatus.OK;
        response.sendJson({ acknowledged: true, reason: ErrorCodes.INVALID_BODY });
        return;
    }

    const eventName = typeof payload?.event === "string" ? payload.event : "";

    // Record the delivery and short-circuit a redelivery we have already
    // handled. This is a cheap gate in FRONT of the per-flow idempotency
    // guards, never a replacement for them — it fails open when the database
    // is unavailable or the provider omitted an event id, in which case the
    // downstream guards still make a duplicate a no-op.
    const eventId = request.headers["x-razorpay-event-id"];
    const deliveryClaim = await WebhookEventQueryEngine.claim
    ({
        provider: paymentProviders.RAZORPAY,
        eventId: eventId,
        eventType: eventName,
        rawBody: rawBody,
        usedPreviousSecret: verification.usedPreviousSecret === true
    });

    if (!deliveryClaim.firstDelivery)
    {
        response.statusCode = httpStatus.OK;
        response.sendJson({ acknowledged: true, reason: ErrorCodes.WEBHOOK_EVENT_ALREADY_PROCESSED, event: eventName });
        return;
    }

    // Subscription lifecycle events (auto-debit recurring plans). Delegated to
    // the processor, which drives credit grants + entitlement via
    // PlanSubscriptionService. Ack 200 regardless so Razorpay stops retrying.
    if (SubscriptionWebhookProcessor.isSubscriptionEvent(eventName))
    {
        try
        {
            const subscriptionResult = await SubscriptionWebhookProcessor.process(eventName, payload);
            response.statusCode = httpStatus.OK;
            response.sendJson({ acknowledged: true, event: eventName, ...subscriptionResult });
        }
        catch (subscriptionError)
        {
            console.error(`[HandleRazorpayWebhook] Subscription event ${eventName} failed: ${subscriptionError?.message || subscriptionError}`);
            response.statusCode = httpStatus.OK;
            response.sendJson({ acknowledged: true, event: eventName, reason: ErrorCodes.EXCEPTION });
        }
        return;
    }

    // A declined or abandoned attempt. Nothing is provisioned — the point is
    // purely to STOP DISCARDING the failure: without this branch a decline
    // existed only as a console line in the buyer's own browser, so support had
    // nothing to look at and card testing had no detectable signature.
    if (eventName === "payment.failed")
    {
        await recordPaymentAttempt(payload?.payload?.payment?.entity, paymentAttemptOutcomes.FAILED);
        await WebhookEventQueryEngine.markProcessed(paymentProviders.RAZORPAY, eventId, "PAYMENT_ATTEMPT_RECORDED");
        response.statusCode = httpStatus.OK;
        response.sendJson({ acknowledged: true, event: eventName, attemptRecorded: true });
        return;
    }

    // A refund or chargeback. This application never issues refunds, so
    // reaching here always means money moved back from outside it — a
    // chargeback, a bank reversal, or a manual dashboard refund. The
    // entitlement it paid for is withdrawn and a human is told. See
    // RefundPolicy for why a no-refund policy still needs this branch.
    if (RefundPolicy.isRefundEvent(eventName))
    {
        const refundEntity = payload?.payload?.refund?.entity;
        const refundedPaymentEntity = payload?.payload?.payment?.entity;

        if (!RefundPolicy.isSettledRefundEvent(eventName))
        {
            // refund.created / refund.failed: money has not (or will not) move.
            // Recorded and acked without touching any entitlement.
            await WebhookEventQueryEngine.markProcessed(paymentProviders.RAZORPAY, eventId, "REFUND_EVENT_NOTED");
            response.statusCode = httpStatus.OK;
            response.sendJson({ acknowledged: true, event: eventName, reversed: false });
            return;
        }

        try
        {
            const reversal = await PaymentReversalService.reverse
            ({
                refundId: refundEntity?.id || "",
                providerPaymentId: refundEntity?.payment_id || refundedPaymentEntity?.id || "",
                providerOrderId: refundedPaymentEntity?.order_id || refundEntity?.notes?.order_id || "",
                amountMinor: refundEntity?.amount,
                currency: refundEntity?.currency,
                eventName: eventName
            });

            await WebhookEventQueryEngine.markProcessed(paymentProviders.RAZORPAY, eventId, "PAYMENT_REVERSED");
            response.statusCode = httpStatus.OK;
            response.sendJson
            ({
                acknowledged: true,
                event: eventName,
                reversed: reversal.reversed,
                flow: reversal.flow,
                creditsClawedBack: reversal.creditsClawedBack,
                licensesRevoked: reversal.licensesRevoked
            });
        }
        catch (reversalError)
        {
            console.error(`[HandleRazorpayWebhook] Reversal failed for ${eventName}: ${reversalError?.message || reversalError}`);
            response.statusCode = httpStatus.OK;
            response.sendJson({ acknowledged: true, event: eventName, reason: ErrorCodes.EXCEPTION });
        }
        return;
    }

    // We care about two events that both indicate "payment is good":
    //   payment.captured — instant captures (most common)
    //   order.paid       — fired alongside payment.captured for orders
    if (eventName !== "payment.captured" && eventName !== "order.paid")
    {
        response.statusCode = httpStatus.OK;
        response.sendJson({ acknowledged: true, reason: "EVENT_IGNORED", event: eventName });
        return;
    }

    const paymentEntity = payload?.payload?.payment?.entity;
    const orderEntity = payload?.payload?.order?.entity;
    const providerOrderId = paymentEntity?.order_id || orderEntity?.id || "";
    const providerPaymentId = paymentEntity?.id || "";

    if (!providerOrderId)
    {
        response.statusCode = httpStatus.OK;
        response.sendJson({ acknowledged: true, reason: ErrorCodes.MISSING_ORDER_ID });
        return;
    }

    // Record the successful attempt alongside the failed ones. Storing only
    // failures would make the attempt log unreadable — a decline rate needs a
    // denominator, and a support case needs to see the successful retry that
    // followed the three declines.
    if (paymentEntity)
    {
        await recordPaymentAttempt(paymentEntity, paymentAttemptOutcomes.CAPTURED);
    }

    // Credit purchase. The pending row's own userId drives the grant (no
    // session exists here); the verified HMAC signature is the auth.
    const pendingCreditOrder = await PendingCreditOrderQueryEngine.getByOrderId(providerOrderId);

    if (pendingCreditOrder)
    {
        if (pendingCreditOrder.status === PendingCreditOrderQueryEngine.STATUS_CONSUMED)
        {
            response.statusCode = httpStatus.OK;
            response.sendJson({ acknowledged: true, reason: ErrorCodes.CREDIT_ORDER_ALREADY_PROCESSED });
            return;
        }

        const creditAmountMatches = await assertReportedAmountMatchesOrder
        (
            paymentEntity,
            {
                amountMinor: pendingCreditOrder.amountMinor,
                currency: pendingCreditOrder.currency,
                providerOrderId: providerOrderId
            },
            { flow: "CREDIT_PURCHASE", providerPaymentId: providerPaymentId }
        );

        if (!creditAmountMatches)
        {
            await WebhookEventQueryEngine.markProcessed(paymentProviders.RAZORPAY, eventId, ErrorCodes.AMOUNT_MISMATCH);
            response.statusCode = httpStatus.OK;
            response.sendJson({ acknowledged: true, reason: ErrorCodes.AMOUNT_MISMATCH });
            return;
        }

        const completion = await CreditPurchaseCompletionService.complete
        (
            pendingCreditOrder,
            { providerPaymentId: providerPaymentId, source: CreditPurchaseCompletionService.SOURCE_WEBHOOK }
        );

        await WebhookEventQueryEngine.markProcessed(paymentProviders.RAZORPAY, eventId, "CREDIT_ORDER_SETTLED");

        response.statusCode = httpStatus.OK;
        response.sendJson
        ({
            acknowledged: true,
            creditOrderCompleted: completion.granted,
            alreadyProcessed: completion.alreadyProcessed
        });
        return;
    }

    // Not a credit purchase — try an admin credit-deal payment (on-spot
    // Razorpay for a periodic assignment / fixed grant). This is the safety net
    // for an admin who closes the tab before the in-page verify runs.
    // Idempotent on the atomic markCaptured CAS.
    const dealPayment = await CreditDealPaymentQueryEngine.findByOrderId(providerOrderId);
    if (dealPayment)
    {
        const dealAmountMatches = await assertReportedAmountMatchesOrder
        (
            paymentEntity,
            {
                amountMinor: dealPayment.getAmountMinor ? dealPayment.getAmountMinor() : undefined,
                currency: dealPayment.getCurrency ? dealPayment.getCurrency() : undefined,
                providerOrderId: providerOrderId
            },
            { flow: "CREDIT_DEAL", providerPaymentId: providerPaymentId }
        );

        if (!dealAmountMatches)
        {
            await WebhookEventQueryEngine.markProcessed(paymentProviders.RAZORPAY, eventId, ErrorCodes.AMOUNT_MISMATCH);
            response.statusCode = httpStatus.OK;
            response.sendJson({ acknowledged: true, reason: ErrorCodes.AMOUNT_MISMATCH });
            return;
        }

        // A deal that buys an organization's credit pool settles through its own
        // service, which credits the pool and moves the contract term with it.
        // Capturing it here alone would mark the deal paid and leave the credits
        // nowhere.
        if (dealPayment.getTargetType() === creditDealTargetTypes.ORGANIZATION_CREDIT_POOL)
        {
            const poolCompletion = await OrganizationCreditDealCompletionService.complete
            (
                providerOrderId,
                providerPaymentId,
                OrganizationCreditDealCompletionService.SOURCE_WEBHOOK
            );

            await WebhookEventQueryEngine.markProcessed(paymentProviders.RAZORPAY, eventId, "ORGANIZATION_POOL_CREDITED");
            response.statusCode = httpStatus.OK;
            response.sendJson
            ({
                acknowledged: true,
                organizationCreditsAdded: poolCompletion.creditsAdded,
                alreadyProcessed: poolCompletion.alreadyProcessed
            });
            return;
        }

        const dealCapture = await CreditDealPaymentQueryEngine.markCaptured(providerOrderId, providerPaymentId);
        await WebhookEventQueryEngine.markProcessed(paymentProviders.RAZORPAY, eventId, "DEAL_CAPTURED");
        response.statusCode = httpStatus.OK;
        response.sendJson({ acknowledged: true, dealCaptured: dealCapture.transitioned });
        return;
    }

    // Not a credit deal either — try a paid-deck purchase. This is the safety
    // net for a buyer who pays and then closes the tab before
    // /PaidDecks/Purchase/Verify runs; without it they were charged with no
    // license issued and no server-side recovery. The pending row is the
    // trusted binding (buyer + exact decks + server price), so no session is
    // needed — the verified HMAC signature is the auth.
    const pendingDeckOrder = await PendingOrderQueryEngine.getByOrderId(providerOrderId);
    if (pendingDeckOrder)
    {
        if (pendingDeckOrder.status === PendingOrderQueryEngine.STATUS_CONSUMED)
        {
            response.statusCode = httpStatus.OK;
            response.sendJson({ acknowledged: true, reason: ErrorCodes.DECK_ORDER_ALREADY_PROCESSED });
            return;
        }

        const deckAmountMatches = await assertReportedAmountMatchesOrder
        (
            paymentEntity,
            {
                amountMinor: pendingDeckOrder.amountMinor,
                currency: pendingDeckOrder.currency,
                providerOrderId: providerOrderId
            },
            { flow: "PAID_DECK_PURCHASE", providerPaymentId: providerPaymentId }
        );

        if (!deckAmountMatches)
        {
            await WebhookEventQueryEngine.markProcessed(paymentProviders.RAZORPAY, eventId, ErrorCodes.AMOUNT_MISMATCH);
            response.statusCode = httpStatus.OK;
            response.sendJson({ acknowledged: true, reason: ErrorCodes.AMOUNT_MISMATCH });
            return;
        }

        try
        {
            const deckCompletion = await PaidDeckPurchaseCompletionService.complete
            (
                pendingDeckOrder,
                {
                    providerPaymentId: providerPaymentId,
                    paymentProvider: paymentProviders.RAZORPAY,
                    source: PaidDeckPurchaseCompletionService.SOURCE_WEBHOOK
                }
            );

            await WebhookEventQueryEngine.markProcessed(paymentProviders.RAZORPAY, eventId, "DECK_ORDER_SETTLED");

            response.statusCode = httpStatus.OK;
            response.sendJson
            ({
                acknowledged: true,
                deckOrderCompleted: deckCompletion.granted,
                licensesIssued: deckCompletion.licenses.length,
                alreadyProcessed: deckCompletion.alreadyProcessed
            });
        }
        catch (deckCompletionError)
        {
            // The claim has already been released by the service, so a later
            // verify (or Razorpay redelivery) can retry. Ack anyway — a 4xx/5xx
            // would only make Razorpay replay an event we know will fail the
            // same way until the underlying fault is fixed.
            console.error(`[HandleRazorpayWebhook] Paid-deck settlement failed for order ${providerOrderId}: ${deckCompletionError?.message || deckCompletionError}`);
            response.statusCode = httpStatus.OK;
            response.sendJson({ acknowledged: true, reason: ErrorCodes.EXCEPTION });
        }
        return;
    }

    // The order belongs to no known payment flow. A captured payment with no
    // local order is never routine: it is the signature of a cloned checkout
    // using our public key id (B8), of an order whose local row was lost before
    // it could be written, or of an integration drift between environments.
    // Someone was charged and this server cannot say what for, so this alerts
    // rather than acking silently.
    await Alerts.raise
    ({
        severity: Alerts.SEVERITY.ERROR,
        source: "RAZORPAY_WEBHOOK",
        title: "Captured Razorpay payment with no matching local order",
        message: `Razorpay reported a captured payment for order ${providerOrderId}, but no credit, deal or paid-deck order exists for it. A customer may have been charged with nothing provisioned. Check the Razorpay dashboard for this order id.`,
        metadata: { providerOrderId: providerOrderId, providerPaymentId: providerPaymentId, event: eventName }
    });

    await WebhookEventQueryEngine.markProcessed(paymentProviders.RAZORPAY, eventId, ErrorCodes.PAYMENT_ROW_NOT_FOUND);

    response.statusCode = httpStatus.OK;
    response.sendJson({ acknowledged: true, reason: ErrorCodes.PAYMENT_ROW_NOT_FOUND });
}

module.exports = { handleRazorpayWebhook };
