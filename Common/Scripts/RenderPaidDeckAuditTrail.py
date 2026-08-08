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
    BaseDocTemplate, Flowable, Frame, LongTable, PageBreak, PageTemplate, Paragraph, Spacer, Table,
    TableStyle,
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

# The height one table row has to work with before it must be split internally.
#
# The frame is the page less its margins; Frame's own 6pt top and bottom padding
# and the repeated header row come off that. A row taller than what is left
# cannot be placed whole on any page, however the table is broken up.
USABLE_FRAME_HEIGHT = PAGE_HEIGHT - TOP_MARGIN - BOTTOM_MARGIN - 12 - 30


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

    # Same rule as make_table: only a bullet too tall for a page splits inside
    # its row. See enable_in_row_split.
    enable_in_row_split(table)

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

    # LongTable + splitInRow, not Table, and both parts matter.
    #
    # A plain Table splits only BETWEEN rows. With repeatRows=1 ReportLab
    # refuses the split outright unless the header row and the first data row
    # both fit the frame, so one row taller than the ~734pt frame made the whole
    # table unplaceable: doctemplate postponed it once and then raised
    # LayoutError, and the entire report failed to render over a single long
    # cell. Every value here is model-authored prose with no length limit, so
    # that was reachable in normal operation and did in fact happen in
    # production.
    #
    # LongTable computes row heights lazily, which keeps a several-hundred-row
    # action trail from being laid out in full before the first page is written.
    #
    # splitInRow is decided below, after measuring, rather than set here. It must
    # be OFF for an ordinary table and ON for one holding an over-tall row, and
    # only the row heights can tell the two apart — see enable_in_row_split.
    table = LongTable(data, colWidths=col_widths, repeatRows=1)
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

    enable_in_row_split(table)

    return table


def enable_in_row_split(table):
    """
    Turns on splitting INSIDE a row, but only for a table that has a row too
    tall to be placed on any page.

    WHY IT IS CONDITIONAL RATHER THAN ALWAYS ON.

    Without it at all, a plain Table splits only BETWEEN rows, and repeatRows=1
    makes ReportLab refuse even that unless the header and the first data row
    both fit the frame. One row taller than a page therefore made the whole table
    unplaceable and the build died with a LayoutError, taking the entire report
    with it. Every value in these tables is model-authored prose with no length
    limit, so that was reachable in normal operation and did happen in
    production.

    With it on for EVERY table, the opposite problem appears. ReportLab reaches
    for an in-row split whenever a between-row split fails — including for a
    perfectly ordinary short table that simply arrived near the bottom of a page,
    where the right answer is to move it whole to the next one. What it produces
    there is an orphan fragment: one cell's first line, every other cell in the
    row blank, and the real row repeated in full overleaf. That reads as a
    corrupted record, which in a document whose only purpose is to be credible
    evidence is its own kind of failure.

    splitInRow also takes a minimum-fragment height, which looks like it should
    solve this — refuse small splits, allow large ones. It does not: a row several
    times a page tall is split repeatedly, and the last fragment is small by
    definition, so any meaningful minimum makes that final split fail and the
    LayoutError comes back. Measured, not guessed.

    So the decision is made per table, from the row heights ReportLab itself
    computes. A table whose tallest row fits a page keeps the old, correct
    behaviour; only a table that cannot be laid out any other way splits inside a
    row.
    """
    try:
        table.wrap(CONTENT_WIDTH, USABLE_FRAME_HEIGHT)
        row_heights = getattr(table, "_rowHeights", None) or []
    except Exception:
        # A table that will not even measure is not one to make assumptions
        # about. Leaving the split off keeps the pre-existing behaviour rather
        # than enabling a mode on a table nothing is known about.
        return

    if any(row_height > USABLE_FRAME_HEIGHT for row_height in row_heights):
        table.splitInRow = 1


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


# The longest a free-prose cell may run before it is cut.
#
# splitInRow already stops a long cell from failing the build, so this is the
# second line of defence rather than the first: it keeps a single pathological
# value from turning one table row into several pages of a report whose other
# rows are one line each. At the narrowest prose column in this document
# (~103pt of usable width, about 23 characters a line at Helvetica 9) this
# bounds a row at roughly two thirds of a page.
PROSE_CELL_CHARACTER_LIMIT = 1200


