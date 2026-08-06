# Payment Adversarial Checklist

The handbook's Part 10.5. The functional matrix (`Dock/VerifyPaymentSettlementReliability.mjs`)
proves the integration **works**; this one proves it **cannot be abused**.

Every case carries a verdict derived from the current source:

| Verdict | Meaning |
|---|---|
| **AUTOMATED** | Asserted by a harness. The command is named; run it. |
| **VERIFIED** | Confirmed by reading the code. Cited file:line. Not yet automated. |
| **OPEN** | Known to fail, or not implemented. Linked to its audit finding. |
| **MANUAL** | Needs a running server, a browser or a provider dashboard. |

Harnesses:

```bash
cd Dock
node VerifyRazorpaySignatures.mjs            # signature + key-mode surface
node VerifyPaymentSettlementReliability.mjs  # settlement reliability matrix
node VerifyPaymentAdversarial.mjs            # the abuse cases below
node VerifyPaymentLifecycle.mjs             # receipts, failed attempts, reversals, ad gating
```

---

## Tampering

| # | Case | Verdict | Evidence |
|---|---|---|---|
| T1 | `POST /orders` with an `amount` field → ignored or rejected | **AUTOMATED** | No handler reads an amount from a body; adversarial harness posts one and asserts the charge is unchanged |
| T2 | `POST /orders` with another tenant's `accountId` → rejected | **VERIFIED** | Identity comes from `session.getUserId()` only — InitiateCreditPurchase.js:31, InitiatePurchase.js:61 |
| T3 | `seats`/`credits` of `-1`, `1e12`, `1.5` → rejected | **AUTOMATED** | `Number.isInteger` + minimum (InitiateCreditPurchase.js:42-63) and `PaymentProvider.isChargeableAmount` |
| T4 | Modify `amount` in Checkout options via devtools → charged amount unchanged | **MANUAL** | Razorpay enforces the amount recorded on the order; the widget's value is display-only |
| T5 | Swap the widget's returned `order_id` → server uses its own | **VERIFIED** | RazorpayCheckout.js:81-84 discards the widget's `razorpay_order_id` by design |

## Forgery and replay

| # | Case | Verdict | Evidence |
|---|---|---|---|
| F1 | `POST /verify` with random values → 400, nothing provisioned | **AUTOMATED** | `VerifyRazorpaySignatures.mjs` §2 |
| F2 | A valid triple from a ₹1 order replayed against an expensive open order → rejected | **AUTOMATED** | `VerifyRazorpaySignatures.mjs` §4 (C2) |
| F3 | Replay a valid triple as a different logged-in user → rejected | **VERIFIED** | Ownership asserted before verification — VerifyCreditPurchase.js:54-59, VerifyPurchase.js:55-60 |
| F4 | Replay a valid triple twice as the same user → provisioned once | **AUTOMATED** | Reliability harness §3/§4; ledger `referenceKey` + `PENDING→CONSUMED` CAS |
| F5 | `razorpay_signature` as `null`, `[]`, `{}`, `true` → 400, no exception leaked | **AUTOMATED** | `VerifyRazorpaySignatures.mjs` §3. **Was a real defect (C1)** — `{}` threw a 500 until the type guard landed |

## Webhooks

