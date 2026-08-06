const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const PendingCreditOrderQueryEngine = require("../Database/PendingCreditOrderQueryEngine");
const PendingOrderQueryEngine = require("../Database/PendingOrderQueryEngine");
const CreditDealPaymentQueryEngine = require("../Credits/CreditDealPaymentQueryEngine");
const CreditPurchaseCompletionService = require("../Credits/CreditPurchaseCompletionService");
const OrganizationCreditDealCompletionService = require("../Organization/OrganizationCreditDealCompletionService");
const PaidDeckPurchaseCompletionService = require("../../../Endpoints/PaidDeck/PaidDeckPurchaseCompletionService");
const PaymentProviderFactory = require("./PaymentProviderFactory");
const SettlementAmountGuard = require("./SettlementAmountGuard");
const Alerts = require("../Alerts/Alerts");
const { paymentProviders } = require("../../Enumerations/PaymentProviders");

/**
 * PendingPaymentReconciler
 *
 * The last line of defence for a payment that was taken but never settled.
 *
 * Every other path in this integration is a PUSH: the browser returns a signed
 * triple to a verify endpoint, or the provider posts a webhook. Both are
 * reliable and neither is guaranteed. A buyer can close the tab mid-verify; a
 * webhook can be lost to an outage, a misconfigured secret, or a deploy that
 * happened to be restarting the process. When every push fails, the money has
 * moved and this server does not know.
 *
 * Before this class existed that state was not merely undetected, it was
 * self-erasing: the order sat PENDING until a TTL index deleted the row, taking
 * the only evidence of the failure with it. The customer was charged, received
 * nothing, and there was no trace to reconcile against — the exact scenario the
 * incident runbook exists to handle, with the runbook's own starting evidence
 * already gone.
 *
 * So this sweep PULLS. It asks the provider what actually happened to each
 * stale pending order and settles the ones that were really captured.
 *
 * ── Design rules, and why each one matters ────────────────────────────────
 *
 *   Settle through the SAME completion services the browser and webhook use.
 *   A reconciler with its own provisioning logic is a third code path that can
 *   drift from the other two, and drift in a money path is how a bug becomes
 *   invisible. Those services are already idempotent, so a sweep racing a
 *   late webhook is a no-op rather than a double grant.
 *
 *   Apply SettlementAmountGuard exactly as the webhook does. The provider is
 *   being asked what it captured, so the same question — does that match what
 *   we recorded as owed — has to be asked here too. Skipping it because "we
 *   fetched it ourselves so it must be right" would leave the one settlement
 *   path with no amount check.
 *
 *   Only CAPTURED counts. An authorized-but-uncaptured payment provisions
 *   nothing (C5), on this path as on every other.
 *
 *   Leave young orders alone. An order minutes old is very likely a checkout
 *   still open in someone's browser; settling underneath it would race the
 *   verify leg for no benefit, since the push paths handle the ordinary case
 *   perfectly well. The sweep is for what they missed, not a replacement.
 *
 *   Alert on every repair. A successful repair is NOT good news to be logged
 *   quietly — it means a webhook that should have arrived did not, and that is
 *   a delivery problem which will keep happening until someone looks. The
 *   alert is the point; the repair just stops a customer being the one who
 *   reports it.
 *
 *   One bad order must never stop the sweep. Each is processed inside its own
 *   try/catch, because the order most likely to throw is precisely the one
 *   most likely to be broken.
 *
 *   Cover every flow that creates an order. Three do: credit purchases, paid
 *   deck baskets and on-spot organization credit deals. A sweep that reaches
 *   only some of them is not a weaker safety net, it is a safety net with a hole
 *   in exactly the place nobody is looking — and the deal flow is the one that
 *   needs it most, since it transacts the largest amounts and its rows carry no
 *   TTL to retire them.
 */
class PendingPaymentReconciler
{
    // How often the sweep runs. Frequent enough that a lost webhook is repaired
    // well within the window a customer would wait before complaining, and far
    // too infrequent to matter as provider API load.
    static SWEEP_INTERVAL_MILLISECONDS = 30 * 60 * 1000;

    // An order younger than this is left alone — a checkout is probably still
    // open. Comfortably longer than any real checkout session, and shorter than
    // the patience of a customer who has been charged.
    static SETTLEMENT_GRACE_MILLISECONDS = 20 * 60 * 1000;

