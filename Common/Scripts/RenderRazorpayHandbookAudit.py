"""
Renders the Razorpay Integration & Security Handbook compliance report to a
themed PDF.

The audit specification is Common/Audits/RazorpayHandbookComplianceRequirements.txt
and the visual theme is Common/Reports/PdfTheme.md; keep all three in sync.

Every finding below was re-derived from the working tree in full, per the re-run
discipline in Common/Audits/Audit.txt. The previous PDF was deleted before this
pass began and no row was carried forward, restated or "updated" from it. That
discipline earned its keep this time: a payment flow that did not exist at the
last pass — the organization credit deal — has shipped without several of the
controls the older flows carry, and a diff-based re-read anchored on where the
risk used to live would have missed all of it.

Run with the repo's Python venv:
    Agent/.venv/Scripts/python.exe Common/Scripts/RenderRazorpayHandbookAudit.py
"""

import os
from datetime import datetime
from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import (
    BaseDocTemplate,
    PageTemplate,
    Frame,
    Paragraph,
    Spacer,
    LongTable,
    Table,
    TableStyle,
    Flowable,
)


# --- Theme palette (Common/Reports/PdfTheme.md) ---------------------------

TEAL_TITLE = colors.HexColor("#134E48")
TEAL_HEADER = colors.HexColor("#1A6B62")
TEAL_TABLE_HEAD = colors.HexColor("#1C5F58")
GOLD_ACCENT = colors.HexColor("#E7A33C")
TEXT_BODY = colors.HexColor("#353D44")
TEXT_MUTED = colors.HexColor("#6E7681")
TEXT_LABEL = colors.HexColor("#1A6B62")
ROW_ALT = colors.HexColor("#F1F5F4")
ROW_LINE = colors.HexColor("#DFE5E4")
RULE_HAIRLINE = colors.HexColor("#E2E7E6")
CALLOUT_BG = colors.HexColor("#F3F7F6")

PAGE_WIDTH, PAGE_HEIGHT = A4
LEFT_MARGIN = RIGHT_MARGIN = 20 * mm
TOP_MARGIN = 18 * mm
BOTTOM_MARGIN = 20 * mm
CONTENT_WIDTH = PAGE_WIDTH - LEFT_MARGIN - RIGHT_MARGIN

OUTPUT_PATH = Path(__file__).resolve().parent.parent / "Reports" / "RazorpayHandbookComplianceReport.pdf"
DOCUMENT_TITLE = "Razorpay Handbook Compliance Report"
# Stamped at render time. This report is re-derived on every audit, so a
# hardcoded date would date it to whenever the file was last hand-edited.
DOCUMENT_DATE = datetime.now().strftime("%-d %B %Y") if os.name != "nt" else datetime.now().strftime("%#d %B %Y")


# --- Status and action vocabulary (requirements section E) ----------------

STATUS_DONE = "<b><font color='#1A6B62'>Accomplished</font></b>"
STATUS_PART = "<b><font color='#B8791C'>Partially accomplished</font></b>"
STATUS_GAP = "<b><font color='#A83232'>Unaccomplished</font></b>"
STATUS_NA = "<font color='#6E7681'>Not applicable</font>"

ACTION_NONE = "No action needed"
ACTION_CHANGE = "Change recommended"
ACTION_NOW = "<b><font color='#A83232'>Needs immediate action</font></b>"
ACTION_NA = "N/A, no action needed"
ACTION_EXCLUDED = "<font color='#6E7681'>Excluded from scope</font>"


# --- Paragraph styles -----------------------------------------------------

styles = {
    "title": ParagraphStyle(
        "title", fontName="Helvetica-Bold", fontSize=27, leading=31,
        textColor=TEAL_TITLE, spaceAfter=4,
    ),
    "subtitle": ParagraphStyle(
        "subtitle", fontName="Helvetica", fontSize=12.5, leading=16,
        textColor=TEXT_MUTED, spaceAfter=2,
    ),
    "date": ParagraphStyle(
        "date", fontName="Helvetica", fontSize=9.5, leading=13,
        textColor=TEXT_MUTED,
    ),
    "h2": ParagraphStyle(
        "h2", fontName="Helvetica-Bold", fontSize=14.5, leading=17,
        textColor=TEAL_HEADER,
    ),
    "h3": ParagraphStyle(
        "h3", fontName="Helvetica-Bold", fontSize=11, leading=15,
        textColor=TEAL_TITLE, spaceBefore=6, spaceAfter=2,
    ),
    "body": ParagraphStyle(
        "body", fontName="Helvetica", fontSize=10, leading=15,
        textColor=TEXT_BODY, spaceAfter=6, alignment=TA_LEFT,
    ),
    "callout": ParagraphStyle(
        "callout", fontName="Helvetica-Oblique", fontSize=10.5, leading=15.5,
        textColor=TEAL_TITLE,
    ),
    "bullet": ParagraphStyle(
        "bullet", fontName="Helvetica", fontSize=10, leading=14.5,
        textColor=TEXT_BODY,
    ),
    "cell": ParagraphStyle(
        "cell", fontName="Helvetica", fontSize=8.2, leading=11,
        textColor=TEXT_BODY,
    ),
    "cellLabel": ParagraphStyle(
        "cellLabel", fontName="Helvetica-Bold", fontSize=8.2, leading=11,
        textColor=TEXT_LABEL,
    ),
    "cellHead": ParagraphStyle(
        "cellHead", fontName="Helvetica-Bold", fontSize=8.6, leading=11.5,
        textColor=colors.white,
    ),
    "cellHeadCenter": ParagraphStyle(
        "cellHeadCenter", fontName="Helvetica-Bold", fontSize=8.6, leading=11.5,
        textColor=colors.white, alignment=TA_CENTER,
    ),
    "cellCenter": ParagraphStyle(
        "cellCenter", fontName="Helvetica", fontSize=8.2, leading=11,
        textColor=TEXT_BODY, alignment=TA_CENTER,
    ),
    "footer": ParagraphStyle(
        "footer", fontName="Helvetica", fontSize=8, leading=10,
        textColor=TEXT_MUTED, alignment=TA_CENTER,
    ),
    "closing": ParagraphStyle(
        "closing", fontName="Helvetica-Oblique", fontSize=9.5, leading=14,
        textColor=TEXT_MUTED,
    ),
}


# --- Custom flowables -----------------------------------------------------

class SectionHeader(Flowable):
    """A deep-teal section title preceded by a short gold accent bar."""

    def __init__(self, text, width):
        super().__init__()
        self.text = text
        self.width = width
        self.paragraph = Paragraph(text, styles["h2"])
        self._height = 0

    def wrap(self, available_width, available_height):
        used_width = self.width - 9 * mm
        _, paragraph_height = self.paragraph.wrap(used_width, available_height)
        self._height = max(paragraph_height, 6 * mm)
        return self.width, self._height

    def draw(self):
        bar_height = min(self._height, 6.2 * mm)
        self.canv.setFillColor(GOLD_ACCENT)
        self.canv.rect(0, self._height - bar_height, 2.2 * mm, bar_height, stroke=0, fill=1)
        self.paragraph.drawOn(self.canv, 6 * mm, 0)


class HorizontalRule(Flowable):
    def __init__(self, width, thickness, color, top_padding=0, bottom_padding=0):
        super().__init__()
        self.width = width
        self.thickness = thickness
        self.color = color
        self.top_padding = top_padding
        self.bottom_padding = bottom_padding

    def wrap(self, available_width, available_height):
        return self.width, self.thickness + self.top_padding + self.bottom_padding

    def draw(self):
        self.canv.setStrokeColor(self.color)
        self.canv.setLineWidth(self.thickness)
        y = self.bottom_padding
        self.canv.line(0, y, self.width, y)


# --- Page chrome ----------------------------------------------------------

def draw_page_chrome(canvas, document):
    canvas.saveState()
    canvas.setFillColor(colors.white)
    canvas.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, stroke=0, fill=1)

    footer_y = 12 * mm
    canvas.setStrokeColor(RULE_HAIRLINE)
    canvas.setLineWidth(0.5)
    canvas.line(LEFT_MARGIN, footer_y + 4 * mm, PAGE_WIDTH - RIGHT_MARGIN, footer_y + 4 * mm)

    canvas.setFillColor(TEXT_MUTED)
    canvas.setFont("Helvetica", 8)
    canvas.drawCentredString(PAGE_WIDTH / 2, footer_y, "CogniumLearn  —  %s" % DOCUMENT_TITLE)
    canvas.drawRightString(PAGE_WIDTH - RIGHT_MARGIN, footer_y, str(document.page))
    canvas.restoreState()


# --- Content builders -----------------------------------------------------


# The height one table row has to work with before it must be split internally:
# the frame less Frame's own 6pt top and bottom padding and a repeated header
# row. See enable_in_row_split.
USABLE_FRAME_HEIGHT = PAGE_HEIGHT - TOP_MARGIN - BOTTOM_MARGIN - 12 - 30


def enable_in_row_split(table):
    """
    Turns on splitting INSIDE a row, but only for a table with a row too tall to
    be placed on any page.

    Without it, a Table splits only BETWEEN rows, and repeatRows=1 makes
    ReportLab refuse even that unless the header and the first data row both fit
    the frame — so one over-tall row makes the whole table unplaceable and the
    build dies with a LayoutError, taking the report with it.

    With it on unconditionally, an ordinary short table that merely arrived near
    a page bottom is split too, leaving an orphan fragment: one cell's first line
    with every other cell blank, and the real row repeated in full overleaf.

    So it is decided per table, from the row heights ReportLab itself computes.
    Copied from Common/Scripts/RenderPaidDeckAuditTrail.py, which carries the
    full rationale and the harness that proves both directions.
    """
    try:
        table.wrap(CONTENT_WIDTH, USABLE_FRAME_HEIGHT)
        row_heights = getattr(table, "_rowHeights", None) or []
    except Exception:
        return

    if any(row_height > USABLE_FRAME_HEIGHT for row_height in row_heights):
        table.splitInRow = 1

def make_bullets(items):
    rows = []
    for item in items:
        if isinstance(item, tuple):
            label, text = item
            body = "<b><font color='#1A6B62'>%s</font></b> &mdash; %s" % (label, text)
        else:
            body = item
        dot = Paragraph("&bull;", ParagraphStyle(
            "dot", fontName="Helvetica-Bold", fontSize=10, leading=14.5,
            textColor=GOLD_ACCENT))
        rows.append([dot, Paragraph(body, styles["bullet"])])
    # splitInRow for the same reason make_table sets it: a bullet holding a long
    # value must flow across a page break rather than fail to place.
    table = Table(rows, colWidths=[5 * mm, CONTENT_WIDTH - 5 * mm])
    table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (0, -1), 2),
        ("LEFTPADDING", (1, 0), (1, -1), 2),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    enable_in_row_split(table)

    return table


def make_table(headers, rows, col_ratios, label_first_column=True, center_from_column=None,
               center_columns=None):
    """
    center_from_column centres that column and every one after it. center_columns
    names an exact set instead, for a table whose numeric columns sit between two
    prose ones — centring a paragraph of prose reads badly, so the two cannot be
    expressed by a single "from here on" threshold.
    """
    total = sum(col_ratios)
    col_widths = [CONTENT_WIDTH * ratio / total for ratio in col_ratios]

    def is_centered(index):
        if center_columns is not None:
            return index in center_columns
        return center_from_column is not None and index >= center_from_column

    header_cells = []
    for index, head in enumerate(headers):
        header_cells.append(Paragraph(head, styles["cellHeadCenter"] if is_centered(index) else styles["cellHead"]))
    data = [header_cells]
    for row in rows:
        cells = []
        for index, value in enumerate(row):
            if label_first_column and index == 0:
                style = styles["cellLabel"]
            elif is_centered(index):
                style = styles["cellCenter"]
            else:
                style = styles["cell"]
            cells.append(Paragraph(value, style))
        data.append(cells)

    # LongTable + splitInRow, not Table. A plain Table splits only BETWEEN rows,
    # and with repeatRows=1 it refuses even that unless the repeated header and
    # the first data row both fit the page frame -- so one cell taller than the
    # frame made the whole table unplaceable and raised LayoutError, taking the
    # report with it. splitInRow is a minimum split height rather than a boolean,
    # so 1 means "split anywhere"; the cells are already Paragraphs, which are
    # splittable. See Common/Reports/PdfTheme.md and, for the production failure
    # this was found through, Agent/Verification/VerifyAuditTrailRenderer.py.
    table = LongTable(data, colWidths=col_widths, repeatRows=1)
    table_style = [
        ("BACKGROUND", (0, 0), (-1, 0), TEAL_TABLE_HEAD),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LINEBELOW", (0, 0), (-1, -1), 0.4, ROW_LINE),
        ("LINEBELOW", (0, 0), (-1, 0), 0, colors.white),
    ]
    for row_index in range(1, len(data)):
        if row_index % 2 == 0:
            table_style.append(("BACKGROUND", (0, row_index), (-1, row_index), ROW_ALT))
    table.setStyle(TableStyle(table_style))
    enable_in_row_split(table)

    return table


