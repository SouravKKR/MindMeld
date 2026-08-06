# Payment Incident Runbook

What to do when a customer says **"I paid and nothing happened."**

This is the runbook the Razorpay Integration & Security Handbook (Part 11) requires before
go-live. It covers the one-time flows (credit top-ups, paid-deck purchases, admin credit
deals) and recurring plan subscriptions. Razorpay is the sole payment provider.

Audience: whoever is on call. It assumes shell access to the base node and `mongosh`, and
read access to the payment provider's dashboard.

---

## 0. Before you touch anything

**Do not re-run a checkout, and do not manually grant credits as a first move.** Every
settlement path in this system is idempotent, which means a genuine payment can still
settle correctly minutes after the customer complained — the webhook may simply be retrying.
Granting by hand while a retry is in flight is how a customer ends up paid once and
provisioned twice.

Establish the facts first. The whole of §1 is read-only.

---

## 1. Triage — find out what actually happened

You need three identifiers. The customer can usually supply the first; the rest you derive.

| Identifier | Looks like | Where to get it |
|---|---|---|
| Provider order id | `order_abc123` | Customer's receipt e-mail, or §1.2 below |
| Provider payment id | `pay_abc123` | Provider dashboard |
| CogniumLearn user id | UUID | `users` collection, by e-mail |

### 1.1 Did the money actually move?

Open the provider dashboard and find the payment.

- **No payment at all** → the customer never completed checkout. Nothing to fix; they were
  not charged. Confirm this to them explicitly, because an abandoned modal often *feels*
  like a completed payment (see the handbook §4.4 — dismissal is not failure, and users do
  close the modal after a UPI approval).
- **Payment `authorized` but not `captured`** → money is on hold and has **not** reached us.
  Razorpay auto-refunds an uncaptured payment after its window. Check that auto-capture is
  enabled (Dashboard → Account & Settings → Payment Capture). This is finding **C5**.
- **Payment `captured`** → the money is ours and the customer is owed something. Continue.
- **Payment `refunded`** → already reversed. Note that entitlement revocation on refund is
  **not yet implemented** (findings F3/G1), so the customer may still hold what they paid
  for. Escalate rather than improvising.

### 1.2 Find our own record of the order

```javascript
// mongosh — replace with the real order id
db.pendingCreditOrders.findOne({ providerOrderId: "order_abc123" })   // credit top-up
db.pendingOrders.findOne({ providerOrderId: "order_abc123" })         // paid-deck purchase
db.creditDealPayments.findOne({ providerOrderId: "order_abc123" })    // admin credit deal
db.userSubscriptions.findOne({ providerSubscriptionId: "sub_abc123" })// plan subscription

// If you only have the user's e-mail, work forward from the user id:
db.pendingCreditOrders.find({ userId: "<uuid>" }).sort({ createdAt: -1 }).limit(5)
```

Interpret `status`:

- **`CONSUMED`** → we settled it. The customer *has* been provisioned; the problem is
  elsewhere (client cache, wrong account, sync). Jump to §3.
- **`PENDING`** → we created the order but never settled it. This is the real case. Go to §2.
- **No row at all** → we have no record of an order the provider captured. Go to §2.4.

### 1.3 Did the webhook arrive?

```javascript
// Every accepted delivery is recorded, with the raw signed body.
db.webhookEvents.find({ eventType: /payment/ }).sort({ receivedAt: -1 }).limit(20)
db.webhookEvents.findOne({ eventId: "<x-razorpay-event-id from the dashboard>" })
```

Cross-check against the provider dashboard's own delivery log for that event.

- **Delivered, and present here** → we received and accepted it. If the order is still
  PENDING, settlement threw; check the logs for that window.
- **Delivered, but absent here** → we rejected it, almost certainly on signature. Check the
  admin **Alerts** tab for *"Razorpay webhook signature verification failed"*. The usual
  cause is a webhook-secret mismatch after an environment change.
- **Never delivered** → provider-side or network. The order will not self-heal today; see
  §2.3.

### 1.4 Check the alerts tab

Two alerts are raised automatically and both are directly relevant:

- **"Razorpay webhook signature verification failed"** → wrong `RAZORPAY_WEBHOOK_SECRET`,
  or a forgery attempt. Note that we ack `200` to stop retries, so the provider dashboard
  will show these as *successful* deliveries — this alert is the only signal.
- **"Captured Razorpay payment with no matching local order"** → someone was charged and we
  cannot say what for. Treat as an incident (§2.4).

---

## 2. Repair

### 2.1 The order is PENDING and the payment is captured

This is the ordinary case and the safe fix is to **let the existing idempotent path run**.

1. Ask the customer to reload the app and, if the flow supports it, return to the purchase
   screen. The browser verify leg settles it.
2. If that is not possible, replay the webhook from the provider dashboard (Razorpay →
   Webhooks → the event → Replay). Replays are available for roughly 15 days.

Both paths converge on the same completion service and are safe to run repeatedly: the
credit ledger's unique `referenceKey`, the pending order's `PENDING → CONSUMED` transition
and the paid-deck grant claim each independently prevent a double grant.

> **Note.** A scheduled reconciliation job that would do this automatically is **not yet
> implemented** (finding §7.3). Until it is, this step is manual and someone has to notice.

### 2.2 Settlement is throwing

If the delivery is recorded but the order stays PENDING, settlement is failing partway.

```bash
# On the base node
journalctl -u cogniumlearn-dock --since "2 hours ago" | grep -i -E "razorpay|settle|webhook"
```

Look for `Paid-deck settlement failed for order ...`. The paid-deck path releases its grant
claim on failure, so a later retry can succeed once the underlying fault is fixed. Fix the
fault, then replay the webhook (§2.1).