    // Orders older than this are past any plausible provider retry window
    // (Razorpay retries for 24 hours), so one still unpaid here is simply an
    // abandoned checkout and is not worth reporting.
    static ABANDONED_AFTER_MILLISECONDS = 48 * 60 * 60 * 1000;

    // A ceiling per sweep so a backlog cannot turn one tick into thousands of
    // provider calls. Anything beyond it is picked up by the next tick, and the
    // truncation is logged rather than silent.
    static MAXIMUM_ORDERS_PER_SWEEP = 200;

    // Recorded on the ledger entry and the purchase log so a settlement can be
    // traced back to the sweep rather than to a browser or a webhook.
    static SETTLEMENT_SOURCE = "RECONCILER";

    static #intervalHandle = null;

    /**
     * Starts the periodic sweep. Safe to call twice; the second call is
     * ignored rather than stacking a second timer.
     */
    static start()
    {
        if (PendingPaymentReconciler.#intervalHandle !== null)
        {
            return;
        }

        PendingPaymentReconciler.#intervalHandle = setInterval
        (
            PendingPaymentReconciler.#tick,
            PendingPaymentReconciler.SWEEP_INTERVAL_MILLISECONDS
        );
    }

    static stop()
    {
        if (PendingPaymentReconciler.#intervalHandle !== null)
        {
            clearInterval(PendingPaymentReconciler.#intervalHandle);
            PendingPaymentReconciler.#intervalHandle = null;
        }
    }

    static async #tick()
    {
        try
        {
            await PendingPaymentReconciler.sweep();
        }
        catch (sweepError)
        {
            console.error("[PendingPaymentReconciler] Periodic sweep failed:", sweepError);
        }
    }

    /**
     * Runs one full sweep across both pending-order collections.
     *
     * Exposed (not private) so it can be invoked directly — once at boot, from
     * an admin action, or by a harness — rather than only on a timer.
     *
     * @param {number} [nowMilliseconds]
     * @returns {Promise<{examined: number, settled: number, stillUnpaid: number, failed: number, truncated: boolean}>}
     */
    static async sweep(nowMilliseconds = Date.now())
    {
        const outcome = { examined: 0, settled: 0, stillUnpaid: 0, failed: 0, truncated: false };

        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return outcome;
        }

        const staleBefore = new Date(nowMilliseconds - PendingPaymentReconciler.SETTLEMENT_GRACE_MILLISECONDS);
        const abandonedBefore = new Date(nowMilliseconds - PendingPaymentReconciler.ABANDONED_AFTER_MILLISECONDS);

        // Each collection is queried with its OWN engine's status constant.
        // They happen to hold the same string today; borrowing one engine's
        // constant for the other's collection would silently break the day that
        // stopped being true.
        const creditOrders = await PendingPaymentReconciler.#findStaleOrders
        (
            database,
            DatabaseConstants.PENDING_CREDIT_ORDERS_COLLECTION,
            PendingCreditOrderQueryEngine.STATUS_PENDING,
            staleBefore,
            abandonedBefore
        );
        const deckOrders = await PendingPaymentReconciler.#findStaleOrders
        (
            database,
            DatabaseConstants.PENDING_ORDERS_COLLECTION,
            PendingOrderQueryEngine.STATUS_PENDING,
            staleBefore,
            abandonedBefore
        );

        // On-spot credit deals are swept from their own collection rather than a
        // pending-order one, and they matter MORE than the other two rather than
        // less: a deal is the largest single amount this product transacts, and
        // unlike the pending-order rows it has no TTL, so an unsettled one sits
        // paid-but-uncredited indefinitely with nobody told.
        const dealOrders = await CreditDealPaymentQueryEngine.findStalePendingDeals(staleBefore, abandonedBefore);

        const candidates = [
            ...creditOrders.map(order => ({ order: order, flow: "CREDIT_PURCHASE" })),
            ...deckOrders.map(order => ({ order: order, flow: "PAID_DECK_PURCHASE" })),
            ...dealOrders.map(deal => ({ order: PendingPaymentReconciler.#asReconcilableOrder(deal), flow: "CREDIT_DEAL" }))
        ];

        if (candidates.length > PendingPaymentReconciler.MAXIMUM_ORDERS_PER_SWEEP)
        {
            outcome.truncated = true;
            console.warn(`[PendingPaymentReconciler] ${candidates.length} stale orders found; examining the first ${PendingPaymentReconciler.MAXIMUM_ORDERS_PER_SWEEP} this sweep.`);
            candidates.length = PendingPaymentReconciler.MAXIMUM_ORDERS_PER_SWEEP;
        }

        for (const candidate of candidates)
        {
            outcome.examined = outcome.examined + 1;
            try
            {
                const settled = await PendingPaymentReconciler.#reconcileOne(candidate.order, candidate.flow);
                if (settled)
                {
                    outcome.settled = outcome.settled + 1;
                }
                else
                {
                    outcome.stillUnpaid = outcome.stillUnpaid + 1;
                }
            }
            catch (orderError)
            {
                // The order most likely to throw is the one most likely to be
                // broken, so it must not take the rest of the sweep with it.
                outcome.failed = outcome.failed + 1;
                console.error(`[PendingPaymentReconciler] Failed to reconcile order ${candidate.order?.providerOrderId}:`, orderError);
            }
        }

        if (outcome.settled > 0 || outcome.failed > 0)
        {
            console.warn(`[PendingPaymentReconciler] Sweep complete: examined ${outcome.examined}, settled ${outcome.settled}, still unpaid ${outcome.stillUnpaid}, failed ${outcome.failed}.`);
        }

        return outcome;
    }

    /**
     * Flattens a creditDealPayments row into the shape the rest of this class
     * already understands.
     *
     * The alternative was a per-flow branch at every point that reads an order,
     * which is how three settlement paths become three subtly different
     * settlement paths. Normalising once at the edge keeps the amount assertion,
     * the receipt-placeholder skip and the alerting identical for all three.
     *
     * `userId` is deliberately empty: a deal is bought by an organization, not a
     * person, so the buyer is carried in `organizationId` instead and the alert
     * reports whichever is present.
     */
    static #asReconcilableOrder(deal)
    {
        const additionalData = deal?.additionalData || {};

        return {
            providerOrderId: deal?.providerOrderId || "",
            receiptId: additionalData.receiptId || "",
            amountMinor: deal?.amountMinor,
            currency: deal?.currency,
            paymentProvider: deal?.paymentProvider,
            userId: "",
            organizationId: deal?.targetId || "",
            dealId: deal?.id || ""
        };
    }

    /**
     * Pending orders old enough to be worth checking and young enough to still
     * plausibly be settleable.
     */
    static async #findStaleOrders(database, collectionName, pendingStatus, staleBefore, abandonedBefore)
    {
        return await database
            .collection(collectionName)
            .find
            ({
                status: pendingStatus,
                createdAt: { $lte: staleBefore, $gte: abandonedBefore }
            }, { projection: { _id: 0 } })
            .toArray();
    }

    /**
     * Checks one order against the provider and settles it if it was captured.
     * @returns {Promise<boolean>} whether it was settled by this call
     */
    static async #reconcileOne(pendingOrder, flow)
    {
        // A row still keyed on its own receipt is one whose provider call never
        // succeeded, so there is no remote order to ask about. The initiation
        // path deletes these, but a process killed between the two writes can
        // leave one behind — and asking the provider about an order it has
        // never heard of, every half hour for a fortnight, is pure waste.
        if (pendingOrder.providerOrderId === pendingOrder.receiptId)
        {
            return false;
        }

        const providerEnumValue = (pendingOrder.paymentProvider !== null && pendingOrder.paymentProvider !== undefined)
            ? pendingOrder.paymentProvider
            : paymentProviders.RAZORPAY;

        const provider = PaymentProviderFactory.getProvider(providerEnumValue);
        if (!provider.isConfigured())
        {
            return false;
        }

        const capturedPayment = await provider.fetchCapturedPaymentForOrder(pendingOrder.providerOrderId);
        if (!capturedPayment)
        {
            // Genuinely unpaid. The TTL will retire the row in its own time.
            return false;
        }

        // The provider says money was captured for an order this server still
        // believes is unpaid. Apply the same amount assertion the webhook does
        // before anything is granted.
        const comparison = SettlementAmountGuard.compare
        (
            {
                amountMinor: capturedPayment.amount,
                currency: capturedPayment.currency,
                providerOrderId: capturedPayment.order_id
            },
            {
                amountMinor: pendingOrder.amountMinor,
                currency: pendingOrder.currency,
                providerOrderId: pendingOrder.providerOrderId
            }
        );

        if (!SettlementAmountGuard.permitsSettlement(comparison))
        {
            await Alerts.raise
            ({
                severity: Alerts.SEVERITY.ERROR,
                source: "PAYMENT_RECONCILER",
                title: "A captured payment does not match the order it belongs to",
                message: `Reconciliation found a captured payment for ${flow} order ${pendingOrder.providerOrderId} that does not match the recorded order. ${SettlementAmountGuard.describe(comparison)}. Nothing was granted; this needs manual review.`,
                metadata:
                {
                    flow: flow,
                    providerOrderId: pendingOrder.providerOrderId,
                    providerPaymentId: capturedPayment.id || "",
                    mismatches: comparison.mismatches
                }
            });
            return false;
        }

        const settlementResult = await PendingPaymentReconciler.#settle(pendingOrder, flow, capturedPayment);

        // Report the repair even when the grant turned out to be a no-op: an
        // alreadyProcessed result means the entitlement was fine and only the
        // pending row was stale, which is a different (milder) fault worth
        // telling apart from a genuine rescue.
        await Alerts.raise
        ({
            severity: Alerts.SEVERITY.WARNING,
            source: "PAYMENT_RECONCILER",
            title: settlementResult.alreadyProcessed
                ? "Reconciliation closed a stale pending order"
                : "Reconciliation settled a payment the webhook never delivered",
            message: settlementResult.alreadyProcessed
                ? `${flow} order ${pendingOrder.providerOrderId} was already provisioned but its pending row was never closed. No entitlement changed. This points at a settlement path that completed partially.`
                : `${flow} order ${pendingOrder.providerOrderId} was captured by the provider but never settled here, so the buyer was charged and received nothing until this sweep repaired it. The entitlement has now been granted. <b>Check webhook delivery</b> — a repair here means a delivery that should have arrived did not.`,
            metadata:
            {
                flow: flow,
                providerOrderId: pendingOrder.providerOrderId,
                providerPaymentId: capturedPayment.id || "",
                // One of these is set per flow: a personal purchase has a buyer,
                // an organization deal has an institute.
                accountId: pendingOrder.userId || "",
                organizationId: pendingOrder.organizationId || "",
                alreadyProcessed: settlementResult.alreadyProcessed === true
            }
        });

        return true;
    }

    /**
     * Hands the order to the same completion service the browser and webhook
     * use. No provisioning logic lives here by design.
     */
    static async #settle(pendingOrder, flow, capturedPayment)
    {
        if (flow === "CREDIT_PURCHASE")
        {
            const completion = await CreditPurchaseCompletionService.complete
            (
                pendingOrder,
                { providerPaymentId: capturedPayment.id || "", source: PendingPaymentReconciler.SETTLEMENT_SOURCE }
            );
            return { alreadyProcessed: completion.alreadyProcessed === true };
        }

        if (flow === "CREDIT_DEAL")
        {
            // Through the same service the browser leg and the webhook use, so
            // the pool credit, the contract term and the unfreeze all move
            // together — capturing the deal alone here would mark it paid and
            // leave the credits nowhere.
            const completion = await OrganizationCreditDealCompletionService.complete
            (
                pendingOrder.providerOrderId,
                capturedPayment.id || "",
                PendingPaymentReconciler.SETTLEMENT_SOURCE
            );
            return { alreadyProcessed: completion.alreadyProcessed === true };
        }

        const completion = await PaidDeckPurchaseCompletionService.complete
        (
            pendingOrder,
            {
                providerPaymentId: capturedPayment.id || "",
                paymentProvider: (pendingOrder.paymentProvider !== null && pendingOrder.paymentProvider !== undefined)
                    ? pendingOrder.paymentProvider
                    : paymentProviders.RAZORPAY,
                source: PendingPaymentReconciler.SETTLEMENT_SOURCE
            }
        );
        return { alreadyProcessed: completion.alreadyProcessed === true };
    }
}

module.exports = PendingPaymentReconciler;