def make_callout(text):
    inner = Paragraph(text, styles["callout"])
    table = Table([[inner]], colWidths=[CONTENT_WIDTH])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), CALLOUT_BG),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 9),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
        ("LINEBEFORE", (0, 0), (0, -1), 2.4, GOLD_ACCENT),
    ]))
    return table


def section(title, blocks):
    flow = [Spacer(1, 9), SectionHeader(title, CONTENT_WIDTH), Spacer(1, 5)]
    flow.extend(blocks)
    return flow


# Four-column finding table: control | status | evidence | action.
FINDING_HEADERS = ["Handbook control", "Status", "Evidence in this repository", "Action"]
FINDING_RATIOS = [25, 17, 41, 17]


def finding_table(rows):
    return make_table(FINDING_HEADERS, rows, FINDING_RATIOS)


# --- The report content ---------------------------------------------------

def build_story():
    story = []

    # 1. Cover block.
    story.append(Paragraph(DOCUMENT_TITLE, styles["title"]))
    story.append(Paragraph(
        "CogniumLearn audited against the Razorpay Integration &amp; Security Handbook "
        "(Orders API + Standard Checkout for SaaS), version 05 August 2026", styles["subtitle"]))
    story.append(Spacer(1, 3))
    story.append(Paragraph(DOCUMENT_DATE, styles["date"]))
    story.append(Spacer(1, 6))
    story.append(HorizontalRule(CONTENT_WIDTH, 2, GOLD_ACCENT, top_padding=2, bottom_padding=6))
    story.append(Spacer(1, 6))

    # 2. Opening callout.
    story.append(make_callout(
        "This is an audit, not a remediation pass. <b>No code was modified while it was "
        "produced.</b> Every control was re-derived from the working tree as it exists on disk "
        "today; the previous report was deleted first and not consulted, so nothing here is "
        "carried forward from an earlier conclusion &mdash; including the conclusion that a "
        "gap had been closed. Each remediated control was re-read in the source rather than "
        "assumed from the change that was made to it.<br/><br/>"
        "The organization credit deal &mdash; the flow that carried four regressions at the last "
        "pass &mdash; now holds every control the older flows do, and reconciliation and reversal "
        "both reach it. A different new surface appeared in the meantime (an organization deck "
        "shelf that grants licences without any payment), and it was audited on its own terms "
        "rather than waved through as adjacent to work already reviewed."))
    story.append(Spacer(1, 4))

    # 3. Scope, method and how to read this report.
    story.extend(section("Scope, method and how to read this report", [
        Paragraph(
            "The audited surface is the whole payment path, server and browser, plus the "
            "configuration and tests around it:", styles["body"]),
        make_bullets([
            ("Provider layer", "<font face='Courier'>Dock/Globals/Classes/Payments/</font> &mdash; "
             "PaymentProvider, RazorpayPaymentProvider, PaymentProviderFactory, "
             "PaymentEnvironmentValidator, PaymentAccessPolicy, SettlementAmountGuard, "
             "CheckoutReceiptIdentifier, RefundPolicy, PaymentReversalService, "
             "PendingPaymentReconciler, PaymentRequestSchema, RazorpayPlanRegistry and the "
             "Stripe / PayPal stubs."),
            ("Order creation", "the credit and paid-deck initiation endpoints, the subscription "
             "initiation helper, and <b>both</b> admin deal-creation endpoints &mdash; "
             "<font face='Courier'>CreateDealPayment.js</font> and the newer "
             "<font face='Courier'>CreateOrganizationCreditDeal.js</font>."),
            ("Verification", "the credit, paid-deck, subscription, admin-deal and "
             "organization-credit-deal verify legs."),
            ("Webhooks", "<font face='Courier'>HandleRazorpayWebhook.js</font>, its route "
             "registration, and SubscriptionWebhookProcessor."),
            ("Settlement and ledger", "the three completion services, CreditLedger, "
             "OrganizationCreditLedger, and the pending-order / webhook-event / payment-attempt "
             "query engines including TimeToLiveIndexReconciler."),
            ("Pricing and eligibility", "RegionResolver, PaidDeckPricingEngine, "
             "CreditPurchasePricingEngine, PlanMetadata, PlanTierResolver, CouponCheckoutService."),
            ("Reads and receipts", "GetPurchaseInvoice, GetMyPurchases, GetCreditPurchaseOptions, "
             "GetRevenueStats."),
            ("Free entitlement paths", "new this pass &mdash; AddOrganizationDeck, "
             "GetOrganizationDeckShelf, RemoveOrganizationDeck and the four "
             "OrganizationAdmin/Decks endpoints. They issue licences with no order behind them, "
             "which puts them squarely inside [B9] even though no money moves."),
            ("Browser", "RazorpayCheckout, PaymentCheckout, and the script "
             "tags in <font face='Courier'>Main/index.html</font> and "
             "<font face='Courier'>Main/login.html</font>."),
            ("Perimeter", "SecurityHeaders, NoCache, EnsureLogin, EnsureAdmin, EnsureOrgAdmin, "
             "EnsurePaymentAccess, EnsurePaymentRequestSchema, EnsureRateLimit, ReceiveCspReport "
             "and the <font face='Courier'>Dock/index.js</font> boot sequence."),
            ("Configuration", "<font face='Courier'>Dock/.env.example</font> and all four "
             "environment files present on disk."),
            ("Tests and documents", "the four payment harnesses (all executed during this audit), "
             "the adversarial checklist, the incident runbook and the payment-page script "
             "inventory."),
            ("Searched-for absences", "a CI directory, a script manifest, and an internal "
             "ledger-versus-accounting comparison. Each was looked for explicitly rather than "
             "inferred from silence; the first and third are genuinely absent."),
        ]),
        Spacer(1, 8),
        Paragraph("Status and action are independent judgements:", styles["body"]),
        make_table(
            ["Term", "What it means"],
            [
                [STATUS_DONE, "The control exists and was verified against the current source."],
                [STATUS_PART, "It exists with a material gap, or is met by a weaker compensating mechanism."],
                [STATUS_GAP, "No implementation exists in the repository."],
                [STATUS_NA, "A dashboard setting, an organisational process, or a flow this product genuinely does not have."],
                [ACTION_NOW, "Money, entitlements or personal data are at risk today."],
                [ACTION_CHANGE, "A real weakness or fragility; schedule it."],
                [ACTION_NONE, "Verified working, or an accepted trade-off that is correct for this product."],
                [ACTION_NA, "Reserved for not-applicable controls, so &quot;we did it&quot; is distinguishable from &quot;it does not apply here&quot;."],
                [ACTION_EXCLUDED, "Deliberately out of scope by the repository owner's decision (specification section B)."],
            ],
            [24, 76]),
        Spacer(1, 6),
        Paragraph(
            "A control may be unaccomplished and still need no action; it may be accomplished and "
            "still warrant a change. Where a control is split between code and a provider-dashboard "
            "setting, that split is stated rather than marked accomplished on the strength of the "
            "code half alone.", styles["body"]),
    ]))

    # 4. Which provider is actually live.
    story.append(Spacer(1, 4))
    story.append(make_callout(
        "<b>Razorpay is the sole live payment provider, verified this pass rather than assumed.</b> "
        "<font face='Courier'>PaymentProviderFactory.getDefaultProvider()</font> falls back to "
        "RAZORPAY when <font face='Courier'>DEFAULT_PAYMENT_PROVIDER</font> names nothing valid, and "
        "every environment file that sets it names RAZORPAY. Zoho has not returned: the enum member "
        "survives as a deliberate tombstone so historical rows stay attributable, and "
        "<font face='Courier'>RETIRED_PROVIDER_ENUM_VALUES</font> makes the factory throw a distinct, "
        "explanatory error for it rather than a generic &quot;unknown provider&quot;. Stripe and "
        "PayPal remain unimplemented stubs whose every method throws. Razorpay is also the only "
        "provider for recurring subscriptions &mdash; "
        "<font face='Courier'>supportsRecurringSubscriptions()</font> returns true there and nowhere "
        "else."))

    # 5. Part 0 — mental model.
    story.extend(section("Part 0 &mdash; Mental model", [
        finding_table([
            ["1. Provisioning only after capture, never on authorized",
             STATUS_DONE,
             "The webhook settles only on <font face='Courier'>payment.captured</font> / "
             "<font face='Courier'>order.paid</font> (HandleRazorpayWebhook.js:375). Reconciliation "
             "uses <font face='Courier'>fetchCapturedPaymentForOrder</font>, which filters on "
             "<font face='Courier'>status === &quot;captured&quot;</font> "
             "(RazorpayPaymentProvider.js:337) &mdash; authorized-but-uncaptured provisions nothing "
             "on any path.",
             ACTION_NONE],
            ["2. Orders created server-side; only the order id reaches the browser",
             STATUS_DONE,
             "Every order is minted by <font face='Courier'>provider.initiateOrder</font> on the "
             "server. The browser receives <font face='Courier'>checkoutContext</font> = "
             "{keyId, orderId, amount, currency} only (RazorpayPaymentProvider.js:144-150); the key "
             "id is public by design.",
             ACTION_NONE],
            ["3. The client is never a source of truth",
             STATUS_DONE,
             "Every settlement reads a server-held row. VerifyCreditPurchase.js:35 and "
             "VerifyPurchase.js:36 take only the three payment-identifying fields, and both carry "
             "an explicit comment that even <font face='Courier'>paymentProvider</font> is resolved "
             "from the stored row so a client cannot choose which verifier validates its payment.",
             ACTION_NONE],
            ["4. Webhooks are an authoritative settlement signal",
             STATUS_DONE,
             "The webhook settles credit purchases, admin deals, organization credit pools and paid "
             "decks with no session at all, driven entirely by the stored order row "
             "(HandleRazorpayWebhook.js:405-579). It is a second settlement path, not a "
             "notification channel.",
             ACTION_NONE],
            ["5. Every settlement path is idempotent by construction",
             STATUS_DONE,
             "Three independent layers: the ledger's unique "
             "<font face='Courier'>referenceKey</font>, the pending row's atomic "
             "PENDING&#8594;CONSUMED transition, and the paid-deck "
             "<font face='Courier'>tryClaimForGrant</font> lease "
             "(PendingOrderQueryEngine.js:273-303). In front of all three sits the webhook-event "
             "unique index, which fails open by design so it can never refuse a genuine payment.",
             ACTION_NONE],
            ["6. Money is integers in the currency subunit; no floats",
             STATUS_DONE,
             "Every amount is <font face='Courier'>amountMinor</font>, and "
             "<font face='Courier'>PaymentProvider.isChargeableAmount</font> requires "
             "<font face='Courier'>Number.isSafeInteger</font>. Storage is BSON double (a plain "
             "JavaScript number), which is <b>exact</b> for every integer below 2<super>53</super>; "
             "the ceiling enforced here is 10,000,000 minor units, eleven orders of magnitude "
             "inside that. Judged at this product's actual price points the representation is "
             "exact, and no rounding artefact is reachable.",
             ACTION_NONE],
        ]),
    ]))

    # 6. Part 1 — prerequisites.
    story.extend(section("Part 1 &mdash; Prerequisites", [
        finding_table([
            ["7. Test and live modes isolated; key mode matches the environment",
             STATUS_DONE,
             "<font face='Courier'>PaymentEnvironmentValidator.enforceOrExit</font> runs at "
             "Dock/index.js:270, before any route is registered, and exits the process on a "
             "mismatch. Verified on disk this pass: both key-bearing env files "
             "(<font face='Courier'>Dock/.env</font>, <font face='Courier'>.development.env</font>) "
             "carry <font face='Courier'>rzp_test_</font> keys, "
             "<font face='Courier'>.testing.env</font> configures Razorpay not at all, and "
             "<font face='Courier'>.production.env</font> carries blank credentials by design.",
             ACTION_NONE],
            ["8. The API key secret is server-only",
             STATUS_DONE,
             "<font face='Courier'>#keySecret</font> is an ES private field read from "
             "<font face='Courier'>process.env</font> and never serialised; the browser receives "
             "only <font face='Courier'>keyId</font>. No env file has ever been committed &mdash; "
             "<font face='Courier'>git log</font> over all four paths returns nothing, and "
             "<font face='Courier'>.gitignore</font> covers <font face='Courier'>.env</font>, "
             "<font face='Courier'>.env.*</font> and <font face='Courier'>.production.env</font> "
             "explicitly.",
             ACTION_NONE],
            ["9. Secrets from a manager or a rendered env file, never a committed one",
             STATUS_DONE,
             "A deployed node renders secrets from Google Secret Manager into "
             "<font face='Courier'>COGNIUMLEARN_SECRETS_DIRECTORY</font>, whose presence is also how "
             "the validator distinguishes a real production node from a local "
             "<font face='Courier'>npm run production</font>. Checked afresh across all four env "
             "files this pass: no key is declared twice in any of them, and "
             "<font face='Courier'>git log</font> over all four paths returns nothing.",
             ACTION_NONE],
            ["10. Key rotation is configuration, not code",
             STATUS_DONE,
             "Keys and both webhook secrets are read from the environment, so rotation is an env "
             "change. A restart <b>is</b> required &mdash; the provider instance is cached in "
             "<font face='Courier'>PaymentProviderFactory.#cache</font> and reads the key once in "
             "its constructor. Stated rather than glossed: an operator expecting a live reload will "
             "be surprised.",
             ACTION_NONE],
            ["11. Required payment methods enabled with the provider",
             STATUS_NA,
             "Entirely a Razorpay Dashboard setting. Nothing in the repository can assert it, and "
             "the code makes no assumption about which methods are enabled.",
             ACTION_NA],
        ]),
    ]))

    # 7. Part 2 — data model.
    story.extend(section("Part 2 &mdash; Your own data model", [
        finding_table([
            ["12. An order ledger records intent before the provider is called",
             STATUS_DONE,
             "All three order-creating flows now write their local row <b>before</b> "
             "<font face='Courier'>initiateOrder</font> &mdash; InitiateCreditPurchase.js:300, "
             "InitiatePurchase.js:412 and CreateOrganizationCreditDeal.js:203, each deleting the "
             "placeholder if the provider call then fails. Verified by reading the deal endpoint's "
             "current source rather than by trusting that the change was made.",
             ACTION_NONE],
            ["13. A payment-attempt record exists, including failures and error codes",
             STATUS_DONE,
             "<font face='Courier'>PaymentAttemptQueryEngine</font> records both captured and failed "
             "attempts from the signed webhook, keeps Razorpay's error taxonomy verbatim "
             "(<font face='Courier'>errorCode / errorDescription / errorReason / errorSource / "
             "errorStep</font>), and stores the instrument <i>class</i> only &mdash; never an "
             "identifier. <font face='Courier'>resolveBuyerIdForOrder</font> now falls through to "
             "creditDealPayments (HandleRazorpayWebhook.js:100), so a failed deal payment is "
             "attributed to the administrator driving it and can reach the burst counter.",
             ACTION_NONE],
            ["14. Every webhook delivery recorded with a unique event id",
             STATUS_DONE,
             "<font face='Courier'>WebhookEventQueryEngine.claim</font> inserts against a unique "
             "partial index on (provider, eventId) &mdash; partial deliberately, so deliveries "
             "lacking an event id do not all collide on a single null key.",
             ACTION_NONE],
            ["15. The order receipt is deterministic",
             STATUS_DONE,
             "No receipt anywhere on the surface now reads the clock. "
             "<font face='Courier'>CheckoutReceiptIdentifier</font> covers all three flows, the "
             "third through <font face='Courier'>forOrganizationCreditDeal</font>, and "
             "<font face='Courier'>CreateDealPayment.js:115</font> uses the stable "
             "<font face='Courier'>deal_&lt;id&gt;</font>. The organization receipt hashes the "
             "INSTITUTE rather than the administrator who clicked &mdash; two admins submitting one "
             "negotiated deal are submitting one deal &mdash; and includes the contract term, since "
             "the same credits at the same price for a different term is a different agreement "
             "rather than a retry. Both properties are asserted directly.",
             ACTION_NONE],
            ["16. Raw provider payload retained for dispute evidence",
             STATUS_DONE,
             "The signed bytes are stored verbatim (truncated at 64&nbsp;KB) on the webhook-event "
             "row, alongside the event type and whether the outgoing secret was used. Retention is "
             "a TTL sized for dispute evidence rather than deduplication, and it is now applied "
             "through <font face='Courier'>TimeToLiveIndexReconciler</font> like every other TTL "
             "on the surface &mdash; which matters most here, where a retention change that "
             "silently failed would quietly shorten the window disputes are argued from.",
             ACTION_NONE],
        ]),
    ]))

    # 8. Part 3 — order creation.
    story.extend(section("Part 3 &mdash; Order creation", [
        finding_table([
            ["17. The client sends an identifier, never an amount [A1]",
             STATUS_DONE,
             "Structurally true across every buyer-facing endpoint: the credit route accepts a "
             "quantity that must match a configured pack, the deck route accepts deck ids, the "
             "subscription route a tier. No handler reads a price from a body. The one endpoint "
             "whose caller does name an amount is admin-only by construction.",
             ACTION_NONE],
            ["18. A strict request schema rejects unknown fields [A1]",
             STATUS_DONE,
             "<font face='Courier'>ensurePaymentRequestSchema</font> is now mounted on all eight "
             "session-facing money routes, the last being "
             "<font face='Courier'>/Organization/Credits/Deals/Verify</font> "
             "(HandleOrganizationEndpoints.js:185). Stated precisely rather than as blanket "
             "coverage: the three <b>admin</b> deal routes carry "
             "<font face='Courier'>ensureAdmin</font> and no schema. That is judged correct rather "
             "than overlooked &mdash; <font face='Courier'>CreateDealPayment</font> legitimately "
             "accepts a caller-named amount, so an allowlist there would guard typos rather than "
             "attacks, and a compromised administrator would send valid fields anyway.",
             ACTION_NONE],
            ["19. The local record is written BEFORE the remote provider call",
             STATUS_DONE,
             "All three flows, each with the same tight failure path: a thrown "
             "<font face='Courier'>initiateOrder</font> deletes the placeholder through a delete "
             "that only ever matches a PENDING row still keyed on its own receipt, so it cannot "
             "touch a real order. Asserted directly for the deal flow &mdash; the harness attaches "
             "a real order id and then confirms the cleanup refuses to delete that row.",
             ACTION_NONE],
            ["20. Provider notes carry correlation ids only",
             STATUS_DONE,
             "Notes hold userId / organizationId / dealId / purpose / credits / deck ids. No email "
             "address, no name, no secret. Every settlement path reads its own row rather than the "
             "notes, so they are advisory in the strict sense.",
             ACTION_NONE],
            ["21. Provider failures return a generic error; internals never reach the client",
             STATUS_DONE,
             "Every initiation endpoint now catches, logs the provider's text server-side and "
             "returns a bare <font face='Courier'>EXCEPTION</font> with 502 &mdash; the two buyer "
             "ones, <font face='Courier'>CreateDealPayment.js:117</font> and "
             "<font face='Courier'>CreateOrganizationCreditDeal.js:220</font>. An administrator is "
             "a trusted audience, but provider internals crossing the boundary is still provider "
             "internals crossing the boundary.",
             ACTION_NONE],
            ["22. An existing unpaid order is reused [A6]",
             STATUS_DONE,
             "All three flows reuse. The two buyer engines return the most recent PENDING row for "
             "the same receipt inside a 30-minute window, scoped to the owning user; reuse is safe "
             "without re-pricing because amount and currency are inputs to the receipt hash, so a "
             "moved price moves the receipt and the lookup misses. A couponed retry has its own "
             "path (<font face='Courier'>findReusableByCoupon</font>), which resolves the coupon "
             "read-only first so a buyer is not locked out of their own abandoned checkout by their "
             "own reservation. The deal engine's reuse is deliberately different in two ways &mdash; "
             "no owner scoping and no time window &mdash; discussed in the gap register.",
             ACTION_NONE],
        ]),
    ]))

    # 9. Part 4 — checkout in the browser.
    story.extend(section("Part 4 &mdash; Checkout in the browser", [
        finding_table([
            ["23. Standard Checkout (hosted iframe); no custom card form",
             STATUS_DONE,
             "<font face='Courier'>RazorpayCheckout.open</font> instantiates "
             "<font face='Courier'>window.Razorpay</font> and nothing else. Searching the whole "
             "frontend finds no card-number, CVV or expiry input anywhere.",
             ACTION_NONE],
            ["24. The handler callback is used, not callback_url",
             STATUS_DONE,
             "RazorpayCheckout.js:77 supplies a <font face='Courier'>handler</font> function; no "
             "<font face='Courier'>callback_url</font> appears in the options object.",
             ACTION_NONE],
            ["25. Success, failure and dismissal are three distinct states",
             STATUS_DONE,
             "<font face='Courier'>handler</font> resolves the triple, "
             "<font face='Courier'>modal.ondismiss</font> resolves null, and a "
             "<font face='Courier'>payment.failed</font> listener logs without settling &mdash; "
             "correct, because Razorpay keeps the widget open for a retry. A "
             "<font face='Courier'>hasSettled</font> guard makes whichever fires first the only "
             "settlement.",
             ACTION_NONE],
            ["26. The widget's order id is never trusted over the server's",
             STATUS_DONE,
             "RazorpayCheckout.js:84 returns <font face='Courier'>checkoutContext.orderId</font> "
             "&mdash; the server's own value &mdash; rather than anything from the payment "
             "response, with an inline comment saying exactly that.",
             ACTION_NONE],
            ["27. PCI scope stays at the lightest attestation tier",
             STATUS_DONE,
             "Card data is entered inside a Razorpay-hosted iframe and never touches this origin, so "
             "SAQ A is the applicable tier. That is defensible <i>because</i> of controls 23 and 65 "
             "together: no first-party card field exists, and nothing card-shaped is stored. The "
             "tier follows from the integration model rather than being asserted.",
             ACTION_NONE],
            ["28. A justified inventory of every payment-page script [PCI 6.4.3]",
             STATUS_PART,
             "<font face='Courier'>Common/ReadmeFiles/PaymentPageScriptInventory.md</font> lists "
             "each payment surface, the one authorised remote script and why it cannot be pinned, "
             "the first-party set, and an explicit table of excluded categories &mdash; and it "
             "already names the organization credits surface as a payment entry point. It is "
             "nevertheless <b>incomplete</b>: loading the app in a real browser during this audit "
             "showed the checkout script fetching a second remote script of its own from "
             "<font face='Courier'>cdn.razorpay.com/static/cx/razorpay-risk-detection/bundle.js</font>, "
             "an origin the inventory does not mention at all. An inventory that omits a script the "
             "payment page actually requests cannot answer the question PCI 6.4.3 asks of it.",
             ACTION_CHANGE],
            ["29. Tamper detection reaches a human [PCI 11.6.1]",
             STATUS_PART,
             "The strict CSP is now the ENFORCED policy and carries "
             "<font face='Courier'>report-uri</font>, so violations keep landing in the admin "
             "Alerts tab through <font face='Courier'>/Security/CspReport</font> and a script from "
             "an unexpected origin reaches a person whichever mode is selected. What is missing is "
             "change detection on the authorised scripts themselves &mdash; control 113, and "
             "unsolvable in-repo for a file the vendor mutates deliberately.",
             ACTION_CHANGE],
            ["30. Subresource Integrity wherever a script can be pinned",
             STATUS_NA,
             "There is nothing pinnable. The single remote script "
             "(<font face='Courier'>checkout.razorpay.com/v1/checkout.js</font>) is deliberately "
             "mutable &mdash; an SRI hash would break checkout the first time Razorpay shipped a "
             "fix. Every other script is same-origin, where SRI adds nothing an attacker with write "
             "access could not also update.",
             ACTION_NA],
        ]),
    ]))

    # 10. Part 5 — signature verification.
    story.extend(section("Part 5 &mdash; Payment signature verification", [
        finding_table([
            ["31. HMAC verification is mandatory and fail-closed on every path",
             STATUS_DONE,
             "All five verify legs call the provider before any state change and return on "
             "<font face='Courier'>!verified</font>. Verified by harness: "
             "<font face='Courier'>VerifyRazorpaySignatures.mjs</font> (50 assertions) and "
             "<font face='Courier'>VerifyPaymentAdversarial.mjs</font> (33), both executed during "
             "this audit.",
             ACTION_NONE],
            ["32. The HMAC is built from the stored order id [C2]",
             STATUS_DONE,
             "Each verify leg looks the row up first and asserts ownership, then signs. The order id "
             "used is the one the row is keyed by; a body naming a different order fails the lookup "
             "or the ownership check before any crypto runs.",
             ACTION_NONE],
            ["33. The order lookup is scoped to the authenticated account [B2]",
             STATUS_DONE,
             "VerifyCreditPurchase.js:54 and VerifyPurchase.js:55 return 403 ORDER_OWNER_MISMATCH on "
             "a userId mismatch; VerifySubscription.js:49 does the same. "
             "VerifyOrganizationCreditDeal.js:59 additionally checks the deal's "
             "<font face='Courier'>targetId</font> against the organization the caller has standing "
             "in &mdash; the correct extra hop for a flow whose buyer is an organization rather "
             "than a person.",
             ACTION_NONE],
            ["34. Comparison is constant-time with a preceding length check [C3]",
             STATUS_DONE,
             "<font face='Courier'>timingSafeEqual</font> throws on unequal lengths, so both "
             "<font face='Courier'>verifyPayment</font> and "
             "<font face='Courier'>verifySubscriptionPayment</font> compare buffer lengths first and "
             "return SIGNATURE_LENGTH_MISMATCH. The webhook path uses the shared "
             "<font face='Courier'>#signaturesMatch</font> helper with the same property.",
             ACTION_NONE],
            ["35. Field types validated before any value reaches a Buffer or HMAC [C1]",
             STATUS_DONE,
             "<font face='Courier'>#isNonEmptyString</font> gates all three fields <i>before</i> "
             "truthiness. The comment at RazorpayPaymentProvider.js:183 explains why it must be that "
             "way round: a client-supplied <font face='Courier'>{}</font> is truthy and would "
             "surface as a 500 instead of a clean rejection.",
             ACTION_NONE],
            ["36. Subscription signatures use the reversed field order, in a distinct path",
             STATUS_DONE,
             "<font face='Courier'>verifySubscriptionPayment</font> signs "
             "<font face='Courier'>paymentId|subscriptionId</font> &mdash; reversed from the "
             "one-time <font face='Courier'>orderId|paymentId</font> &mdash; in a separate method "
             "with its own guards.",
             ACTION_NONE],
            ["37. Amount, currency and order re-asserted before fulfilment [C4]",
             STATUS_DONE,
             "Asserted at two points rather than one. At <b>creation</b>, "
             "RazorpayPaymentProvider.js:129 compares the order Razorpay echoed against the order "
             "requested and throws on any divergence &mdash; closing the one place the stored and "
             "the charged amount could silently differ. At <b>settlement</b>, the webhook and the "
             "reconciler both run <font face='Courier'>SettlementAmountGuard</font> against the "
             "stored row and refuse on mismatch. A fetch on the browser verify leg is genuinely "
             "unnecessary: orders are immutable once created, so it would add latency to re-ask an "
             "answered question.",
             ACTION_NONE],
        ]),
    ]))

    # 11. Part 6 — webhooks.
    story.extend(section("Part 6 &mdash; Webhooks", [
        finding_table([
            ["38. HMAC over the raw body, never a re-serialised one [D2]",
             STATUS_DONE,
             "The route is registered with "
             "<font face='Courier'>PacketronHandlerFlags.PLAIN_TEXT_BODY</font> "
             "(HandleWebhookEndpoints.js:18), so the handler receives the exact bytes Razorpay "
             "signed.",
             ACTION_NONE],
            ["39. The body is parsed only after verification succeeds",
             STATUS_DONE,
             "<font face='Courier'>JSON.parse</font> is at HandleRazorpayWebhook.js:252, strictly "
             "after the signature check at :229. A parse failure acks 200 rather than throwing.",
             ACTION_NONE],
            ["40. The webhook secret is separate from the API key secret",
             STATUS_DONE,
             "<font face='Courier'>RAZORPAY_WEBHOOK_SECRET</font> is a distinct variable, documented "
             "as such in <font face='Courier'>.env.example</font>, and "
             "<font face='Courier'>verifyWebhookSignature</font> never touches "
             "<font face='Courier'>#keySecret</font>.",
             ACTION_NONE],
            ["41. An unverified delivery is rejected and nothing is processed [D1]",
             STATUS_DONE,
             "The handler returns immediately on failure. It acks 200 to stop retries &mdash; and "
             "because that also makes the failure look successful in Razorpay's own dashboard, it "
             "raises an admin alert so the failure is invisible on neither side. That reasoning is "
             "written into the code rather than left implicit.",
             ACTION_NONE],
            ["42. Duplicate deliveries gated on a unique event id [D3]",
             STATUS_DONE,
             "<font face='Courier'>claim</font> short-circuits a repeat delivery. It fails <b>open</b> "
             "deliberately, and that is the right trade: losing an audit row is a diagnostic "
             "problem, refusing a genuine payment is a customer-facing one, and the three downstream "
             "idempotency layers make the duplicate case safe regardless.",
             ACTION_NONE],
            ["43. Out-of-order delivery tolerated",
             STATUS_DONE,
             "Entitlement extension takes <font face='Courier'>Math.max(existing, proposed)</font> "
             "(PlanSubscriptionService.js:73), so a late or replayed event can never shorten access. "
             "No handler assumes an ordering.",
             ACTION_NONE],
            ["44. Event type read from the body; entities from documented paths",
             STATUS_DONE,
             "<font face='Courier'>payload.event</font> drives the switch; entities are read from "
             "<font face='Courier'>payload.payload.&lt;entity&gt;.entity</font> throughout, with "
             "optional chaining at every hop.",
             ACTION_NONE],
            ["45. Ownership re-checked against a server-held record",
             STATUS_DONE,
             "Every branch fetches its own row and grants from it. The notes are never the source of "
             "a grant &mdash; the one place a note is consulted at all is as a last-resort order-id "
             "fallback on a refund event.",
             ACTION_NONE],
            ["46. IP allowlisting is not relied on [D8]",
             STATUS_DONE,
             "There is no IP check anywhere on the webhook path, and none is needed: the HMAC is the "
             "boundary. Confirmed by search rather than assumed.",
             ACTION_NONE],
            ["47. The endpoint acks quickly; heavy work does not block [D4]",
             STATUS_DONE,
             "Settlement runs before the ack rather than after. Judged correct rather than "
             "deficient: Razorpay's timeout is generous, retries are idempotent, and the reconciler "
             "now backstops a settlement lost to a restart &mdash; so acking first would trade a "
             "real capability (the error path) for a theoretical latency gain.",
             ACTION_NONE],
            ["48. A body-size limit applies before HMAC computation [D4]",
             STATUS_DONE,
             "256&nbsp;KB, checked at HandleRazorpayWebhook.js:219 &mdash; <i>before</i> the "
             "signature check at :228. The ordering is the whole control. An oversized body is "
             "refused with 413 rather than acked, because unlike a bad signature there is no chance "
             "it is a genuine delivery worth suppressing a retry for.",
             ACTION_NONE],
            ["49. Current and previous secrets both accepted during rotation [E2]",
             STATUS_DONE,
             "<font face='Courier'>RAZORPAY_WEBHOOK_SECRET_PREVIOUS</font> is evaluated alongside "
             "the current secret, and both are always computed so response time cannot reveal which "
             "matched. <font face='Courier'>usedPreviousSecret</font> is recorded on the event row "
             "&mdash; the signal that tells an operator when the old secret is safe to retire.",
             ACTION_NONE],
            ["50. refund.processed is subscribed and handled",
             STATUS_DONE,
             "Handled at HandleRazorpayWebhook.js:324. <font face='Courier'>refund.created</font> "
             "and <font face='Courier'>refund.failed</font> are recorded and acked without touching "
             "entitlement; only <font face='Courier'>refund.processed</font> reverses. Under the "
             "no-refund policy this is treated as an alertable exception, which is the correct "
             "reading &mdash; see the gap register for what it does not yet reverse.",
             ACTION_NONE],
            ["51. payment.failed is subscribed and handled",
             STATUS_DONE,
             "Handled at :310. Nothing is provisioned; the branch exists to stop discarding the "
             "failure, and it feeds the card-testing burst detector.",
             ACTION_NONE],
            ["52. Unknown event types return 2xx and never crash-loop [D7]",
             STATUS_DONE,
             "The final <font face='Courier'>EVENT_IGNORED</font> branch acks 200, and the "
             "subscription and reversal handlers are individually wrapped so a thrown error still "
             "acks.",
             ACTION_NONE],
        ]),
    ]))

    # 12. Part 7 — fulfilment, capture, reconciliation.
    story.extend(section("Part 7 &mdash; Fulfilment, capture, reconciliation", [
        finding_table([
            ["53. Fulfilment is idempotent and serialised against concurrency [B3]",
             STATUS_DONE,
             "<font face='Courier'>tryClaimForGrant</font> gives exactly one caller the right to run "
             "a multi-collection deck grant; the loser reports "
             "<font face='Courier'>alreadyProcessed</font>. The claim is released on failure and "
             "expires after ten minutes, so a holder that dies never strands a paid order. Verified "
             "by <font face='Courier'>VerifyPaymentSettlementReliability.mjs</font> (51 assertions).",
             ACTION_NONE],
            ["54. One provisioning path shared by verify and webhook",
             STATUS_DONE,
             "Three completion services, each called by both legs and by the reconciler. No "
             "settlement path holds private provisioning logic &mdash; the reconciler's class "
             "comment states this as a design rule and the code holds to it.",
             ACTION_NONE],
            ["55. Auto-capture enabled and provisioning gated on captured [C5]",
             STATUS_PART,
             "The code half is complete and verified (control 1). The dashboard half &mdash; whether "
             "auto-capture is actually switched on for the live merchant account &mdash; cannot be "
             "asserted from this repository. Recorded as split rather than marked done on the code "
             "alone.",
             ACTION_CHANGE],
            ["56. A scheduled job repairs orders the webhook never settled",
             STATUS_DONE,
             "<font face='Courier'>PendingPaymentReconciler</font> is started and swept once at boot "
             "(Dock/index.js:192-196), sweeps every 30 minutes, leaves orders younger than 20 "
             "minutes alone, gives up after 48 hours, caps at 200 orders per sweep, applies the same "
             "amount guard as the webhook, settles through the shared services and alerts on every "
             "repair. It now reaches <b>all three</b> order-creating flows: on-spot deals are pulled "
             "from creditDealPayments and normalised into the same shape at the edge, rather than "
             "branching per flow at every point an order is read &mdash; which is how three "
             "settlement paths become three subtly different ones. Rows still keyed on their own "
             "receipt are excluded on every flow, so a failed initiation is not asked about forever. "
             "Asserted end to end: the harness leaves a stale deal, stubs a captured payment, and "
             "checks the credits actually reach the pool rather than only the deal row flipping.",
             ACTION_NONE],
            ["57. Alerting for orders stuck pending",
             STATUS_DONE,
             "The reconciler alerts on every repair and distinguishes a genuine rescue from a merely "
             "stale row. A successful repair is deliberately treated as bad news &mdash; it means a "
             "webhook that should have arrived did not.",
             ACTION_NONE],
            ["58. Alerting for webhook signature failures",
             STATUS_DONE,
             "HandleRazorpayWebhook.js:236, ERROR severity, deduped by (source, title) so a flood "
             "produces one growing row rather than a wall.",
             ACTION_NONE],
            ["59. Alerting for amount mismatches",
             STATUS_DONE,
             "<font face='Courier'>assertReportedAmountMatchesOrder</font> alerts and settles "
             "nothing; the reconciler raises the equivalent on its own path. Both name the flow and "
             "the exact field that differed.",
             ACTION_NONE],
            ["60. Alerting for captured payments with no local order [B8]",
             STATUS_DONE,
             "HandleRazorpayWebhook.js:587, reached only after the credit, deal and deck lookups all "
             "miss. The message says plainly that a customer may have been charged with nothing "
             "provisioned.",
             ACTION_NONE],
            ["61. Internal reconciliation of ledger against accounting records",
             STATUS_GAP,
             "Searched for explicitly; no such comparison exists. The inputs are all present "
             "(creditTransactions, purchases, pendingOrders, webhookEvents, paymentAttempts) but "
             "nothing compares them against an accounting source.",
             ACTION_CHANGE],
            ["62. External reconciliation against the bank is defined and owned",
             STATUS_GAP,
             "No owner is named anywhere in the repository. This is an ownership decision rather "
             "than an engineering task.",
             ACTION_CHANGE],
        ]),
    ]))

    # 13. Part 8 — SaaS specifics.
    story.extend(section("Part 8 &mdash; SaaS specifics", [
        finding_table([
            ["63. Recurring billing is deliberate, with a swappable entitlement layer",
             STATUS_DONE,
             "Plan &#8594; subscription &#8594; <font face='Courier'>subscription.charged</font> "
             "drives credits and entitlement through PlanSubscriptionService, the only writer of "
             "plan state. <font face='Courier'>supportsRecurringSubscriptions()</font> keeps "
             "one-time-only providers from having to implement any of it.",
             ACTION_NONE],
            ["64. Indian regulatory reality respected",
             STATUS_DONE,
             "AFA is handled by Razorpay's hosted mandate page "
             "(<font face='Courier'>shortUrl</font>), pre-debit notice by "
             "<font face='Courier'>customer_notify</font>, and the cap by the plan amount. A failed "
             "charge produces <font face='Courier'>subscription.pending</font>, which explicitly "
             "does <b>not</b> shorten <font face='Courier'>planExpiresAt</font> &mdash; a grace "
             "window rather than a midnight cut-off.",
             ACTION_NONE],
            ["65. No raw card numbers stored anywhere",
             STATUS_DONE,
             "Searched the whole payment surface. The only instrument field stored is "
             "<font face='Courier'>method</font> (card / upi / netbanking), and "
             "PaymentAttemptQueryEngine.js:115 carries an explicit comment that it must never become "
             "an identifier.",
             ACTION_NONE],
            ["66. Tax invoicing compliant for the jurisdiction",
             STATUS_NA,
             "Handled outside the application by the owner's decision. Checked rather than assumed: "
             "the in-app receipt never claims to be a GST tax invoice &mdash; it carries no GSTIN, "
             "no HSN/SAC and no place-of-supply field.",
             ACTION_NA],
            ["67. Proration on upgrade computed server-side; a paid order never repriced",
             STATUS_DONE,
             "<font face='Courier'>ChangeSubscriptionPlan</font> prices from "
             "<font face='Courier'>PlanMetadata</font> server-side. Settlement records the amount "
             "actually captured, not a price recomputed later: "
             "<font face='Courier'>resolveChargedAmountMinor</font> takes the order total for a "
             "single deck and splits a basket proportionally with the last deck absorbing rounding, "
             "so the per-deck rows sum exactly to what was charged.",
             ACTION_NONE],
            ["68. A controlled internal refund tool",
             STATUS_NA,
             "Not applicable <b>by design and enforced in code</b>, not merely unbuilt. "
             "<font face='Courier'>RefundPolicy.REFUNDS_OFFERED</font> is false, "
             "<font face='Courier'>PaymentProvider.refund()</font> throws for every provider, and no "
             "subclass declares one &mdash; verified by search this pass: all three providers carry "
             "only a comment recording that the deletion was deliberate. No code path in this "
             "application can call a refund API.",
             ACTION_NA],
            ["69. Tokenisation binds tokens to customer and merchant; no PANs",
             STATUS_NA,
             "The application offers no tokenisation. Saved instruments, where they exist, live "
             "entirely inside Razorpay.",
             ACTION_NA],
            ["70. 3D Secure provider-handled; its failure modes classified separately",
             STATUS_PART,
             "3DS is entirely inside the hosted widget, correctly. The classification half is "
             "partial: <font face='Courier'>errorStep</font> and "
             "<font face='Courier'>errorReason</font> are stored verbatim &mdash; which is where "
             "Razorpay reports an authentication failure &mdash; but nothing distinguishes an "
             "authentication failure from a genuine decline when counting. The data is there; the "
             "distinction is not drawn.",
             ACTION_CHANGE],
        ]),
    ]))

    # 14. Part 9 [A].
    story.extend(section("Part 9 &mdash; Threat model [A]: order and pricing manipulation", [
        finding_table([
            ["71. [A1] Amount tampering structurally impossible",
             STATUS_DONE,
             "No buyer-facing handler reads a price from a body; every amount comes from a "
             "server-side pricing engine. The strict schema plugin removes even the silence &mdash; "
             "a caller probing for <font face='Courier'>amount</font> now gets a distinct refusal "
             "rather than an indistinguishable success.",
             ACTION_NONE],
            ["72. [A2] Currency and price region not buyer-selectable to advantage",
             STATUS_DONE,
             "<font face='Courier'>RegionResolver</font> runs a fixed cascade &mdash; explicit pick, "
             "Cloudflare <font face='Courier'>cf-ipcountry</font>, validated locale hint, default "
             "&mdash; and every candidate must pass "
             "<font face='Courier'>isValidRegion</font>. The region is frozen onto the order row, "
             "and <font face='Courier'>SettlementAmountGuard</font> compares currency exactly "
             "(case-insensitively), so 49900 of one currency can never settle 49900 of another.",
             ACTION_NONE],
            ["73. [A3] Quantities and amounts bounded, integer and positive",
             STATUS_DONE,
             "<font face='Courier'>isChargeableAmount</font> enforces a safe integer in "
             "[100, 10,000,000] and is now applied by every endpoint that creates a remote order, "
             "including <font face='Courier'>CreateOrganizationCreditDeal.js:101</font>. The band "
             "is deliberately applied only on the ON_SPOT path there: an offline deal is "
             "bookkeeping for money that already moved elsewhere and may legitimately record any "
             "non-negative figure, so gating both would have broken a real flow to satisfy a "
             "control that does not describe it.",
             ACTION_NONE],
            ["74. [A4] Coupon redemption atomic, once-per-user, released on failure",
             STATUS_DONE,
             "<font face='Courier'>CouponCheckoutService.resolveAndReserve</font> claims a slot "
             "atomically against a unique (couponId, userId) row, and every failure path in "
             "InitiateCreditPurchase calls <font face='Courier'>release</font> &mdash; the "
             "below-minimum case, the out-of-band case and the provider-failure case alike.",
             ACTION_NONE],
            ["75. [A5] Cross-tenant order creation impossible",
             STATUS_DONE,
             "Identity is always <font face='Courier'>session.getUserId()</font>; no endpoint "
             "accepts a userId in a body. The organization deal takes an organizationId but resolves "
             "authority through "
             "<font face='Courier'>OrganizationAuthorityResolver.requirePower</font> and then "
             "re-checks that the deal's target matches it.",
             ACTION_NONE],
            ["76. [A6] Order-creation flooding rate limited and authenticated",
             STATUS_DONE,
             "Every initiation route carries <font face='Courier'>ensureLogin</font> plus the global "
             "per-user limiter and a default per-endpoint cap. Order reuse now does the heavier "
             "lifting: a repeated click on the same basket returns the existing order instead of "
             "minting a second one, so the commonest flooding shape no longer reaches the provider "
             "at all.",
             ACTION_NONE],
            ["77. [A7] Order ids stay out of URLs, referrers and analytics",
             STATUS_DONE,
             "No provider order id appears in any URL &mdash; all five verify legs are POSTs with a "
             "JSON body. The one identifier that does appear in a query string is the internal "
             "purchase UUID on <font face='Courier'>/PaidDecks/Purchases/Invoice</font>, which is "
             "non-sequential, owner-scoped, and shielded from cross-origin leakage by "
             "<font face='Courier'>Referrer-Policy: strict-origin-when-cross-origin</font>. No "
             "analytics script exists to receive either.",
             ACTION_NONE],
            ["78. [A8] The purchase is frozen into the order; no live cart at fulfilment",
             STATUS_DONE,
             "<font face='Courier'>pendingOrder.deckIds</font> is the authoritative list and "
             "<font face='Courier'>pendingOrder.amountMinor</font> the authoritative figure. Pricing "
             "is recomputed at settlement only for licence duration and perk metadata &mdash; "
             "properties of the deck rather than of the money &mdash; and the code says so at the "
             "point it happens.",
             ACTION_NONE],
            ["79. [A9] Plan eligibility authorised separately from pricing",
             STATUS_DONE,
             "<font face='Courier'>PlanMetadata.isPaidTier</font> gates the tier before any price is "
             "looked up, and a tier with no configured price returns SUBSCRIPTION_NOT_CONFIGURED "
             "rather than a zero-priced order. The monthly free-deck perk is re-authorised "
             "server-side against the stored tier, never the claim in the request.",
             ACTION_NONE],
        ]),
    ]))

    # 15. Part 9 [B].
    story.extend(section("Part 9 &mdash; Threat model [B]: forgery, replay and the client", [
        finding_table([
            ["80. [B1] A forged success callback provisions nothing",
             STATUS_DONE,
             "The signature is HMAC-SHA256 under the key secret, which the browser never holds. "
             "Asserted directly by the adversarial harness, which submits fabricated triples against "
             "real order rows and confirms each is refused.",
             ACTION_NONE],
            ["81. [B2] A signature cannot be replayed across accounts or consumed twice",
             STATUS_DONE,
             "Across accounts: the ownership check precedes verification. Twice: the "
             "PENDING&#8594;CONSUMED transition is scoped to (providerOrderId, userId) and only one "
             "caller ever sees <font face='Courier'>transitioned</font>.",
             ACTION_NONE],
            ["82. [B3] Concurrent submission cannot double-fulfil",
             STATUS_DONE,
             "The grant claim serialises the browser leg against the webhook against the reconciler. "
             "The reliability harness drives all three orderings and asserts exactly one grant "
             "results.",
             ACTION_NONE],
            ["83. [B4] The payment page is defended by an ENFORCED policy",
             STATUS_DONE,
             "Judged on the enforced policy, not a candidate &mdash; and the strict policy is now "
             "the ENFORCED default. <font face='Courier'>script-src</font> drops "
             "<font face='Courier'>'unsafe-inline'</font> and "
             "<font face='Courier'>'unsafe-eval'</font> and replaces blanket "
             "<font face='Courier'>https:</font> with two named origins, so an injected "
             "<font face='Courier'>&lt;script&gt;</font> on the payment page is genuinely blocked. "
             "The permissive policy survives only when "
             "<font face='Courier'>CONTENT_SECURITY_POLICY_MODE</font> is set to "
             "<font face='Courier'>compatible</font>, and a mangled value falls towards strict; no "
             "env file present sets it. <b>One collateral effect was observed at runtime and needs "
             "attention:</b> the enforced allow-list names "
             "<font face='Courier'>checkout.razorpay.com</font> but not "
             "<font face='Courier'>cdn.razorpay.com</font>, so the risk-detection bundle Razorpay's "
             "own checkout script fetches is refused on every page load, in every environment. The "
             "policy is doing its job; the allow-list is one origin short of what the provider "
             "needs.",
             ACTION_CHANGE],
            ["84. [B5] Frontend supply chain controlled",
             STATUS_DONE,
             "Confirmed by reading the markup this pass: no tag manager, no session replay, no chat "
             "widget, no error tracker. Advertising has been removed from the product outright "
             "&mdash; there is no loader, no script tag, and no advertising origin in "
             "<font face='Courier'>STRICT_SCRIPT_ORIGINS</font>, whose script-src now names only "
             "the Razorpay widget and the Cloudflare beacon. This supersedes the previous control, "
             "which injected AdSense for the home page only and suppressed it during checkout: that "
             "closed direct-to-purchase traffic but could not close a session which browsed Home "
             "first, because an injected script cannot be un-injected. That residual case no longer "
             "exists. Both <font face='Courier'>VerifyPaymentLifecycle.mjs</font> &sect;7 and "
             "<font face='Courier'>VerifySecurityHardening.mjs</font> assert the ABSENCE of the "
             "advertising origins by name, so a stale allow-list entry cannot outlive the code.",
             ACTION_NONE],
            ["85. [B6] State-changing payment endpoints are CSRF-protected",
             STATUS_DONE,
             "Every money route is POST-only and the session cookie is "
             "<font face='Courier'>httpOnly</font> with "
             "<font face='Courier'>sameSite: &quot;lax&quot;</font>, which browsers do not attach to "
             "a cross-site POST. The OAuth leg additionally uses a single-use state token in its own "
             "httpOnly cookie.",
             ACTION_NONE],
            ["86. [B7] The payment page is not framable by others",
             STATUS_DONE,
             "<font face='Courier'>frame-ancestors 'self'</font> plus "
             "<font face='Courier'>X-Frame-Options: SAMEORIGIN</font>, both stamped by a global "
             "plugin at EXTEMELY_HIGH priority so they are present even on a short-circuit 429 or "
             "403.",
             ACTION_NONE],
            ["87. [B8] A cloned checkout cannot provision, and is detected",
             STATUS_DONE,
             "Provisioning requires a local order row keyed by the provider's order id; a clone "
             "using the public key id creates an order this server has never heard of. Detection is "
             "the captured-payment-with-no-local-order alert.",
             ACTION_NONE],
            ["88. [B9] No state change reachable from a public route without a captured payment",
             STATUS_DONE,
             "Enumerated route by route again. The eight session-facing money routes carry "
             "<font face='Courier'>ensureLogin</font> (or <font face='Courier'>ensureOrgAdmin</font>) "
             "plus <font face='Courier'>ensurePaymentAccess</font>; all three admin deal routes carry "
             "<font face='Courier'>ensureAdmin</font>. "
             "<font face='Courier'>/Webhooks/Razorpay</font> is deliberately ungated &mdash; the "
             "provider carries no session and its HMAC is the boundary &mdash; and "
             "<font face='Courier'>/Subscription/Cancel</font> is deliberately ungated so a "
             "non-admin who already holds a subscription outside production is not stranded.<br/><br/>"
             "<b>The new organization deck shelf was the interesting case</b>, because it issues a "
             "real licence with no order, no provider and no payment anywhere on the path. It "
             "holds: <font face='Courier'>AddOrganizationDeck</font> requires active membership, "
             "resolves the deck through an organization-SCOPED lookup so membership of one "
             "institute cannot reach another's material, refuses an unpublished deck with the same "
             "answer as a non-existent one, and refuses a re-grant rather than re-seeding over "
             "someone's progress. The claim that these decks are unpurchasable was verified rather "
             "than accepted: <font face='Courier'>InitiatePurchase.js:100</font> refuses them "
             "BEFORE pricing and before any coupon is reserved, so no payment path exists for one "
             "at all.",
             ACTION_NONE],
            ["89. [B10] Full security-header baseline on payment responses",
             STATUS_DONE,
             "CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy and "
             "HSTS. <font face='Courier'>Permissions-Policy</font> denies "
             "<font face='Courier'>payment=()</font>, which specifically stops injected script "
             "invoking the Payment Request API from this origin. HSTS is emitted only on secure "
             "requests, so plain-http local development is unaffected.",
             ACTION_NONE],
        ]),
    ]))

    # 16. Part 9 [C] and [D].
    story.extend(section("Part 9 &mdash; Threat model [C] and [D]: verification, injection, payloads", [
        finding_table([
            ["90. [C1] Verification cannot be omitted, weakened, type-confused or bypassed",
             STATUS_DONE,
             "Type guards precede all crypto; comparison is constant-time; the verifier is resolved "
             "from the stored row. Fifty assertions in "
             "<font face='Courier'>VerifyRazorpaySignatures.mjs</font> cover the tampering, "
             "truncation and type-confusion cases and were executed during this audit.",
             ACTION_NONE],
            ["91. [C6] Payment identifiers cannot reach a query as an operator",
             STATUS_DONE,
             "Every query engine that takes an identifier type-guards it with "
             "<font face='Courier'>typeof x !== &quot;string&quot;</font> before it reaches Mongo "
             "&mdash; verified in PendingOrderQueryEngine, PendingCreditOrderQueryEngine and "
             "CreditDealPaymentQueryEngine. A supplied object is rejected rather than interpreted as "
             "an operator.",
             ACTION_NONE],
            ["92. [D5] Provider strings treated as hostile on output",
             STATUS_DONE,
             "<font face='Courier'>GetPurchaseInvoice</font> escapes every interpolated value "
             "through <font face='Courier'>#escapeHtml</font>, including both provider identifiers. "
             "There is no CSV export anywhere in the application, so the formula-injection half of "
             "this control has no surface &mdash; confirmed by search rather than assumed.",
             ACTION_NONE],
            ["93. [D6] Untrusted payload JSON never deep-merged",
             STATUS_DONE,
             "Every field is read by explicit path. No <font face='Courier'>Object.assign</font>, "
             "spread or merge of a provider payload into an application object appears anywhere on "
             "the payment surface.",
             ACTION_NONE],
        ]),
    ]))

    # 17. Part 9 [E].
    story.extend(section("Part 9 &mdash; Threat model [E]: secrets and infrastructure", [
        finding_table([
            ["94. [E1] Key compromise paths closed; rotation documented",
             STATUS_PART,
             "The code paths are closed and rotation is documented in "
             "<font face='Courier'>.env.example</font> and the incident runbook. The tooling half "
             "&mdash; CI secret scanning &mdash; is deliberately out of scope by the repository "
             "owner's decision, recorded here rather than dropped.",
             ACTION_EXCLUDED],
            ["95. [E3] Dashboard access treated as production infrastructure",
             STATUS_NA,
             "An organisational control with no repository surface. Nothing in the code assumes "
             "dashboard access is restricted.",
             ACTION_NA],
            ["96. [E4] TLS enforced end to end with certificate validation intact",
             STATUS_DONE,
             "All provider calls use <font face='Courier'>https://api.razorpay.com</font> through "
             "Node's <font face='Courier'>fetch</font> with default certificate validation. No "
             "<font face='Courier'>rejectUnauthorized: false</font> and no "
             "<font face='Courier'>NODE_TLS_REJECT_UNAUTHORIZED</font> override appears anywhere. "
             "Inbound TLS terminates at Cloudflare with HSTS asserted.",
             ACTION_NONE],
            ["97. [E6] A test key in production, or a live key outside it, refuses to start",
             STATUS_DONE,
             "Both directions are FATAL and call <font face='Courier'>process.exit(1)</font>. The one "
             "relaxation &mdash; a local <font face='Courier'>npm run production</font>, detected by "
             "the absence of <font face='Courier'>COGNIUMLEARN_SECRETS_DIRECTORY</font> &mdash; "
             "emits a WARNING so the operator is never left guessing whether the strict gate ran. "
             "Under section B3 this now carries a compensating control: a mis-copied env file has a "
             "blast radius of administrators rather than every user pointed at that environment, "
             "because <font face='Courier'>PaymentAccessPolicy</font> restricts payments outside "
             "production and fails closed while unconfigured &mdash; refusing administrators too, "
             "so a boot-order mistake cannot hide behind still-working admin flows.",
             ACTION_NONE],
            ["98. [E7] Payment payloads do not leak PII into logs or third-party trackers",
             STATUS_DONE,
             "Alert metadata carries order ids, payment ids, amounts and an "
             "<font face='Courier'>accountId</font> &mdash; never an email or a name. "
             "<font face='Courier'>SettlementAmountGuard.describe</font> is documented as log-safe "
             "and emits only amounts, currencies and order ids. There is no third-party error "
             "tracker to leak to.",
             ACTION_NONE],
            ["99. [E8] Endpoint compromise acknowledged as a path around every secrets control",
             STATUS_DONE,
             "Acknowledged in <font face='Courier'>PaymentIncidentRunbook.md</font>. Honest rather "
             "than solved: no application-level control survives a compromised server, and the "
             "runbook says so rather than implying otherwise.",
             ACTION_NONE],
        ]),
    ]))

    # 18. Part 9 [F] and [G].
    story.extend(section("Part 9 &mdash; Threat model [F] and [G]: fraud, abuse and lifecycle", [
        finding_table([
            ["100. [F1] Card testing deterred",
             STATUS_DONE,
             "Authentication precedes every checkout, rate limits apply, and "
             "<font face='Courier'>countRecentFailures</font> / "
             "<font face='Courier'>isFailureBurst</font> raise a WARNING at six declines in ten "
             "minutes. The alert text is careful to say that the same shape is also a buyer with a "
             "genuinely failing card &mdash; a detector that overclaims gets ignored.",
             ACTION_NONE],
            ["101. [F2] Chargeback evidence captured at purchase time",
             STATUS_DONE,
             "The Purchase row records buyer, deck, amount charged, currency, region, both provider "
             "identifiers and a timestamp; the webhook-event row keeps the signed bytes; the attempt "
             "row keeps the instrument class and the provider's own error taxonomy verbatim &mdash; "
             "which is what a dispute is argued in months later.",
             ACTION_NONE],
            ["102. [F3] A refund revokes the entitlement it paid for",
             STATUS_PART,
             "<font face='Courier'>PaymentReversalService</font> claws back credits to a floor of "
             "zero and revokes deck licences as REVOKED rather than EXPIRED &mdash; a real "
             "distinction, since expired means the term ran out and revoked means the purchase was "
             "undone. Every write is keyed on the refund id. It now attributes three of the four "
             "flows &mdash; credits, paid decks and organization credit deals, the last through "
             "<font face='Courier'>OrganizationCreditLedger.clawBack</font>, which is deliberately "
             "NOT <font face='Courier'>debit</font>: a clawback must still empty a FROZEN pool (the "
             "money has gone back either way) and must recover partially rather than refusing "
             "all-or-nothing. A reversed subscription charge remains alert-only.",
             ACTION_CHANGE],
            ["103. [F4] Refunds audited and reconciled against approvals",
             STATUS_NA,
             "No refund is ever issued from this application, so there are no approvals to reconcile "
             "against. Not applicable by design and enforced in code &mdash; see control 68.",
             ACTION_NA],
            ["104. [F5] Billing-sensitive account changes protected against takeover",
             STATUS_DONE,
             "Every billing action requires a live session; organization billing additionally "
             "requires the DISTRIBUTE_CREDITS power resolved per organization, and organization "
             "admin verification runs through a separate OTP flow.",
             ACTION_NONE],
            ["105. [F6] Trial and free-tier eligibility resists plus-addressing",
             STATUS_NA,
             "There is no trial. The signup grant is deliberately small &mdash; "
             "CreditConfiguration.js:33 states it is sized to limit farming via disposable aliases "
             "&mdash; so the abuse this control guards has no meaningful prize.",
             ACTION_NA],
            ["106. [F7] The refund path is idempotent, to the original instrument, approval-gated",
             STATUS_NA,
             "There is no refund path to hold these properties, and its absence is enforced rather "
             "than incidental.",
             ACTION_NA],
            ["107. [F8] Business rules enforced server-side at the state change, from server time",
             STATUS_DONE,
             "Pack membership, plan tier, coupon eligibility, the free-deck claim and licence "
             "duration are all re-checked server-side at fulfilment from server-held time. The "
             "explicit-duration gate runs at both initiation and settlement, and the settlement copy "
             "alerts rather than minting a forever licence if pricing moved in between.",
             ACTION_NONE],
            ["108. [G1] Refunds and chargebacks revoke entitlement automatically",
             STATUS_PART,
             "Automatic for three of four flows now, including the largest: a chargeback against an "
             "organization deal empties the pool to a floor of zero, marks the deal REFUNDED so it "
             "stops reading as money received, and quantifies whatever had already been distributed "
             "and could not be recovered. Only a reversed subscription charge still needs a human.",
             ACTION_CHANGE],
            ["109. [G2] A refund mid-provisioning cannot leave an account paid-and-refunded but active",
             STATUS_PART,
             "Every revocation is status-scoped (ACTIVE licences, COMPLETED purchases, CAPTURED "
             "deals) so it converges whichever order the two events arrive in, and the pool "
             "clawback re-derives the recoverable amount inside a bounded compare-and-set loop &mdash; "
             "reading it once would let a distribution landing mid-reversal make the update match "
             "nothing and silently recover zero. Same single coverage limit as 108.",
             ACTION_CHANGE],
            ["110. [G3] No card data retained; payment metadata retention deliberate",
             STATUS_DONE,
             "No card data exists to retain. Retention is deliberate and documented per collection: "
             "pending orders 14 days, payment attempts 90, webhook events long enough to serve as "
             "dispute evidence. The 14-day figure carries its own reasoning &mdash; the row is the "
             "only local evidence a payment was attempted, so deleting it destroys the starting "
             "point of any &quot;I paid and got nothing&quot; investigation. <b>All four</b> "
             "TTL-bearing collections now apply their expiry through "
             "<font face='Courier'>TimeToLiveIndexReconciler</font>, which is what makes a retention "
             "change actually take effect on an existing deployment instead of raising an "
             "IndexOptionsConflict that a catch-and-log swallows.",
             ACTION_NONE],
            ["111. [G4] Every payment read scoped to the authenticated account",
             STATUS_DONE,
             "<font face='Courier'>GetPurchaseInvoice</font> queries "
             "<font face='Courier'>{id, userId}</font> together and returns <b>404</b> rather than "
             "403 on a mismatch, so the identifier's existence is not disclosed. "
             "<font face='Courier'>GetMyPurchases</font> filters on the session user and strips "
             "licence key material through <font face='Courier'>LicenseClientView</font>. "
             "Identifiers are UUIDs, and the invoice is served "
             "<font face='Courier'>Cache-Control: no-store</font>.",
             ACTION_NONE],
        ]),
    ]))

    # 19. Part 9.9 — priority table.
    story.extend(section("Part 9.9 &mdash; The handbook's fifteen priority controls", [
        make_table(
            ["#", "Priority control", "Status in this repository"],
            [
                ["1", "Server-side order creation; the amount never comes from the client [A1]", STATUS_DONE],
                ["2", "Signature verification on every payment return path [C1]", STATUS_DONE],
                ["3", "Verification against the stored order, not the request [C2]", STATUS_DONE],
                ["4", "Webhook HMAC computed over the raw body [D2]", STATUS_DONE],
                ["5", "Fulfilment idempotent and serialised [B3]", STATUS_DONE],
                ["6", "Provision only on captured, never on authorized [C5]", STATUS_DONE],
                ["7", "Order-to-buyer binding held server-side [A5 / B2]", STATUS_DONE],
                ["8", "Duplicate webhook delivery gated on a unique event id [D3]", STATUS_DONE],
                ["9", "Amount and currency re-asserted before fulfilment [C4]", STATUS_DONE],
                ["10", "Key secret server-only and never committed [E1]", STATUS_DONE],
                ["11", "Key mode matches the environment, enforced at boot [E6]", STATUS_DONE],
                ["12", "Reconciliation repairs orders the webhook never settled", STATUS_DONE],
                ["13", "Alerting on the money-critical conditions", STATUS_DONE],
                ["14", "The payment page carries no third-party script [B5]", STATUS_DONE],
                ["15", "Every payment read scoped to the account [G4]", STATUS_DONE],
            ],
            [5, 62, 33]),
        Spacer(1, 8),
        make_callout(
            "<b>Fifteen of fifteen met.</b> The one partial at the last pass was reconciliation, "
            "whose gap was coverage rather than design; the sweep now reaches all three "
            "order-creating flows and the repair is asserted end to end rather than inferred from "
            "the code reading correctly. Worth stating what this table does and does not claim: it "
            "is the handbook's ranked list of controls that <i>prevent loss</i>, and every one of "
            "them is met with independent layers rather than a single mechanism. It says nothing "
            "about the controls that <i>detect</i> loss after the fact, where this repository is "
            "genuinely weaker &mdash; see the monitoring table and the gap register."),
    ]))

    # 20. Part 9.10 — monitoring.
    story.extend(section("Part 9.10 &mdash; Continuous monitoring", [
        finding_table([
            ["112. Leaked-secret monitoring in public sources",
             STATUS_GAP,
             "Genuinely absent, and deliberately so &mdash; excluded from scope by the repository "
             "owner's decision (specification section B). Recorded rather than dropped, so a reader "
             "can see it was considered and consciously deferred.",
             ACTION_EXCLUDED],
            ["113. Client-side script integrity monitoring on deployed bundles",
             STATUS_PART,
             "The strict CSP candidate reports any script from an unexpected origin, and those "
             "reports reach the admin Alerts tab. What is not monitored is change to an "
             "<i>already-authorised</i> script &mdash; which for the one remote script is "
             "structurally unmonitorable, since Razorpay mutates it on purpose.",
             ACTION_CHANGE],
            ["114. Brand and credential exposure monitoring",
             STATUS_GAP,
             "No implementation. Adjacent to the excluded tooling in section B and, like it, an "
             "operational subscription rather than an engineering task.",
             ACTION_EXCLUDED],
            ["115. The handbook's indicator list has somewhere to fire",
             STATUS_DONE,
             "Six distinct alert sources fire today, all into the same admin Alerts tab: "
             "RAZORPAY_WEBHOOK (signature failure, amount mismatch, captured-with-no-order), "
             "PAYMENT_RECONCILER (repair, and captured-but-mismatched), PAYMENT_REVERSAL (refund or "
             "chargeback, and unattributable refund), PAYMENT_ATTEMPT (decline burst), "
             "PAID_DECK_SETTLEMENT (a paid-for deck withheld at settlement), and the CSP report "
             "stream. Named individually rather than claimed in aggregate.",
             ACTION_NONE],
        ]),
    ]))

    # 21. Part 10 — testing.
    story.extend(section("Part 10 &mdash; Testing", [
        finding_table([
            ["116. Test mode used for development and cannot be confused with live",
             STATUS_DONE,
             "Confirmed on disk: every key-bearing env file uses "
             "<font face='Courier'>rzp_test_</font>, production is blank, and the boot gate refuses "
             "a mismatch in either direction.",
             ACTION_NONE],
            ["117. Local webhook testing possible through a tunnel",
             STATUS_DONE,
             "Documented in the incident runbook and the local-development notes. The webhook route "
             "needs no allowlist, so a tunnel is sufficient.",
             ACTION_NONE],
            ["118. A functional matrix covers happy path, edge cases, reliability, money movement",
             STATUS_DONE,
             "Four harnesses, <b>all executed during this audit</b>: "
             "<font face='Courier'>VerifyRazorpaySignatures</font> 50, "
             "<font face='Courier'>VerifyPaymentSettlementReliability</font> 51, "
             "<font face='Courier'>VerifyPaymentAdversarial</font> 33 and "
             "<font face='Courier'>VerifyPaymentLifecycle</font> 168 &mdash; "
             "<b>302 assertions, 0 failures</b>, up from 268 at the last pass. The 34 new ones "
             "cover exactly the flow that was weakest: receipt determinism, the delete that must "
             "not touch a real order, reuse, reconciliation reaching the pool, and the clawback's "
             "floor / frozen-pool / replay behaviour. Four organization harnesses add a further "
             "140 (also run; one database-tier case each skips by design without an opt-in).",
             ACTION_NONE],
            ["119. Signature verification has a non-vacuous regression test",
             STATUS_DONE,
             "The signature harness asserts that a tampered order id, a tampered payment id, a "
             "truncated signature and a type-confused field are each rejected &mdash; and asserts "
             "the valid triple passes, which is what makes the negative cases non-vacuous rather "
             "than a verifier that refuses everything.",
             ACTION_NONE],
            ["120. An adversarial checklist run against a production-like environment",
             STATUS_PART,
             "<font face='Courier'>PaymentAdversarialChecklist.md</font> exists across nine attack "
             "categories and its automatable subset is the 33-assertion harness; its own closing "
             "section is honest that the browser-, server- and dashboard-dependent rows have not "
             "been walked against staging. A second gap is sharper than it was: searched this pass, "
             "the checklist contains <b>no mention of the organization or credit-deal flow at "
             "all</b>. The newest money path &mdash; and the one transacting the largest amounts "
             "&mdash; is absent from the document meant to be walked against it.",
             ACTION_CHANGE],
        ]),
    ]))

    # 22. Part 11 — go-live.
    story.extend(section("Part 11 &mdash; Go-live checklist", [
        finding_table([
            ["121. A runbook for &quot;payment succeeded but no access&quot;",
             STATUS_DONE,
             "<font face='Courier'>Common/ReadmeFiles/PaymentIncidentRunbook.md</font>, 243 lines. "
             "Its starting evidence is now durable rather than self-erasing: pending rows survive 14 "
             "days and the reconciler repairs the case automatically within 48 hours, so the runbook "
             "is a fallback rather than the only recovery.",
             ACTION_NONE],
            ["122. A secret-rotation procedure documented and rehearsed",
             STATUS_PART,
             "Documented, and the code supports it properly &mdash; the previous webhook secret is "
             "accepted during a rotation window and its use is recorded per delivery, which is what "
             "tells an operator when the old secret is safe to retire. Not rehearsed against a real "
             "environment.",
             ACTION_CHANGE],
            ["123. Every payment read endpoint covered by an authorisation test",
             STATUS_DONE,
             "The lifecycle harness seeds <b>two</b> buyers rather than one, so a leak is detectable "
             "rather than merely absent: an owner sees their invoice, a second account naming the "
             "identifier exactly gets a 404 with a null body, and a signed-out caller is refused "
             "before any lookup runs.",
             ACTION_NONE],
            ["124. Live-mode configuration verified",
             STATUS_PART,
             "The repository half is verified: keys blank in "
             "<font face='Courier'>.production.env</font>, rendered from Secret Manager on a "
             "deployed node, the boot gate in place. Four dashboard-side settings &mdash; "
             "auto-capture, webhook registration, callback domains and the settlement account "
             "&mdash; cannot be asserted from here. The published refund policy is settled: the "
             "product does not offer refunds, and that is enforced in code rather than only stated.",
             ACTION_CHANGE],
        ]),
    ]))

    # 23. Part 12 — known pitfalls.
    story.extend(section("Part 12 &mdash; The seventeen known pitfalls", [
        make_table(
            ["#", "Pitfall", "Verdict", "Note"],
            [
                ["1", "Trusting the amount from the client", "<b><font color='#1A6B62'>Absent</font></b>",
                 "No buyer-facing handler reads a price from a body."],
                ["2", "Skipping signature verification on the browser return", "<b><font color='#1A6B62'>Absent</font></b>",
                 "All five verify legs are fail-closed."],
                ["3", "Verifying against the order id in the request body", "<b><font color='#1A6B62'>Absent</font></b>",
                 "The row is looked up and ownership asserted first."],
                ["4", "Re-serialising the webhook body before the HMAC", "<b><font color='#1A6B62'>Absent</font></b>",
                 "PLAIN_TEXT_BODY preserves the signed bytes."],
                ["5", "Provisioning on authorized instead of captured", "<b><font color='#1A6B62'>Absent</font></b>",
                 "Both the webhook and the reconciler require captured."],
                ["6", "No idempotency, so a retry double-grants", "<b><font color='#1A6B62'>Absent</font></b>",
                 "Three layers, verified by 51 reliability assertions."],
                ["7", "Returning 4xx from the webhook and causing retry storms", "<b><font color='#1A6B62'>Absent</font></b>",
                 "Every benign failure acks 200 and alerts instead."],
                ["8", "Assuming webhook ordering", "<b><font color='#1A6B62'>Absent</font></b>",
                 "Entitlement extension never shortens."],
                ["9", "Timestamp-based receipts, so retries fork the order", "<b><font color='#1A6B62'>Absent</font></b>",
                 "No receipt on the surface reads the clock; all three flows hash their intent."],
                ["10", "Creating the remote order before the local record", "<b><font color='#1A6B62'>Absent</font></b>",
                 "All three flows write locally first and clean up a failed provider call."],
                ["11", "Storing money as a float", "<b><font color='#1A6B62'>Absent</font></b>",
                 "Integer minor units; BSON double is exact at these magnitudes."],
                ["12", "Leaking the key secret to the browser or logs", "<b><font color='#1A6B62'>Absent</font></b>",
                 "Private field; only the public key id is ever sent."],
                ["13", "A test key in production, or a live key outside it", "<b><font color='#1A6B62'>Absent</font></b>",
                 "Both directions are a fatal boot failure."],
                ["14", "No reconciliation for the paid-but-not-settled case", "<b><font color='#1A6B62'>Absent</font></b>",
                 "Sweep reaches all three order-creating flows and alerts on every repair."],
                ["15", "Third-party script on the payment page", "<b><font color='#1A6B62'>Absent</font></b>",
                 "Advertising removed from the product; the Razorpay widget is the only third-party "
                 "script the markup loads. It pulls a second Razorpay origin of its own at runtime "
                 "&mdash; see control 28; the origin is the provider's, but the inventory omits it."],
                ["16", "Refund or chargeback leaving entitlement intact", "<b><font color='#B8791C'>Partly</font></b>",
                 "Reversed for credits, decks and organization pools; alert-only for subscriptions."],
                ["17", "Payment reads not scoped to the buyer", "<b><font color='#1A6B62'>Absent</font></b>",
                 "Owner-scoped queries, 404 on mismatch, two-buyer test."],
            ],
            [4, 33, 13, 50]),
        Spacer(1, 6),
        Paragraph(
            "Sixteen absent, one partly present, none fully present. The three that closed since "
            "the last pass were the same three symptoms of one cause &mdash; a flow built after the "
            "others were hardened, which has now inherited their controls. The survivor is the "
            "subscription half of pitfall 16, and it is a genuinely different case: there is no "
            "order to reconcile a subscription charge against, so closing it means new code rather "
            "than extending existing code to one more collection.", styles["body"]),
    ]))

    # 24. Gap register.
    story.extend(section("Gap register &mdash; ordered by the damage a realistic failure would cause", [
        Paragraph(
            "Every entry from the previous pass that could be closed in code has been, and each was "
            "re-read in the source this pass rather than marked done on the strength of the change "
            "that was made to it. What follows is what is actually left.", styles["body"]),
        make_table(
            ["Ref", "Gap and why it matters", "Recommended fix", "Leave as is?", "Action"],
            [
                ["102, 108, 109<br/>subscription<br/>reversal",
                 "A reversed subscription charge alerts but reverses nothing. It is the last "
                 "unattributed flow, and it is structurally different from the three now covered: a "
                 "recurring charge has no order row to look up, so there is nothing for the existing "
                 "attribution cascade to fall through to.",
                 "Attribute from the charge payment id back to the UserSubscription, then withdraw "
                 "that cycle's credits through the ledger's existing floor and reference key.",
                 "<b>Yes, for now.</b> A reversed charge already stops the next renewal and the alert "
                 "reaches a human, so the exposure is one cycle of credits on one account &mdash; "
                 "against an organization pool block, which is now covered, that is small. Worth "
                 "scheduling, not worth rushing.",
                 ACTION_CHANGE],
                ["28, 83<br/>strict CSP blocks<br/>a Razorpay script",
                 "The strict policy is now ENFORCED, which closes the previous pass's largest gap "
                 "&mdash; injected script on the payment page is genuinely blocked. It also blocks "
                 "something it should not. Loading the app in a real browser shows every page refuse "
                 "<font face='Courier'>cdn.razorpay.com/static/cx/razorpay-risk-detection/bundle.js</font>, "
                 "a script Razorpay's own checkout fetches for itself, because the allow-list names "
                 "<font face='Courier'>checkout.razorpay.com</font> only. No env file overrides the "
                 "policy, so this is the behaviour in production too. A second request to "
                 "<font face='Courier'>checkout-static-next.razorpay.com/build/undefined</font> is "
                 "also refused, and that literal <font face='Courier'>undefined</font> suggests the "
                 "checkout script is failing to derive something it expects.",
                 "Add <font face='Courier'>https://cdn.razorpay.com</font> to "
                 "<font face='Courier'>SecurityHeaders.STRICT_SCRIPT_ORIGINS</font> &mdash; a named "
                 "first-party provider origin, so the policy's strength is unchanged. Record it in "
                 "the script inventory, re-check the console for any further refusal, and add a "
                 "violation assertion to <font face='Courier'>VerifySecurityHardening.mjs</font> so "
                 "the next policy change cannot repeat this silently.",
                 "<b>No.</b> A fraud-detection component the provider ships is disabled today, in "
                 "every environment, and nothing alerts on it &mdash; a refused script is a console "
                 "message, not an exception, so the payment still completes and no gate notices. "
                 "This was found by watching a browser, which is the only way it could be.",
                 ACTION_NOW],
                ["120<br/>checklist misses<br/>a whole flow",
                 "The adversarial checklist contains no mention of the organization or credit-deal "
                 "flow. Its manual rows were already unwalked; the sharper problem is that walking "
                 "them would still not exercise the path transacting the largest amounts.",
                 "Add an organization section covering the deal-verify leg's cross-organization "
                 "refusal, the reuse path, and a chargeback against a partly-distributed pool. Then "
                 "walk the whole document against staging.",
                 "<b>No.</b> The automated subset now covers this flow well, which makes the "
                 "document the weakest part of the testing story rather than the code.",
                 ACTION_CHANGE],
                ["61, 62<br/>ledger vs bank",
                 "Nothing compares this system's ledger against an accounting source, and no owner is "
                 "named for settlement-versus-bank checking. A systematic shortfall would be "
                 "invisible until someone happened to look. This is now the clearest shape of "
                 "weakness on the surface: prevention is thorough, detection after the fact is not.",
                 "For 61, a scheduled job summing captured attempts against granted ledger entries "
                 "and alerting on divergence. For 62 there is nothing to build &mdash; name a person "
                 "and a cadence.",
                 "<b>Yes for 61</b> at current volume, where per-payment alerting catches the "
                 "individual case and the reconciler now closes the systematic one it was most "
                 "likely to miss. <b>No for 62</b>, which costs nothing but a decision.",
                 ACTION_CHANGE],
                ["55, 124<br/>dashboard<br/>settings",
                 "Four live-mode settings &mdash; auto-capture, webhook registration, callback "
                 "domains, settlement account &mdash; cannot be asserted from this repository. "
                 "Auto-capture is the one that matters: the code correctly refuses to provision on "
                 "anything but a captured payment, so were auto-capture off, buyers would pay and "
                 "receive nothing while every control in this report passed.",
                 "Someone with dashboard access confirms and initials each of the four.",
                 "<b>No</b> &mdash; it costs one person ten minutes, and it is the only remaining way "
                 "a customer could be charged and correctly receive nothing.",
                 ACTION_CHANGE],
            ],
            [14, 26, 24, 20, 16]),
        Spacer(1, 8),
        Paragraph("Lower-severity gaps", styles["h3"]),
        make_table(
            ["Ref", "Gap and why it matters", "Recommended fix", "Leave as is?", "Action"],
            [
                ["22<br/>deal reuse is<br/>scoped differently",
                 "The deal engine's <font face='Courier'>findReusableByReceipt</font>, "
                 "<font face='Courier'>attachProviderOrderId</font> and "
                 "<font face='Courier'>deleteUnclaimedDeal</font> are not owner-scoped, and reuse has "
                 "no time window &mdash; both differ from the two pending-order engines. Found by "
                 "comparing the three engines against each other rather than by reading the new one "
                 "alone.",
                 "If it is ever tightened: scope on "
                 "<font face='Courier'>createdByUserId</font> and borrow the 30-minute window.",
                 "<b>Yes, and deliberately.</b> The receipt is a 128-bit hash of the institute, the "
                 "block, the price and the term, so a collision IS the reuse case; the route is "
                 "super-admin only; and a negotiated contract does not go stale in thirty minutes "
                 "the way an abandoned checkout does. Recorded here so the difference reads as a "
                 "decision rather than a discrepancy someone finds later.",
                 ACTION_NONE],
                ["70<br/>3DS declines",
                 "Authentication failures and genuine declines are both counted as FAILED, so the "
                 "burst detector cannot tell an authentication problem from a card-testing pattern.",
                 "Derive a classification from <font face='Courier'>errorStep</font> at record time "
                 "and count the two separately.",
                 "<b>Yes.</b> The raw taxonomy is stored verbatim, so the distinction can be drawn "
                 "retrospectively whenever volume justifies it. Nothing is lost by waiting.",
                 ACTION_NONE],
                ["111<br/>invoice after<br/>reversal",
                 "<font face='Courier'>GetPurchaseInvoice</font> renders regardless of "
                 "<font face='Courier'>purchase.status</font>, so a REFUNDED purchase still produces "
                 "an invoice that says nothing about the reversal.",
                 "Render a REVERSED banner when the status is not COMPLETED.",
                 "<b>Yes.</b> Refunds are not offered, so this is reachable only through the "
                 "chargeback path, which already alerts a human and now revokes the entitlement. "
                 "Cosmetic against that.",
                 ACTION_NONE],
                ["113, 122<br/>monitoring and<br/>rotation rehearsal",
                 "No change detection on an already-authorised script, and the secret-rotation "
                 "procedure has never been rehearsed against a real environment.",
                 "For 113 there is nothing buildable for the one remote script, which the vendor "
                 "mutates on purpose. For 122, rehearse once and record what broke.",
                 "<b>Yes for 113</b>, structurally unsolvable in-repo. <b>No for 122</b> &mdash; the "
                 "code supports rotation properly, including recording which deliveries still used "
                 "the outgoing secret, so a rehearsal is cheap and the alternative is discovering "
                 "the gaps during an incident.",
                 ACTION_CHANGE],
            ],
            [14, 26, 24, 20, 16]),
    ]))

    # 25. Overall assessment.
    story.extend(section("Overall assessment", [
        make_table(
            ["Dimension", "Weight", "Score", "Basis"],
            [
                ["Tamper and forgery resistance", "Very high", "9.5",
                 "No amount reaching a provider is client-supplied on any flow now that the deal "
                 "endpoint enforces the same chargeable band; signatures verified fail-closed with "
                 "type guards and constant-time comparison; the creation-time assertion closes the "
                 "one place a stored and a charged figure could silently diverge."],
                ["Idempotency and concurrency", "Very high", "9.5",
                 "Three independent layers plus a claim lease with staleness recovery, and the new "
                 "pool clawback re-derives its amount inside a bounded compare-and-set loop rather "
                 "than reading once and trusting it. Exercised across every arrival order."],
                ["Authorisation and tenancy", "High", "9.5",
                 "Ownership re-checked server-side on every settlement and every read; the deal leg "
                 "adds a target-match hop; the new deck shelf is membership-gated with an "
                 "organization-scoped lookup; reads answer 404 rather than 403."],
                ["Correctness under failure", "High", "9.0",
                 "All three order-creating flows now write locally before the provider call, clean "
                 "up a failed one, and are swept by a reconciler that alerts on every repair. The "
                 "residual is the dashboard half of auto-capture, unverifiable from here."],
                ["Post-payment lifecycle", "High", "8.5",
                 "Reversal is real, idempotent, distinguishes REVOKED from EXPIRED, and now reaches "
                 "three of four flows including the largest. A reversed subscription charge is still "
                 "alert-only."],
                ["Client-side and transport security", "Medium", "8.5",
                 "Advertising removed from the product outright; no inline script in either shell; "
                 "full header baseline; TLS intact; and the strict CSP is now the enforced default, "
                 "so injected script on the payment page is genuinely blocked. Held back by the "
                 "collateral of that promotion: the allow-list is one origin short and refuses "
                 "Razorpay's own risk-detection bundle, unnoticed until a browser was watched."],
                ["Secrets and configuration", "Medium", "9.5",
                 "Production keys blank, no env file ever committed, test prefixes and the absence "
                 "of duplicate keys both re-confirmed on disk, fatal boot gate in both directions."],
                ["Monitoring and detection", "Medium", "8.5",
                 "Six alert sources naming specific conditions rather than generic errors. Unchanged "
                 "and now the weakest dimension: no internal ledger comparison, no external "
                 "reconciliation owner."],
                ["Testing", "Medium", "9.5",
                 "302 payment assertions plus 140 organization ones, all run during this audit with "
                 "zero failures, and the 34 new ones target precisely the flow that was weakest. The "
                 "checklist's manual rows remain unwalked and omit that flow entirely."],
            ],
            [24, 11, 8, 57], center_columns={1, 2}),
        Spacer(1, 9),
        make_callout(
            "<b>Headline rating: 9.2 / 10</b>, from 8.9. The rise is not a reward for work having "
            "been done &mdash; it is that the specific failure the last report described is no "
            "longer reachable. Every control the previous pass found holding in two of three places "
            "now holds in three, which is the difference between a habit and a property of the "
            "system.<br/><br/>"
            "The shape of what remains has changed, and it is worth naming plainly because it is no "
            "longer the same weakness: <i>this system now prevents loss considerably better than it "
            "would notice one.</i> Nothing can take money without provisioning, nothing can "
            "provision without money, and all three order-creating flows are swept, reversed and "
            "asserted end to end. The payment page's enforced policy now genuinely blocks injected "
            "script, which was the last prevention gap. But there is still no comparison of this "
            "ledger against an accounting source and no named owner for bank reconciliation, and "
            "this pass found the detection weakness reaching further than expected: the strict "
            "policy has been quietly refusing one of Razorpay's own scripts in every environment, "
            "and nothing anywhere noticed, because a refused script is a console message rather "
            "than an exception. A determined attacker who got past the prevention layer would meet "
            "a per-payment alert and very little else."),
        Spacer(1, 9),
        Paragraph("If only three things are done", styles["h3"]),
        Paragraph(
            "Only one of the three is code, which is itself the finding. <b>Allow-list "
            "<font face='Courier'>cdn.razorpay.com</font> and record it in the script inventory</b> "
            "&mdash; the provider's own risk-detection bundle is being blocked by our policy on "
            "every page load in every environment, and the fix is one named origin that weakens "
            "nothing; add the CSP-violation assertion to the hardening harness in the same change, "
            "so the next policy edit cannot repeat this silently. <b>Confirm the four Razorpay "
            "Dashboard settings</b>, auto-capture first: it is the only remaining way a customer "
            "could be charged and correctly receive nothing, because the code would refuse to "
            "provision an uncaptured payment exactly as it should while every control in this report "
            "passed. Ten minutes for someone with dashboard access. <b>Name an owner and a cadence "
            "for bank reconciliation</b>, which costs nothing to build and closes the widest "
            "remaining hole in detection: prevention here is now thorough enough that the realistic "
            "failure is one nobody notices rather than one nobody stopped.", styles["body"]),
    ]))

    # 26. Closing line.
    story.append(Spacer(1, 12))
    story.append(HorizontalRule(CONTENT_WIDTH, 0.6, RULE_HAIRLINE, top_padding=2, bottom_padding=6))
    story.append(Paragraph(
        "Derived from branch <b>native-on-device-llm</b>, which advanced from commit "
        "<b>9ad446c</b> to <b>e6dee9f</b> while this audit ran &mdash; an in-progress on-device-LLM "
        "feature being committed in parallel. The working tree was <b>not clean</b> at either point. "
        "<b>None of that movement touched the audited payment surface:</b> a diff of "
        "<font face='Courier'>Payments/</font>, <font face='Courier'>Plans/</font>, "
        "<font face='Courier'>Pricing/</font>, the credit, paid-deck, subscription and webhook "
        "endpoints, the perimeter plugins and <font face='Courier'>Dock/index.js</font> across that "
        "range is empty. The only audited paths differing from the commit are "
        "<font face='Courier'>Dock/Endpoints/Plugins/EnsureAgeConsent.js</font> and three browser "
        "suites under <font face='Courier'>Common/Testing/Main/</font> (modified), plus one "
        "untracked scratch probe beside them; each was audited exactly as it exists on disk. "
        "<font face='Courier'>Main/index.html</font> changed by one stylesheet link during the run "
        "and carries no new script tag. "
        "All four payment harnesses were executed during this audit and reported <b>311 assertions "
        "with zero failures</b> (signatures 50, settlement reliability 51, adversarial 33, lifecycle "
        "177). The runtime observation behind controls 28 and 83 was made by loading the real app in "
        "a headless Chromium against a local server. No source file was modified to produce this "
        "report.",
        styles["closing"]))

    return story


def main():
    document = BaseDocTemplate(
        str(OUTPUT_PATH),
        pagesize=A4,
        leftMargin=LEFT_MARGIN,
        rightMargin=RIGHT_MARGIN,
        topMargin=TOP_MARGIN,
        bottomMargin=BOTTOM_MARGIN,
        title=DOCUMENT_TITLE,
        author="CogniumLearn",
    )
    frame = Frame(
        LEFT_MARGIN, BOTTOM_MARGIN, CONTENT_WIDTH,
        PAGE_HEIGHT - TOP_MARGIN - BOTTOM_MARGIN,
        id="body", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0,
    )
    document.addPageTemplates([
        PageTemplate(id="main", frames=[frame], onPage=draw_page_chrome),
    ])
    document.build(build_story())
    print("Wrote", OUTPUT_PATH)


if __name__ == "__main__":
    main()
