const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const PaymentProviderFactory = require("./PaymentProviderFactory");
const ReconciliationBreak = require("./ReconciliationBreak");
const CreditLedger = require("../Credits/CreditLedger");
const OrganizationCreditLedger = require("../Organization/OrganizationCreditLedger");
const Alerts = require("../Alerts/Alerts");
const { reconciliationBreakTypes } = require("../../Enumerations/ReconciliationBreakTypes");
const { creditTransactionTypes } = require("../../Enumerations/CreditTransactionTypes");
const { creditDealPaymentStatuses } = require("../../Enumerations/CreditDealPaymentStatuses");
const { purchaseStatuses } = require("../../Enumerations/PurchaseStatuses");
const { paymentProviders } = require("../../Enumerations/PaymentProviders");

/**
 * FinancialReconciliationService
 *
 * Asks, once a day and automatically, the question no other code in this
 * integration asks: does the money we took equal the entitlement we handed out?
 *
 * Every other guard here is PER EVENT. SettlementAmountGuard checks one capture
 * against one order; the ledger's referenceKey stops one grant happening twice;
 * PendingPaymentReconciler repairs one order the pushes missed. All of them can
 * be individually correct while the day as a whole is wrong — a payment that
 * exists at Razorpay and matches no local row is invisible to every one of
 * them, because they all start from something this server already knows about.
 * Reconciliation starts from the PROVIDER's account of the day instead, which
 * is the only direction that can find money arriving against nothing.
 *
 * ── The three bodies of evidence ──────────────────────────────────────────
 *
 *   1. The provider. Every payment Razorpay recorded in the window, pulled
 *      through fetchPaymentsInWindow. This is the closest thing to the bank
 *      that an API can answer, and it is deliberately the SPINE of the check
 *      rather than one input among three.
 *   2. The money records. purchases, creditDealPayments and the pending-order
 *      rows: what this server believes it was paid.
 *   3. The ledger. creditTransactions and organizationCreditTransactions: what
 *      this server actually handed out in return.
 *
 * A day reconciles when all three agree. Where they do not, the disagreement is
 * recorded as a typed ReconciliationBreak — never as prose — so the same break
 * recurring on twenty days is countable rather than twenty separate mysteries.
 *
 * ── Why matching does not use the window ──────────────────────────────────
 *
 * The window decides WHICH provider payments are examined. It plays no part in
 * deciding whether a local record exists for one: those lookups are by order id
 * with no date bound at all. A payment captured at 23:59:58 and settled locally
 * at 00:00:03 is completely ordinary, and a reconciliation that treated the day
 * boundary as a matching criterion would report it as missing money every
 * single midnight — which is precisely how a control gets switched off.
 *
 * ── Against accounting records ────────────────────────────────────────────
 *
 * The three bodies above are all this application's own. Agreeing with itself
 * is necessary and not sufficient, so each day's report carries a slot for the
 * figure the accounting system holds, filled through recordAccountingTotals
 * (admin endpoint, or the settlement owner's monthly pass — see
 * Common/ReadmeFiles/PaymentReconciliationOwnership.md). A day whose accounting
 * total is present and disagrees raises ACCOUNTING_TOTAL_MISMATCH; a day where
 * it was never entered stays visibly unconfirmed rather than quietly passing.
 *
 * ── Idempotency ───────────────────────────────────────────────────────────
 *
 * Reports are keyed on the UTC day and upserted, so re-running a day overwrites
 * its own previous conclusion rather than accumulating duplicates. That matters
 * because a day gets reconciled again whenever it is re-swept: breaks that were
 * repaired must be able to disappear, or the report becomes a list of things
 * that were once wrong instead of a statement about today.
 */
class FinancialReconciliationService
{
    // Runs often enough that a day is reconciled within hours of closing, and
    // rarely enough that the provider list API is never a load concern.
    static SWEEP_INTERVAL_MILLISECONDS = 6 * 60 * 60 * 1000;

    // A UTC day is not reconciled until it is this far in the past. Razorpay
    // webhooks retry for hours, and reconciling a day while its own settlement
    // paths are still converging would manufacture breaks that resolve
    // themselves before anyone reads them.
    static SETTLEMENT_LAG_MILLISECONDS = 3 * 60 * 60 * 1000;

    // How many closed days a single sweep will reconcile. Enough to backfill
    // after a week of downtime, bounded so a first run on an old database does
    // not page the provider API for a year.
    static MAXIMUM_DAYS_PER_SWEEP = 14;

    // Money is compared exactly. There is no float in a minor-unit integer, so
    // any tolerance here would only ever hide a real difference.
    static AMOUNT_TOLERANCE_MINOR = 0;

    // A ceiling on stored breaks so one catastrophic day cannot write a
    // document Mongo refuses. The COUNTS are always exact; only the itemised
    // list is truncated, and the truncation is recorded.
    static MAXIMUM_BREAKS_RECORDED = 200;

    // Named in the stored report so a figure can be traced to the pass that
    // produced it.
    static RECONCILER_NAME = "FinancialReconciliationService";

    static MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

    static #intervalHandle = null;
    static #indexesEnsured = false;

