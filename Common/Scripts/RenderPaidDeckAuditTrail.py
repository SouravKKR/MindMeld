"""
Renders one paid deck's generation audit trail as a PDF, in the shared
CogniumLearn document theme (Common/Reports/PdfTheme.md).

Invoked by Dock (Admin/PaidDecks/AuditTrail) as:

    <Agent venv python> RenderPaidDeckAuditTrail.py <provenance.json> <output.pdf>

THE CENTRAL RULE OF THIS RENDERER: it draws ONLY what the stored provenance
document contains. It never re-queries Mongo, never re-reads the task bucket,
never re-runs a check, and never infers a value it was not given. A report that
reconstructs its own evidence is not evidence — it is a fresh opinion wearing the
formatting of a record.

The corollary is that gaps are STATED, not hidden. A missing verification
section, an absent action trail, a source with no recorded hash: each is printed
as a named gap. A report that silently omits the section it could not fill reads
as complete and is not, which is worse than one that says plainly what it does
not know.

Deterministic: the same provenance document renders byte-identical output apart
from the report-generation timestamp in the header. Nothing is sorted by an
unstable key, nothing samples, nothing truncates without saying so.

All times are UTC and are labelled UTC.
"""

import json
import sys
from datetime import datetime, timezone
from html import escape as html_escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (
    BaseDocTemplate, Flowable, Frame, PageTemplate, Paragraph, Spacer, Table, TableStyle,
)


# --- Theme (Common/Reports/PdfTheme.md) -----------------------------------

TEAL_TITLE = colors.HexColor("#134E48")
TEAL_HEADER = colors.HexColor("#1A6B62")
TEAL_TABLE_HEAD = colors.HexColor("#1C5F58")
GOLD_ACCENT = colors.HexColor("#E7A33C")
TEXT_BODY = colors.HexColor("#353D44")
TEXT_MUTED = colors.HexColor("#6E7681")
TEXT_LABEL = colors.HexColor("#1A6B62")
ROW_ALT = colors.HexColor("#F1F5F4")
ROW_LINE = colors.HexColor("#DfE5E4")
RULE_HAIRLINE = colors.HexColor("#E2E7E6")
CALLOUT_BG = colors.HexColor("#F3F7F6")

PAGE_WIDTH, PAGE_HEIGHT = A4
LEFT_MARGIN = RIGHT_MARGIN = 20 * mm
TOP_MARGIN = 18 * mm
BOTTOM_MARGIN = 20 * mm
CONTENT_WIDTH = PAGE_WIDTH - LEFT_MARGIN - RIGHT_MARGIN

DOCUMENT_TITLE = "Paid Deck Generation Audit Trail"


