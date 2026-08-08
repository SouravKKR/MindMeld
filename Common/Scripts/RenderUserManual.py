"""
Renders the CogniumLearn User Manual to a themed PDF.

The theme intentionally mirrors the "Hive on Campus Edge Devices" proposal:
a clean white page, deep-teal section headers each preceded by a small gold
accent bar, teal-headed tables with alternating body rows, and a muted-gray
centered footer. This is deliberately NOT the in-app CogniumLearn theme.

Run with the repo's Python venv:
    Agent/.venv/Scripts/python.exe Common/Scripts/RenderUserManual.py

The output is written to Common/ReadmeFiles/UserManual.pdf. The visual theme is
specified in Common/Reports/PdfTheme.md; keep the two in sync.
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
    KeepTogether,
)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont


# --- Unicode font for glyphs Helvetica lacks (rupee sign, check marks) -----
# ReportLab's built-in Helvetica has no glyph for the rupee sign (U+20B9) or
# the check / cross marks, so those would render as blank boxes. DejaVu Sans
# (shipped with matplotlib in Agent/.venv) covers them. We register it and use
# it only for the few cells that need those glyphs, keeping Helvetica for the
# rest of the document. If it cannot be registered we fall back to plain text.

UNICODE_FONT = "Helvetica"
UNICODE_FONT_BOLD = "Helvetica-Bold"
UNICODE_GLYPHS_AVAILABLE = False
try:
    import matplotlib

    _font_directory = Path(matplotlib.get_data_path()) / "fonts" / "ttf"
    pdfmetrics.registerFont(TTFont("DejaVuSans", str(_font_directory / "DejaVuSans.ttf")))
    pdfmetrics.registerFont(TTFont("DejaVuSans-Bold", str(_font_directory / "DejaVuSans-Bold.ttf")))
    UNICODE_FONT = "DejaVuSans"
    UNICODE_FONT_BOLD = "DejaVuSans-Bold"
    UNICODE_GLYPHS_AVAILABLE = True
except Exception:
    UNICODE_GLYPHS_AVAILABLE = False


def money(amount_text):
    """Renders a rupee price with the real INR sign when the Unicode font is
    available, otherwise the WinAnsi-safe 'INR ' prefix."""
    if UNICODE_GLYPHS_AVAILABLE:
        return "<font name='%s'>&#8377;%s</font>" % (UNICODE_FONT, amount_text)
    return "INR %s" % amount_text


# Availability markers for the plan feature matrix.
if UNICODE_GLYPHS_AVAILABLE:
    FEATURE_YES = "<font name='%s' color='#1A6B62'>&#10003;</font>" % UNICODE_FONT_BOLD
    FEATURE_NO = "<font name='%s' color='#AEB6BA'>&#10007;</font>" % UNICODE_FONT
else:
    FEATURE_YES = "<b><font color='#1A6B62'>Yes</font></b>"
    FEATURE_NO = "<font color='#AEB6BA'>&mdash;</font>"


# --- Theme palette (matched to the Hive proposal) -------------------------

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

OUTPUT_PATH = Path(__file__).resolve().parent.parent / "ReadmeFiles" / "UserManual.pdf"
DOCUMENT_DATE = "17 July 2026"


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
        "cell", fontName="Helvetica", fontSize=9, leading=12.5,
        textColor=TEXT_BODY,
    ),
    "cellLabel": ParagraphStyle(
        "cellLabel", fontName="Helvetica-Bold", fontSize=9, leading=12.5,
        textColor=TEXT_LABEL,
    ),
    "cellHead": ParagraphStyle(
        "cellHead", fontName="Helvetica-Bold", fontSize=9, leading=12.5,
        textColor=colors.white,
    ),
    "cellHeadCenter": ParagraphStyle(
        "cellHeadCenter", fontName="Helvetica-Bold", fontSize=9, leading=12.5,
        textColor=colors.white, alignment=TA_CENTER,
    ),
    "cellCenter": ParagraphStyle(
        "cellCenter", fontName="Helvetica", fontSize=9.5, leading=12.5,
        textColor=TEXT_BODY, alignment=TA_CENTER,
    ),
    "footer": ParagraphStyle(
        "footer", fontName="Helvetica", fontSize=8, leading=10,
        textColor=TEXT_MUTED, alignment=TA_CENTER,
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

    # Footer hairline + centered wordmark and page number.
    footer_y = 12 * mm
    canvas.setStrokeColor(RULE_HAIRLINE)
    canvas.setLineWidth(0.5)
    canvas.line(LEFT_MARGIN, footer_y + 4 * mm, PAGE_WIDTH - RIGHT_MARGIN, footer_y + 4 * mm)

    canvas.setFillColor(TEXT_MUTED)
    canvas.setFont("Helvetica", 8)
    canvas.drawCentredString(PAGE_WIDTH / 2, footer_y, "CogniumLearn  —  User Manual")
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
    """items: list of either (label, text) tuples or plain strings."""
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


def make_table(headers, rows, col_ratios, label_first_column=True, center_from_column=None):
    total = sum(col_ratios)
    col_widths = [CONTENT_WIDTH * ratio / total for ratio in col_ratios]

    def is_centered(index):
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
    """Groups a header with its first block so headers never dangle."""
    flow = [Spacer(1, 9), SectionHeader(title, CONTENT_WIDTH), Spacer(1, 5)]
    flow.extend(blocks)
    return flow


# --- The manual content ---------------------------------------------------

def build_story():
    story = []

    # Cover block (top of page one, Hive-style).
    story.append(Paragraph("CogniumLearn User Manual", styles["title"]))
    story.append(Paragraph(
        "The complete guide to AI-powered spaced-repetition learning", styles["subtitle"]))
    story.append(Spacer(1, 3))
    story.append(Paragraph(DOCUMENT_DATE, styles["date"]))
    story.append(Spacer(1, 6))
    story.append(HorizontalRule(CONTENT_WIDTH, 2, GOLD_ACCENT, top_padding=2, bottom_padding=4))
    story.append(Spacer(1, 8))

    story.append(make_callout(
        "CogniumLearn turns your notes, syllabi and textbooks into flashcards, study "
        "materials and mock tests &mdash; then schedules your revision with proven "
        "spaced-repetition science so you remember more in less time. This manual "
        "walks through every feature and explains exactly how credits and plans work."))

    # 1. What is CogniumLearn
    story += section("What is CogniumLearn", [
        Paragraph(
            "CogniumLearn is an AI-powered learning platform built around spaced "
            "repetition &mdash; the study technique of reviewing material at "
            "increasing intervals so it moves into long-term memory. You upload "
            "documents or type your own content, and CogniumLearn generates the study "
            "assets for you. As you study, it tracks how well you know each item "
            "using the FSRS scheduling algorithm and a Glicko-2 mastery rating, and "
            "shows you exactly where you are weak, strong, or inconsistent.", styles["body"]),
        Paragraph("What you can do with it:", styles["body"]),
        make_bullets([
            ("Build decks", "organise flashcards into a tidy, nested subject tree."),
            ("Generate automatically", "upload a PDF or syllabus and let the AI write cards, notes and tests."),
            ("Study smart", "revise on an optimised schedule that adapts to your performance."),
            ("See your progress", "heatmaps, mastery reports and AI topic insights per deck."),
            ("Ask the AI", "get explanations while you study, or chat with a tutor that knows your deck."),
            ("Buy ready-made decks", "browse a marketplace of professionally curated content."),
            ("Study anywhere", "web, desktop and mobile apps that sync and work offline."),
        ]),
    ])

    # 2. Getting started
    story += section("Getting Started", [
        Paragraph(
            "Sign in with your Google account (or request a one-time email code) and "
            "you are ready to go &mdash; there is nothing to install to use the web "
            "app. The first time you open CogniumLearn on a new device, an interactive "
            "tutorial runs automatically, demonstrating the AI and paid features on a "
            "safe sample deck that spends no credits and touches no real data. You can "
            "replay any tutorial later from the Tutorials page in the home menu.", styles["body"]),
        Paragraph(
            "Every new account receives a small welcome grant of <b>5 free credits</b> "
            "so you can try the AI features before deciding on a plan. Larger bonuses "
            "are handed out through promo codes (see Coupons &amp; Promo Codes).", styles["body"]),
    ])

    # 3. Decks and cards
    story += section("Decks &amp; Cards", [
        Paragraph(
            "A <b>deck</b> is a collection of flashcards, study materials and mock "
            "tests. Decks are hierarchical &mdash; you can nest a deck inside another "
            "to mirror the structure of a subject (for example <i>Biology &rarr; Cell "
            "Biology &rarr; Mitosis</i>). The home page shows your decks as tiles; tap "
            "a tile to drill into its sub-decks or to start studying.", styles["body"]),
        Paragraph("Working with decks and cards:", styles["body"]),
        make_bullets([
            ("Create a deck", "give it a name, an optional short name for tight spaces, and tags for grouping."),
            ("Organise a hierarchy", "set a parent deck to build a nested subject tree."),
            ("Add or edit cards", "the card editor supports rich text, images, and LaTeX for equations on both the question and answer."),
            ("Tag and flag", "tag individual cards, or mark a card for later review."),
            ("Reset progress", "wipe a card's learning history to start it fresh."),
            ("Auto-analysis toggle", "enable weekly performance analysis and auto-generated curated study per deck from the deck editor."),
        ]),
    ])

    # 4. Automatic generation
    story += section("Automatic Content Generation", [
        Paragraph(
            "This is the heart of CogniumLearn. Upload your material &mdash; PDFs, images, "
            "documents, a specific web page, or a syllabus/question paper &mdash; and "
            "the AI produces study assets for you. You can also draw from the open web "
            "or reputable external sources, or have the AI create content from a prompt.", styles["body"]),
        Paragraph("You choose what gets generated:", styles["body"]),
        make_bullets([
            ("Flashcards", "set how many, the difficulty, and the question types (multiple choice, multiple correct, objective, or short / medium / long subjective)."),
            ("Study materials", "organised notes at three depths &mdash; Summary, Standard, or Comprehensive &mdash; with a chosen number of sections."),
            ("Mock tests", "full timed papers with sections, page ranges from the source, question counts, and a marking scheme."),
        ]),
        Paragraph(
            "Three modes suit different needs: <b>Simple</b> for a quick one-click job, "
            "<b>Advanced</b> for full control of every parameter, and <b>Template</b> to "
            "start from a preset for a common subject. You can optionally enhance images "
            "from your documents (OCR and clean-up). Once a job starts, the Progress page "
            "tracks it live &mdash; showing status and credits consumed &mdash; and you "
            "can pause and resume. Everything you generate also appears in your Activity "
            "history.", styles["body"]),
    ])

    # 5. Studying
    story += section("Studying with Spaced Repetition", [
        Paragraph(
            "Open a deck and tap Study to begin. CogniumLearn shows one card at a time: "
            "read the question, tap <b>Show Answer</b>, then grade how well you knew it. "
            "Your grade drives the schedule &mdash; cards you find easy come back far "
            "less often, while shaky cards return soon.", styles["body"]),
        Paragraph("The four grades:", styles["body"]),
        make_bullets([
            ("Very Hard", "you did not know it &mdash; it will come back quickly."),
            ("Hard", "you knew it but struggled."),
            ("Medium", "you knew it after some thought."),
            ("Easy", "you knew it instantly &mdash; the interval grows the most."),
        ]),
        Paragraph(
            "Behind the scenes, the <b>FSRS</b> algorithm computes each card's next "
            "review date and its <i>stability</i> (how firmly it is learned), while a "
            "<b>Glicko-2</b> rating tracks your overall mastery of the deck along with "
            "how confident the system is in that rating. You can restrict a session to "
            "cards you have already started, or enter Revise mode to re-drill cards you "
            "flagged for review. While studying you can resize the question / answer "
            "split, zoom the text, and jump straight into the card editor to fix a "
            "mistake.", styles["body"]),
    ])

    # 5b. The study modes
    story += section("The Study Modes", [
        Paragraph(
            "Spaced repetition is one of <b>six ways to study</b> a deck. Pick the mode "
            "that fits where you are &mdash; first read, active recall, targeted revision, "
            "or a conversation with a tutor. Timed Mock Tests (covered in the next "
            "section) add a further way to pressure-test what you know.", styles["body"]),
        make_table(
            ["Mode", "What it is for"],
            [
                ["Spaced Repetition", "The core active-recall mode. Cards are scheduled by FSRS to appear just before you would forget them; you grade each recall and the schedule adapts."],
                ["Revise", "Short, focused sessions that pull only the cards your performance data flags as weakest &mdash; ideal for the morning before an exam."],
                ["Content Study", "A linear, textbook-style read-through of a deck's material, for building a first mental model of brand-new topics before you start drilling."],
                ["Content Summary", "A condensed, summary-level pass through a deck's material &mdash; a fast overview or last-minute refresher rather than a full read."],
                ["Curated Study", "AI-built sessions woven around your real weak topics, alternating tailored study material (grounded in your own documents) with the flashcards on that topic."],
                ["Chat", "A conversational tutor grounded in your deck's own cards and notes. Ask follow-up questions, get explanations, and save a useful chat as a study material."],
            ],
            col_ratios=[1.1, 3.6],
        ),
    ])

    # 6. Study materials and curated study
    story += section("Study Materials &amp; Curated Study", [
        Paragraph(
            "Study materials are readable lessons &mdash; formatted HTML with images "
            "and equations &mdash; tied to a deck and available at Summary, Standard or "
            "Comprehensive detail. Browse them from the deck's Browser view, or write "
            "and edit your own in the study-material editor.", styles["body"]),
        Paragraph(
            "<b>Curated Study</b> is a guided mode where the AI weaves a lesson together "
            "with the flashcards on that topic: you read a section, then immediately "
            "drill the related cards, alternating between understanding and recall. When "
            "you switch on <i>auto-generate curated study material</i> for a deck, "
            "CogniumLearn automatically builds these flows for your weak topics after each "
            "weekly analysis.", styles["body"]),
    ])

    # 7. Mock tests
    story += section("Mock Tests &amp; Exams", [
        Paragraph(
            "Mock tests are full, exam-style papers with automatic grading. Build one in "
            "the mock-test editor: set the title, duration and marking scheme, then add "
            "title pages, instruction blocks, sections and individual questions. Marking "
            "is flexible &mdash; award marks for correct, wrong, unattempted and "
            "partially-correct answers, with overrides per question type or per section.", styles["body"]),
        Paragraph(
            "When you take a test, choose <b>Practice</b> (untimed review) or "
            "<b>Timed</b> (a countdown that auto-submits at zero, with a custom duration "
            "if you like). Afterwards the answer key shows your answers beside the "
            "expected ones, with explanations and step-by-step solutions, and computes "
            "your score automatically. You can also review transcribed content extracted "
            "from your source documents before finalising a test.", styles["body"]),
    ])

    # 8. Insights
    story += section("Deck Insights &amp; Performance Analysis", [
        Paragraph(
            "Every deck has an Insights page that turns your study history into a clear "
            "picture of where you stand:", styles["body"]),
        make_bullets([
            ("Study metrics", "total cards, cards due today, and cards flagged for review."),
            ("Activity heatmap", "a calendar of your study activity over time."),
            ("Mastery report", "your proficiency across the deck and how it has trended."),
            ("Topic insights", "an AI breakdown of Weak, Strong and Volatile topics &mdash; the last flags topics where your answers keep flipping."),
        ]),
        Paragraph(
            "With auto-analysis enabled, CogniumLearn scores every studied card weekly on "
            "weakness, strength and volatility, sends the standout topics to the AI for "
            "labelling, and &mdash; if you also enabled curated study &mdash; "
            "automatically generates fresh study material for your weakest topics.", styles["body"]),
    ])

    # 9. AI assistant
    story += section("The AI Assistant — Ask AI &amp; Chat", [
        Paragraph(
            "Help is always a tap away. While studying a card or reading a lesson, "
            "highlight any text to pop up a menu with <b>Explain</b>, <b>Simplify</b> "
            "and <b>Ask</b> &mdash; the assistant answers about exactly what you "
            "selected, and can even see images from the current card. <b>Chat</b> mode "
            "is a full conversation with a tutor grounded in your deck's own cards and "
            "notes; you can save a useful chat as a study material to keep.", styles["body"]),
        Paragraph(
            "There are two ways to run the AI:", styles["body"]),
        make_bullets([
            ("In your browser (free)", "download a compact model that runs entirely on your device &mdash; completely private, works offline, and spends no credits. Manage the download from the Activity page."),
            ("In the cloud (credits)", "more capable models across Basic, Pro and Pro Plus tiers, chosen in Settings, charged per request and available in multiple languages."),
        ]),
    ])

    # 10. Marketplace
    story += section("Paid Deck Marketplace", [
        Paragraph(
            "Don't want to build a deck from scratch? Browse the marketplace of "
            "professionally curated decks from creators and institutions. Search across "
            "titles, categories and tags; filter by category, difficulty, creator or "
            "institution; sort by newest, rating, price or popularity; and set your "
            "region for local pricing. Each deck's detail page previews its structure, "
            "card / material / test counts and feature badges before you buy.", styles["body"]),
        Paragraph(
            "Purchasing is one tap. Bought decks decrypt and sync straight into your "
            "library and behave exactly like your own &mdash; spaced repetition, Ask AI "
            "and insights all work normally. Content is encrypted at rest and in transit "
            "for the creator's protection, and you are notified when a creator ships an "
            "update. Pro Plus members receive one free marketplace deck each month.", styles["body"]),
    ])

    # 11. Sync, offline, apps
    story += section("Sync, Offline Mode &amp; Apps", [
        Paragraph(
            "Your library follows you. CogniumLearn syncs decks, cards and study progress "
            "across every device you sign in on &mdash; after each study session and "
            "whenever you make a change. From device management you can see every "
            "device, its last sync time, and remove any you no longer use (your plan "
            "sets how many devices and sessions you may have at once).", styles["body"]),
        Paragraph(
            "The desktop apps (Windows, macOS, Linux) and mobile apps (Android, iOS) add "
            "true offline study: pages and assets are cached locally so a full session "
            "works with no connection, and your progress syncs the moment you are back "
            "online. The apps also update themselves automatically in the background. "
            "The web version needs no installation and is always current.", styles["body"]),
    ])

    # 12. Streaks + activity
    story += section("Streaks, Achievements &amp; Activity", [
        Paragraph(
            "Consistency is rewarded. Completing at least one study session a day builds "
            "a <b>streak</b>, and hitting milestones (7, 30, 100 days) earns badges you "
            "can view in your profile; you are warned before a streak is about to lapse. "
            "The Activity page is your history hub &mdash; search and filter across "
            "generation tasks (with live progress and credits used), marketplace "
            "purchases with invoices, and browser-AI model downloads.", styles["body"]),
    ])

    # 13. Account & settings
    story += section("Account &amp; Settings", [
        Paragraph(
            "The Settings page centralises your account: view your profile and join "
            "date; check your credit balance, top up, and see purchase history; pick "
            "your preferred cloud AI tier and Ask-AI language; choose a light / dark / "
            "auto theme with custom colours; configure text-to-speech for accessibility; "
            "and manage devices, subscriptions and notifications.", styles["body"]),
    ])

    # ---- Pricing part ----
    story.append(Spacer(1, 10))
    story.append(HorizontalRule(CONTENT_WIDTH, 1, RULE_HAIRLINE, top_padding=2, bottom_padding=6))

    # 14. Credits
    story += section("How Credits Work", [
        Paragraph(
            "CogniumLearn's AI features run on <b>credits</b>. Credits are separate from "
            "your subscription: every plan includes a monthly credit allowance, and you "
            "can always buy more on top &mdash; even on the Free plan. Ordinary "
            "studying, building decks and taking tests are free; only AI work draws "
            "credits. Every transaction is logged so you can audit exactly where your "
            "credits went.", styles["body"]),
        Paragraph(
            "The in-study helpers (Ask AI, auto-fill, deck analysis) charge a small flat "
            "amount, while the big generation jobs are metered by the actual AI usage they "
            "consume &mdash; longer documents and more items cost more &mdash; so you only "
            "pay for what you use, and the exact estimate is shown before you commit. "
            "Current rates:", styles["body"]),
        make_table(
            ["AI action", "Credits", "Notes"],
            [
                ["Ask AI — Basic tier", "0.025 / request", "In-study explanations on the entry cloud model."],
                ["Ask AI — Pro tier", "0.17 / request", "A more capable cloud model."],
                ["Ask AI — Pro Plus tier", "1.2 / request", "The most capable cloud model."],
                ["Auto-fill question options", "0.3 / call", "One-shot helper while editing a card."],
                ["Weekly deck analysis", "~0.2 each", "Auto-analysis of your weak, strong and volatile topics."],
                ["Mock-test AI evaluation", "~0.2 + usage", "Grading a mock-test attempt; scales with the test's length."],
                ["Generate flashcards / notes / tests", "Usage-metered", "About 1 credit per 350,000 input tokens plus 1 per 88,000 output tokens; estimate shown first."],
                ["Curated study material", "Usage-metered", "About 1 credit per 80,000 input tokens plus 1 per 35,000 output tokens."],
                ["In-browser AI (WebLLM)", "Free", "Runs on your own device &mdash; never charged."],
            ],
            col_ratios=[2.2, 1.2, 3.4],
        ),
        Paragraph(
            "New accounts start with <b>5 free credits</b>, and redeeming a promo code "
            "grants another 5. Behind-the-scenes steps (extracting text, OCR, similarity "
            "search and the like) are effectively free &mdash; only the AI actions above "
            "draw meaningful credit. Rates are set by the platform and can change.", styles["body"]),
    ])

    # 15. Plans
    story += section("Plans &amp; Subscriptions", [
        Paragraph(
            "Four monthly plans scale with how much AI you use. All prices are in Indian "
            "Rupees (INR); the platform supports other currencies as they are rolled out. "
            "Each tier is cumulative &mdash; it includes everything in the tier below and "
            "raises your credit, storage, device and session limits.", styles["body"]),
        make_table(
            ["Plan", "Price / month", "Monthly credits", "Storage", "Devices"],
            [
                ["Free", money("0"), "0", "20 MB", "2"],
                ["Basic", money("199"), "25", "250 MB", "4"],
                ["Pro", money("499"), "60", "500 MB", "5"],
                ["Pro Plus", money("999"), "125", "2 GB", "6"],
            ],
            col_ratios=[1.2, 1.2, 1.2, 1.0, 0.9],
            center_from_column=1,
        ),
        Paragraph(
            "Everyday studying &mdash; spaced repetition, revise, content reading, taking "
            "mock tests, deck insights and the free in-browser AI &mdash; is included on "
            "every plan, Free included. What the plan changes is access to the AI-powered "
            "and premium features below:", styles["body"]),
        make_table(
            ["Feature", "Free", "Basic", "Pro", "Pro Plus"],
            [
                ["Ask AI (in-study Q&amp;A)", FEATURE_YES, FEATURE_YES, FEATURE_YES, FEATURE_YES],
                ["Chat with your decks", FEATURE_YES, FEATURE_YES, FEATURE_YES, FEATURE_YES],
                ["Curated Study", FEATURE_NO, FEATURE_YES, FEATURE_YES, FEATURE_YES],
                ["Mock-test AI evaluation", FEATURE_NO, FEATURE_YES, FEATURE_YES, FEATURE_YES],
                ["Automatic content generation", FEATURE_NO, FEATURE_NO, FEATURE_YES, FEATURE_YES],
                ["Image generation", FEATURE_NO, FEATURE_NO, FEATURE_NO, FEATURE_YES],
                ["Free marketplace deck each month", FEATURE_NO, FEATURE_NO, FEATURE_NO, FEATURE_YES],
            ],
            col_ratios=[2.4, 1.0, 1.0, 1.0, 1.1],
            center_from_column=1,
        ),
        Paragraph(
            "Subscriptions bill monthly. You can buy extra credits on any plan, including "
            "Free, whenever you run low &mdash; so even without a subscription you can use "
            "the paid AI features on a pay-as-you-go basis, subject to that feature being "
            "available on your plan.", styles["body"]),
    ])

    # 16. Coupons
    story += section("Coupons &amp; Promo Codes", [
        Paragraph(
            "Promo codes and coupons unlock discounts and bonuses. Enter a code from "
            "your profile, or have one applied automatically at checkout. Depending on "
            "how it is issued, a coupon can:", styles["body"]),
        make_bullets([
            ("Discount a purchase", "a percentage off, a fixed amount off, or make it entirely free."),
            ("Grant credits", "drop bonus credits straight into your balance."),
            ("Reduce a plan", "take money off a subscription."),
            ("Unlock a free plan or deck", "grant a plan upgrade or a marketplace deck at no cost."),
        ]),
        Paragraph(
            "Each code has a redemption limit and can be used only once per account.", styles["body"]),
    ])

    # 17. Buying credits
    story += section("Buying Credits &amp; Payments", [
        Paragraph(
            "When you run low, top up from Settings or the credit store. Credits cost "
            "%s each, and larger packs come with a built-in discount:" % money("10"),
            styles["body"]),
        make_table(
            ["Credit pack", "Price", "You save"],
            [
                ["25 credits", money("237.50"), "5%"],
                ["50 credits", money("450"), "10%"],
                ["100 credits", money("800"), "20%"],
            ],
            col_ratios=[2.0, 1.4, 1.4],
            center_from_column=1,
        ),
        Paragraph(
            "You can also buy any custom amount (from a 1-credit minimum). Pay securely "
            "through the integrated payment provider, and your credits are added to your "
            "balance the moment payment is confirmed. Purchases and invoices are recorded "
            "in your Activity history. Prices are shown in your local currency where "
            "supported.", styles["body"]),
        Paragraph(
            "Because AI actions can charge after a task completes, your balance may dip "
            "slightly negative on the final job &mdash; you simply top up before starting "
            "the next one. That is the whole system: study freely, spend credits only on "
            "AI, and scale up with a plan whenever it makes sense.", styles["body"]),
    ])

    story.append(Spacer(1, 12))
    story.append(HorizontalRule(CONTENT_WIDTH, 1.5, GOLD_ACCENT, top_padding=2, bottom_padding=4))
    story.append(Spacer(1, 4))
    story.append(Paragraph(
        "Happy studying. Upload something you need to learn, let CogniumLearn build the "
        "deck, and let spaced repetition do the rest.",
        ParagraphStyle("closing", fontName="Helvetica-Oblique", fontSize=10,
                       leading=14, textColor=TEXT_MUTED)))

    return story


def main():
    document = BaseDocTemplate(
        str(OUTPUT_PATH),
        pagesize=A4,
        leftMargin=LEFT_MARGIN,
        rightMargin=RIGHT_MARGIN,
        topMargin=TOP_MARGIN,
        bottomMargin=BOTTOM_MARGIN,
        title="CogniumLearn User Manual",
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
