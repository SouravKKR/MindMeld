# Payment Reconciliation — Procedure and Ownership

Who checks that the money CogniumLearn believes it took is the money that actually reached
the bank, how often, and what happens when it does not.

This document exists because reconciliation is the one payment control that **cannot be
finished in code**. The server can compare its own records against Razorpay's API and can
hold a slot for the accounting figure, and it does both automatically (see §2). It cannot
open a bank statement, and it cannot be accountable. Those parts need a named person, and
an unnamed procedure is the same as no procedure.

Companion documents: [Payment Incident Runbook](PaymentIncidentRunbook.md) for a single
customer's failed payment, and [Payment Page Script Inventory](PaymentPageScriptInventory.md)
for the script-integrity controls.

---

## 1. Owner

| Role | Person | Contact |
|---|---|---|
| **Settlement reconciliation owner** (accountable) | Sourav K K R | developer@cogniumlabs.co.in |
| Backup / escalation | Same, until a second person exists | — |

Effective **2026-08-05**.

This is a single-operator business today, so the owner and the engineer are the same
person. That is a real limitation and is stated rather than disguised: there is no
segregation of duties, so the compensating control is that every figure below is recorded
in the application with a `recordedBy` stamp and every admin request is written to the
admin audit trail. **When a second person joins, this table changes before anything else
does** — the person who reconciles should not be the person who can grant credits by hand.

Changing the owner means editing this table in the same commit as the handover. An owner
who left is worse than no owner, because the report still looks owned.

---

## 2. What the server does automatically

`FinancialReconciliationService` runs every six hours and reconciles each closed UTC day
once, three hours after it closes (so in-flight webhook retries have finished converging).
For each day it produces one stored report in `financialReconciliations`, visible at
`GET /Admin/Reconciliation/List`, comparing three bodies of evidence:

1. **Razorpay** — every payment the provider recorded in the window, pulled from the
   payments API. This is the spine of the check.
2. **The money records** — `purchases`, `creditDealPayments`, and the pending-order rows.
3. **The ledger** — `creditTransactions` and `organizationCreditTransactions`: what was
   actually handed out in return.

Any disagreement is stored as a typed `ReconciliationBreak` and raises an ERROR alert in
the admin Alerts tab. **A day with breaks is not signed off until the breaks are resolved
or explained.**

What the server cannot do is confirm that Razorpay's number equals the bank's number. That
is §3.

> **UTC, deliberately.** A "day" here is a UTC day, because every stored timestamp and
> every Razorpay epoch is UTC. In IST that means a day runs 05:30 to 05:30. Do not compare
> a UTC day against an IST bank-statement day — that mismatch is the single most likely
> cause of a false break, and the fix is to take the bank window from §3.2, not to adjust
> the server.

---

## 3. The monthly pass — what the owner actually does

**Cadence:** monthly, within five working days of month end. Razorpay settles on a T+2
cycle, so a month's last settlements land in the first days of the next one; running the
pass earlier reconciles against money that has not arrived yet.

**Time required:** under an hour for a normal month.

### 3.1 Check the automated reports first

Open `GET /Admin/Reconciliation/List` (admin panel) and confirm:

- every day of the month has a report — a missing day means the server was down and that
  day must be reconciled by re-running the sweep;
- `providerAvailable` is true on all of them — a run of `PROVIDER_UNREACHABLE` days is a
  gap in coverage, not a clean month;
- `breakCount` is zero. If not, work each break through the incident runbook first. Do not
  proceed to the bank comparison with unresolved breaks; you will be reconciling against a
  number you already know is wrong.

### 3.2 Compare the three external numbers

| Number | Where it comes from |
|---|---|
| **A — Provider gross** | Razorpay dashboard → Transactions → the month's captured total |
| **B — Bank credits** | The settlement account's statement: sum of Razorpay settlements credited in the period |
| **C — Fees and refunds** | Razorpay settlement report: commission, GST on commission, refunds and chargebacks |

The identity to check is **A − C = B**, within the tolerance in §3.4.

Razorpay settles net of fees, so A will never equal B on its own. A month where A − C does
not equal B means either a settlement has not landed (check the settlement status — a held
or delayed settlement is common and self-resolving) or money has moved that neither system
accounts for, which is §4.

### 3.3 Feed the accounting figure back in

Export the server's own journal for the month:

```
GET /Admin/Reconciliation/ExportJournal?from=YYYY-MM-DD&to=YYYY-MM-DD
```

That is a CSV with one row per settled transaction and reversals carried as negative gross,
in the shape the accounting system imports. Reconcile it against the accounting ledger,
then post the accounting system's figure back per day:

```
POST /Admin/Reconciliation/RecordAccountingTotals
{ "dayKey": "YYYY-MM-DD", "grossMinor": 123400, "currency": "INR", "source": "<accounting system>", "note": "monthly pass" }
```

`grossMinor` is in **minor units** (paise). The day is re-reconciled the moment it is
posted, so a disagreement surfaces while you are still looking at it, and the report
records who entered it. **This posting is the sign-off.** A month whose days have
`accountingConfirmed: false` has not been reconciled against accounting records, whatever
else is green.

### 3.4 Tolerance

**Zero.** Every amount in this system is an integer in minor units, so there is no rounding
to absorb and any tolerance would only hide a real difference. A discrepancy of one paisa is
investigated the same as one of a lakh — the amount tells you the urgency, not whether it
counts.

The one legitimate reason for A and the server's internal gross to differ is timing at a
period boundary (a payment captured 23:59 UTC on the last day, settled locally after
midnight). Confirm it by looking for the same amount on the adjacent day's report; do not
write it off without finding it.

---

## 4. When it does not reconcile

1. **Do not adjust the books to match.** Find the transaction. The break's `reference`
   field is the provider order, payment or refund id — search it in the Razorpay dashboard.
2. Work the individual transaction through the [Payment Incident Runbook](PaymentIncidentRunbook.md).
   Most breaks are one customer's failed provisioning, and that runbook already covers it.
3. **A `PROVIDER_PAYMENT_WITHOUT_LOCAL_RECORD` break is the serious one.** It means money
   arrived that this server has no record of, so a customer paid and got nothing and does
   not necessarily know to complain. Treat it as a customer-facing incident, not a
   bookkeeping entry.
4. If money is missing rather than misfiled, that is a fraud or a provider incident, not a
   reconciliation break: preserve the evidence, raise it with Razorpay support the same day,
   and do not close the month.
5. Record the resolution in the day's `note` when re-posting the accounting totals, so the
   next reader sees why a day that looked wrong is now signed off.

---

## 5. Review triggers

Re-read this document when:

- a second person joins and duties can be segregated (§1 changes first);
- a payment provider is added or replaced — the whole of §3.2 assumes Razorpay's net
  settlement model;
- a new flow that takes money is added, which means it must also appear in the journal
  export and in `FinancialReconciliationService`;
- the business starts settling into more than one bank account or currency, at which point
  A − C = B becomes a per-account identity rather than one sum.
