"""
Renders the CogniumLearn Legal & Compliance Exposure Audit to a themed PDF.

Covers user-uploaded documents (coaching-institute textbooks, question papers,
answer-sheet scans, support attachments) and the AI-generated derivatives built
from them, across five architectural risk areas: file lifecycle and retention,
prompt-level derivative-work risk, tenant isolation, third-party API hygiene,
and intermediary safe-harbour safeguards.

Requirements: Common/Audits/LegalComplianceRequirements.txt
Theme:        Common/Reports/PdfTheme.md

Run with the repo's Python venv:
    Agent/.venv/Scripts/python.exe Common/Scripts/RenderLegalComplianceAudit.py
"""

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

SEVERITY_GREEN = "#2E9E54"
SEVERITY_AMBER = "#B9791A"
SEVERITY_RED = "#C0392B"

PAGE_WIDTH, PAGE_HEIGHT = A4
LEFT_MARGIN = RIGHT_MARGIN = 20 * mm
TOP_MARGIN = 18 * mm
BOTTOM_MARGIN = 20 * mm
CONTENT_WIDTH = PAGE_WIDTH - LEFT_MARGIN - RIGHT_MARGIN

OUTPUT_PATH = Path(__file__).resolve().parent.parent / "Reports" / "LegalComplianceAuditReport.pdf"
DOCUMENT_TITLE = "Legal & Compliance Exposure Audit"
DOCUMENT_DATE = "8 August 2026"


# --- Paragraph styles -----------------------------------------------------

styles = {
    "title": ParagraphStyle("title", fontName="Helvetica-Bold", fontSize=27, leading=31, textColor=TEAL_TITLE, spaceAfter=4),
    "subtitle": ParagraphStyle("subtitle", fontName="Helvetica", fontSize=12.5, leading=16, textColor=TEXT_MUTED, spaceAfter=2),
    "date": ParagraphStyle("date", fontName="Helvetica", fontSize=9.5, leading=13, textColor=TEXT_MUTED),
    "h2": ParagraphStyle("h2", fontName="Helvetica-Bold", fontSize=14.5, leading=17, textColor=TEAL_HEADER),
    "h3": ParagraphStyle("h3", fontName="Helvetica-Bold", fontSize=11, leading=15, textColor=TEAL_TITLE, spaceBefore=6, spaceAfter=2),
    "body": ParagraphStyle("body", fontName="Helvetica", fontSize=10, leading=15, textColor=TEXT_BODY, spaceAfter=6, alignment=TA_LEFT),
    "callout": ParagraphStyle("callout", fontName="Helvetica-Oblique", fontSize=10.5, leading=15.5, textColor=TEAL_TITLE),
    "bullet": ParagraphStyle("bullet", fontName="Helvetica", fontSize=10, leading=14.5, textColor=TEXT_BODY),
    "cell": ParagraphStyle("cell", fontName="Helvetica", fontSize=8.5, leading=11.5, textColor=TEXT_BODY),
    "cellLabel": ParagraphStyle("cellLabel", fontName="Helvetica-Bold", fontSize=8.5, leading=11.5, textColor=TEXT_LABEL),
    "cellHead": ParagraphStyle("cellHead", fontName="Helvetica-Bold", fontSize=9, leading=12.5, textColor=colors.white),
    "cellHeadCenter": ParagraphStyle("cellHeadCenter", fontName="Helvetica-Bold", fontSize=9, leading=12.5, textColor=colors.white, alignment=TA_CENTER),
    "cellCenter": ParagraphStyle("cellCenter", fontName="Helvetica-Bold", fontSize=8.5, leading=11.5, textColor=TEXT_BODY, alignment=TA_CENTER),
    "footer": ParagraphStyle("footer", fontName="Helvetica", fontSize=8, leading=10, textColor=TEXT_MUTED, alignment=TA_CENTER),
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
        _, paragraph_height = self.paragraph.wrap(self.width - 9 * mm, available_height)
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
    canvas.drawCentredString(PAGE_WIDTH / 2, footer_y, "CogniumLearn  —  " + DOCUMENT_TITLE)
    canvas.drawRightString(PAGE_WIDTH - RIGHT_MARGIN, footer_y, str(document.page))
    canvas.restoreState()


# --- Content builders -----------------------------------------------------

def risk(level):
    palette = {"HIGH": SEVERITY_RED, "MEDIUM": SEVERITY_AMBER, "LOW": SEVERITY_GREEN, "PASS": SEVERITY_GREEN}
    return "<font color='%s'>%s</font>" % (palette.get(level, "#6E7681"), level)


def action(disposition):
    """
    The operator-facing disposition. Deliberately NOT derived from severity:
    severity says how bad the exposure is, disposition says what to do about it,
    and the two legitimately diverge. An accepted trade-off can be MEDIUM and
    still need no action; a trivial LOW defect can still be worth fixing.
    """
    palette = {
        "IMMEDIATE": (SEVERITY_RED, "Needs immediate action"),
        "RECOMMENDED": (SEVERITY_AMBER, "Change recommended"),
        "NONE": (SEVERITY_GREEN, "No action needed"),
    }
    colour, label = palette.get(disposition, ("#6E7681", disposition))
    return "<font color='%s'>%s</font>" % (colour, label)


def where(path, lines):
    """File path plus line reference; basename breaks onto its own line so a long
    filename wraps at the separator rather than mid-word."""
    separator_index = path.rfind("/")
    rendered = path if separator_index == -1 else path[:separator_index + 1] + "<br/>" + path[separator_index + 1:]
    if lines is None:
        return "<font face='Courier' size='7'>%s</font>" % rendered
    return "<font face='Courier' size='7'>%s<br/>: %s</font>" % (rendered, lines)



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
        dot = Paragraph("&bull;", ParagraphStyle("dot", fontName="Helvetica-Bold", fontSize=10, leading=14.5, textColor=GOLD_ACCENT))
        rows.append([dot, Paragraph(body, styles["bullet"])])
    # splitInRow for the same reason make_table sets it: a bullet holding a long
    # value must flow across a page break rather than fail to place.
    table = Table(rows, colWidths=[5 * mm, CONTENT_WIDTH - 5 * mm])
    table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 2),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    enable_in_row_split(table)

    return table