| # | Case | Verdict | Evidence |
|---|---|---|---|
| W1 | Unsigned webhook POST → not processed | **AUTOMATED** | Reliability harness §10 |
| W2 | Correctly signed webhook, replayed → processed once | **AUTOMATED** | Reliability harness §3, event-id gate |
| W3 | Signed webhook whose amount ≠ the order → not fulfilled, alert raised | **AUTOMATED** | Reliability harness §7 (C4) |
| W4 | Signed webhook with a substituted currency → not fulfilled | **AUTOMATED** | Reliability harness §8 (A2) |
| W5 | `<script>` in `notes` → renders escaped in the admin UI | **VERIFIED** | Only scalar ids are extracted (HandleRazorpayWebhook.js); the invoice escapes every field (GetPurchaseInvoice.js:160-172) |
| W6 | `__proto__` keys in the payload → no behavioural change | **AUTOMATED** | Reliability harness §10 asserts `Object.prototype` is unpolluted |
| W7 | 5 MB body → rejected before HMAC computation | **OPEN** | No body-size limit precedes the HMAC (finding D4) |
| W8 | Unknown event type → 200, logged, no crash | **AUTOMATED** | Reliability harness §10 |
| W10 | `payment.failed` → recorded with the provider's error codes, nothing provisioned | **AUTOMATED** | `VerifyPaymentLifecycle.mjs` §3 |
| W11 | A burst of declines on one account → alert | **AUTOMATED** | `VerifyPaymentLifecycle.mjs` §4 (F1) |
| W9 | Captured payment with no local order → acked, nothing granted, alert | **AUTOMATED** | Reliability harness §9 (B8) |

## Concurrency

| # | Case | Verdict | Evidence |
|---|---|---|---|
| C1 | Two simultaneous `/verify` calls with the same triple → one fulfilment | **AUTOMATED** | Reliability harness §5 asserts the balance moved once |
| C2 | `/verify` and the webhook arriving together → one fulfilment | **VERIFIED** | Both call the same completion service; paid decks serialise on `tryClaimForGrant` (PendingOrderQueryEngine.js:19-25) |
| C3 | The same single-use coupon from 10 concurrent requests → one redemption | **VERIFIED** | Atomic `claimRedemptionSlot` + unique `(couponId, userId)` — CouponCheckoutService.js:52-58 |

## Secrets and configuration

| # | Case | Verdict | Evidence |
|---|---|---|---|
| S1 | Grep the production bundle for `rzp_`, key secret, webhook secret → no hits | **MANUAL** | Only `keyId` is ever sent to the browser. Note: the bundle is obfuscated, so a naive grep proves little — read the source instead |
| S2 | Grep logs for secrets after an end-to-end payment → no hits | **VERIFIED** | Logs carry ids and enum reasons only; raw payloads are never logged |
| S3 | Boot with a test key on a deployed production node → refuses to start | **AUTOMATED** | `VerifyRazorpaySignatures.mjs` §9 (E6) |
| S4 | Boot with a live key outside production → refuses to start | **AUTOMATED** | `VerifyRazorpaySignatures.mjs` §9 |
| S5 | Ask for a retired provider → clear error, not a silent fallback | **AUTOMATED** | `VerifyRazorpaySignatures.mjs` §9 |

## Business logic

| # | Case | Verdict | Evidence |
|---|---|---|---|
| B1 | Change the plan in another tab after the order is created, then pay → provisioned for what was **ordered** | **AUTOMATED** | Adversarial harness mutates pricing between initiation and settlement (A8) |
| B2 | Pass an internal or zero-priced `planId` → rejected as not purchasable | **VERIFIED** | `PlanMetadata.isPaidTier` + positive-price guard — SubscriptionInitiationHelper.js:24-42 (A9) |
| B3 | Call the provisioning endpoint directly with no payment → rejected | **VERIFIED** | Completion services have no route; they are plain modules (B9) |
| B4 | Request a refund twice concurrently → refunded once | **N/A** | No refund can be issued at all: `PaymentProvider.refund()` refuses for every provider and no subclass overrides it. Asserted in `VerifyPaymentLifecycle.mjs` §5 |
| B5 | Refund with an altered destination account → destination ignored | **N/A** | Same — there is no refund call to redirect |
| B6 | Refund outside the policy window by replaying an older request → rejected | **N/A** | Same. The published policy is that refunds are not offered |
| B7 | An externally-issued refund (chargeback / dashboard) leaves the entitlement live | **AUTOMATED** | It does not: `refund.processed` claws back credits and revokes licences, and alerts. `VerifyPaymentLifecycle.mjs` §6 |
| B8 | A redelivered refund event claws back twice | **AUTOMATED** | Keyed on the refund id through the ledger's referenceKey. `VerifyPaymentLifecycle.mjs` §6 |
| B9 | An **unsigned** refund revokes someone's access | **AUTOMATED** | Refused by the same HMAC gate as every other event, asserted explicitly because this one destroys entitlement |