styles = {
    "title": ParagraphStyle("title", fontName="Helvetica-Bold", fontSize=27, leading=31, textColor=TEAL_TITLE, spaceAfter=4),
    "subtitle": ParagraphStyle("subtitle", fontName="Helvetica", fontSize=12.5, leading=16, textColor=TEXT_MUTED, spaceAfter=2),
    "date": ParagraphStyle("date", fontName="Helvetica", fontSize=9.5, leading=13, textColor=TEXT_MUTED),
    "h2": ParagraphStyle("h2", fontName="Helvetica-Bold", fontSize=14.5, leading=17, textColor=TEAL_HEADER),
    "h3": ParagraphStyle("h3", fontName="Helvetica-Bold", fontSize=11, leading=15, textColor=TEAL_TITLE, spaceBefore=6, spaceAfter=2),
    "body": ParagraphStyle("body", fontName="Helvetica", fontSize=10, leading=15, textColor=TEXT_BODY, spaceAfter=6, alignment=TA_LEFT),
    "callout": ParagraphStyle("callout", fontName="Helvetica-Oblique", fontSize=10.5, leading=15.5, textColor=TEAL_TITLE),
    "bullet": ParagraphStyle("bullet", fontName="Helvetica", fontSize=10, leading=14.5, textColor=TEXT_BODY),
    "cell": ParagraphStyle("cell", fontName="Helvetica", fontSize=9, leading=12.5, textColor=TEXT_BODY),
    "cellLabel": ParagraphStyle("cellLabel", fontName="Helvetica-Bold", fontSize=9, leading=12.5, textColor=TEXT_LABEL),
    "cellHead": ParagraphStyle("cellHead", fontName="Helvetica-Bold", fontSize=9, leading=12.5, textColor=colors.white),
    "cellHeadCenter": ParagraphStyle("cellHeadCenter", fontName="Helvetica-Bold", fontSize=9, leading=12.5, textColor=colors.white, alignment=TA_CENTER),
    "cellCenter": ParagraphStyle("cellCenter", fontName="Helvetica", fontSize=9.5, leading=12.5, textColor=TEXT_BODY, alignment=TA_CENTER),
    "footer": ParagraphStyle("footer", fontName="Helvetica", fontSize=8, leading=10, textColor=TEXT_MUTED, alignment=TA_CENTER),
}


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
        self.canv.line(0, self.bottom_padding, self.width, self.bottom_padding)


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
    canvas.drawCentredString(PAGE_WIDTH / 2, footer_y, f"CogniumLearn  —  {DOCUMENT_TITLE}")
    canvas.drawRightString(PAGE_WIDTH - RIGHT_MARGIN, footer_y, str(document.page))
    canvas.restoreState()


def make_bullets(items):
    rows = []
    for item in items:
        if isinstance(item, tuple):
            label, text = item
            body = "<b><font color='#1A6B62'>%s</font></b> &mdash; %s" % (label, text)
        else:
            body = item
        dot = Paragraph("&bull;", ParagraphStyle(
            "dot", fontName="Helvetica-Bold", fontSize=10, leading=14.5, textColor=GOLD_ACCENT))
        rows.append([dot, Paragraph(body, styles["bullet"])])
    table = Table(rows, colWidths=[5 * mm, CONTENT_WIDTH - 5 * mm])
    table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (0, -1), 2),
        ("LEFTPADDING", (1, 0), (1, -1), 2),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    return table


def make_table(headers, rows, col_ratios, label_first_column=True, center_from_column=None):
    total = sum(col_ratios)
    col_widths = [CONTENT_WIDTH * ratio / total for ratio in col_ratios]

    def is_centered(index):
        return center_from_column is not None and index >= center_from_column

    header_cells = [
        Paragraph(head, styles["cellHeadCenter"] if is_centered(index) else styles["cellHead"])
        for index, head in enumerate(headers)
    ]
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

    table = Table(data, colWidths=col_widths, repeatRows=1)
    table_style = [
        ("BACKGROUND", (0, 0), (-1, 0), TEAL_TABLE_HEAD),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LINEBELOW", (0, 0), (-1, -1), 0.4, ROW_LINE),
        ("LINEBELOW", (0, 0), (-1, 0), 0, colors.white),
    ]
    for row_index in range(1, len(data)):
        if row_index % 2 == 0:
            table_style.append(("BACKGROUND", (0, row_index), (-1, row_index), ROW_ALT))
    table.setStyle(TableStyle(table_style))
    return table


def make_callout(text):
    table = Table([[Paragraph(text, styles["callout"])]], colWidths=[CONTENT_WIDTH])
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


# --- Value helpers --------------------------------------------------------

MISSING_TEXT = "<i>not recorded</i>"


def safe(value, fallback=MISSING_TEXT):
    """
    Escapes a value for the PDF, or renders the explicit not-recorded marker.

    Every absent field in this report goes through here, so a gap always looks
    like a gap and never like an empty cell that might just be blank.
    """
    if value is None:
        return fallback
    text = str(value).strip()
    if not text:
        return fallback
    return html_escape(text)