def make_table(headers, rows, col_ratios, label_first_column=True, centered_columns=()):
    total = sum(col_ratios)
    col_widths = [CONTENT_WIDTH * ratio / total for ratio in col_ratios]

    header_cells = [
        Paragraph(head, styles["cellHeadCenter"] if index in centered_columns else styles["cellHead"])
        for index, head in enumerate(headers)
    ]
    data = [header_cells]
    for row in rows:
        cells = []
        for index, value in enumerate(row):
            if index in centered_columns:
                style = styles["cellCenter"]
            elif label_first_column and index == 0:
                style = styles["cellLabel"]
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
    return [Spacer(1, 9), SectionHeader(title, CONTENT_WIDTH), Spacer(1, 5)] + list(blocks)


FINDING_HEADERS = ["ID", "Location", "Finding", "Risk", "Action"]
FINDING_COLUMNS = [7, 21, 43, 12, 17]
FINDING_CENTERED = (3, 4)


def findings_table(rows):
    return make_table(FINDING_HEADERS, rows, FINDING_COLUMNS, centered_columns=FINDING_CENTERED)


# --- The audit content ----------------------------------------------------

def build_story():
    story = []

    story.append(Paragraph("Legal &amp; Compliance Exposure Audit", styles["title"]))
    story.append(Paragraph("User-uploaded documents and AI-generated derivatives &mdash; CogniumLearn platform", styles["subtitle"]))
    story.append(Spacer(1, 3))
    story.append(Paragraph(DOCUMENT_DATE + "  &middot;  Static source review  &middot;  Advisory only", styles["date"]))
    story.append(Spacer(1, 6))
    story.append(HorizontalRule(CONTENT_WIDTH, 2, GOLD_ACCENT, top_padding=2, bottom_padding=4))
    story.append(Spacer(1, 8))

    story.append(make_callout(
        "CogniumLearn ingests third-party copyrighted material by design, so its exposure lives in how source "
        "documents are retained, how they are re-expressed, and who can reach them. On this pass the erasure "
        "cascade is whole: a document's stored bytes, its extracted page text, its figure rows and the figure "
        "images themselves all go together, a takedown deletes one copy per holder rather than one in total, and "
        "no removal reports a success it has not achieved. The retention rule the code enforces is the one the "
        "Privacy Policy publishes, to the day. "
        "What this sweep surfaced instead is quieter and sits in two places. <b>Three object-storage prefixes "
        "still have no lifecycle at all</b> &mdash; the mock-test evaluation payload, the folder an abandoned "
        "generation run leaves behind, and deal invoices &mdash; none of them reached by any reaper. And "
        "<b>two retrieval paths resolve across the tenant boundary</b>: Ask AI can label a citation with another "
        "account's filename, and the document download reads out of another account's storage prefix whenever two "
        "users hold the same file. Neither leaks content, because the bytes are identical either way; both "
        "quietly undo the per-user separation the platform deliberately adopted, and one of them puts a stranger's "
        "brand-bearing filename in front of the model."))
    story.append(Spacer(1, 4))

    # ── Executive summary ─────────────────────────────────────────────────
    story.extend(section("1. Executive Risk Summary", [
        Paragraph(
            "Ratings are per architectural component. The Action column is set independently of severity "
            "&mdash; an accepted trade-off can be MEDIUM and still need no action, and a trivial defect "
            "can be LOW and still be worth fixing.", styles["body"]),
        make_table(
            ["Component", "Rating", "Headline", "Action"],
            [
                ["Unlifecycled storage prefixes", risk("MEDIUM"),
                 "Three object-storage prefixes are written by user action and deleted by nothing: the mock-test "
                 "evaluation payload (the candidate's answers plus the question text), the task folder an "
                 "abandoned generation run leaves behind, and deal invoices. Every other upload surface now has a "
                 "reaper; these were never given one.",
                 action("RECOMMENDED")],
                ["Cross-tenant retrieval resolution", risk("MEDIUM"),
                 "Two paths resolve past the tenant boundary once two accounts hold the same file: the Ask AI "
                 "citation label can resolve to another user's filename, and the download reads the blob out of "
                 "another user's storage prefix. No content leaks &mdash; the bytes are identical &mdash; but both "
                 "undo the per-user separation the platform deliberately adopted.",
                 action("RECOMMENDED")],
                ["Derivative provenance", risk("MEDIUM"),
                 "Generated cards, study material and mock tests record nothing about the document they came from. "
                 "The worker stages sourcePages and the write-back drops it, so a takedown has no way to find the "
                 "content derived from a work &mdash; the gap is in the write-back, not the pipeline.",
                 action("RECOMMENDED")],
                ["Ask-AI expression contract", risk("MEDIUM"),
                 "The shared expression rules lead study-material, flashcard, mock-test and knowledge-chunk "
                 "generation, but not Ask AI &mdash; the one path that puts verbatim source excerpts in front of "
                 "the model behind a one-paragraph system prompt.",
                 action("RECOMMENDED")],
                ["Answer-sheet promise divergence", risk("MEDIUM"),
                 "The Privacy Policy promises a scanned answer sheet is kept 60 days so a candidate can dispute "
                 "their marks against it. The worker deletes each scan the moment it is read into memory. The "
                 "privacy posture is better than published; the dispute guarantee is not kept.",
                 action("RECOMMENDED")],
                ["Third-party mark handling", risk("MEDIUM"),
                 "A cross-tenant egress path exists (paid-deck library, organization deck shelf). Mark detection "
                 "runs there as an advisory warning; the redaction function it was built around is called from "
                 "nowhere.",
                 action("RECOMMENDED")],
                ["Grievance timelines", risk("MEDIUM"),
                 "The Grievance Officer is named with a postal address in both documents, but neither commits to a "
                 "statutory acknowledgement or disposal window, and no public copyright-complaint route is "
                 "published.",
                 action("RECOMMENDED")],
                ["Residual prompt exposure", risk("MEDIUM"),
                 "Exam-paper extraction requests verbatim text deliberately, and the pool self-expires with the "
                 "task; one prompt asks for an examination board's official instructions reproduced exactly.",
                 action("RECOMMENDED")],
                ["Similarity enforcement", risk("MEDIUM"),
                 "Containment is scored on generated prose and logged, never persisted, and enforcement is off "
                 "pending calibration. Deliberate &mdash; an uncalibrated threshold pressures the model to "
                 "paraphrase content that must stay exact &mdash; but the calibration data is being discarded.",
                 action("RECOMMENDED")],
                ["Brand identifiers to the model", risk("MEDIUM"),
                 "Ask AI labels each grounding excerpt with the uploaded document's name &mdash; the same "
                 "brand-bearing string that is pseudonymised at every logging site before it reaches disk.",
                 action("RECOMMENDED")],
                ["Takedown derivative scope", risk("MEDIUM"),
                 "Takedown removes the source and its derived artefacts, but not content generated from it. "
                 "Deliberate: original wording about facts is not a reproduction, and full lineage is "
                 "unachievable across synced and user-edited copies.",
                 action("NONE")],
                ["Erasure cascade completeness", risk("PASS"),
                 "A document's blob, page text, figure rows and figure images are removed together, ordered so no "
                 "step destroys the record the next one needs, with a last-reference check before an image is "
                 "dropped and a cursor-driven sweep reclaiming what earlier gaps left.",
                 action("NONE")],
                ["Takedown completeness", risk("PASS"),
                 "The cross-tenant purge deletes one stored copy per holder, counts what it found against what it "
                 "removed, and reports completion only when every copy went and no row resisted.",
                 action("NONE")],
                ["Retention policy vs. published terms", risk("PASS"),
                 "The subscription-linked grace period the reaper enforces is the same period the Privacy Policy "
                 "publishes, and the free-tier branch is load-bearing rather than decorative.",
                 action("NONE")],
                ["Derived-content tenancy", risk("PASS"),
                 "Embedding chunks and cached figures carry a tenant column, both vector-search paths filter on "
                 "it, and orphan detection matches the (user, document) pair rather than the hash.",
                 action("NONE")],
                ["Source reachability", risk("PASS"),
                 "No public bucket, pre-signed URL or unauthenticated route to stored content exists; every read "
                 "is server-side and credentialed behind a login guard and an ownership check.",
                 action("NONE")],
                ["Secondary upload lifecycle", risk("PASS"),
                 "Support attachments and answer-sheet prefixes have a registry-backed retention window plus an "
                 "eager purge on ticket closure; account deletion purges both immediately.",
                 action("NONE")],
                ["Expression contract (generation)", risk("PASS"),
                 "One shared contract leads generation, separating content that must stay exact &mdash; formulae, "
                 "constants, statutory definitions &mdash; from prose that must be re-authored.",
                 action("NONE")],
                ["Export handling", risk("PASS"),
                 "Export writes a pure local file with no server link, and paid and AI-generated decks are "
                 "refused, with the client-side nature of that gate acknowledged and monitored.",
                 action("NONE")],
                ["Third-party API hygiene", risk("PASS"),
                 "All three providers assert their data posture in code: Vertex refuses a silent downgrade to the "
                 "API-key surface, OpenAI sets store=False, Anthropic fails closed and states what it may receive.",
                 action("NONE")],
                ["Application logging", risk("PASS"),
                 "No document content reaches the logs, uploaded filenames are pseudonymised across six workflows, "
                 "and the task archive stores a summary string rather than the payload.",
                 action("NONE")],
                ["Contractual safeguards", risk("PASS"),
                 "Terms carry an infringing-content prohibition, a UGC rights warranty and an IP indemnity; "
                 "point-of-action IP notices appear at both upload and export.",
                 action("NONE")],
                ["Inbound dependency licensing", risk("PASS"),
                 "Assessed separately and not rated here &mdash; see "
                 "<b>Common/Reports/DependencyLicenceReport.pdf</b>, which is generated from the manifests and "
                 "installed metadata and carries its own rating.",
                 action("NONE")],
            ],
            [19, 12, 51, 18], centered_columns=(1, 3)),
    ]))

    # ── Area 1 ────────────────────────────────────────────────────────────
    story.extend(section("2. File Lifecycle &amp; Retention", [
        Paragraph(
            "Six upload surfaces were traced end to end: study documents, support attachments, answer-sheet "
            "scans, mock-test attempt payloads, deal invoices and generation task staging. The document cascade "
            "is now complete and the two secondary surfaces have real windows. What remains is three prefixes "
            "that no reaper covers, and one place where the code is stricter than the promise it publishes.",
            styles["body"]),
        findings_table([
            ["R-01", where("Dock/Endpoints/MockTest/EvaluateAttempt.js", "227-244, 303-316"),
             "The attempt payload &mdash; the candidate's answers plus the question text they answered &mdash; is "
             "written to <font face='Courier' size='7'>Tasks/&lt;evaluationTaskId&gt;/MockTestEvaluations/</font> "
             "and the graded output lands beside it. Nothing registers that prefix with "
             "<font face='Courier' size='7'>EphemeralUploadRegistry</font>, and the only code that deletes a task "
             "folder is the generation success path, which never runs for an evaluation task. The transcription "
             "flow immediately alongside it registers its prefix; this one does not, so it keeps a graded exam "
             "attempt indefinitely by omission rather than by decision.",
             risk("MEDIUM"), action("RECOMMENDED")],
            ["R-02", where("Dock/Endpoints/Helpers/MoveToDatabase.js", "319-339"),
             "The generation task folder is listed and deleted as the last step of the SUCCESS path only. A run "
             "that fails, is paused and abandoned, or is orphaned by a restart leaves "
             "<font face='Courier' size='7'>Tasks/&lt;mainTaskId&gt;/</font> intact &mdash; staged flashcards and "
             "study material, worker logs, the web image cache and the figure scratch prefix, all of it derived "
             "from the uploaded book. The orphan reconciler reads that folder to decide what happened "
             "(<font face='Courier' size='7'>OrphanedGenerationReconciler.js:100</font>) and deliberately leaves "
             "it in place; no reaper covers the prefix afterwards.",
             risk("MEDIUM"), action("RECOMMENDED")],
            ["R-03", where("Agent/Workflows/TranscribeMockTestAttempt/TranscribeMockTestAttempt.py", "252-270"),
             "Each answer-sheet scan is deleted as soon as it has been read into memory. Privacy Policy clause "
             "10.5 states the opposite: the scan is retained &quot;for 60 (sixty) days from upload so that it "
             "remains available if You dispute the transcription or the marks awarded&quot;. The registry entry "
             "written at upload does book a 60-day window "
             "(<font face='Courier' size='7'>TranscribeOfflineAttempt.js:268-275</font>), but by the time the "
             "reaper sees it the images are already gone. The privacy posture is better than published; the "
             "dispute-evidence guarantee is not kept, and it is the half a candidate would rely on.",
             risk("MEDIUM"), action("RECOMMENDED")],
            ["R-04", where("Dock/Endpoints/Admin/Deals/UploadDealInvoice.js", "110-135"),
             "Deal invoices are moved to <font face='Courier' size='7'>Invoices/&lt;dealId&gt;/</font> with no "
             "deletion path anywhere in the file and no registry entry. Admin-authored commercial documents "
             "rather than third-party content, so the copyright exposure is negligible; listed because it is the "
             "last upload surface with no lifecycle at all, and because a commercial record deserves a stated "
             "retention period rather than an unstated one.",
             risk("LOW"), action("RECOMMENDED")],
            ["R-05", where("Dock/Globals/Classes/Content/SourceRetentionPolicy.js", "30-124"),
             "<b>Control verified.</b> Three branches &mdash; subscribed, lapsed, never-subscribed &mdash; all at "
             "<font face='Courier' size='7'>SOURCE_RETENTION_GRACE_DAYS = 60</font>, which is exactly the period "
             "Privacy Policy clause 10.4 publishes for both the subscription and the free case. The cutoff is "
             "derived per sweep rather than stamped at upload, so no subscription event can leave it stale, and "
             "the free-tier branch actually deletes rather than reading as a policy that never fires.",
             risk("PASS"), action("NONE")],
            ["R-06", where("Dock/Globals/Classes/Content/DerivedContentPurger.js", "38-160"),
             "<b>Control verified.</b> The figure images cropped from an uploaded book are now removed with the "
             "document. The ordering is the part that makes it correct: the storage paths are read while the rows "
             "still name them, the rows go, and only then is each path re-checked against surviving rows before "
             "the object is dropped &mdash; a PNG is addressed by (user, perceptual hash), so two of one user's "
             "books containing the same illustration share it. A bounded, cursor-driven sweep reclaims what "
             "earlier gaps left, skipping anything younger than the write-to-record window.",
             risk("PASS"), action("NONE")],
            ["R-07", where("Dock/Globals/Classes/Content/EphemeralUploadRegistry.js", "53-201"),
             "<b>Control verified.</b> Support attachments and answer-sheet prefixes are registered at upload with "
             "60-day windows matching Privacy Policy clauses 10.5 and 10.6, purged eagerly when a ticket is "
             "resolved, and purged immediately on account deletion. Deletion is by prefix rather than by a stored "
             "file list, so a partially-written batch is still fully reclaimable, and the row is dropped only "
             "after the objects are &mdash; the failure mode is &quot;sweep again&quot;, never &quot;forget&quot;.",
             risk("PASS"), action("NONE")],
            ["R-08", where("Dock/Endpoints/AutomaticGeneration/InformationSourceDownload.js", "19-49"),
             "<b>Control verified.</b> No route serves stored content without authentication. The download is "
             "registered behind <font face='Courier' size='7'>ensureLogin</font> "
             "(<font face='Courier' size='7'>HandleAutomaticGenerationEndpoints.js:117-121</font>), the read is "
             "server-side through credentialed object storage, and no pre-signed URL, public ACL or public bucket "
             "path exists anywhere in the tree. A separate defect in how this handler resolves the blob is "
             "recorded at T-02.",
             risk("PASS"), action("NONE")],
        ]),
    ]))

    # ── Area 2 ────────────────────────────────────────────────────────────
    story.extend(section("3. System Prompts &amp; Content Transformation", [
        Paragraph(
            "Eighty-three prompt assets were read. The shared expression contract is genuine and well drafted "
            "&mdash; it separates what must stay exact from what must be re-authored, and refuses the trade the "
            "requirements file forbids. The exposure is in which paths lead with it and which do not.",
            styles["body"]),
        findings_table([
            ["X-01", where("Agent/Workflows/AskAi/AskAiPromptBuilder.py", "215, 553-563"),
             "Ask AI composes its grounding block from retrieved page chunks &mdash; verbatim extracted text of "
             "the uploaded book &mdash; and pairs it with "
             "<font face='Courier' size='7'>ASK_AI_SYSTEM</font>, a single paragraph about tone that says nothing "
             "about expression. The other four generation paths all lead with "
             "<font face='Courier' size='7'>SOURCE_EXPRESSION_RULES</font>. This is the path where verbatim source "
             "prose is closest to the output and the only one with no contract governing how it is re-expressed.",
             risk("MEDIUM"), action("RECOMMENDED")],
            ["X-02", where("Agent/Globals/Classes/Automation/Pools/Prompts/MOCK_TEST_INSTRUCTIONS_USER.txt", "6"),
             "The prompt asks the model to &quot;return its official instructions and duration exactly as they "
             "would appear on the paper&quot; for a named exam. An examination board's instruction sheet is that "
             "board's own text, and reproducing it exactly is a reproduction rather than a fact. The functional "
             "need &mdash; a candidate practising under the real rubric &mdash; is met by an equivalent statement "
             "of the same rules, since the marking scheme and timing are facts while the wording is not.",
             risk("MEDIUM"), action("RECOMMENDED")],
            ["X-03", where("Agent/Globals/Classes/Compliance/SourceSimilarityScorer.py", "160-225"),
             "Containment of generated prose within its source chunks is scored on every study-material and "
             "flashcard generation, but the score is written to stderr and discarded &mdash; nothing persists it "
             "with the entity. Enforcement is off behind "
             "<font face='Courier' size='7'>SOURCE_SIMILARITY_ENFORCEMENT_ENABLED</font> with an explicitly "
             "uncalibrated 0.25 default. Keeping enforcement off is right; discarding the distribution means the "
             "calibration that would let it be turned on is never accumulated.",
             risk("MEDIUM"), action("RECOMMENDED")],
            ["X-04", where("Agent/Globals/Classes/Automation/Pools/Prompts/PYQ_EXTRACTION_SYSTEM.txt", "6, 15"),
             "Exam-paper extraction instructs &quot;verbatim where possible&quot; and &quot;Do NOT make up "
             "questions or paraphrase them. Verbatim extraction.&quot; This is deliberate and largely contained: "
             "the extracted pool is never written to the blueprint or any collection &mdash; it travels only in "
             "the worker task payload, which carries a five-hour Redis TTL "
             "(<font face='Courier' size='7'>TaskManager.js:18, 298</font>) &mdash; and downstream every seed is "
             "rewritten through the rephrase pass rather than emitted. Recorded because the verbatim step is real "
             "and its containment rests on that TTL rather than on an explicit deletion.",
             risk("MEDIUM"), action("RECOMMENDED")],
            ["X-05", where("Agent/Globals/Classes/Automation/Pools/Prompts/SOURCE_EXPRESSION_RULES.txt", None),
             "<b>Control verified.</b> The contract does what the requirements file demands and refuses the trade "
             "it forbids: formulae, constants, chemical species, statutory definitions, terms of art and "
             "numerical values are named as content that MUST be reproduced exactly, prose as content that must "
             "be re-authored, with an explicit instruction never to reword a fact to satisfy the rule. It also "
             "closes the loophole that a &quot;never mention the source&quot; instruction could be read as "
             "licence to copy it unattributed. Composed into flashcards, study material, mock tests and knowledge "
             "chunks.",
             risk("PASS"), action("NONE")],
            ["X-06", where("Agent/Globals/Classes/Automation/Pools/Prompts/MOCK_TEST_QUESTION_REPHRASE_SYSTEM.txt", None),
             "<b>Control verified.</b> Every PYQ seed is rewritten under a closed-book rule that forbids "
             "referring to any source, backed by a measurable six-word shared-run limit mirrored in code as "
             "<font face='Courier' size='7'>DEFAULT_MAX_SHARED_WORD_RUN</font>. This is the control that keeps "
             "X-04's verbatim extraction from reaching the learner as a copy.",
             risk("PASS"), action("NONE")],
        ]),
    ]))

    # ── Area 3 ────────────────────────────────────────────────────────────
    story.extend(section("4. Tenant Isolation &amp; Database Leakage", [
        Paragraph(
            "Every retrieval path over user content was read, not only the shared query engine. The scoping of "
            "the content itself is sound and defended three times over. Both findings below are in the "
            "<i>resolution</i> steps that sit beside that scoping &mdash; a name lookup and a path lookup, "
            "neither of which inherited the tenant filter the query next to it applies.",
            styles["body"]),
        findings_table([
            ["T-01", where("Agent/Globals/Classes/Database/EmbeddingsQueryEngine.py", "180-191"),
             "After the scoped vector search returns, source names are resolved with "
             "<font face='Courier' size='7'>find({hash: {$in: hashes}})</font> &mdash; no "
             "<font face='Courier' size='7'>userId</font> filter, unlike every query above it in the same method. "
             "The hash set is the caller's own, but rows for that hash exist for every tenant holding the file, "
             "and the hash&#8209;to&#8209;name map keeps whichever row Mongo returns last. A user who uploaded "
             "&quot;Physics.pdf&quot; can therefore see a citation labelled with another account's filename for "
             "the same book &mdash; and by D-01 that foreign name is also what reaches the model.",
             risk("MEDIUM"), action("RECOMMENDED")],
            ["T-02", where("Dock/Endpoints/AutomaticGeneration/InformationSourceDownload.js", "35-45"),
             "Authorisation is checked by content hash "
             "(<font face='Courier' size='7'>doesUserOwnInformationSourceWithHash</font>) but the read then uses "
             "the <i>requested row's</i> <font face='Courier' size='7'>directoryPath</font>, which belongs to "
             "whichever tenant that row is for. A user passing another account's information-source id downloads "
             "out of that account's per-user prefix whenever both hold the same file. No content leaks &mdash; "
             "the check guarantees the requester owns the same bytes &mdash; but this is exactly the &quot;one "
             "stored copy served to two accounts&quot; pattern the per-user storage split was adopted to end "
             "(<font face='Courier' size='7'>InformationSourceUpload.js:448-461</font>). Separately, the "
             "<font face='Courier' size='7'>getUser</font> result is dereferenced without a null check; the route "
             "sits behind <font face='Courier' size='7'>ensureLogin</font>, so this costs a 500 instead of a 401 "
             "rather than admitting anyone.",
             risk("MEDIUM"), action("RECOMMENDED")],
            ["T-03", where("Agent/Globals/Classes/Database/EmbeddingsQueryEngine.py", "96-273"),
             "<b>Control verified.</b> Grounding retrieval is scoped three independent times: Dock filters the "
             "caller's hashes before the worker spawns, the worker re-derives the permitted set from "
             "<font face='Courier' size='7'>informationSources</font>, and both retrieval implementations filter "
             "on <font face='Courier' size='7'>userId</font> &mdash; the Atlas "
             "<font face='Courier' size='7'>$vectorSearch</font> in its filter clause and the brute-force "
             "fallback in its find. An empty owner id returns nothing rather than falling open, and the fallback "
             "path was checked specifically because a degraded search node is where a filter usually gets lost.",
             risk("PASS"), action("NONE")],
            ["T-04", where("Agent/Globals/Classes/Database/EmbeddingsQueryEngine.py", "15-68"),
             "<b>Control verified.</b> Derived content is keyed on the tenant at write time, not only at read "
             "time: chunk upserts match on "
             "<font face='Courier' size='7'>(userId, informationSourceHash, pageNumber, content)</font>, so one "
             "document uploaded by two users produces two independent chunk sets rather than one shared row that "
             "later needs an access check. Figure rows carry the same pair, and orphan detection matches on it "
             "rather than on the hash alone.",
             risk("PASS"), action("NONE")],
        ]),
    ]))

    # ── Area 4 ────────────────────────────────────────────────────────────
    story.extend(section("5. Model Training &amp; Data Logging", [
        Paragraph(
            "Three providers carry live traffic. All three state their data posture in code at the point of "
            "reliance rather than inheriting it from a platform default, which is the distinction the "
            "requirements file asks for. The one finding is not about a provider setting but about what is put "
            "into the prompt.", styles["body"]),
        findings_table([
            ["D-01", where("Agent/Workflows/AskAi/AskAiPromptBuilder.py", "559-563"),
             "Each grounding excerpt is labelled "
             "<font face='Courier' size='7'>[Source: &lt;document name&gt;, page N]</font> using the uploaded "
             "file's own name. That string routinely carries a coaching institute or publisher mark, and it is "
             "the same string the platform is careful to pseudonymise everywhere it touches disk. The page number "
             "is what makes the citation useful to the learner; the brand-bearing stem is not. Compounded by "
             "T-01, the name sent can belong to a different account.",
             risk("MEDIUM"), action("RECOMMENDED")],
            ["D-02", where("Agent/Globals/Classes/Automation/Providers/GoogleEnterpriseAiProvider.py", "152-182"),
             "<b>Control verified.</b> The provider refuses to fall back from the service-account Vertex backend "
             "to the Express API-key surface implicitly, raising with an explanation that names the reason "
             "&mdash; a different contractual and data-governance posture &mdash; and requiring "
             "<font face='Courier' size='7'>GOOGLE_ENTERPRISE_AGENT_ALLOW_API_KEY_FALLBACK</font> to accept it "
             "deliberately. The resolved auth mode is printed once per process, so the posture in force is "
             "visible in every worker's log rather than inferred.",
             risk("PASS"), action("NONE")],
            ["D-03", where("Agent/Globals/Classes/Automation/Providers/OpenAiProvider.py", "34, 78"),
             "<b>Control verified.</b> <font face='Courier' size='7'>store=False</font> is a named class constant "
             "passed on every call rather than an argument that could be dropped at one call site, so prompts and "
             "completions are not retained for the platform's own use.",
             risk("PASS"), action("NONE")],
            ["D-04", where("Agent/Globals/Classes/Automation/Providers/AnthropicProvider.py", "57-90"),
             "<b>Control verified.</b> The provider fails loudly at construction when its key is absent rather "
             "than routing paid-deck work to a different model, and it documents honestly what it does not "
             "control &mdash; the 30-day platform-level abuse-monitoring window, and that zero-data-retention is "
             "an account-level agreement rather than a request parameter. Stating an uncontrolled posture "
             "explicitly is worth more than asserting a flag that does not exist.",
             risk("PASS"), action("NONE")],
            ["D-05", where("Agent/Globals/Utility/RedactSourceName.py", "5-36"),
             "<b>Control verified.</b> Uploaded filenames are converted to a deterministic pseudonym "
             "(<font face='Courier' size='7'>src-4f2a9c71.pdf</font>) before any logging, applied across six "
             "workflows, keeping the extension for diagnostics and the digest for cross-run correlation. The "
             "reasoning is recorded at the helper: Agent output is teed into Dock's pipeline, persisted to Mongo "
             "and the write-ahead log, and is downloadable through the admin export, so a raw filename would "
             "become a durable exportable record attributing named third-party material to the platform. The task "
             "archive likewise stores a summary string rather than the payload.",
             risk("PASS"), action("NONE")],
        ]),
    ]))

    # ── Area 5 ────────────────────────────────────────────────────────────
    story.extend(section("6. Legal Intermediary Provisions", [
        Paragraph(
            "The safe-harbour machinery is largely present and, where present, genuinely built rather than "
            "gestured at: an insert-only notice register, a dry-run takedown that refuses an unattributed "
            "removal, export gates and a full contractual set. Three gaps sit between that machinery and what it "
            "can actually reach.", styles["body"]),
        findings_table([
            ["H-01", where("Dock/Endpoints/Helpers/MoveToDatabase.js", "319-341"),
             "Generated cards, study material and mock tests record nothing about the document they were built "
             "from. The pipeline has the information &mdash; workers stage "
             "<font face='Courier' size='7'>sourcePages</font> alongside each entity "
             "(<font face='Courier' size='7'>FlashcardGenerationWorker.py:461</font>, "
             "<font face='Courier' size='7'>StudyMaterialGenerationWorker.py:210</font>) &mdash; and the "
             "write-back drops it; the field appears nowhere in Dock. Only the deck carries an "
             "&quot;AI-generated&quot; marker, which says nothing about which work it came from. A rightsholder "
             "notice therefore has no way to enumerate what was derived from the material, which is what makes "
             "H-07 an accepted limit rather than a solvable one.",
             risk("MEDIUM"), action("RECOMMENDED")],
            ["H-02", where("Dock/Globals/Classes/Content/BrandNameSanitizer.js", "128-147"),
             "<font face='Courier' size='7'>redact</font> is implemented, tested against a curated mark list and "
             "called from nowhere. The only consumer is "
             "<font face='Courier' size='7'>findRegisteredMarks</font>, used at publish time as an advisory "
             "warning that does not block "
             "(<font face='Courier' size='7'>PaidDeckPublishService.js:311-318</font>). Advisory detection is the "
             "right default for a title, because nominative use is legitimate and only an operator can tell it "
             "from implied endorsement &mdash; but nothing applies the redaction on the one path where content "
             "crosses to an account that is not the publisher's.",
             risk("MEDIUM"), action("RECOMMENDED")],
            ["H-03", where("Dock/SeedData/LegalDocuments.json", "Terms cl.19; Privacy cl.18"),
             "A Grievance Officer is named in both documents with a full postal address and an email, which is "
             "the substantive part of the obligation. Neither commits to a timeline: the Terms promise "
             "&quot;reasonable efforts&hellip; at the earliest possible opportunity&quot; and the Privacy Policy "
             "&quot;within the timelines prescribed under Applicable Law&quot;, where the IT Rules 2021 specify "
             "24 hours to acknowledge and 15 days to dispose. No separate copyright-complaint route is published "
             "either, so a rightsholder's only entry point is the general support address.",
             risk("MEDIUM"), action("RECOMMENDED")],
            ["H-04", where("Dock/Globals/Classes/Content/InformationSourcePurger.js", "81-215"),
             "<b>Control verified.</b> The takedown purge builds one blob path per matching row from that row's "
             "own directory, deduplicates, and deletes each independently so one failure does not abandon the "
             "rest. <font face='Courier' size='7'>bContentRemoved</font> is true only when every located copy was "
             "removed, no row resisted deletion and no row was unlocatable; the register records "
             "<font face='Courier' size='7'>storedCopiesFound</font> against "
             "<font face='Courier' size='7'>storedCopiesRemoved</font> so a partial removal is legible rather "
             "than rounded up to success. A row with no directory path is counted and skipped rather than having "
             "a path guessed from the hash.",
             risk("PASS"), action("NONE")],
            ["H-05", where("Dock/Endpoints/Admin/Content/TakedownContent.js", "36-160"),
             "<b>Control verified.</b> A notice reference is mandatory even for a dry run, so an unattributed "
             "removal cannot be actioned; a hash matching neither rows nor derived artefacts returns 404 rather "
             "than recording a takedown that removed nothing; the dry run reports the distinct stored-copy count "
             "before an irreversible action; and every outcome is appended to an insert-only register that has no "
             "update or delete method.",
             risk("PASS"), action("NONE")],
            ["H-06", where("Main/Globals/Model/Deck.js", "1094-1147"),
             "<b>Control verified.</b> Export writes a local <font face='Courier' size='7'>.mmd</font> file "
             "through the client's own persistence layer &mdash; a self-contained payload, not a link back to a "
             "central server, so a shared export cannot become a distribution channel for platform-hosted "
             "content. Paid and AI-generated decks are refused at the export entry point, with the client-side "
             "nature of that gate acknowledged and reported.",
             risk("PASS"), action("NONE")],
            ["H-07", where("Dock/SeedData/LegalDocuments.json", "Terms cl.9.2"),
             "<b>Control verified.</b> The contractual set is complete: a UGC rights warranty that the user owns "
             "or is licensed for what they upload, a representation that it infringes no third-party right, an IP "
             "indemnity, and an express statement that the Company is not obliged to host or retain any UGC.",
             risk("PASS"), action("NONE")],
            ["H-08", where("Dock/Globals/Classes/Content/InformationSourcePurger.js", "81-90"),
             "Takedown reaches the source and everything derived mechanically from it, but not the flashcards and "
             "study material generated from it. Recorded as an accepted limit rather than a defect: original "
             "wording about facts is not a reproduction of the work, and once content has synced to devices and "
             "been user-edited, full lineage is unachievable. H-01 is what would make a case-by-case review "
             "possible where it is warranted.",
             risk("MEDIUM"), action("NONE")],
        ]),
    ]))

    # ── Section 6 pointer ─────────────────────────────────────────────────
    story.extend(section("7. Inbound Dependency Licensing", [
        make_callout(
            "Inbound third-party licence exposure is assessed in its own report and is deliberately not "
            "summarised, rated or restated here. It is generated &mdash; never hand-written &mdash; from the "
            "manifests and installed package metadata at render time, and carries its own weighted rating out of "
            "ten. See <b>Common/Reports/DependencyLicenceReport.pdf</b>, regenerated as the first step of this "
            "audit by <b>Common/Scripts/RenderDependencyLicenceReport.py</b>."),
    ]))

    # ── Remediation ───────────────────────────────────────────────────────
    story.extend(section("8. Recommended Remediation", [
        Paragraph(
            "Specifications only &mdash; nothing was changed while producing this audit. None of these trades "
            "accuracy for originality; where a fix touches a prompt, the invariant content (formulae, constants, "
            "statutory definitions, quantities) is explicitly left exact.", styles["body"]),
        make_table(
            ["Priority", "Addresses", "Specification"],
            [
                ["P1", "R-01, R-02",
                 "Register the evaluation prefix with "
                 "<font face='Courier' size='7'>EphemeralUploadRegistry</font> at the point the attempt payload "
                 "is written, and register the generation task prefix at run start rather than relying on the "
                 "success path to clean it. The success path can still purge eagerly; the registration is the "
                 "backstop for every path that does not reach it. Reuse the existing reaper &mdash; it already "
                 "runs this exact shape of sweep for two other content types, so this is one call per producer "
                 "and no new machinery."],
                ["P1", "T-01",
                 "Add <font face='Courier' size='7'>userId</font> to the source-name lookup, matching every other "
                 "query in that method. One filter term; it cannot regress retrieval because the hash set is "
                 "already the caller's own, and it closes both the label leak and the foreign-name-to-model path "
                 "in D-01."],
                ["P1", "T-02",
                 "Resolve the requester's OWN row for the hash and read from that row's directory, rather than "
                 "reading from the row whose id was supplied. The ownership check already loads exactly that row "
                 "&mdash; return it instead of a boolean and use it. Add the missing null check on "
                 "<font face='Courier' size='7'>getUser</font> so the handler answers 401 on its own rather than "
                 "depending solely on the route guard."],
                ["P1", "R-03",
                 "Decide which half is right and make the other match, rather than leaving them divergent. The "
                 "recommended direction is to keep the code and correct clause 10.5: state that the scan is "
                 "deleted as soon as it has been transcribed and that the transcription is what a dispute is "
                 "reviewed against. That is the stronger privacy posture and it is what already happens. If the "
                 "dispute-evidence guarantee is wanted instead, remove the eager delete and let the registered "
                 "60-day window do the work it was already booked for."],
                ["P2", "H-01",
                 "Persist the <font face='Courier' size='7'>sourcePages</font> and source hash the workers "
                 "already stage onto the stored card, study material and mock test, then add an admin lookup that "
                 "lists generated entities by source content hash. Store the containment score from X-03 "
                 "alongside each entity so the lookup can rank candidates by how verbatim they actually are, and "
                 "keep removal a manual per-case decision rather than a cascade."],
                ["P2", "X-01",
                 "Compose <font face='Courier' size='7'>SOURCE_EXPRESSION_RULES</font> into the Ask AI system "
                 "prompt, as the other four generation paths already do. Its accuracy carve-out is what makes "
                 "this safe: definitions, formulae and quantities stay exact, and only the surrounding prose must "
                 "be the model's own. Do not narrow the grounding block to compensate &mdash; less grounding "
                 "means more invention, which is the worse failure."],
                ["P2", "D-01",
                 "Send the redacted pseudonym rather than the raw document name in the grounding label, keeping "
                 "the page number, which is the part that makes the citation useful. "
                 "<font face='Courier' size='7'>RedactSourceName</font> already produces a stable pseudonym, so "
                 "citations stay consistent within a response, and the frontend can map it back to the real title "
                 "client-side where the user is entitled to see it."],
                ["P2", "X-02",
                 "Replace &quot;return its official instructions&hellip; exactly as they would appear on the "
                 "paper&quot; with an instruction to state the same rules in the platform's own words &mdash; "
                 "keeping duration, marks per question, negative marking and section counts exact, because those "
                 "are facts and the candidate's practice depends on them, while the rubric prose is re-authored."],
                ["P2", "X-03",
                 "Persist the containment score with the entity instead of only logging it, and extend scoring to "
                 "mock-test question generation. Then calibrate a threshold from the collected distribution "
                 "before enabling enforcement anywhere &mdash; an uncalibrated threshold either never fires or "
                 "pressures the model to paraphrase the content that must stay exact."],
                ["P2", "H-02",
                 "Apply <font face='Courier' size='7'>BrandNameSanitizer.redact</font> to the publicly listed "
                 "fields of paid decks and organization decks at the point they are shown to an account other "
                 "than the publisher's, leaving the publisher's own view unmodified. That is exactly the posture "
                 "the class documents and has never been wired to."],
                ["P2", "H-03",
                 "State the IT Rules 2021 windows explicitly in both documents &mdash; acknowledgement within 24 "
                 "hours, disposal within 15 days &mdash; and publish a dedicated copyright-notice route "
                 "identifying what a valid notice must contain. The takedown machinery to honour one already "
                 "exists; what is missing is the published address that lets a rightsholder reach it."],
                ["P3", "R-04",
                 "Give deal invoices a stated retention period and a deletion path, either through the same "
                 "registry with a commercial-records window or through an explicit archival rule. The exposure is "
                 "negligible; the value is that no upload surface is left with an unstated lifecycle, which is "
                 "how the three findings above came to exist."],
                ["P3", "X-04",
                 "Delete the extracted question pool from the worker payload once the rephrase pass has consumed "
                 "it, rather than relying on the five-hour task TTL. The TTL is a real bound and the current "
                 "state is acceptable; an explicit delete makes the containment a decision rather than a "
                 "consequence of an unrelated cache setting."],
            ],
            [9, 13, 78]),
    ]))

    # ── Operational notes ─────────────────────────────────────────────────
    story.extend(section("9. Operational Notes", [
        Paragraph(
            "Behaviour that changes how an environment boots or what it does by default, recorded so a deploy "
            "does not discover it.", styles["body"]),
        make_bullets([
            ("Vertex auth now gates Agent boot",
             "<font face='Courier' size='7'>GOOGLE_ENTERPRISE_AGENT_PROJECT</font> must be set. An environment "
             "carrying only <font face='Courier' size='7'>GOOGLE_ENTERPRISE_AGENT_API_KEY</font> raises at "
             "provider construction instead of running, and must set "
             "<font face='Courier' size='7'>GOOGLE_ENTERPRISE_AGENT_ALLOW_API_KEY_FALLBACK=true</font> to accept "
             "the Express surface deliberately. This is the intended failure mode, but it will stop an "
             "unmigrated environment."),
            ("Anthropic key is paid-deck-only and fails closed",
             "<font face='Courier' size='7'>ANTHROPIC_API_KEY</font> is required only by the admin-only "
             "paid-deck generation stages. The provider raises at construction when it is unset rather than "
             "silently routing to another model, which would contradict the model id recorded in the run's "
             "generation-provenance document. Environments that never run paid-deck generation can leave it "
             "unset."),
            ("Similarity enforcement is off and its threshold is uncalibrated",
             "<font face='Courier' size='7'>SOURCE_SIMILARITY_ENFORCEMENT_ENABLED</font> defaults to off and "
             "<font face='Courier' size='7'>SOURCE_SIMILARITY_CONTAINMENT_THRESHOLD</font> defaults to 0.25, "
             "which the code documents as a starting point rather than a validated value. Enabling enforcement "
             "before calibrating against production data is the specific mistake the default exists to prevent."),
            ("The figure-object sweep cursor is in-memory",
             "The reaper's position in the figure prefix is held in process memory, so a restart re-scans from "
             "the head of the prefix. The sweep is idempotent, so this costs repeated listing rather than "
             "correctness &mdash; but on a bucket large enough that a full pass spans many ticks, frequent "
             "restarts will keep it near the beginning."),
            ("Answer-sheet retention is shorter than published",
             "Per R-03 the scans are deleted within minutes of transcription, not the 60 days clause 10.5 "
             "states. Support answering a marks dispute cannot retrieve the original image today, whatever the "
             "policy says."),
        ]),
    ]))

    # ── Rating ────────────────────────────────────────────────────────────
    story.extend(section("10. Overall Rating", [
        make_table(
            ["Area", "Weight", "Score", "Reasoning"],
            [
                ["File lifecycle &amp; retention", "High", "8",
                 "The document cascade is complete and ordered correctly, the published retention period is the "
                 "one enforced, and two secondary surfaces have real registry-backed windows. Against that: three "
                 "prefixes no reaper covers, and a published promise the code contradicts."],
                ["Derivative-work risk", "High", "8",
                 "The shared expression contract is genuinely good and refuses the accuracy trade outright, and "
                 "the closed-book rephrase rule is measurable. The deduction is for the one path that puts "
                 "verbatim source in front of the model without it, and for discarding the similarity data that "
                 "would let enforcement be calibrated."],
                ["Tenant isolation", "High", "8",
                 "Closed at the schema rather than by convention: a tenant column written at upsert time, three "
                 "independent checks on retrieval, both search implementations filtered, per-user storage paths. "
                 "Two resolution steps beside that scoping still cross the boundary, neither leaking content."],
                ["Third-party API hygiene", "Medium", "9",
                 "All three providers assert their posture in code at the point of reliance, refuse silent "
                 "downgrades, and state honestly what they do not control. The deduction is for sending the "
                 "uploader's brand-bearing document name to a provider the logs are careful to keep it from."],
                ["Intermediary safeguards", "High", "7",
                 "Contract, insert-only register, dry-run takedown that now removes every holder's copy, export "
                 "gates and point-of-action notices are all present and verified. Against that: generated content "
                 "records no provenance at all, the redaction function is built but unwired, and no statutory "
                 "timeline is committed."],
            ],
            [26, 12, 9, 53], centered_columns=(1, 2)),
        Spacer(1, 9),
        make_callout(
            "<b>Overall: 8 / 10.</b> No HIGH finding survived this pass. The erasure cascade &mdash; the thing "
            "that most determines whether a retention promise means anything &mdash; is complete and, more to the "
            "point, honest: it reports partial removal as partial, which is the property that lets an operator "
            "trust the register. What holds the score at eight is a consistent pattern rather than any single "
            "defect: <b>the platform is good at the mechanism and less good at its edges</b>. Three storage "
            "prefixes were never handed to the reaper that already exists. Two lookups sitting inches from "
            "correctly-scoped queries did not inherit the filter. Provenance is computed by the workers and "
            "dropped by the write-back. A redaction function is written and never called. Each is small and "
            "individually cheap &mdash; a registration call, a filter term, a persisted field &mdash; and "
            "together they are the difference between controls that exist and controls that reach. With the P1 "
            "items done, the same codebase rates around 9."),
    ]))

    story.append(Spacer(1, 10))
    story.append(HorizontalRule(CONTENT_WIDTH, 1.5, GOLD_ACCENT, top_padding=2, bottom_padding=5))
    story.append(Paragraph(
        "Produced by independent static analysis of the CogniumLearn source tree. No changes were made in the "
        "course of this audit.",
        ParagraphStyle("closing", fontName="Helvetica-Oblique", fontSize=10, leading=14, textColor=TEXT_MUTED)))

    return story


def main():
    document = BaseDocTemplate(
        str(OUTPUT_PATH),
        pagesize=A4,
        leftMargin=LEFT_MARGIN,
        rightMargin=RIGHT_MARGIN,
        topMargin=TOP_MARGIN,
        bottomMargin=BOTTOM_MARGIN,
        title="CogniumLearn " + DOCUMENT_TITLE,
        author="CogniumLearn",
    )
    frame = Frame(
        LEFT_MARGIN, BOTTOM_MARGIN, CONTENT_WIDTH,
        PAGE_HEIGHT - TOP_MARGIN - BOTTOM_MARGIN,
        id="body", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0,
    )
    document.addPageTemplates([PageTemplate(id="main", frames=[frame], onPage=draw_page_chrome)])
    document.build(build_story())
    print("Wrote", OUTPUT_PATH)


if __name__ == "__main__":
    main()
