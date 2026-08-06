# Payment Page Script Inventory

The inventory PCI DSS 6.4.3 asks for, and the evidence for the Razorpay handbook's
**B5** control (*no ad, tag-manager, chat or session-replay scripts on the payment path*).

Every script that can execute on a page where a payment is taken is listed below, with
who authorised it and why it is necessary. A script that is not in this list must not be
added to a payment surface without adding it here first.

---

## What counts as a payment surface

CogniumLearn is a single-page application, so "page" means *the document a checkout runs
in*, not a URL. The checkout widget is opened by
[PaymentCheckout.js](../../Main/Globals/Classes/Payments/PaymentCheckout.js) from four
flows:

| Flow | Entry point |
|---|---|
| Credit top-up | `Main/Globals/Classes/Credits/CreditPurchaseFlow.js` |
| Paid-deck purchase | `Main/Globals/Classes/PaidDeckPurchaseFlow.js` |
| Organization credits | `Main/Pages/Organization/Components/OrganizationCreditsSection.js` |
| Admin credit deal | `Main/Pages/AdminPanel/Components/DealPaymentEditor.js` |

Card data itself never reaches this document. Razorpay Standard Checkout renders in a
hosted iframe on Razorpay's own origin, so the inventory below governs what shares the
*parent* document — which is what a skimmer would need in order to overlay a fake form or
read one.

---

## Authorised scripts

### Remote

| Script | Origin | Why it is necessary | Pinned? | Monitored? |
|---|---|---|---|---|
| Razorpay Standard Checkout | `checkout.razorpay.com` | The payment widget itself. There is no payment without it. | **No** — deliberately. Razorpay ships fixes to this file continuously; an SRI hash would break checkout the moment they did. | **Yes** — re-fetched and hashed daily by [ScriptIntegrityMonitor](../../Dock/Globals/Classes/Security/ScriptIntegrityMonitor.js); a change raises an admin alert. |

That is the entire remote list. It is one entry by design.

**A remote script listed here must also appear in `ScriptIntegrityMonitor.MONITORED_REMOTE_SCRIPTS`.**
An entry in this table with no entry there is a script nobody is watching.

### First-party

Everything else on the document is served from this origin: the application bundle, KaTeX,
jsPDF, SheetJS and the Web Components. These are same-origin, so Subresource Integrity adds
nothing an attacker with write access to the origin could not also update — they could
rewrite the `integrity` attribute in the same write.

They are covered instead by a build-time hash manifest. `Common/Scripts/GenerateScriptIntegrityManifest.js`
runs as the final build step and records a sha384 hash of every `.js` / `.mjs` / `.html`
file the build emits into `Dock/Static`, writing `Dock/ScriptIntegrityManifest.json` (kept
*outside* the served tree, so it is neither publishable nor self-referential).
`ScriptIntegrityMonitor` re-hashes the served tree against it at boot and daily. Because the
manifest is written on a different machine at a different time from any tampering, rewriting
a served bundle does not retroactively change what the build recorded — which is the
property SRI cannot give a same-origin file.

Nothing legitimate rewrites `Dock/Static` after a deploy, so a changed, missing or
*unexpectedly added* file is raised as an ERROR alert, not a warning.

---

## Explicitly excluded

| Category | Status |
|---|---|
| Tag managers | None. No Google Tag Manager, Segment or equivalent anywhere in the application. |
| Session replay | None. No FullStory, Hotjar, LogRocket or equivalent. |
| Chat widgets | None. Support is a first-party ticket form. |
| Error trackers | None. Errors are reported to the first-party `/Logs` endpoint, so no payment payload can reach a third-party tracker. |
| Advertising | **Removed from the payment path** — see below. |

---

## Advertising: what changed and what remains

Google AdSense used to be a `<script>` tag in `Main/index.html`. In a single-page
application that meant the advertising script — and everything AdSense pulls in at runtime
(`googletagservices`, `doubleclick`, `adtrafficquality`) — was resident in the same document
as every checkout, with full DOM access to it.

It is now injected at runtime by
[AdvertisementLoader](../../Main/Globals/Classes/Advertising/AdvertisementLoader.js), under
two rules:

1. **Home page only.** `loadForPage` refuses any tag name other than `home-page`, and only
   `HomePage` calls it.
2. **Never while a checkout is open.** `PaymentCheckout.open` raises a suppression flag for
   the whole duration of the widget, in a `finally` block so that paid, declined, dismissed
   and thrown all lower it again.

**What this fixes.** A user who reaches a purchase without passing through the home page —
a paid-deck deep link, a credits dialog opened after a fresh load, anything entered from
the login page — never loads the advertising script at all. That is the majority of
direct-to-purchase traffic, and it is the case where an attacker would have the clearest
run at a payment form.

**What it does not fix.** A script cannot be un-injected. A user who browses the home page
and *then* opens a checkout without a full page reload still has AdSense resident in that
document. Closing that would require forcing a navigation boundary on the way into
checkout, which is a worse trade than the risk it removes.

**Residual risk, stated plainly:** for a session that visited the home page first, the
advertising origins retain DOM access to the document hosting the checkout iframe. They
cannot read card data — that is inside Razorpay's iframe, on Razorpay's origin, and is
cross-origin to them — but they could in principle overlay the page. The mitigations that
remain in force are `Permissions-Policy: payment=()`, `frame-ancestors 'self'`, and the
enforced Content-Security-Policy described below.

---

## Content-Security-Policy interaction

The strict policy is **enforced** — it is the default, and the permissive predecessor
survives only as a `CONTENT_SECURITY_POLICY_MODE=compatible` escape hatch. So `script-src`
now genuinely blocks: an injected inline `<script>` on a checkout document does not run, and
neither does a script from an origin outside the allow-list.

The advertising origins stay in
[`SecurityHeaders.STRICT_SCRIPT_ORIGINS`](../../Dock/Endpoints/Plugins/SecurityHeaders.js)
because AdSense still legitimately loads on the home page, and `script-src` is a
document-wide directive rather than a per-route one.

The gating above does not by itself tighten the policy. What it changes is the *blast
radius*: the set of origins with script access to a payment document is now the Razorpay
widget alone for any session that entered directly.

Adding a remote script to a payment surface therefore now takes **three** coordinated
changes, and skipping any one of them is a visible failure rather than a silent gap: this
table, `STRICT_SCRIPT_ORIGINS` (or the script is blocked), and
`ScriptIntegrityMonitor.MONITORED_REMOTE_SCRIPTS` (or it runs unwatched).

---

## Review triggers

Re-check this inventory when any of the following happens:

- a new remote `<script>` is added to `Main/index.html` or `Main/login.html`;
- a new checkout flow is added (it must go through `PaymentCheckout`, which is what makes
  the suppression universal);
- `AdvertisementLoader.loadForPage` gains a caller other than `HomePage`;
- an analytics, support or monitoring vendor is introduced.