## Access control

| # | Case | Verdict | Evidence |
|---|---|---|---|
| A1 | Fetch another tenant's invoice / receipt / payment record → 403 or 404 | **VERIFIED** | Scoped in the same statement that selects — `findOne({ id, userId })`, GetPurchaseInvoice.js:49-57 (G4) |
| A2 | Enumerate sequential ids on payment reads → no data, alert raised | **VERIFIED** for enumeration (ids are UUIDs, PendingCreditOrderQueryEngine.js:82); **OPEN** for alerting |
| A3 | Fetch a receipt URL while logged out → rejected | **VERIFIED** | Session required before any lookup — GetPurchaseInvoice.js:26-31 |

## Injection

| # | Case | Verdict | Evidence |
|---|---|---|---|
| I1 | SQL/NoSQL payloads in `order_id`, `receipt`, coupon code, `notes` → rejected, no DB error text | **AUTOMATED** | Adversarial harness sends `{$ne: null}` and `{$gt: ""}` as order ids. Every lookup asserts `typeof === "string"` first |

## Client

| # | Case | Verdict | Evidence |
|---|---|---|---|
| L1 | CSP present and blocks an injected inline script on the checkout page | **OPEN** | The **enforced** profile still allows `'unsafe-inline'`; the strict profile is report-only (B4) |
| L6 | Advertising script present on a payment surface | **AUTOMATED** | Removed from `index.html`; `AdvertisementLoader` loads only for `home-page` and refuses while a checkout is open. `VerifyPaymentLifecycle.mjs` §7. Residual SPA case documented in `Common/ReadmeFiles/PaymentPageScriptInventory.md` |
| L2 | Checkout page not framable | **VERIFIED** | `X-Frame-Options: SAMEORIGIN` + `frame-ancestors 'self'` — SecurityHeaders.js |
| L3 | Session cookies `HttpOnly; Secure; SameSite` | **VERIFIED** | HandleLoginCallback.js:273-280 |
| L4 | No analytics / session-replay / chat scripts on the payment path | **VERIFIED** | Main/index.html carries no such tag |
| L5 | `Permissions-Policy` denies `payment` | **VERIFIED** | SecurityHeaders.js `DEFAULT_PERMISSIONS_POLICY` |

---

## Open items, and why each is open

- **W7 body-size limit (D4)** — a large body is hashed before it can be rejected. Low
  severity: verification is cheap and the global rate limiter applies. Fix with a length
  check before the HMAC.
- **B4/B5/B6 refund abuse** — closed as not-applicable rather than open. CogniumLearn does
  not offer refunds, and that is enforced in code rather than only in the terms: every
  provider inherits a refusing `refund()` and none overrides it, so there is no path to
  abuse. The related risk did NOT disappear with the policy — it moved. A chargeback or a
  dashboard refund can still reverse money without the application's consent, so B7/B8/B9
  above cover the case that actually remains.
- **L1 enforced CSP (B4)** — the tightened policy exists and ships report-only. Promote it
  once the violation stream is clean; this is a config change plus a watch period.
- **A2 enumeration alerting** — identifiers are UUIDs so enumeration is impractical, but
  nothing alerts on a burst of 403/404s.

## What this checklist is not

It does not replace an external penetration test, and several MANUAL rows genuinely need a
browser and a provider dashboard. It also cannot prove the absence of a vulnerability — a
passing row means one specific abuse was attempted and refused, nothing broader.