def format_utc(milliseconds):
    if not isinstance(milliseconds, (int, float)) or milliseconds <= 0:
        return MISSING_TEXT
    moment = datetime.fromtimestamp(milliseconds / 1000.0, tz=timezone.utc)
    return moment.strftime("%Y-%m-%d %H:%M:%S UTC")


def format_token_usage(action):
    input_tokens = action.get("inputTokens")
    output_tokens = action.get("outputTokens")
    if input_tokens is None and output_tokens is None:
        return "&mdash;"
    return f"{input_tokens if input_tokens is not None else '?'} in / {output_tokens if output_tokens is not None else '?'} out"


def format_chain(topic_chain):
    """
    Renders a topic chain as "Unit > Chapter > Topic".

    Each segment is escaped individually and the separator is added afterwards —
    escaping the joined string would turn the "&" of the "&gt;" entity into
    "&amp;gt;" and print a literal "&gt;" on the page.
    """
    if not isinstance(topic_chain, list) or not topic_chain:
        return MISSING_TEXT
    return " &gt; ".join(html_escape(str(segment)) for segment in topic_chain)


# --- Report sections ------------------------------------------------------

def build_header(provenance, generated_at):
    published_at = provenance.get("publishedAt")
    publish_state = "Published" if published_at else "Not published"

    story = [
        Paragraph(DOCUMENT_TITLE, styles["title"]),
        Paragraph(safe(provenance.get("deckName"), "<i>untitled deck</i>"), styles["subtitle"]),
        Paragraph(f"Report generated {generated_at}", styles["date"]),
        Spacer(1, 8),
        HorizontalRule(CONTENT_WIDTH, 2, GOLD_ACCENT, bottom_padding=2),
        Spacer(1, 10),
    ]

    story.append(make_table(
        ["Field", "Value"],
        [
            ["Deck title", safe(provenance.get("deckName"))],
            ["Deck ID", safe(provenance.get("deckId"))],
            ["Generation run ID", safe(provenance.get("mainTaskId"))],
            ["Publish state", publish_state],
            ["Published by", safe(provenance.get("publishedByUserId"), "&mdash;")],
            ["Published at", format_utc(published_at) if published_at else "&mdash;"],
            ["Generated by", safe(provenance.get("generatedByUserId"))],
            ["Record written at", format_utc(provenance.get("recordedAt"))],
            ["Report generated at", html_escape(generated_at)],
        ],
        [1, 2.4],
    ))

    return story


def build_source_declaration(provenance):
    """
    The most important section of the report. It states what entered the
    pipeline and — just as importantly — what the mode structurally could not
    accept.
    """
    sources = provenance.get("sources") or []
    accepted_type = provenance.get("acceptedSourceTypeName") or "CURRICULUM_OR_SYLLABUS"

    blocks = [make_callout(
        "This deck was produced in the admin-only paid-deck generation mode. In that mode the "
        f"pipeline accepts information sources of type <b>{html_escape(accepted_type)}</b> and no other "
        "type. Uploaded documents (<b>PROVIDED_DOCUMENTS</b>), image sources and open web sources are "
        "rejected at the point of submission, so no such source formed part of this generation. "
        "Content was written from the model's own knowledge of the subject against the syllabus below."
    )]

    if sources:
        blocks.append(Spacer(1, 8))
        blocks.append(make_table(
            ["Source name", "Declared type", "Content hash (SHA-512)"],
            [
                [safe(source.get("name")), safe(source.get("declaredSourceType")), safe(source.get("contentHash"))]
                for source in sources
            ],
            [1.6, 1.0, 2.4],
        ))
    else:
        blocks.append(Spacer(1, 8))
        blocks.append(Paragraph(
            "<b>Gap:</b> no source declaration was recorded for this run. The generation-mode "
            "restriction above still applied — it is enforced before any task is scheduled — but this "
            "report cannot name the specific syllabus document that was uploaded.",
            styles["body"],
        ))

    blocks.append(Paragraph(
        "The declared source type is metadata supplied at upload time. It is corroborated by a "
        "structural check applied to every curriculum/syllabus upload before it is stored, which "
        "rejects documents whose page count or prose density indicates a textbook rather than a "
        "syllabus.",
        styles["body"],
    ))

    return section("1. Source declaration", blocks)