def safe_clamped(value, character_limit=PROSE_CELL_CHARACTER_LIMIT, fallback=MISSING_TEXT):
    """
    safe(), for cells whose content has no natural length limit.

    The cut ANNOUNCES ITSELF and says how much it removed. This report's stated
    contract is that nothing truncates without saying so — a silently shortened
    explanation reads as the whole explanation, which is the failure mode the
    contract exists to prevent. Clamping happens BEFORE escaping so the cut can
    never land in the middle of an HTML entity.
    """
    if value is None:
        return fallback

    text = str(value).strip()
    if not text:
        return fallback

    if len(text) <= character_limit:
        return html_escape(text)

    omitted_count = len(text) - character_limit
    return (
        html_escape(text[:character_limit])
        + f" <i>[&hellip; truncated, {omitted_count} character(s) omitted]</i>"
    )


def short_hash(value, prefix_length=16):
    """
    The leading characters of a content hash, sliced BEFORE escaping.

    Slicing the escaped string instead can cut an entity in half — a value
    containing "&" becomes "&amp;" and a 16-character slice can end mid-entity,
    printing "&am" as literal text in a field whose whole job is to be checkable
    against the stored hash.
    """
    if value is None:
        return MISSING_TEXT

    text = str(value).strip()
    if not text:
        return MISSING_TEXT

    return html_escape(text[:prefix_length])


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

def build_header(provenance, generated_at, run_number=1, run_count=1):
    published_at = provenance.get("publishedAt")
    publish_state = "Published" if published_at else "Not published"

    subtitle = safe(provenance.get("deckName"), "<i>untitled deck</i>")
    if run_count > 1:
        subtitle = f"{subtitle} &mdash; generation run {run_number} of {run_count}"

    story = [
        Paragraph(DOCUMENT_TITLE, styles["title"]),
        Paragraph(subtitle, styles["subtitle"]),
        Paragraph(f"Report generated {generated_at}", styles["date"]),
        Spacer(1, 8),
        HorizontalRule(CONTENT_WIDTH, 2, GOLD_ACCENT, bottom_padding=2),
        Spacer(1, 10),
    ]

    rows = [
        ["Deck title", safe(provenance.get("deckName"))],
        ["Deck ID", safe(provenance.get("deckId"))],
        ["Generation run ID", safe(provenance.get("mainTaskId"))],
    ]

    # Which decks this particular run added beneath the deck being sold. Stated
    # because a deck can hold the output of several runs, and "what did THIS run
    # put here" is otherwise unanswerable from the report.
    produced_deck_ids = provenance.get("producedDeckIds") or []
    if produced_deck_ids:
        rows.append(["Decks this run created", html_escape(", ".join(str(deck_id) for deck_id in produced_deck_ids))])

    rows.extend([
        ["Publish state", publish_state],
        ["Published by", safe(provenance.get("publishedByUserId"), "&mdash;")],
        ["Published at", format_utc(published_at) if published_at else "&mdash;"],
        ["Generated by", safe(provenance.get("generatedByUserId"))],
        ["Record written at", format_utc(provenance.get("recordedAt"))],
        ["Report generated at", html_escape(generated_at)],
    ])

    story.append(make_table(["Field", "Value"], rows, [1, 2.4]))

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