    // ── Scheduling ────────────────────────────────────────────────────────

    static start()
    {
        if (FinancialReconciliationService.#intervalHandle !== null)
        {
            return;
        }

        FinancialReconciliationService.#intervalHandle = setInterval
        (
            FinancialReconciliationService.#tick,
            FinancialReconciliationService.SWEEP_INTERVAL_MILLISECONDS
        );
    }

    static stop()
    {
        if (FinancialReconciliationService.#intervalHandle !== null)
        {
            clearInterval(FinancialReconciliationService.#intervalHandle);
            FinancialReconciliationService.#intervalHandle = null;
        }
    }

    static async #tick()
    {
        try
        {
            await FinancialReconciliationService.sweep();
        }
        catch (sweepError)
        {
            console.error("[FinancialReconciliationService] Sweep failed:", sweepError);
        }
    }

    // ── Day keys ──────────────────────────────────────────────────────────

    /**
     * The UTC day a timestamp falls in, as "YYYY-MM-DD".
     *
     * UTC deliberately, and not the operator's local day: the stored records
     * are UTC, Razorpay's timestamps are UTC epochs, and a report keyed on a
     * local day would silently change shape when the server moves or the clocks
     * do. The human-facing consequence — that "yesterday" means UTC yesterday —
     * is stated in the ownership runbook rather than papered over here.
     */
    static buildDayKey(timestampMilliseconds)
    {
        return new Date(timestampMilliseconds).toISOString().substring(0, 10);
    }

    static parseDayKey(dayKey)
    {
        const startMilliseconds = Date.parse(`${dayKey}T00:00:00.000Z`);
        if (Number.isNaN(startMilliseconds))
        {
            return null;
        }

        return {
            startMilliseconds: startMilliseconds,
            endMilliseconds: startMilliseconds + FinancialReconciliationService.MILLISECONDS_PER_DAY
        };
    }

    // ── Storage ───────────────────────────────────────────────────────────

    static async #getReportsCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return null;
        }

        const collection = database.collection(DatabaseConstants.FINANCIAL_RECONCILIATIONS_COLLECTION);

        if (!FinancialReconciliationService.#indexesEnsured)
        {
            try
            {
                await collection.createIndex({ dayKey: 1 }, { unique: true });
                FinancialReconciliationService.#indexesEnsured = true;
            }
            catch (indexError)
            {
                console.error("[FinancialReconciliationService] Failed to ensure indexes:", indexError);
            }
        }

        return collection;
    }

    // ── The sweep ─────────────────────────────────────────────────────────

    /**
     * Reconciles every closed day that has no report yet, oldest first.
     *
     * Oldest first matters: if the ceiling truncates the run, the days that get
     * done are the ones closest to being forgotten, and the recent ones come
     * round again on the next tick anyway.
     *
     * @param {number} [nowMilliseconds]
     * @returns {Promise<{reconciledDays: string[], skipped: boolean, reason?: string}>}
     */
    static async sweep(nowMilliseconds = Date.now())
    {
        const reportsCollection = await FinancialReconciliationService.#getReportsCollection();
        if (!reportsCollection)
        {
            return { reconciledDays: [], skipped: true, reason: "NO_DATABASE" };
        }

        const latestClosedDayKey = FinancialReconciliationService.buildDayKey
        (
            nowMilliseconds - FinancialReconciliationService.SETTLEMENT_LAG_MILLISECONDS - FinancialReconciliationService.MILLISECONDS_PER_DAY
        );

        const candidateDayKeys = [];
        for (let dayOffset = FinancialReconciliationService.MAXIMUM_DAYS_PER_SWEEP; dayOffset >= 0; dayOffset = dayOffset - 1)
        {
            const parsedLatest = FinancialReconciliationService.parseDayKey(latestClosedDayKey);
            candidateDayKeys.push(FinancialReconciliationService.buildDayKey(parsedLatest.startMilliseconds - (dayOffset * FinancialReconciliationService.MILLISECONDS_PER_DAY)));
        }

        const existingReports = await reportsCollection
            .find({ dayKey: { $in: candidateDayKeys } }, { projection: { dayKey: 1 } })
            .toArray();
        const alreadyReconciled = new Set(existingReports.map(report => report.dayKey));

        const reconciledDays = [];
        for (const dayKey of candidateDayKeys)
        {
            if (alreadyReconciled.has(dayKey))
            {
                continue;
            }

            try
            {
                await FinancialReconciliationService.reconcileDay(dayKey);
                reconciledDays.push(dayKey);
            }
            catch (dayError)
            {
                // One bad day must never stop the sweep — the day most likely to
                // throw is the one most likely to be broken.
                console.error(`[FinancialReconciliationService] Failed to reconcile ${dayKey}:`, dayError);
            }
        }

        return { reconciledDays: reconciledDays, skipped: false };
    }

    /**
     * Reconciles one UTC day and stores the report.
     *
     * @param {string} dayKey "YYYY-MM-DD"
     * @returns {Promise<object|null>} the stored report
     */
    static async reconcileDay(dayKey)
    {
        const window = FinancialReconciliationService.parseDayKey(dayKey);
        if (!window)
        {
            throw new Error(`Invalid day key: ${dayKey}`);
        }

        const database = await DatabaseConnector.getDatabase();
        const reportsCollection = await FinancialReconciliationService.#getReportsCollection();
        if (!database || !reportsCollection)
        {
            return null;
        }

        const breaks = [];

        const localSettlements = await FinancialReconciliationService.#collectLocalSettlements(database, window);
        const providerOutcome = await FinancialReconciliationService.#collectProviderPayments(window);

        await FinancialReconciliationService.#compareProviderAgainstLocal(database, providerOutcome, breaks);
        await FinancialReconciliationService.#compareLocalAgainstProvider(localSettlements, providerOutcome, breaks);
        await FinancialReconciliationService.#checkDuplicateEntitlements(localSettlements, breaks);
        await FinancialReconciliationService.#checkPurchasesHaveLicenses(database, localSettlements, breaks);
        await FinancialReconciliationService.#checkDealsCreditedPools(database, localSettlements, breaks);
        await FinancialReconciliationService.#checkReversals(database, window, breaks);

        const existingReport = await reportsCollection.findOne({ dayKey: dayKey });
        const accountingTotals = existingReport?.accountingTotals || null;

        FinancialReconciliationService.#checkAccountingTotals(localSettlements, accountingTotals, breaks);

        const report = FinancialReconciliationService.#buildReport(dayKey, localSettlements, providerOutcome, accountingTotals, breaks);

        await reportsCollection.updateOne
        (
            { dayKey: dayKey },
            { $set: report },
            { upsert: true }
        );

        if (breaks.length > 0)
        {
            await FinancialReconciliationService.#raiseBreaksAlert(dayKey, report, breaks);
        }

        return report;
    }

    // ── Evidence gathering ────────────────────────────────────────────────

    /**
     * What this server believes happened: the money it recorded and the
     * entitlement it issued, for the day.
     */
    static async #collectLocalSettlements(database, window)
    {
        const windowStart = new Date(window.startMilliseconds);
        const windowEnd = new Date(window.endMilliseconds);

        const creditGrants = await database
            .collection(DatabaseConstants.CREDIT_TRANSACTIONS_COLLECTION)
            .find
            ({
                type: { $in: [creditTransactionTypes.PURCHASE_GRANT, creditTransactionTypes.SUBSCRIPTION_GRANT] },
                status: CreditLedger.TRANSACTION_STATUS_APPLIED,
                createdAt: { $gte: windowStart, $lt: windowEnd }
            })
            .toArray();

        const deckPurchases = await database
            .collection(DatabaseConstants.PURCHASES_COLLECTION)
            .find
            ({
                status: purchaseStatuses.COMPLETED,
                purchaseDate: { $gte: windowStart, $lt: windowEnd }
            })
            .toArray();

        const capturedDeals = await database
            .collection(DatabaseConstants.CREDIT_DEAL_PAYMENTS_COLLECTION)
            .find
            ({
                status: creditDealPaymentStatuses.CAPTURED,
                capturedAt: { $gte: windowStart, $lt: windowEnd }
            })
            .toArray();

        const organizationPoolCredits = await database
            .collection(DatabaseConstants.ORGANIZATION_CREDIT_TRANSACTIONS_COLLECTION)
            .find
            ({
                type: OrganizationCreditLedger.TRANSACTION_TYPE_PURCHASE,
                status: OrganizationCreditLedger.TRANSACTION_STATUS_APPLIED,
                createdAt: { $gte: windowStart, $lt: windowEnd }
            })
            .toArray();

        return {
            creditGrants: creditGrants,
            deckPurchases: deckPurchases,
            capturedDeals: capturedDeals,
            organizationPoolCredits: organizationPoolCredits
        };
    }

    /**
     * What the provider says happened. A provider that cannot be reached does
     * NOT silently pass the day: the report records that its spine was missing,
     * so a run of unreachable days is visible rather than looking like a run of
     * clean ones.
     */
    static async #collectProviderPayments(window)
    {
        const provider = PaymentProviderFactory.getProvider(paymentProviders.RAZORPAY);

        if (!provider || !provider.isConfigured())
        {
            return { available: false, reason: "PROVIDER_NOT_CONFIGURED", capturedPayments: [], provider: null };
        }

        try
        {
            // Razorpay's window is inclusive at both ends and in SECONDS, so the
            // end is the last second INSIDE the day rather than the next day's
            // first — otherwise every midnight payment is counted twice.
            const fromEpochSeconds = Math.floor(window.startMilliseconds / 1000);
            const toEpochSeconds = Math.floor(window.endMilliseconds / 1000) - 1;

            const allPayments = await provider.fetchPaymentsInWindow(fromEpochSeconds, toEpochSeconds);

            return {
                available: true,
                capturedPayments: allPayments.filter(payment => payment?.status === "captured"),
                totalPaymentCount: allPayments.length,
                provider: provider
            };
        }
        catch (providerError)
        {
            console.error("[FinancialReconciliationService] Could not read the provider's payments:", providerError);
            return { available: false, reason: "PROVIDER_UNREACHABLE", capturedPayments: [], provider: provider };
        }
    }

    // ── The comparisons ───────────────────────────────────────────────────

    /**
     * For every payment the provider captured: does this server have a record of
     * it, and for the same amount?
     *
     * The lookups are by order id with NO date bound — see the class comment on
     * why the window must not participate in matching.
     */
    static async #compareProviderAgainstLocal(database, providerOutcome, breaks)
    {
        if (!providerOutcome.available)
        {
            return;
        }

        for (const capturedPayment of providerOutcome.capturedPayments)
        {
            const providerOrderId = typeof capturedPayment?.order_id === "string" ? capturedPayment.order_id : "";
            const providerPaymentId = typeof capturedPayment?.id === "string" ? capturedPayment.id : "";
            const capturedAmountMinor = Number(capturedPayment?.amount) || 0;
            const currency = typeof capturedPayment?.currency === "string" ? capturedPayment.currency : "";

            const localRecord = await FinancialReconciliationService.#findLocalRecordForPayment(database, providerOrderId, providerPaymentId);

            if (!localRecord.found)
            {
                breaks.push(new ReconciliationBreak
                ({
                    type: reconciliationBreakTypes.PROVIDER_PAYMENT_WITHOUT_LOCAL_RECORD,
                    reference: providerPaymentId || providerOrderId,
                    detail: `Razorpay captured ${capturedAmountMinor} ${currency} on payment ${providerPaymentId} (order ${providerOrderId || "none"}) and this server has no settled record of it. The customer has been charged; confirm what they were owed and provision it.`,
                    amountMinor: capturedAmountMinor,
                    currency: currency
                }));
                continue;
            }

            if (localRecord.amountMinor > 0
                && Math.abs(localRecord.amountMinor - capturedAmountMinor) > FinancialReconciliationService.AMOUNT_TOLERANCE_MINOR)
            {
                breaks.push(new ReconciliationBreak
                ({
                    type: reconciliationBreakTypes.AMOUNT_MISMATCH_AGAINST_PROVIDER,
                    reference: providerPaymentId || providerOrderId,
                    detail: `Razorpay captured ${capturedAmountMinor} ${currency} but this server recorded ${localRecord.amountMinor} for ${localRecord.flow} ${providerOrderId}.`,
                    amountMinor: Math.abs(localRecord.amountMinor - capturedAmountMinor),
                    currency: currency
                }));
            }
        }
    }

    /**
     * The mirror: a local settlement with no captured payment behind it, which
     * would mean entitlement granted for money that never arrived.
     *
     * A settlement missing from the fetched window is re-checked against the
     * provider one order at a time before it is reported. The window is a
     * bulk-fetch optimisation, not evidence of absence — a payment captured
     * seconds either side of midnight is legitimately outside it.
     */
    static async #compareLocalAgainstProvider(localSettlements, providerOutcome, breaks)
    {
        if (!providerOutcome.available)
        {
            return;
        }

        const capturedOrderIds = new Set
        (
            providerOutcome.capturedPayments
                .map(payment => (typeof payment?.order_id === "string" ? payment.order_id : ""))
                .filter(orderId => orderId.length > 0)
        );

        const settledOrderIds = new Set();

        for (const creditGrant of localSettlements.creditGrants)
        {
            const providerOrderId = creditGrant?.metadata?.providerOrderId;
            if (typeof providerOrderId === "string" && providerOrderId.length > 0)
            {
                settledOrderIds.add(providerOrderId);
            }
        }

        for (const deckPurchase of localSettlements.deckPurchases)
        {
            if (typeof deckPurchase?.providerOrderId === "string" && deckPurchase.providerOrderId.length > 0)
            {
                settledOrderIds.add(deckPurchase.providerOrderId);
            }
        }

        for (const capturedDeal of localSettlements.capturedDeals)
        {
            if (typeof capturedDeal?.providerOrderId === "string" && capturedDeal.providerOrderId.length > 0)
            {
                settledOrderIds.add(capturedDeal.providerOrderId);
            }
        }

        for (const providerOrderId of settledOrderIds)
        {
            if (capturedOrderIds.has(providerOrderId))
            {
                continue;
            }

            let capturedPayment = null;
            try
            {
                capturedPayment = await providerOutcome.provider.fetchCapturedPaymentForOrder(providerOrderId);
            }
            catch (lookupError)
            {
                // Unreachable for this one order. Reporting it as missing money
                // on the strength of a network failure would be worse than
                // saying nothing, so it is logged and skipped.
                console.error(`[FinancialReconciliationService] Could not confirm order ${providerOrderId} with the provider:`, lookupError);
                continue;
            }

            if (!capturedPayment)
            {
                breaks.push(new ReconciliationBreak
                ({
                    type: reconciliationBreakTypes.LOCAL_SETTLEMENT_WITHOUT_PROVIDER_PAYMENT,
                    reference: providerOrderId,
                    detail: `This server settled order ${providerOrderId} and granted entitlement for it, but Razorpay reports no captured payment against that order. Entitlement may have been granted for money that never arrived.`,
                    amountMinor: 0,
                    currency: ""
                }));
            }
        }
    }

    /**
     * Two applied ledger grants naming the same order. The referenceKey index
     * makes a REPLAY impossible, but nothing stops two DIFFERENT keys being
     * built for one order — a flow change, a manual grant, a second completion
     * service — and that is a double grant nobody would otherwise notice.
     */
    static async #checkDuplicateEntitlements(localSettlements, breaks)
    {
        const grantsByOrderId = new Map();

        for (const creditGrant of localSettlements.creditGrants)
        {
            const providerOrderId = creditGrant?.metadata?.providerOrderId;
            if (typeof providerOrderId !== "string" || providerOrderId.length === 0)
            {
                continue;
            }

            if (!grantsByOrderId.has(providerOrderId))
            {
                grantsByOrderId.set(providerOrderId, []);
            }
            grantsByOrderId.get(providerOrderId).push(creditGrant);
        }

        for (const [providerOrderId, grants] of grantsByOrderId)
        {
            if (grants.length <= 1)
            {
                continue;
            }

            const totalCredits = grants.reduce((runningTotal, grant) => runningTotal + (Number(grant.amount) || 0), 0);

            breaks.push(new ReconciliationBreak
            ({
                type: reconciliationBreakTypes.DUPLICATE_ENTITLEMENT_FOR_ORDER,
                reference: providerOrderId,
                detail: `Order ${providerOrderId} produced ${grants.length} separate applied credit grants totalling ${totalCredits} credits (reference keys: ${grants.map(grant => grant.referenceKey).join(", ")}). One order should grant once.`,
                amountMinor: Number(grants[0]?.metadata?.amountMinor) || 0,
                currency: typeof grants[0]?.metadata?.currency === "string" ? grants[0].metadata.currency : ""
            }));
        }
    }

    /**
     * A completed paid-deck purchase with no licence issued: the buyer paid and
     * cannot open what they bought. Scoped to the purchase's own deck, and
     * accepting a REVOKED licence as evidence — a purchase later reversed did
     * issue its licence, and re-reporting it here would double-count the
     * reversal that already handled it.
     */
    static async #checkPurchasesHaveLicenses(database, localSettlements, breaks)
    {
        for (const deckPurchase of localSettlements.deckPurchases)
        {
            const existingLicense = await database
                .collection(DatabaseConstants.DECK_LICENSES_COLLECTION)
                .findOne({ userId: deckPurchase.userId, deckId: deckPurchase.deckId });

            if (existingLicense)
            {
                continue;
            }

            breaks.push(new ReconciliationBreak
            ({
                type: reconciliationBreakTypes.PURCHASE_WITHOUT_ENTITLEMENT,
                reference: deckPurchase.providerOrderId || "",
                detail: `User ${deckPurchase.userId} completed a purchase of deck ${deckPurchase.deckId} on order ${deckPurchase.providerOrderId} but holds no licence for it.`,
                amountMinor: Number(deckPurchase.amountMinor) || 0,
                currency: typeof deckPurchase.currency === "string" ? deckPurchase.currency : ""
            }));
        }
    }

    /**
     * A captured organization deal whose pool was never credited. The largest
     * single amount this product sells, so the one where a silent failure costs
     * the most.
     */
    static async #checkDealsCreditedPools(database, localSettlements, breaks)
    {
        for (const capturedDeal of localSettlements.capturedDeals)
        {
            const dealId = capturedDeal?.id;
            if (typeof dealId !== "string" || dealId.length === 0)
            {
                continue;
            }

            const poolCredit = await database
                .collection(DatabaseConstants.ORGANIZATION_CREDIT_TRANSACTIONS_COLLECTION)
                .findOne
                ({
                    referenceKey: `orgDeal:${dealId}`,
                    status: OrganizationCreditLedger.TRANSACTION_STATUS_APPLIED
                });

            if (poolCredit)
            {
                continue;
            }

            breaks.push(new ReconciliationBreak
            ({
                type: reconciliationBreakTypes.CAPTURED_DEAL_WITHOUT_POOL_CREDIT,
                reference: capturedDeal.providerOrderId || dealId,
                detail: `Credit deal ${dealId} is CAPTURED but no applied pool credit exists for it. The institute paid and its pool was not topped up.`,
                amountMinor: Number(capturedDeal.amountMinor) || 0,
                currency: typeof capturedDeal.currency === "string" ? capturedDeal.currency : ""
            }));
        }
    }

    /**
     * Reversals that did not fully undo what they should have. Two shapes, kept
     * separate because they need different actions: one that could not be
     * attributed to any order at all (nothing was reversed, and a human must
     * find out what), and one that was attributed but could only recover part
     * of the credits (a real loss that needs a decision).
     */
    static async #checkReversals(database, window, breaks)
    {
        const reversals = await database
            .collection(DatabaseConstants.PAYMENT_REVERSALS_COLLECTION)
            .find({ reversedAt: { $gte: new Date(window.startMilliseconds), $lt: new Date(window.endMilliseconds) } })
            .toArray();

        for (const reversal of reversals)
        {
            if (reversal.reversed === false || reversal.flow === "UNKNOWN")
            {
                breaks.push(new ReconciliationBreak
                ({
                    type: reconciliationBreakTypes.UNATTRIBUTED_REVERSAL,
                    reference: reversal.refundId || reversal.providerPaymentId || "",
                    detail: `Refund ${reversal.refundId} could not be attributed to any flow, so nothing was revoked. The money has gone back and the entitlement it bought may still be active.`,
                    amountMinor: Number(reversal.amountMinor) || 0,
                    currency: typeof reversal.currency === "string" ? reversal.currency : ""
                }));
                continue;
            }

            if ((Number(reversal.creditShortfall) || 0) > 0)
            {
                breaks.push(new ReconciliationBreak
                ({
                    type: reconciliationBreakTypes.REVERSAL_WITHOUT_CLAWBACK,
                    reference: reversal.refundId || "",
                    detail: `Refund ${reversal.refundId} (${reversal.flow}) could not recover ${reversal.creditShortfall} credits — they had already been spent. This is an unrecovered loss awaiting a decision.`,
                    amountMinor: Number(reversal.amountMinor) || 0,
                    currency: typeof reversal.currency === "string" ? reversal.currency : ""
                }));
            }
        }
    }

    /**
     * The accounting figure, when one has been entered. Absence is NOT a break:
     * a day nobody has signed off is reported as unconfirmed, and turning that
     * into an alert would fire every single day until the monthly pass and
     * train the reader to ignore it.
     */
    static #checkAccountingTotals(localSettlements, accountingTotals, breaks)
    {
        if (!accountingTotals || typeof accountingTotals.grossMinor !== "number")
        {
            return;
        }

        const internalGrossMinor = FinancialReconciliationService.#sumInternalGrossMinor(localSettlements);

        if (Math.abs(internalGrossMinor - accountingTotals.grossMinor) > FinancialReconciliationService.AMOUNT_TOLERANCE_MINOR)
        {
            breaks.push(new ReconciliationBreak
            ({
                type: reconciliationBreakTypes.ACCOUNTING_TOTAL_MISMATCH,
                reference: accountingTotals.source || "accounting",
                detail: `The accounting system reports ${accountingTotals.grossMinor} ${accountingTotals.currency || ""} gross for this day; this server's records total ${internalGrossMinor}.`,
                amountMinor: Math.abs(internalGrossMinor - accountingTotals.grossMinor),
                currency: accountingTotals.currency || ""
            }));
        }
    }

    // ── Totals and the stored report ──────────────────────────────────────

    /**
     * Gross money this server believes it received on the day.
     *
     * Credit grants contribute their recorded amountMinor; deck purchases and
     * deals contribute theirs. Organization pool credits are deliberately NOT
     * summed — their money is the deal row already counted, and adding both
     * would double the largest amounts in the product.
     */
    static #sumInternalGrossMinor(localSettlements)
    {
        let runningTotal = 0;

        for (const creditGrant of localSettlements.creditGrants)
        {
            runningTotal = runningTotal + (Number(creditGrant?.metadata?.amountMinor) || 0);
        }

        for (const deckPurchase of localSettlements.deckPurchases)
        {
            runningTotal = runningTotal + (Number(deckPurchase.amountMinor) || 0);
        }

        for (const capturedDeal of localSettlements.capturedDeals)
        {
            runningTotal = runningTotal + (Number(capturedDeal.amountMinor) || 0);
        }

        return runningTotal;
    }

    static #sumProviderGrossMinor(providerOutcome)
    {
        return providerOutcome.capturedPayments.reduce
        (
            (runningTotal, payment) => runningTotal + (Number(payment?.amount) || 0),
            0
        );
    }

    static #buildReport(dayKey, localSettlements, providerOutcome, accountingTotals, breaks)
    {
        const breakCountsByTypeName = {};
        for (const reconciliationBreak of breaks)
        {
            const typeName = reconciliationBreak.getTypeName();
            breakCountsByTypeName[typeName] = (breakCountsByTypeName[typeName] || 0) + 1;
        }

        return {
            dayKey: dayKey,
            reconciledAt: new Date(),
            reconciler: FinancialReconciliationService.RECONCILER_NAME,

            providerAvailable: providerOutcome.available === true,
            providerUnavailableReason: providerOutcome.available === true ? "" : (providerOutcome.reason || ""),
            providerCapturedCount: providerOutcome.capturedPayments.length,
            providerGrossMinor: FinancialReconciliationService.#sumProviderGrossMinor(providerOutcome),

            internalGrossMinor: FinancialReconciliationService.#sumInternalGrossMinor(localSettlements),
            creditGrantCount: localSettlements.creditGrants.length,
            deckPurchaseCount: localSettlements.deckPurchases.length,
            capturedDealCount: localSettlements.capturedDeals.length,
            organizationPoolCreditCount: localSettlements.organizationPoolCredits.length,

            accountingTotals: accountingTotals,
            accountingConfirmed: Boolean(accountingTotals && typeof accountingTotals.grossMinor === "number"),

            breakCount: breaks.length,
            breakCountsByTypeName: breakCountsByTypeName,
            breaksTruncated: breaks.length > FinancialReconciliationService.MAXIMUM_BREAKS_RECORDED,
            breaks: breaks
                .slice(0, FinancialReconciliationService.MAXIMUM_BREAKS_RECORDED)
                .map(reconciliationBreak => reconciliationBreak.toJson()),

            balanced: breaks.length === 0 && providerOutcome.available === true
        };
    }

    static async #raiseBreaksAlert(dayKey, report, breaks)
    {
        const summary = Object.entries(report.breakCountsByTypeName)
            .map(([typeName, count]) => `${typeName} x${count}`)
            .join(", ");

        await Alerts.raise
        ({
            severity: Alerts.SEVERITY.ERROR,
            source: "FINANCIAL_RECONCILIATION",
            title: `${dayKey} did not reconcile`,
            message: `${breaks.length} break(s) on ${dayKey}: ${summary}. Provider gross ${report.providerGrossMinor}, this server's records ${report.internalGrossMinor}. First break: ${breaks[0].getDetail()}`,
            metadata:
            {
                dayKey: dayKey,
                breakCount: breaks.length,
                breakCountsByTypeName: report.breakCountsByTypeName,
                providerGrossMinor: report.providerGrossMinor,
                internalGrossMinor: report.internalGrossMinor
            }
        });
    }

    // ── Local record lookup ───────────────────────────────────────────────

    /**
     * Finds whatever this server recorded for a provider payment, across every
     * flow that can produce one. Matching is by ORDER id for the three order
     * flows and by PAYMENT id for subscriptions, because a subscription charge
     * is not created from an order this server made.
     *
     * @returns {Promise<{found: boolean, flow: string, amountMinor: number}>}
     */
    static async #findLocalRecordForPayment(database, providerOrderId, providerPaymentId)
    {
        if (typeof providerOrderId === "string" && providerOrderId.length > 0)
        {
            const creditGrant = await database
                .collection(DatabaseConstants.CREDIT_TRANSACTIONS_COLLECTION)
                .findOne({ "metadata.providerOrderId": providerOrderId, status: CreditLedger.TRANSACTION_STATUS_APPLIED });

            if (creditGrant)
            {
                return { found: true, flow: "CREDIT_PURCHASE", amountMinor: Number(creditGrant?.metadata?.amountMinor) || 0 };
            }

            const deckPurchases = await database
                .collection(DatabaseConstants.PURCHASES_COLLECTION)
                .find({ providerOrderId: providerOrderId })
                .toArray();

            if (deckPurchases.length > 0)
            {
                // A basket writes one purchase row per deck, so the order's
                // amount is the SUM. Comparing a single row against the captured
                // total would report every multi-deck purchase as a mismatch.
                const basketTotalMinor = deckPurchases.reduce
                (
                    (runningTotal, purchase) => runningTotal + (Number(purchase.amountMinor) || 0),
                    0
                );
                return { found: true, flow: "PAID_DECK_PURCHASE", amountMinor: basketTotalMinor };
            }

            const dealPayment = await database
                .collection(DatabaseConstants.CREDIT_DEAL_PAYMENTS_COLLECTION)
                .findOne({ providerOrderId: providerOrderId });

            if (dealPayment)
            {
                return { found: true, flow: "ORGANIZATION_CREDIT_DEAL", amountMinor: Number(dealPayment.amountMinor) || 0 };
            }
        }

        if (typeof providerPaymentId === "string" && providerPaymentId.length > 0)
        {
            const subscriptionGrant = await database
                .collection(DatabaseConstants.CREDIT_TRANSACTIONS_COLLECTION)
                .findOne
                ({
                    type: creditTransactionTypes.SUBSCRIPTION_GRANT,
                    "metadata.providerPaymentId": providerPaymentId
                });

            if (subscriptionGrant)
            {
                // A subscription grant records the credits, not the money: the
                // amount is the plan's, held at Razorpay. Reporting 0 here means
                // "found, no local amount to compare", which suppresses a
                // meaningless mismatch rather than inventing one.
                return { found: true, flow: "SUBSCRIPTION_CHARGE", amountMinor: 0 };
            }
        }

        return { found: false, flow: "UNKNOWN", amountMinor: 0 };
    }

    // ── The accounting side ───────────────────────────────────────────────

    /**
     * Records what the accounting system holds for a day, and re-reconciles it
     * so the comparison happens immediately rather than on the next sweep.
     *
     * This is the hop that makes the control an "internal reconciliation of the
     * ledger against ACCOUNTING RECORDS" rather than the application agreeing
     * with itself.
     *
     * @param {string} dayKey
     * @param {{grossMinor: number, currency: string, source: string, recordedBy: string, note?: string}} totals
     */
    static async recordAccountingTotals(dayKey, { grossMinor, currency, source, recordedBy, note } = {})
    {
        const window = FinancialReconciliationService.parseDayKey(dayKey);
        if (!window)
        {
            throw new Error(`Invalid day key: ${dayKey}`);
        }

        const reportsCollection = await FinancialReconciliationService.#getReportsCollection();
        if (!reportsCollection)
        {
            return null;
        }

        await reportsCollection.updateOne
        (
            { dayKey: dayKey },
            {
                $set:
                {
                    dayKey: dayKey,
                    accountingTotals:
                    {
                        grossMinor: Number(grossMinor) || 0,
                        currency: typeof currency === "string" ? currency : "",
                        source: typeof source === "string" ? source : "",
                        recordedBy: typeof recordedBy === "string" ? recordedBy : "",
                        note: typeof note === "string" ? note : "",
                        recordedAt: new Date()
                    }
                }
            },
            { upsert: true }
        );

        // Re-run the day so the comparison — and the alert, if they disagree —
        // happens now. Whoever just entered the figure is the right person to
        // learn immediately that it does not match.
        return await FinancialReconciliationService.reconcileDay(dayKey);
    }

    /**
     * Stored reports, newest first.
     */
    static async listReports(limit = 60)
    {
        const reportsCollection = await FinancialReconciliationService.#getReportsCollection();
        if (!reportsCollection)
        {
            return [];
        }

        return await reportsCollection
            .find({}, { projection: { _id: 0 } })
            .sort({ dayKey: -1 })
            .limit(Math.max(1, Math.min(400, Number(limit) || 60)))
            .toArray();
    }

    /**
     * One row per settled transaction across a date range, in the shape an
     * accounting system imports.
     *
     * Deliberately built from the same records the reconciliation reads rather
     * than from the stored reports: an export is evidence, and evidence
     * assembled from a summary of itself proves nothing.
     *
     * @param {string} fromDayKey inclusive
     * @param {string} toDayKey inclusive
     */
    static async buildJournalRows(fromDayKey, toDayKey)
    {
        const fromWindow = FinancialReconciliationService.parseDayKey(fromDayKey);
        const toWindow = FinancialReconciliationService.parseDayKey(toDayKey);

        if (!fromWindow || !toWindow || toWindow.endMilliseconds <= fromWindow.startMilliseconds)
        {
            throw new Error("Invalid journal export range");
        }

        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return [];
        }

        const window = { startMilliseconds: fromWindow.startMilliseconds, endMilliseconds: toWindow.endMilliseconds };
        const localSettlements = await FinancialReconciliationService.#collectLocalSettlements(database, window);

        const journalRows = [];

        for (const creditGrant of localSettlements.creditGrants)
        {
            journalRows.push
            ({
                date: FinancialReconciliationService.buildDayKey(new Date(creditGrant.createdAt).getTime()),
                flow: creditGrant.type === creditTransactionTypes.SUBSCRIPTION_GRANT ? "SUBSCRIPTION_CHARGE" : "CREDIT_PURCHASE",
                reference: creditGrant?.metadata?.providerOrderId || creditGrant?.metadata?.providerPaymentId || creditGrant.referenceKey,
                accountId: creditGrant.userId || "",
                description: `${creditGrant.amount} credits`,
                grossMinor: Number(creditGrant?.metadata?.amountMinor) || 0,
                currency: creditGrant?.metadata?.currency || ""
            });
        }

        for (const deckPurchase of localSettlements.deckPurchases)
        {
            journalRows.push
            ({
                date: FinancialReconciliationService.buildDayKey(new Date(deckPurchase.purchaseDate).getTime()),
                flow: "PAID_DECK_PURCHASE",
                reference: deckPurchase.providerOrderId || "",
                accountId: deckPurchase.userId || "",
                description: `Deck ${deckPurchase.deckId}`,
                grossMinor: Number(deckPurchase.amountMinor) || 0,
                currency: deckPurchase.currency || ""
            });
        }

        for (const capturedDeal of localSettlements.capturedDeals)
        {
            journalRows.push
            ({
                date: FinancialReconciliationService.buildDayKey(new Date(capturedDeal.capturedAt).getTime()),
                flow: "ORGANIZATION_CREDIT_DEAL",
                reference: capturedDeal.providerOrderId || capturedDeal.id || "",
                accountId: capturedDeal.targetId || "",
                description: `${capturedDeal?.additionalData?.credits || 0} pool credits`,
                grossMinor: Number(capturedDeal.amountMinor) || 0,
                currency: capturedDeal.currency || ""
            });
        }

        // Reversals are money going OUT, carried as a negative gross so the
        // export sums to the net figure the bank will show rather than to the
        // gross this server took.
        const reversals = await database
            .collection(DatabaseConstants.PAYMENT_REVERSALS_COLLECTION)
            .find({ reversedAt: { $gte: new Date(window.startMilliseconds), $lt: new Date(window.endMilliseconds) } })
            .toArray();

        for (const reversal of reversals)
        {
            journalRows.push
            ({
                date: FinancialReconciliationService.buildDayKey(new Date(reversal.reversedAt).getTime()),
                flow: "REVERSAL",
                reference: reversal.refundId || "",
                accountId: "",
                description: `Reversal of ${reversal.flow} order ${reversal.providerOrderId || ""}`,
                grossMinor: -(Number(reversal.amountMinor) || 0),
                currency: reversal.currency || ""
            });
        }

        journalRows.sort((firstRow, secondRow) => firstRow.date.localeCompare(secondRow.date));

        return journalRows;
    }
}

module.exports = FinancialReconciliationService;