def build_action_trail(provenance):
    actions = provenance.get("actions") or []

    if not actions:
        return section("2. Action trail", [Paragraph(
            "<b>Gap:</b> no action trail was recorded for this run. Without it this report cannot "
            "state which models ran, in what order, or with what settings.",
            styles["body"],
        )])

    rows = []
    for action in actions:
        action_type = action.get("actionType") or ""

        if action_type == "LLM_CALL":
            detail = f"{safe(action.get('promptIdentifier'), '&mdash;')}"
            model = safe(action.get("modelIdentifier"), "&mdash;")
            effort = safe(action.get("reasoningEffort"), "default")
            tokens = format_token_usage(action)
        elif action_type == "WEB_FETCH":
            detail = f"{safe(action.get('url'))} <i>({safe(action.get('reason'))})</i>"
            model = "&mdash;"
            effort = "&mdash;"
            tokens = "&mdash;"
        elif action_type == "VERIFICATION_FLAG":
            detail = f"{safe(action.get('flagCategory'))} &mdash; {safe(action.get('subject'), '&mdash;')}"
            model = "&mdash;"
            effort = "&mdash;"
            tokens = "&mdash;"
        elif action_type == "VISUAL":
            detail = f"{safe(action.get('kind'))} via {safe(action.get('method'))}"
            model = safe(action.get("modelIdentifier"), "&mdash;")
            effort = safe(action.get("reasoningEffort"), "default")
            tokens = "&mdash;"
        else:
            detail = safe(action.get("promptIdentifier"), "&mdash;")
            model = safe(action.get("modelIdentifier"), "&mdash;")
            effort = "&mdash;"
            tokens = "&mdash;"

        outcome_prefix = "" if action.get("succeeded") is not False else "<b>FAILED:</b> "
        outcome_text = action.get("outcome") if action.get("outcome") else action.get("detail")

        rows.append([
            safe(action.get("phase")),
            format_utc(action.get("timestampUtcMilliseconds")),
            model,
            effort,
            detail,
            f"{outcome_prefix}{safe(outcome_text, '&mdash;')}",
            tokens,
        ])

    blocks = [
        Paragraph(
            f"{len(actions)} action(s), in the order they occurred. Failures and retries are included: "
            "a trail with the awkward parts removed would not be a record of what happened.",
            styles["body"],
        ),
        make_table(
            ["Phase", "Timestamp (UTC)", "Model", "Effort", "Prompt / detail", "Outcome", "Tokens"],
            rows,
            [1.22, 1.00, 1.00, 0.80, 1.30, 1.80, 0.60],
            label_first_column=True,
        ),
    ]

    return section("2. Action trail", blocks)


def build_sources_consulted(provenance):
    actions = provenance.get("actions") or []
    web_fetches = [action for action in actions if action.get("actionType") == "WEB_FETCH"]

    blocks = [Paragraph(
        "Every web page consulted during this generation, with the reason it was consulted. Web "
        "access in this mode is used for verification only — checking the syllabus against the "
        "current examination pattern, and checking whether a stated value or classification is "
        "still current. No fetched content was used as source material for the generated deck.",
        styles["body"],
    )]

    if not web_fetches:
        blocks.append(Paragraph("No web pages were consulted during this generation.", styles["body"]))
        return section("3. Sources consulted", blocks)

    blocks.append(make_table(
        ["Reason", "URL", "Phase", "Timestamp (UTC)"],
        [
            [
                safe(fetch.get("reason")),
                safe(fetch.get("url")),
                safe(fetch.get("phase")),
                format_utc(fetch.get("timestampUtcMilliseconds")),
            ]
            for fetch in web_fetches
        ],
        [1.0, 2.6, 1.0, 1.1],
    ))

    return section("3. Sources consulted", blocks)