def build_verification_sources(provenance):
    """
    Section 1b: the documents and URLs this deck's content was CHECKED AGAINST,
    with the licence each was declared under and who declared it.

    Deliberately its own section, placed immediately after the source
    declaration, because the two answer questions that are easy to confuse and
    must not be: section 1 says what went INTO the pipeline, this one says what
    the output was checked AGAINST afterwards. A reader who merged them would
    conclude a third-party document had been used to write the deck, which is
    the opposite of what happened.

    Detached sources are shown alongside attached ones. A source removed last
    month is still what a past check was carried out against, and a log that
    quietly dropped it would leave a verification nobody can trace back to the
    document that justified it.
    """
    declarations = provenance.get("verificationSourceDeclarations") or []

    blocks = [Paragraph(
        "Documents and pages an administrator cleared and attached so this deck's already-generated "
        "content could be checked against them. These are <b>not</b> generation inputs &mdash; they were "
        "read only by the verification pass, which runs after the content exists and can only raise "
        "flags for review. Every attachment and every removal is recorded below with the licence "
        "declared for it at the time and the person who declared it.",
        styles["body"],
    )]

    if not declarations:
        blocks.append(Paragraph(
            "No verification sources were declared for this deck. Its content was checked by the "
            "standard verification described in section 5, and against no external document.",
            styles["body"],
        ))
        return section("1b. Verification sources declared", blocks)

    rows = []
    for declaration in declarations:
        declared_by = declaration.get("declaredByEmail") or declaration.get("declaredByUserId")

        rows.append([
            safe(declaration.get("event"), "ATTACHED"),
            safe(declaration.get("sourceName")),
            format_licence(declaration),
            build_hyperlink(declaration.get("sourceUrl")) if declaration.get("sourceUrl") else "&mdash;",
            short_hash(declaration.get("sourceHash"), 24) if declaration.get("sourceHash") else "&mdash;",
            safe(declared_by),
            format_utc(declaration.get("createdAt")),
        ])

    # The Event column is wider than its two short values need, because both of
    # them are single unbreakable words: at a narrower width "ATTACHED" wraps to
    # "ATTA CHED", which reads as a typo in a document whose credibility is the
    # point of it existing.
    blocks.append(make_table(
        ["Event", "Source", "Declared licence", "URL", "Content hash", "Declared by", "When (UTC)"],
        rows,
        [1.35, 1.40, 1.45, 1.20, 1.00, 1.20, 1.10],
    ))

    blocks.append(Spacer(1, 6))
    blocks.append(Paragraph(
        "The declared licence is the administrator's own statement of the basis on which the document "
        "was used. Uploaded documents are retained and cannot be deleted while their declaration "
        "stands, so each hash above still names bytes that can be produced and compared &mdash; a "
        "declaration nobody can check against the document it describes is a claim, not evidence.",
        styles["body"],
    ))

    return section("1b. Verification sources declared", blocks)


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
            f"{outcome_prefix}{safe_clamped(outcome_text, fallback='&mdash;')}",
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
            review_text = safe_clamped(review_outcome)

        rows.append([
            format_chain(visual.get("topicChain")),
            safe_clamped(visual.get("description")),
            safe(visual.get("origin"), "DECLARED"),
            safe(visual.get("kind")),
            safe(visual.get("method")),
            review_text,
            "yes" if visual.get("succeeded") else "no",
        ])

    # The two prose columns carry a model-written visual description and a
    # model-written review verdict; the three between them carry short enum
    # tokens. Splitting the width evenly wrapped the prose at about eighteen
    # characters a line, which is what made this the table most likely to
    # produce a row taller than the page.
    blocks.append(make_table(
        ["Topic", "Visual", "Origin", "Kind", "Method", "Vision review", "Kept"],
        rows,
        [1.10, 1.85, 0.75, 0.85, 0.90, 1.85, 0.45],
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
                + (f"<br/><i>{safe_clamped(resolution.get('note'), fallback='')}</i>" if resolution.get("note") else "")
                for resolution in resolutions
            )
        else:
            resolution_text = "<b>unresolved</b>"

        problem_text = safe_clamped(flag.get("problem"))

        # A source-grounded flag carries the passage it is founded on, and that
        # passage is printed with it. The claim such a flag makes is not "a model
        # disagrees" but "a cleared document says otherwise, here" — and a reader
        # who cannot see the quotation cannot tell the two apart, which is the
        # entire difference in weight between them.
        cited_passage = flag.get("citedPassage")
        if cited_passage:
            source_label = safe(flag.get("sourceName"), "an attached source")
            problem_text = (
                f"{problem_text}<br/><br/><i>From {source_label}:</i><br/>"
                f"&ldquo;{safe_clamped(cited_passage)}&rdquo;"
            )

        rows.append([
            safe(flag.get("category")),
            safe(flag.get("severity")),
            safe(flag.get("source")),
            format_chain(flag.get("topicChain")),
            problem_text,
            resolution_text,
        ])

    blocks.append(make_table(
        ["Category", "Severity", "Raised by", "Topic", "Problem", "Resolution"],
        rows,
        [0.95, 0.75, 0.95, 1.15, 2.15, 1.55],
    ))

    blocks.append(Spacer(1, 6))
    blocks.append(Paragraph(
        "\"Raised by\" distinguishes the independent checks: <b>REFERENCE_SET</b> is a "
        "deterministic comparison against a curated table of physical constants and standard values, "
        "performed in code; <b>MODEL</b> is a language-model review of formulae, definitions, units "
        "and worked answers; <b>ADMIN_SOURCE</b> is a comparison against the documents listed in "
        "section 1b, and every such flag quotes the passage it rests on; <b>STAGE</b> records that "
        "something could not be verified at all.",
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
            [[safe(gap.get("topic")), safe_clamped(gap.get("reason")), safe(gap.get("suggestedParent"), "&mdash;")] for gap in gaps],
            [1.4, 2.6, 1.2],
        ))
        blocks.append(Spacer(1, 6))

    if out_of_scope:
        blocks.append(Paragraph("Topics in this deck the exam pattern does not assess:", styles["h3"]))
        blocks.append(make_table(
            ["Topic", "Reason"],
            [[format_chain(entry.get("topicChain")), safe_clamped(entry.get("reason"))] for entry in out_of_scope],
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


LICENCE_TYPE_LABELS = {
    0: "Not specified",
    1: "CC0",
    2: "Public domain",
    3: "CC BY",
    4: "Own work",
    5: "Licensed / permission held",
    6: "Other (see note)",
}


def format_licence(refinement):
    """
    The declared licensing basis for an attached reference document.

    A refinement with no attached document renders nothing at all rather than
    "Not specified" — the absence of a source is not an unspecified licence, and
    conflating the two would put a permissions question mark against every
    correction that was simply typed by hand.
    """
    licence_type = refinement.get("licenceType")
    label = LICENCE_TYPE_LABELS.get(licence_type, "Unrecognised")
    note = str(refinement.get("licenceNote") or "").strip()

    if note:
        return f"{html_escape(label)} &mdash; {html_escape(note)}"
    return html_escape(label)


def build_hyperlink(url, label=None):
    """
    A clickable link whose LABEL is escaped and whose href is validated.

    safe() escapes everything it is given, which is right for text and wrong for
    markup — an escaped <link> tag prints as characters. So the tag is composed
    here instead, and the URL is checked to be http/https first. An unvalidated
    href in a document whose entire purpose is to be trustworthy evidence would
    be an injection into your own audit record.
    """
    cleaned_url = str(url or "").strip()

    if not cleaned_url.lower().startswith(("http://", "https://")):
        return safe(cleaned_url)

    escaped_url = html_escape(cleaned_url, quote=True)
    escaped_label = html_escape(str(label).strip()) if label else html_escape(cleaned_url)

    return f'<link href="{escaped_url}" color="#0F6B5C"><u>{escaped_label}</u></link>'


def build_content_refinements(provenance):
    """
    Section 8: corrections applied to this deck's content after it was generated.

    Appended at the end rather than inserted in topic order, because the section
    numbers above are hardcoded in a dozen places and renumbering them to slot
    this in the middle would be a large edit for no reader benefit — this is
    genuinely the last thing that happened, so it belongs last.

    Each entry names what a person instructed, which model carried it out, what
    the provider observed itself consulting, and — when a reference document was
    attached — the declared licensing basis for using it, with a link to retrieve
    the document itself. That retrievability is the point: a declaration nobody
    can check against the document it describes is a claim, not evidence.
    """
    refinements = provenance.get("contentRefinements") or []

    blocks = [Paragraph(
        "Corrections applied to this deck's content after generation finished, each approved by a person "
        "who compared the proposed change against what was there before. Consulted URLs are those the "
        "model provider reported having actually retrieved, not URLs the model named in its answer. Where "
        "a reference document was attached, the licence its provider declared is recorded and the document "
        "itself is retained and retrievable.",
        styles["body"],
    )]

    if not refinements:
        blocks.append(Paragraph(
            "No corrections were applied to this deck's content after it was generated.",
            styles["body"],
        ))
        return section("8. Post-generation content corrections", blocks)

    for refinement_index, refinement in enumerate(refinements):
        blocks.append(Spacer(1, 6))
        blocks.append(Paragraph(
            f"<b>Correction {refinement_index + 1} of {len(refinements)}</b> "
            f"&mdash; {format_utc(refinement.get('createdAt'))}",
            styles["body"],
        ))

        detail_rows = [
            ["Applied by", safe(refinement.get("actorUserId"))],
            ["Entity", f"{safe(refinement.get('entityTypeName'))} {safe(refinement.get('entityId'))}"],
            ["Instruction", safe_clamped(refinement.get("instruction"))],
            ["Model", safe(refinement.get("modelIdentifier"))],
            ["Change summary", safe_clamped(refinement.get("summary"))],
            ["Content before / after", f"{short_hash(refinement.get('beforeContentHash'))} &rarr; {short_hash(refinement.get('afterContentHash'))}"],
        ]

        concerns = str(refinement.get("concerns") or "").strip()
        if concerns:
            detail_rows.append(["Noted concerns", safe_clamped(concerns)])

        if refinement.get("visionReviewOutcome"):
            detail_rows.append(["Visual review", safe_clamped(refinement.get("visionReviewOutcome"))])

        # A flag link means this correction answered a verification finding.
        # Naming the flag it answered is what lets an auditor walk from
        # "verification said this was wrong" to "and here is what was done".
        if refinement.get("flagIndex") is not None:
            detail_rows.append([
                "Answers verification flag",
                f"#{int(refinement.get('flagIndex')) + 1} of run {safe(refinement.get('mainTaskId'))}",
            ])

        blocks.append(make_table(["Field", "Value"], detail_rows, [1.2, 3.8]))

        consulted_urls = refinement.get("consultedUrls") or []
        if consulted_urls:
            blocks.append(Paragraph("Pages the provider reported consulting:", styles["body"]))
            blocks.append(make_bullets([build_hyperlink(url) for url in consulted_urls]))

        if refinement.get("informationSourceId") or refinement.get("sourceUrl"):
            source_rows = [
                ["Reference", safe(refinement.get("sourceName")) if refinement.get("sourceName") else build_hyperlink(refinement.get("sourceUrl"))],
                ["Declared licence", format_licence(refinement)],
            ]

            if refinement.get("sourceHash"):
                source_rows.append(["Content hash (SHA-512)", safe(refinement.get("sourceHash"))])

            if refinement.get("informationSourceId"):
                source_rows.append([
                    "Retrieve the document",
                    f"/Admin/PaidDecks/RefinementProofSource?refinementId={safe(refinement.get('refinementId'))}",
                ])

            blocks.append(make_table(["Attached reference", "Value"], source_rows, [1.2, 3.8]))

    return section("8. Post-generation content corrections", blocks)


def build_story(provenance, generated_at, run_number=1, run_count=1):
    story = []
    story.extend(build_header(provenance, generated_at, run_number, run_count))
    story.extend(build_source_declaration(provenance))
    story.extend(build_verification_sources(provenance))
    story.extend(build_action_trail(provenance))
    story.extend(build_sources_consulted(provenance))
    story.extend(build_visual_inventory(provenance))
    story.extend(build_verification(provenance))
    story.extend(build_coverage_reconciliation(provenance))
    story.extend(build_summary(provenance))
    story.extend(build_content_refinements(provenance))
    story.append(Spacer(1, 10))
    story.append(HorizontalRule(CONTENT_WIDTH, 1.5, GOLD_ACCENT, top_padding=2))
    return story


def build_run_index(deck_name, records, generated_at):
    """
    The opening page when a deck was generated into more than once.

    A deck can be built by several runs, and each one is separate evidence about
    a separate act — so they are reported one after another, in the order they
    happened, with this index naming every one of them up front. A report that
    presented only the newest run, or silently merged them into a single
    narrative, would be a true document creating a false impression of how the
    content came to exist.
    """
    story = [
        Paragraph(DOCUMENT_TITLE, styles["title"]),
        Paragraph(safe(deck_name, "<i>untitled deck</i>"), styles["subtitle"]),
        Paragraph(f"Report generated {generated_at}", styles["date"]),
        Spacer(1, 8),
        HorizontalRule(CONTENT_WIDTH, 2, GOLD_ACCENT, bottom_padding=2),
        Spacer(1, 10),
    ]

    story.extend(section("Generation runs covered by this report", [
        Paragraph(
            f"This deck was generated into {len(records)} separate times. Every run is reported below, "
            "in the order it happened, each with its own sources, action trail and verification outcome. "
            "No run supersedes another and none has been merged or omitted.",
            styles["body"],
        ),
        Spacer(1, 6),
        make_table(
            ["#", "Generation run ID", "Recorded at (UTC)", "Verification"],
            [
                [
                    str(run_number),
                    safe(record.get("mainTaskId")),
                    format_utc(record.get("recordedAt")),
                    describe_verification_outcome(record),
                ]
                for run_number, record in enumerate(records, start=1)
            ],
            [0.35, 2.2, 1.4, 1.5],
            label_first_column=False,
        ),
    ]))

    return story


def describe_verification_outcome(record):
    verification = record.get("verification")
    if not verification or not isinstance(verification.get("flags"), list):
        return "No verification result recorded"

    blocking_count = verification.get("blockingFlagCount") or 0
    advisory_count = verification.get("advisoryFlagCount") or 0
    return f"{blocking_count} blocking, {advisory_count} advisory"


def resolve_records(loaded_json):
    """
    Accepts either the multi-run envelope ({deckId, deckName, records: [...]}) or
    a single bare provenance record. The bare form is still read so a server and
    a renderer that are momentarily out of step produce a report rather than a
    stack trace.
    """
    if isinstance(loaded_json, dict) and isinstance(loaded_json.get("records"), list):
        records = [record for record in loaded_json["records"] if isinstance(record, dict)]
        deck_name = loaded_json.get("deckName") or (records[0].get("deckName") if records else None)
        return records, deck_name

    return [loaded_json], loaded_json.get("deckName")


def main():
    if len(sys.argv) < 3:
        print("Usage: RenderPaidDeckAuditTrail.py <provenance.json> <output.pdf>", file=sys.stderr)
        return 2

    provenance_path = sys.argv[1]
    output_path = sys.argv[2]

    with open(provenance_path, "r", encoding="utf-8") as provenance_file:
        loaded_json = json.load(provenance_file)

    records, deck_name = resolve_records(loaded_json)

    if not records:
        print("No provenance records to render.", file=sys.stderr)
        return 1

    generated_at = datetime.now(tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

    document = BaseDocTemplate(
        output_path,
        pagesize=A4,
        leftMargin=LEFT_MARGIN,
        rightMargin=RIGHT_MARGIN,
        topMargin=TOP_MARGIN,
        bottomMargin=BOTTOM_MARGIN,
        title=f"{DOCUMENT_TITLE} — {deck_name or records[0].get('deckId') or ''}",
        author="CogniumLearn",
    )

    frame = Frame(
        LEFT_MARGIN, BOTTOM_MARGIN,
        CONTENT_WIDTH, PAGE_HEIGHT - TOP_MARGIN - BOTTOM_MARGIN,
        id="content", showBoundary=0,
    )
    document.addPageTemplates([PageTemplate(id="main", frames=[frame], onPage=draw_page_chrome)])

    story = []

    if len(records) > 1:
        story.extend(build_run_index(deck_name, records, generated_at))
        story.append(PageBreak())

    for run_number, record in enumerate(records, start=1):
        if run_number > 1:
            story.append(PageBreak())
        story.extend(build_story(record, generated_at, run_number, len(records)))

    document.build(story)

    print(f"Wrote {output_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
