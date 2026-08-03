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
DOCUMENT_DATE = "31 July 2026"


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
    table = Table(rows, colWidths=[5 * mm, CONTENT_WIDTH - 5 * mm])
    table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 2),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
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

    table = Table(data, colWidths=col_widths, repeatRows=1)
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
        "CogniumLearn ingests third-party copyrighted material by design, so its exposure lives in how "
        "source documents are retained, how they are re-expressed, and who can reach them. On this pass "
        "<b>no HIGH-severity finding remains</b>. The cross-tenant retrieval path is gone: curated study "
        "now grounds only on the learner's own weak cards, their own study material, and the web, so the "
        "isolation property holds by construction rather than by a filter that could be forgotten. "
        "Answer-sheet scans are deleted as soon as they are read into memory, which also closes every "
        "later failure path. Generated entities now record which uploaded documents fed them, making "
        "&quot;what did we generate from this source&quot; an answerable question. "
        "What remains is a tail of second-order retention gaps on the smaller upload surfaces "
        "&mdash; support attachments and mock-test attempt payloads, neither of which has a lifecycle "
        "&mdash; plus prompt-level residue and a structural weakness worth naming: the derived-content "
        "collections still carry no tenant column, so isolation continues to depend on every caller "
        "behaving. There is now only one such caller, and it checks twice."))
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
                ["Derived-content tenancy model", risk("MEDIUM"),
                 "Chunk and figure documents carry no tenant column, so isolation is enforced by callers rather "
                 "than by the schema. Only one caller reads them now and it checks ownership twice, but the "
                 "structural weakness is what allowed the previous cross-tenant path to exist.",
                 action("RECOMMENDED")],
                ["Secondary upload retention", risk("MEDIUM"),
                 "Support attachments and mock-test attempt payloads are written to permanent storage with no "
                 "expiry, no sweep and no delete endpoint. The primary document path has a full lifecycle; "
                 "these were built without one.",
                 action("RECOMMENDED")],
                ["Residual prompt exposure", risk("MEDIUM"),
                 "Exam-paper extraction still requests verbatim text (deliberately, transformed downstream), and "
                 "one prompt asks for an examination board's official instructions reproduced exactly.",
                 action("RECOMMENDED")],
                ["Similarity enforcement coverage", risk("MEDIUM"),
                 "Verbatim-overlap scoring is observe-only and wired to study material alone; flashcards and "
                 "mock-test questions are generated from the same sources and are unmeasured.",
                 action("RECOMMENDED")],
                ["Provenance usability", risk("MEDIUM"),
                 "Generated entities now record their source documents, but nothing can query that field &mdash; "
                 "the data needed to answer a notice exists and is unreachable.",
                 action("RECOMMENDED")],
                ["Source document retention", risk("MEDIUM"),
                 "A PERMANENT upload is kept indefinitely as a full OCRed reproduction. That is the user's "
                 "explicit choice and is no longer the silent default.",
                 action("NONE")],
                ["Takedown derivative scope", risk("MEDIUM"),
                 "Takedown removes the source, its chunks and its figures, but not content generated from it. "
                 "This is deliberate: original wording about facts is not a reproduction, and full lineage is "
                 "unachievable across synced and user-edited copies.",
                 action("NONE")],
                ["Curated-study retrieval", risk("PASS"),
                 "Grounds only on the learner's own weak cards, their own non-curated study material, and web "
                 "search. The shared chunk store is not read at all.",
                 action("NONE")],
                ["Answer-sheet scan retention", risk("PASS"),
                 "Scans are deleted immediately after being loaded into memory, so every later failure path "
                 "leaves nothing behind and no sweeper is required.",
                 action("NONE")],
                ["Ask-AI grounded retrieval", risk("PASS"),
                 "Client-supplied source hashes are resolved against the caller's own rows in Dock and "
                 "re-derived independently in the Agent.",
                 action("NONE")],
                ["Retention lifecycle", risk("PASS"),
                 "TEMPORARY retention is enforced by an expiry stamp and a reaper running the full cascade; "
                 "deletion removes blob, chunks and figures; orphans are reconciled.",
                 action("NONE")],
                ["Takedown governance", risk("PASS"),
                 "A dry-run-capable admin endpoint actions notices by content hash across tenants and writes to "
                 "an append-only register.",
                 action("NONE")],
                ["Third-party API hygiene", risk("PASS"),
                 "Vertex service-account auth is asserted and fails loudly rather than silently downgrading; the "
                 "OpenAI client suppresses server-side retention.",
                 action("NONE")],
                ["Application logging", risk("PASS"),
                 "No document content reaches the logs and uploaded filenames are pseudonymised before entering "
                 "the pipeline.",
                 action("NONE")],
                ["Generated-content tenancy", risk("PASS"),
                 "Decks, cards, study materials and mock tests are uniquely indexed on userId; the paid-deck "
                 "catalogue is admin-curated, not pooled user content.",
                 action("NONE")],
                ["Contractual safeguards", risk("PASS"),
                 "Terms carry a UGC rights warranty, an indemnity and an infringing-content prohibition; a "
                 "Grievance Officer is named with contact details.",
                 action("NONE")],
            ],
            [19, 12, 51, 18], centered_columns=(1, 3)),
    ]))

    # ── Area 1 ────────────────────────────────────────────────────────────
    story.extend(section("2. File Lifecycle &amp; Retention", [
        Paragraph(
            "The information-source path has a complete lifecycle and the answer-sheet path now has one too. "
            "The remaining gaps are on the two upload surfaces that were never given one.", styles["body"]),
        findings_table([
            ["R-01", where("Dock/Endpoints/Support/SubmitSupportReport.js", "299, 338"),
             "Support attachments are moved to permanent object storage on submission. The only delete call is "
             "the rollback for a failed upload, so once a ticket exists the attachment is permanent, and the "
             "supportTickets collection carries no TTL. Users attach screenshots of whatever they were looking "
             "at, which routinely includes copyrighted study material.",
             risk("MEDIUM"), action("RECOMMENDED")],
            ["R-02", where("Dock/Endpoints/MockTest/EvaluateAttempt.js", "227-240"),
             "The evaluated attempt payload &mdash; the candidate's transcribed answers &mdash; is written to "
             "object storage and never removed. Less sensitive than the scan images now that those are deleted, "
             "but it is still a permanent record of an individual's exam responses with no expiry.",
             risk("MEDIUM"), action("RECOMMENDED")],
            ["R-03", where("Dock/Endpoints/Admin/Deals/UploadDealInvoice.js", "115"),
             "Deal invoices are uploaded to permanent storage with no deletion path anywhere in the file. "
             "Admin-authored commercial documents rather than third-party content, so the copyright exposure is "
             "negligible; listed because it is the third upload surface without a lifecycle.",
             risk("LOW"), action("RECOMMENDED")],
            ["R-04", where("Dock/Endpoints/AutomaticGeneration/InformationSourceUpload.js", "300-345"),
             "A PERMANENT-retention upload is stored indefinitely as a complete OCRed reproduction of the source "
             "document. The user selects this explicitly and it is no longer the fallback for an omitted mode, "
             "so the retention is consented rather than accidental.",
             risk("MEDIUM"), action("NONE")],
            ["R-05", where("Agent/Workflows/OcrPdf/OcrPdf.py", "196-203"),
             "When OCR fails the workflow stores the original un-OCRed bytes so the upload is not lost. Reviewed "
             "and judged the right trade-off &mdash; the alternative silently loses the user's document &mdash; "
             "but it means the retained artefact is byte-identical to the source.",
             risk("MEDIUM"), action("NONE")],
            ["R-06", where("Dock/Endpoints/AutomaticGeneration/InformationSourceDownload.js", "21-35"),
             "The getUser result is not null-checked before user.getId() is called, so an unauthenticated request "
             "produces a 500 rather than a 401. Not a disclosure &mdash; the throw precedes any storage read "
             "&mdash; but it is the only handler in this group missing the guard.",
             risk("LOW"), action("RECOMMENDED")],
            ["R-07", where("Agent/Workflows/TranscribeMockTestAttempt/TranscribeMockTestAttempt.py", "128-141, 252-269"),
             "<b>Control verified.</b> Answer-sheet scans are deleted immediately after being normalised into "
             "memory. Deleting at the earliest safe point rather than on completion means an LLM error, a write "
             "failure or a killed worker all leave nothing behind, so no sweeper is needed. Confirmed that no "
             "consumer reads them back: the result endpoint returns transcription JSON only, and a retry "
             "re-uploads from the browser as a new task.",
             risk("PASS"), action("NONE")],
            ["R-08", where("Dock/Globals/Classes/Content/ExpiredInformationSourceReaper.js", "whole class"),
             "<b>Control verified.</b> TEMPORARY retention is enforced by an expiry stamp and an hourly reaper "
             "running the full cascade. A Mongo TTL index was correctly avoided: it would drop the row while "
             "orphaning the blob and derived content that only the row points to.",
             risk("PASS"), action("NONE")],
            ["R-09", where("Dock/Globals/Classes/Content/InformationSourcePurger.js", "42-160"),
             "<b>Control verified.</b> One shared removal path serves user delete, expiry and takedown: row "
             "first, then blob plus embedding chunks plus cached figures once no row references the content.",
             risk("PASS"), action("NONE")],
            ["R-10", where("Dock/Globals/Classes/Database/DerivedContentQueryEngine.js", "56-96"),
             "<b>Control verified.</b> An orphan sweep clears chunks and figures whose source row no longer "
             "exists. Only hashes with zero surviving rows are candidates, so live grounding data is never at risk.",
             risk("PASS"), action("NONE")],
            ["R-11", where("Dock/Endpoints/AutomaticGeneration/InformationSourceDownload.js", "35-49"),
             "<b>Control verified.</b> Source download requires a session and re-checks ownership server-side. No "
             "public bucket, pre-signed URL or unauthenticated route to a source document exists.",
             risk("PASS"), action("NONE")],
        ]),
    ]))

    # ── Area 2 ────────────────────────────────────────────────────────────
    story.extend(section("3. System Prompts &amp; Content Transformation", [
        Paragraph(
            "A single shared expression contract now leads every generation prompt. Its central rule is worth "
            "stating: content with only one accurate expression &mdash; formulae, constants, chemical species, "
            "statutory definitions, terms of art, quantities &mdash; must be reproduced exactly, because "
            "copyright does not reach it and altering it would introduce error. Only prose, where alternative "
            "phrasings exist, must be re-authored.", styles["body"]),
        findings_table([
            ["X-01", where("Agent/.../Pools/Prompts/PYQ_EXTRACTION_SYSTEM.txt", "4, 13"),
             "Still instructs verbatim extraction of exam questions. This is a deliberate choice &mdash; faithful "
             "extraction preserves the question's meaning and transformation happens downstream &mdash; and the "
             "pool is held in memory only, never persisted. The residual risk is that the copyrighted text does "
             "exist in the prompt, and only the rephrase stage stands between it and the user.",
             risk("MEDIUM"), action("RECOMMENDED")],
            ["X-02", where("Agent/.../Pools/Prompts/MOCK_TEST_INSTRUCTIONS_USER.txt", "6"),
             "Asks the model to return an examination board's official instructions and duration &quot;exactly as "
             "they would appear on the paper&quot;. Partly defensible as functional matter, but it is authored "
             "text owned by the board being reproduced verbatim into a commercial product.",
             risk("MEDIUM"), action("RECOMMENDED")],
            ["X-03", where("Agent/Workflows/StudyMaterialGenerationWorker/", "similarity hook"),
             "Verbatim-overlap measurement is wired to study material only. Flashcards and mock-test questions "
             "are generated from the same source chunks and are not measured, so a copied flashcard leaves no "
             "trace anywhere.",
             risk("MEDIUM"), action("RECOMMENDED")],
            ["X-04", where("Agent/.../Pools/Prompts/SOURCE_EXPRESSION_RULES.txt", "whole file"),
             "<b>Control verified.</b> A shared expression contract is composed into the study-material, "
             "flashcard and both mock-test prompts. It separates content that must stay exact from prose that "
             "must be re-authored, and states that the no-attribution rule is a presentation rule rather than "
             "permission to copy.",
             risk("PASS"), action("NONE")],
            ["X-05", where("Agent/.../Pools/Prompts/STUDY_MATERIAL_GENERATION_SYSTEM.txt", "24"),
             "<b>Control verified.</b> The former instruction to quote source statements precisely is now scoped "
             "to canonical statements of laws and definitions, capped at three per document and never "
             "consecutive &mdash; addressing aggregate similarity as well as individual copying.",
             risk("PASS"), action("NONE")],
            ["X-06", where("Agent/.../Pools/Prompts/MOCK_TEST_QUESTION_REPHRASE_SYSTEM.txt", "70-88"),
             "<b>Control verified.</b> The rephrase stage states that seeds are copyrighted text and that this is "
             "the only point the wording is replaced, requires re-authoring rather than editing, sets a "
             "six-consecutive-word ceiling, and requires discarding a seed that cannot be rephrased accurately.",
             risk("PASS"), action("NONE")],
        ]),
    ]))

    # ── Area 3 ────────────────────────────────────────────────────────────
    story.extend(section("4. Tenant Isolation &amp; Database Segregation", [
        Paragraph(
            "The chunk store now has exactly one reader, and it verifies ownership twice. What remains is the "
            "schema-level weakness that made a second, unchecked reader possible in the first place.",
            styles["body"]),
        findings_table([
            ["I-01", where("Agent/Globals/Classes/Database/EmbeddingsQueryEngine.py", "16-97"),
             "Chunk documents carry informationSourceHash but no tenant column, and the same is true of the "
             "figures cache. Isolation is therefore a property of every caller rather than of the schema. That is "
             "exactly how a workflow was previously able to bypass the safe query engine with a raw pipeline; "
             "nothing structural prevents a future one from doing the same.",
             risk("MEDIUM"), action("RECOMMENDED")],
            ["I-02", where("Dock/Globals/Classes/Database/DatabaseConnector.js", "316-317"),
             "A stale comment states that &quot;the curated-study textbook search&quot; issues $vectorSearch "
             "aggregations against this index. That consumer no longer exists. A future reader auditing the "
             "index would conclude there are two retrieval paths and look for one that is not there.",
             risk("LOW"), action("RECOMMENDED")],
            ["I-03", where("Agent/Workflows/PrepareImages/PrepareImages.py", "272"),
             "The figures cache is looked up by content hash, so figure extractions are reused across every user "
             "who uploaded the same document. Same content-addressed sharing model as the source blob itself, "
             "and it exposes no text &mdash; noted for completeness rather than as a defect.",
             risk("LOW"), action("NONE")],
            ["I-04", where("Agent/Workflows/GenerateCuratedStudyMaterial/GenerateCuratedStudyMaterial.py", "298-345"),
             "<b>Control verified.</b> Curated study grounds on the learner's own weak cards (carried in the task "
             "payload), their own non-curated study material for the deck, and web search. The query filters on "
             "userId and deckId, and the shared chunk store is not read at all. Curated material is excluded "
             "from its own corpus so successive batches cannot ground on each other and drift.",
             risk("PASS"), action("NONE")],
            ["I-05", where("Agent/Globals/Classes/Database/EmbeddingsQueryEngine.py", "99-165"),
             "<b>Control verified.</b> vector_search takes a mandatory owner id and re-derives which requested "
             "hashes that user owns before querying, failing closed on an empty id. It is now the only reader of "
             "the chunk store anywhere in the codebase.",
             risk("PASS"), action("NONE")],
            ["I-06", where("Dock/Endpoints/AskAi/Helpers/AskAiStreamRunner.js", "461-511"),
             "<b>Control verified.</b> Client-supplied source hashes are resolved against the caller's own rows "
             "before the payload leaves Dock, and the filtered list overrides the client value. With I-05 this is "
             "genuine defence in depth &mdash; neither layer depends on the other.",
             risk("PASS"), action("NONE")],
            ["I-07", where("Dock/Globals/Classes/Database/DatabaseConnector.js", "199-214"),
             "<b>Control verified.</b> Decks, cards, study materials and mock tests are each uniquely indexed on "
             "{ userId, data.id }; the deck-merge heuristic filters on userId; the paid-deck catalogue is "
             "admin-uploaded first-party content rather than pooled user material.",
             risk("PASS"), action("NONE")],
            ["I-08", where("Dock/Endpoints/AutomaticGeneration/InformationSourceUpload.js", "300-330"),
             "<b>Control verified.</b> The upload response is identical in shape whether or not the content was "
             "already stored, closing the oracle that revealed whether a file existed on the platform. Completion "
             "timing still differs, which is inherent to deduplication.",
             risk("LOW"), action("NONE")],
        ]),
    ]))

    # ── Area 4 ────────────────────────────────────────────────────────────
    story.extend(section("5. Model Training &amp; Data Logging", [
        Paragraph(
            "The strongest of the five areas. Both provider postures are asserted in code rather than inherited "
            "from platform defaults, and the log pipeline carries no brand-bearing identifiers.", styles["body"]),
        findings_table([
            ["D-01", where("Agent/.../Providers/GoogleEnterpriseAiProvider.py", "146-190"),
             "<b>Control verified.</b> A missing Vertex project no longer falls silently back to the API-key path "
             "with its different data-governance posture; it raises unless the fallback is explicitly opted into, "
             "and the resolved auth mode is logged once per process.",
             risk("PASS"), action("NONE")],
            ["D-02", where("Agent/.../Providers/OpenAiProvider.py", "12-40, 74"),
             "<b>Control verified.</b> store=False is set on every call and the account-level zero-data-retention "
             "requirement is documented where it is relied upon. The provider is not on the live path and the "
             "docstring says so.",
             risk("PASS"), action("NONE")],
            ["D-03", where("Agent/Globals/Utility/RedactSourceName.py", "whole file"),
             "<b>Control verified.</b> Uploaded filenames, which routinely carry institute and publisher names, "
             "are replaced with a deterministic pseudonym at fifteen log sites across six workflows. Correlation "
             "survives; the brand-attribution trail in MongoDB and the admin log export does not.",
             risk("PASS"), action("NONE")],
            ["D-04", where("Agent/.../Providers/GoogleEnterpriseAiProvider.py", "~810"),
             "The image-generation stream prints interleaved model text parts verbatim to stderr. Model output "
             "rather than source input and confined to the diagram path, so exposure is slight &mdash; but it is "
             "the last place raw model text enters the log.",
             risk("LOW"), action("RECOMMENDED")],
            ["D-05", where("Agent/Workflows/", "reviewed across all workflows"),
             "<b>Control verified.</b> A sweep of every print statement in the Agent service found no raw "
             "document text, chunk content or full prompt written to logs.",
             risk("PASS"), action("NONE")],
        ]),
    ]))

    # ── Area 5 ────────────────────────────────────────────────────────────
    story.extend(section("6. Legal Intermediary Provisions &amp; Safe Harbour", [
        Paragraph(
            "The platform can action a notice, record it, and evidence what it removed. The open question is no "
            "longer whether it can delete, but whether it can investigate.", styles["body"]),
        findings_table([
            ["H-01", where("Dock/Globals/Classes/Generation/GenerationProvenance.js", "whole class"),
             "Generated cards and study material now record the content hashes of the uploads that produced "
             "them, but <b>no query surface reads that field</b>. Answering &quot;what did we generate from this "
             "document&quot; still requires an ad-hoc database query. The data exists and is unreachable through "
             "any supported path, which is only half the capability.",
             risk("MEDIUM"), action("RECOMMENDED")],
            ["H-02", where("Dock/Globals/Classes/Content/InformationSourcePurger.js", "84-140"),
             "Takedown removes the source rows across all tenants, the blob, the chunks and the figures &mdash; "
             "but not content generated from them. <b>This is deliberate and correct.</b> Original wording about "
             "facts is not a reproduction, so a notice against a source does not automatically reach it; and full "
             "lineage is unachievable in any case across synced device copies, user edits via content overlays, "
             "and materials synthesised from several sources plus the web. Removal of derivatives should stay a "
             "per-case decision informed by the similarity score, not an automatic cascade.",
             risk("MEDIUM"), action("NONE")],
            ["H-03", where("Dock/Globals/Classes/Content/BrandNameSanitizer.js", "whole class"),
             "Third-party mark detection is correct but wired to a single surface (paid-deck upload) as an "
             "advisory warning. It is applied on no egress path because none exists, which also means it is "
             "untested against real cross-tenant traffic.",
             risk("MEDIUM"), action("RECOMMENDED")],
            ["H-04", where("Dock/Endpoints/Admin/Content/TakedownContent.js", "whole file"),
             "<b>Control verified.</b> An admin endpoint actions a notice by content hash across all tenants, "
             "with a dry-run mode reporting exactly what would be removed and whether the hash was actioned "
             "before. A mistyped hash returns 404 rather than silently succeeding.",
             risk("PASS"), action("NONE")],
            ["H-05", where("Dock/Globals/Classes/Database/ContentTakedownNoticeQueryEngine.js", "whole class"),
             "<b>Control verified.</b> Every takedown is appended to an insert-only register recording hash, "
             "notice reference, actor, tenants affected and counts purged. No update or delete method exists.",
             risk("PASS"), action("NONE")],
            ["H-06", where("Dock/SeedData/LegalDocuments.json", "Terms 7, 9.2, 14; Privacy 18"),
             "<b>Control verified.</b> The Terms prohibit infringing uploads, require the user to warrant they "
             "hold all rights in their content, and carry an IP indemnity. The Privacy Policy names a Grievance "
             "Officer with published contact details and statutory response timelines.",
             risk("PASS"), action("NONE")],
            ["H-07", where("Main/, Dock/Endpoints/", "no such handlers"),
             "<b>Control verified.</b> No export or share handler exists, so no user-authored text reaches "
             "another tenant. This is what keeps H-03 contained &mdash; a property that lapses silently the "
             "moment sharing ships.",
             risk("PASS"), action("NONE")],
        ]),
    ]))

    # ── Remediation ───────────────────────────────────────────────────────
    story.extend(section("7. Recommended Remediation", [
        Paragraph("Specifications only &mdash; nothing was changed while producing this audit.", styles["body"]),
        make_table(
            ["Priority", "Addresses", "Specification"],
            [
                ["P1", "I-01",
                 "Stamp an owner set onto chunk and figure documents at write time so tenancy is a property of "
                 "the schema rather than of caller discipline, and treat any raw $vectorSearch against "
                 "textEmbeddings outside the query engine as a review failure. The convention held only because "
                 "there is now one caller; it was broken once already."],
                ["P1", "R-01, R-02",
                 "Give the secondary upload surfaces a lifecycle: expire support attachments on ticket closure "
                 "and attempt payloads after a defined review window, then sweep both. Reuse the existing reaper "
                 "rather than adding schedulers &mdash; it already runs the cascade for two other content types."],
                ["P1", "H-01",
                 "Add an admin lookup that lists generated entities by source content hash, so the provenance "
                 "field can actually answer a notice. Report the stored similarity score alongside each result so "
                 "the operator can distinguish original phrasing from a substantially-copied artefact, and keep "
                 "removal a manual per-case decision."],
                ["P2", "X-03",
                 "Extend similarity scoring to the flashcard and mock-test workers so all three generation paths "
                 "are measured, then calibrate a threshold from the collected distribution before enabling "
                 "enforcement anywhere."],
                ["P2", "X-01, X-02",
                 "Once mock-test similarity telemetry exists, revisit whether verbatim PYQ extraction is still "
                 "warranted. Separately, replace the request for official exam instructions with a summary of "
                 "format, duration and marking rather than the board's own text."],
                ["P2", "H-03",
                 "Wire brand-mark redaction into the first cross-tenant egress path at the time it is built, and "
                 "treat that as a launch requirement rather than a follow-up."],
                ["P3", "I-02, D-04, R-06",
                 "Housekeeping: correct the stale vector-index comment, drop the verbatim model-text print from "
                 "the image-generation stream, and add the missing null guard in the download handler."],
                ["P3", "R-03",
                 "Give deal invoices a retention period consistent with the commercial record-keeping "
                 "requirement they exist to satisfy."],
            ],
            [9, 17, 74], centered_columns=(0,)),
    ]))

    # ── Operational notes ─────────────────────────────────────────────────
    story.extend(section("8. Operational Notes", [
        make_bullets([
            ("Deployment gate",
             "The Vertex provider refuses to start when no project is configured unless the API-key fallback is "
             "explicitly enabled. Confirm every environment sets GOOGLE_ENTERPRISE_AGENT_PROJECT before "
             "deploying, or the Agent will not boot."),
            ("Behaviour change &mdash; curated study",
             "Curated material is now grounded on the learner's own cards and study material plus the web, not "
             "on a shared textbook corpus. Output will be narrower and more personal. It also no longer loads a "
             "sentence-transformer model per task, which reduces worker memory pressure."),
            ("Behaviour change &mdash; retention default",
             "An upload omitting a retention mode now defaults to TEMPORARY and is deleted after seven days. The "
             "shipped client always sends the mode explicitly, so only non-conforming callers are affected; the "
             "fallback logs a warning worth watching after release."),
            ("Enforcement stays off",
             "Similarity scoring is observe-only. Do not enable SOURCE_SIMILARITY_ENFORCEMENT_ENABLED until real "
             "containment scores have been collected &mdash; an uncalibrated threshold either never fires or "
             "pressures the model to paraphrase the formulae that must stay exact."),
        ]),
    ]))

    # ── Scope ─────────────────────────────────────────────────────────────
    story.extend(section("9. Scope &amp; Method", [
        make_bullets([
            ("Method",
             "Independent static review of the working tree, tracing each data flow from its entry handler "
             "through storage, worker, prompt and retrieval to the rendered or persisted output. Every control "
             "was re-verified against the current source rather than assumed from a prior review, and the "
             "previous report was deleted before this pass began."),
            ("Covered",
             "All four upload handlers; the information-source, support-attachment, attempt-payload and "
             "answer-sheet lifecycles; every vector-retrieval path in both services; the prompt corpus; the "
             "Agent's logging surface; MongoDB schema, index and TTL definitions; the admin route table; and the "
             "seeded Terms of Service and Privacy Policy."),
            ("Not covered",
             "Deployed infrastructure and bucket ACLs as configured in production, third-party contractual terms "
             "as executed, and dynamic behaviour &mdash; no suite was run against a live environment, which the "
             "repository has no runner for. Findings describe source code, not a running system."),
            ("Standing",
             "An engineering risk assessment, not legal advice. Ratings reflect architectural exposure and "
             "remediation cost; whether any finding constitutes infringement, a data-protection breach or an "
             "intermediary-liability failure is a question for qualified counsel."),
        ]),
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