def build_visual_inventory(provenance):
    actions = provenance.get("actions") or []
    visuals = [action for action in actions if action.get("actionType") == "VISUAL"]

    blocks = [Paragraph(
        "Each visual the deck was given, where the requirement came from, the kind it was recorded "
        "as, the method that kind routed to, and the result of the vision review of the rendered "
        "output. Technical "
        "diagrams are produced as symbolic markup (inline SVG or Mermaid) rather than as generated "
        "images, so their labels are real text and their geometry is exact.",
        styles["body"],
    )]

    if not visuals:
        blocks.append(Paragraph("No visuals were recorded for this deck.", styles["body"]))
        return section("4. Visual inventory", blocks)

    rows = []
    for visual in visuals:
        review_outcome = visual.get("visionReviewOutcome")
        if review_outcome is None:
            review_text = "<i>generation entry (see review row)</i>"
        else:
            review_text = safe(review_outcome)

        rows.append([
            format_chain(visual.get("topicChain")),
            safe(visual.get("description")),
            safe(visual.get("origin"), "DECLARED"),
            safe(visual.get("kind")),
            safe(visual.get("method")),
            review_text,
            "yes" if visual.get("succeeded") else "no",
        ])

    blocks.append(make_table(
        ["Topic", "Visual", "Origin", "Kind", "Method", "Vision review", "Kept"],
        rows,
        [1.05, 1.42, 0.95, 0.96, 0.96, 1.42, 0.52],
        center_from_column=6,
    ))

    blocks.append(Spacer(1, 6))
    blocks.append(Paragraph(
        "\"Origin\" separates <b>DECLARED</b> — the coverage specification derived from the syllabus "
        "asked for this visual — from <b>INFERRED</b>, where the pipeline judged the topic needed one "
        "that nothing had asked for. The distinction is recorded rather than smoothed over: a syllabus "
        "names topics, not figures, so most visuals in a deck built this way are the pipeline's "
        "judgement, and the record should not present a judgement as an instruction. Both are held to "
        "the same vision review and both are dropped on failure.",
        styles["body"],
    ))

    return section("4. Visual inventory", blocks)


def build_verification(provenance):
    verification = provenance.get("verification")
    flag_resolutions = provenance.get("flagResolutions") or []

    if not verification or not isinstance(verification.get("flags"), list):
        return section("5. Verification results", [Paragraph(
            "<b>Gap:</b> no verification result was recorded for this deck. The publish gate refuses "
            "to publish a pipeline-generated deck in this state, so if this deck is shown as "
            "published above, that is a discrepancy worth investigating.",
            styles["body"],
        )])

    flags = verification["flags"]

    resolutions_by_index = {}
    for resolution in flag_resolutions:
        flag_index = resolution.get("flagIndex")
        if isinstance(flag_index, int):
            resolutions_by_index.setdefault(flag_index, []).append(resolution)

    blocks = [
        Paragraph(
            f"{verification.get('verifiedEntityCount', 0)} generated item(s) were verified. "
            f"{verification.get('blockingFlagCount', 0)} blocking and "
            f"{verification.get('advisoryFlagCount', 0)} advisory flag(s) were raised. "
            "Flags are raised, never auto-corrected: a model silently rewriting another model's "
            "output introduces errors as readily as it removes them, so every change is a recorded "
            "human decision.",
            styles["body"],
        ),
    ]

    if not flags:
        blocks.append(Paragraph("No verification flags were raised.", styles["body"]))
        return section("5. Verification results", blocks)

    rows = []
    for flag_index, flag in enumerate(flags):
        resolutions = resolutions_by_index.get(flag_index) or []
        if resolutions:
            resolution_text = "<br/>".join(
                f"{safe(resolution.get('resolution'))} by {safe(resolution.get('actorUserId'), 'unknown')} "
                f"at {format_utc(resolution.get('resolvedAt'))}"
                + (f"<br/><i>{safe(resolution.get('note'), '')}</i>" if resolution.get("note") else "")
                for resolution in resolutions
            )
        else:
            resolution_text = "<b>unresolved</b>"

        rows.append([
            safe(flag.get("category")),
            safe(flag.get("severity")),
            safe(flag.get("source")),
            format_chain(flag.get("topicChain")),
            safe(flag.get("problem")),
            resolution_text,
        ])

    blocks.append(make_table(
        ["Category", "Severity", "Raised by", "Topic", "Problem", "Resolution"],
        rows,
        [0.95, 0.75, 0.95, 1.15, 2.15, 1.55],
    ))

    blocks.append(Spacer(1, 6))
    blocks.append(Paragraph(
        "\"Raised by\" distinguishes the two independent checks: <b>REFERENCE_SET</b> is a "
        "deterministic comparison against a curated table of physical constants and standard values, "
        "performed in code; <b>MODEL</b> is a language-model review of formulae, definitions, units "
        "and worked answers; <b>STAGE</b> records that a batch could not be verified at all.",
        styles["body"],
    ))

    return section("5. Verification results", blocks)