### 2.3 The webhook was never delivered

Confirm the endpoint is reachable from outside, then replay:

```bash
curl -i -X POST https://learn.cogniumlabs.io/Webhooks/Razorpay \
     -H "Content-Type: application/json" -d '{}'
# Expect 200 with an INVALID_SIGNATURE reason — that proves reachability
# AND that verification is rejecting unsigned bodies. Anything else is the bug.
```

Then check the webhook URL registered in the provider dashboard actually points at this
environment. Test and Live mode have **separate** webhook configurations and separate
secrets; a wrong-mode secret fails every single delivery.

### 2.4 Captured payment with no local order

Escalate — do not self-serve. This means one of:

- The local order row was never written. The order is created remotely *before* the local
  row is written (finding §3.3), so a crash in that window produces exactly this.
- A cloned checkout is using our public `key_id` (finding **B8**). Payments made this way
  cannot provision anything, but the customer was genuinely charged.
- Environment drift — a production payment landing against a non-production database.

Record the order id, payment id, amount and customer, then decide deliberately between a
manual grant and a refund. Both are manual today.

### 2.5 Manual grant — last resort

Only after §1 has established that the payment is **captured**, the order is **PENDING**, and
§2.1 has failed. Grant through the admin credit-grant tooling (Admin → Credits), never by
editing the `users` document directly — the ledger is the source of truth for balances and a
direct edit desynchronises it from the transaction history.

Afterwards, mark the pending row consumed so a later retry does not grant a second time:

```javascript
db.pendingCreditOrders.updateOne(
    { providerOrderId: "order_abc123", status: "PENDING" },
    { $set: { status: "CONSUMED", consumedAt: new Date() } }
);
```

Record what you did and why, in the support ticket.

---

## 3. The order settled but the customer still cannot see it

The money side is fine; this is a delivery problem.

- **Credits** — check the balance and the ledger:
  ```javascript
  db.creditTransactions.find({ referenceKey: "creditPurchase:order_abc123" })
  ```
  A row here means the grant applied. If the balance disagrees with the ledger, escalate:
  that is a ledger integrity problem, not a payment one.
- **Paid decks** — check `deckLicenses` for the user and deck. A licence with no content is
  a seeding failure, not a payment failure.
- **Plans** — check `additionalData.plan` and `planExpiresAt` on the user. Remember an
  expired paid plan degrades to FREE at read time even if the stored field still says
  otherwise.
- **Wrong account.** Users with both Google sign-in and e-mail OTP can hold two accounts.
  Search `users` by e-mail and confirm the purchase is on the account they are logged into.

---

## 4. Escalation

Escalate immediately, rather than repairing, when:

- More than one customer reports the same symptom within an hour — this is systemic.
- Any amount mismatch appears anywhere. It means either an attack or a serious pricing bug.
- A refund was issued that nobody approved (findings **F4** / **E8**).
- A captured payment has no local order (§2.4).
- The alerts tab shows a burst of signature failures — either the secret is wrong in this
  environment, or someone is probing the webhook endpoint.

---

## 5. Configuration reference

| Variable | Purpose |
|---|---|
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | API auth, and the HMAC key for **payment** signatures |
| `RAZORPAY_WEBHOOK_SECRET` | HMAC key for **webhook** signatures — a different value with a different purpose |
| `RAZORPAY_WEBHOOK_SECRET_PREVIOUS` | Accepted alongside the current secret during a rotation window, because in-flight retries were signed with the old one. Clear it once 24 hours have passed. |

The server refuses to boot on a key-mode mismatch — a test key in production, or a live key
outside it (`PaymentEnvironmentValidator`). If Dock exits immediately after a deploy with a
`FATAL` payment line, that is this check, and the env file is wrong.

Verify the signature surface at any time, without a server or a database:

```bash
cd Dock && node VerifyRazorpaySignatures.mjs
```

---

## 6. Known gaps that shape this runbook

These are open findings from the Razorpay handbook compliance report. Each one is why a step
above is manual:

- **§8.3 / F7** No refund tooling; refunds are provider-dashboard only and fall outside the
  admin audit trail. This product does not issue refunds (`RefundPolicy`), so reaching a
  refund always means something happened outside the application.
- **Segregation of duties.** The person who reconciles is the person who can grant credits
  by hand. See [Payment Reconciliation Ownership §1](PaymentReconciliationOwnership.md).

Closed since this runbook was written, and worth knowing because they change what you should
do first:

- **§7.3** Stuck orders now settle themselves — `PendingPaymentReconciler` sweeps every 30
  minutes and asks the provider what really happened, so §2.1 is a way to force what is
  already scheduled rather than the only route.
- **C4** `SettlementAmountGuard` now asserts the captured amount against the ordered amount
  on every settlement path, including the reconciler's.
- **F3 / G1** A refund now revokes automatically across all four flows — credit top-up,
  paid-deck basket, organization credit deal and subscription charge — through
  `PaymentReversalService`. Credits are clawed back to a floor of zero and any unrecoverable
  shortfall is alerted rather than forced through.

---

## 7. Reconciliation is a different job

This runbook is for **one customer's payment that went wrong**. It is not how you find out
whether the books balance.

That is a scheduled, automated daily check plus a monthly human pass against the bank, with
a named owner — see [Payment Reconciliation Ownership](PaymentReconciliationOwnership.md).
If you arrived here from a `FINANCIAL_RECONCILIATION` alert, read §4 of that document
first: it tells you which breaks are bookkeeping and which one
(`PROVIDER_PAYMENT_WITHOUT_LOCAL_RECORD`) is a customer-facing incident that belongs back
here in §2.4.