def build_coverage_reconciliation(provenance):
    reconciliation = provenance.get("coverageReconciliation")

    if not reconciliation:
        return []

    if not reconciliation.get("attempted"):
        return section("6. Coverage reconciliation", [Paragraph(
            "<b>Gap:</b> the coverage audit did not complete "
            f"({safe(reconciliation.get('failureReason'), 'no reason recorded')}). The syllabus tree "
            "was therefore not checked against the current examination pattern.",
            styles["body"],
        )])

    blocks = [Paragraph(
        f"The syllabus tree was audited against the current examination pattern. "
        f"Pattern confidence: <b>{safe(reconciliation.get('patternConfidence'))}</b>. "
        f"{safe(reconciliation.get('patternSummary'), '')}<br/><br/>"
        "This audit is advisory: it informs the reviewer and never alters the syllabus.",
        styles["body"],
    )]

    gaps = reconciliation.get("gaps") or []
    out_of_scope = reconciliation.get("outOfScope") or []

    if gaps:
        blocks.append(Paragraph("Topics the exam pattern assesses that this deck does not cover:", styles["h3"]))
        blocks.append(make_table(
            ["Topic", "Reason", "Suggested parent"],
            [[safe(gap.get("topic")), safe(gap.get("reason")), safe(gap.get("suggestedParent"), "&mdash;")] for gap in gaps],
            [1.4, 2.6, 1.2],
        ))
        blocks.append(Spacer(1, 6))

    if out_of_scope:
        blocks.append(Paragraph("Topics in this deck the exam pattern does not assess:", styles["h3"]))
        blocks.append(make_table(
            ["Topic", "Reason"],
            [[format_chain(entry.get("topicChain")), safe(entry.get("reason"))] for entry in out_of_scope],
            [1.6, 3.0],
        ))
        blocks.append(Spacer(1, 6))

    if not gaps and not out_of_scope:
        blocks.append(Paragraph("The audit found no gaps and no out-of-scope topics.", styles["body"]))

    return section("6. Coverage reconciliation", blocks)


def build_summary(provenance):
    actions = provenance.get("actions") or []
    verification = provenance.get("verification") or {}
    sources = provenance.get("sources") or []
    web_fetch_count = sum(1 for action in actions if action.get("actionType") == "WEB_FETCH")
    visual_count = sum(1 for action in actions if action.get("actionType") == "VISUAL" and action.get("visionReviewOutcome") is None)

    source_sentence = (
        f"a single declared {safe(sources[0].get('declaredSourceType'), 'curriculum')} source"
        if len(sources) == 1
        else f"{len(sources)} declared curriculum/syllabus source(s)" if sources
        else "no recorded source declaration"
    )

    paragraphs = [
        Paragraph(
            "This record shows how the deck named above was produced. It was generated in the "
            "admin-only paid-deck mode, which accepts curriculum and syllabus sources and refuses "
            "uploaded documents, image sources and open web sources at submission time. The run "
            f"began from {source_sentence}. The subject content was written from the generating "
            "model's own knowledge, worked against a per-topic coverage specification derived from "
            "the syllabus — not retrieved, quoted or paraphrased from any document held by the "
            "platform.",
            styles["body"],
        ),
        Paragraph(
            f"The trail above records {len(actions)} action(s) across the run, naming for each the "
            "phase, the model, the reasoning effort where one was set explicitly, the prompt used and "
            f"the outcome, including failures. {web_fetch_count} web page(s) were consulted, each "
            "recorded with the reason it was consulted; all such access was for verification — "
            "checking the syllabus against the current examination pattern, and checking whether "
            "stated values remain current — and none of it was used as source material.",
            styles["body"],
        ),
        Paragraph(
            f"{visual_count} visual(s) were produced and each was reviewed against the specification "
            "it was generated from. Generated content was checked both by a deterministic comparison "
            "against a curated set of physical constants and standard values, and by a language-model "
            "review of formulae, definitions, units and worked answers. "
            f"{verification.get('blockingFlagCount', 0)} blocking flag(s) were raised; a deck cannot "
            "be published while any of them is unresolved, and each resolution recorded above names "
            "the person who made it and when.",
            styles["body"],
        ),
        Paragraph(
            "This report is rendered entirely from the stored provenance record written while the "
            "generation ran. Nothing in it is re-derived, re-queried or re-checked at render time, "
            "and any part of the record that is absent is stated above as a gap rather than omitted.",
            styles["body"],
        ),
    ]

    return section("7. What this record shows", paragraphs)


def build_story(provenance, generated_at):
    story = []
    story.extend(build_header(provenance, generated_at))
    story.extend(build_source_declaration(provenance))
    story.extend(build_action_trail(provenance))
    story.extend(build_sources_consulted(provenance))
    story.extend(build_visual_inventory(provenance))
    story.extend(build_verification(provenance))
    story.extend(build_coverage_reconciliation(provenance))
    story.extend(build_summary(provenance))
    story.append(Spacer(1, 10))
    story.append(HorizontalRule(CONTENT_WIDTH, 1.5, GOLD_ACCENT, top_padding=2))
    return story


def main():
    if len(sys.argv) < 3:
        print("Usage: RenderPaidDeckAuditTrail.py <provenance.json> <output.pdf>", file=sys.stderr)
        return 2

    provenance_path = sys.argv[1]
    output_path = sys.argv[2]

    with open(provenance_path, "r", encoding="utf-8") as provenance_file:
        provenance = json.load(provenance_file)

    generated_at = datetime.now(tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

    document = BaseDocTemplate(
        output_path,
        pagesize=A4,
        leftMargin=LEFT_MARGIN,
        rightMargin=RIGHT_MARGIN,
        topMargin=TOP_MARGIN,
        bottomMargin=BOTTOM_MARGIN,
        title=f"{DOCUMENT_TITLE} — {provenance.get('deckName') or provenance.get('deckId') or ''}",
        author="CogniumLearn",
    )

    frame = Frame(
        LEFT_MARGIN, BOTTOM_MARGIN,
        CONTENT_WIDTH, PAGE_HEIGHT - TOP_MARGIN - BOTTOM_MARGIN,
        id="content", showBoundary=0,
    )
    document.addPageTemplates([PageTemplate(id="main", frames=[frame], onPage=draw_page_chrome)])
    document.build(build_story(provenance, generated_at))

    print(f"Wrote {output_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
