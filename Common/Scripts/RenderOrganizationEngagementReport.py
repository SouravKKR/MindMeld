"""
Renders an organization's engagement report as a themed PDF.

    python RenderOrganizationEngagementReport.py <engagement.json> <output.pdf>

Spawned by Dock's /Organization/Reports/Engagement endpoint, which writes the
report payload to disk first. Theme is Common/Reports/PdfTheme.md, mandatory for
every PDF this repository produces; the scaffolding below (palette, styles,
SectionHeader, HorizontalRule, make_table, section, draw_page_chrome, safe,
format_utc) is copied from RenderPaidDeckAuditTrail.py rather than reinvented,
so the two reports look like the same product.

Two things here that no other renderer in this repository does yet:

  * A HEATMAP. UsageHeatmap draws a Monday-rows by weeks-columns grid of
    coloured cells directly on the canvas, which is how "how often does this
    student use the app" is answered in one glance rather than in a column of
    numbers nobody reads.

  * INTERNAL LINKS. Each member's row links to that member's own page later in
    the document, and every page is registered as a PDF outline entry so a
    reader can jump between students from the bookmark pane. The alternative —
    a genuine embedded file attachment — opens in a separate viewer, which is
    not what a reader of a report wants.

Everything it draws comes from the payload. Where the payload has no data, the
page says so; it never draws an empty grid, because an empty grid reads as
"this student did nothing" when the truth is usually "nothing was recorded".
"""

import html
import json
import sys
from datetime import datetime, timedelta, timezone

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (
    BaseDocTemplate, Flowable, Frame, PageBreak, PageTemplate, Paragraph, Spacer, Table, TableStyle,
    LongTable,
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

# The heatmap ramp. Teal rather than the in-app accent, because this is a
# document and the document's palette is the theme's, not the app's. The idle
# cell is a visible grey rather than white so an unused day still reads as a
# day that was measured.
HEATMAP_IDLE = colors.HexColor("#EDF1F0")
HEATMAP_RAMP_START = colors.HexColor("#9CC9C2")
HEATMAP_RAMP_END = colors.HexColor("#134E48")

PAGE_WIDTH, PAGE_HEIGHT = A4
LEFT_MARGIN = RIGHT_MARGIN = 20 * mm
TOP_MARGIN = 18 * mm
BOTTOM_MARGIN = 20 * mm
CONTENT_WIDTH = PAGE_WIDTH - LEFT_MARGIN - RIGHT_MARGIN

DOCUMENT_TITLE = "Organization Engagement Report"

MISSING_TEXT = "<i>not recorded</i>"


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
    "caption": ParagraphStyle("caption", fontName="Helvetica", fontSize=8.5, leading=11.5, textColor=TEXT_MUTED),
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


class PageAnchor(Flowable):
    """
    Registers a named destination and an outline entry at this point.

    Zero height, so it costs no layout. It exists because a table row can link
    to "#member-3" only if something in the document has claimed that name, and
    because the outline is what lets a reader move between students without
    scrolling — with fifty members that is the difference between a usable
    document and a long one.
    """

    def __init__(self, destination_key, outline_title, outline_level=0):
        super().__init__()
        self.destination_key = destination_key
        self.outline_title = outline_title
        self.outline_level = outline_level

    def wrap(self, available_width, available_height):
        return 0, 0

    def draw(self):
        self.canv.bookmarkPage(self.destination_key)
        self.canv.addOutlineEntry(self.outline_title, self.destination_key, level=self.outline_level, closed=False)


class UsageHeatmap(Flowable):
    """
    A GitHub-style day grid: Monday-to-Sunday rows, one column per week.

    THE SCALE IS ABSOLUTE ACROSS THE WHOLE REPORT, not per student. The in-app
    heatmap normalises against the busiest day in the span it is showing, which
    is right for one learner looking at themselves and wrong here: two students
    on adjacent pages would be drawn on different scales and the darker grid
    would not mean the busier student. The maximum is computed once for the
    document and printed beside the legend, so a reader can see what full
    saturation means.

    Empty series still draw. A grid of idle cells says "measured, nothing
    happened"; omitting the grid would leave the reader unsure whether the
    student was inactive or the feature was untracked, and those are different
    facts the page states separately.
    """

    CELL_SIZE = 2.6 * mm
    CELL_GAP = 0.5 * mm
    ROW_COUNT = 7
    LABEL_WIDTH = 9 * mm
    MONTH_LABEL_HEIGHT = 4 * mm

    def __init__(self, series_by_day, from_day_utc, to_day_utc, maximum_daily_value):
        super().__init__()
        self.series_by_day = series_by_day or {}
        self.from_day = parse_day(from_day_utc)
        self.to_day = parse_day(to_day_utc)
        self.maximum_daily_value = max(1, int(maximum_daily_value or 0))
        self._week_count = 0

    def wrap(self, available_width, available_height):
        # The grid starts on the Monday containing the window's first day, so a
        # column is always a whole week and the weekday rows line up.
        grid_start = self.from_day - timedelta(days=monday_based_weekday(self.from_day))
        total_days = (self.to_day - grid_start).days + 1
        self._week_count = max(1, (total_days + 6) // 7)

        column_pitch = UsageHeatmap.CELL_SIZE + UsageHeatmap.CELL_GAP
        width = UsageHeatmap.LABEL_WIDTH + (self._week_count * column_pitch)
        height = UsageHeatmap.MONTH_LABEL_HEIGHT + (UsageHeatmap.ROW_COUNT * column_pitch)

        return min(width, CONTENT_WIDTH), height

    def draw(self):
        canvas = self.canv
        canvas.saveState()

        column_pitch = UsageHeatmap.CELL_SIZE + UsageHeatmap.CELL_GAP
        grid_height = UsageHeatmap.ROW_COUNT * column_pitch
        grid_start = self.from_day - timedelta(days=monday_based_weekday(self.from_day))

        canvas.setFont("Helvetica", 6)
        canvas.setFillColor(TEXT_MUTED)

        for row_index, weekday_label in enumerate(("M", "", "W", "", "F", "", "S")):
            if weekday_label:
                cell_y = grid_height - ((row_index + 1) * column_pitch)
                canvas.drawString(0, cell_y + 0.6 * mm, weekday_label)

        rendered_month_labels = set()

        for week_index in range(self._week_count):
            for row_index in range(UsageHeatmap.ROW_COUNT):
                cell_day = grid_start + timedelta(days=(week_index * 7) + row_index)

                if cell_day < self.from_day or cell_day > self.to_day:
                    continue

                cell_x = UsageHeatmap.LABEL_WIDTH + (week_index * column_pitch)
                cell_y = grid_height - ((row_index + 1) * column_pitch)

                canvas.setFillColor(self.__resolve_cell_colour(self.series_by_day.get(format_day(cell_day), 0)))
                canvas.rect(cell_x, cell_y, UsageHeatmap.CELL_SIZE, UsageHeatmap.CELL_SIZE, stroke=0, fill=1)

                # One label per month, anchored to the column its first week
                # falls in, so a twelve-month grid reads as a calendar rather
                # than as an undated stripe.
                month_key = (cell_day.year, cell_day.month)
                if cell_day.day <= 7 and month_key not in rendered_month_labels:
                    rendered_month_labels.add(month_key)
                    canvas.setFillColor(TEXT_MUTED)
                    canvas.setFont("Helvetica", 6)
                    canvas.drawString(cell_x, grid_height + 1 * mm, cell_day.strftime("%b"))

        canvas.restoreState()

    def __resolve_cell_colour(self, dailyValue):
        if dailyValue <= 0:
            return HEATMAP_IDLE

        intensity = min(1.0, float(dailyValue) / float(self.maximum_daily_value))

        # A floor on the lightest active cell, so one review on a quiet day is
        # still visibly different from no reviews at all.
        intensity = 0.25 + (intensity * 0.75)

        return colors.linearlyInterpolatedColor(HEATMAP_RAMP_START, HEATMAP_RAMP_END, 0, 1, intensity)


# --- Builders -------------------------------------------------------------


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
    table = Table([[Paragraph(text, styles["callout"])]], colWidths=[CONTENT_WIDTH])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), CALLOUT_BG),
        ("LINEBEFORE", (0, 0), (0, -1), 2.4, GOLD_ACCENT),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    return table


def section(title, blocks):
    flow = [Spacer(1, 9), SectionHeader(title, CONTENT_WIDTH), Spacer(1, 5)]
    flow.extend(blocks)
    return flow


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


# --- Value helpers --------------------------------------------------------

def safe(value, fallback=MISSING_TEXT):
    """
    Escapes a value for the PDF, or renders the explicit not-recorded marker.

    Every absent field goes through here, so a gap always looks like a gap and
    never like an empty cell that might just be blank.
    """
    if value is None:
        return fallback
    text = str(value).strip()
    if not text:
        return fallback
    return html.escape(text)


def format_count(value):
    return f"{int(value):,}" if isinstance(value, (int, float)) else "0"


def format_utc(iso_text):
    if not iso_text:
        return MISSING_TEXT
    try:
        moment = datetime.fromisoformat(str(iso_text).replace("Z", "+00:00"))
    except ValueError:
        return MISSING_TEXT
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def parse_day(day_utc):
    return datetime.strptime(str(day_utc), "%Y-%m-%d").date()


def format_day(day_value):
    return day_value.strftime("%Y-%m-%d")


def monday_based_weekday(day_value):
    """Monday is 0, matching the client heatmap's own row order."""
    return day_value.weekday()


def build_internal_link(destination_key, label):
    """
    A clickable jump to a named destination in this same document.

    The label is escaped and the tag composed around it, because safe() escapes
    markup — an escaped <link> prints as characters rather than linking.
    """
    return f'<link href="#{html.escape(str(destination_key), quote=True)}" color="#0F6B5C"><u>{html.escape(str(label))}</u></link>'


def resolve_document_maximum(report):
    """
    The busiest single day anyone in the organization had, across every feature.

    One number for the whole document, so every grid on every page is drawn on
    the same scale and a darker cell always means a busier day.
    """
    maximum_value = 0

    for row in report.get("rows") or []:
        for feature in (row.get("engagement") or {}).values():
            for daily_value in (feature.get("series") or {}).values():
                maximum_value = max(maximum_value, int(daily_value or 0))

        for series in ((row.get("aiUsage") or {}).get("seriesByCategory") or {}).values():
            for daily_value in series.values():
                maximum_value = max(maximum_value, int(daily_value or 0))

    return maximum_value


# --- Report sections ------------------------------------------------------

ENGAGEMENT_COLUMNS = [
    ("cardsStudied", "Cards studied"),
    ("studyMaterialsViewed", "Materials viewed"),
    ("mockTestsTaken", "Mock tests"),
    ("curatedStudyIterations", "Curated study"),
]


def build_header(report):
    return [
        Paragraph("Engagement report", styles["title"]),
        Paragraph(safe(report.get("organizationName")), styles["subtitle"]),
        Paragraph(
            f"Generated {format_utc(report.get('generatedAt'))} &nbsp;•&nbsp; "
            f"covering {safe(report.get('windowFromDayUtc'))} to {safe(report.get('windowToDayUtc'))}",
            styles["date"],
        ),
        Spacer(1, 8),
        HorizontalRule(CONTENT_WIDTH, 2, GOLD_ACCENT),
        Spacer(1, 10),
        make_callout(safe(report.get("scopeDisclaimer"))),
        Spacer(1, 6),
        make_callout(safe(report.get("measurementDisclaimer"))),
    ]


def build_engagement_table(report):
    rows = report.get("rows") or []

    blocks = [Paragraph(
        "What each member did with this organization's decks. Cards studied and materials viewed are reported "
        "by the member's device; mock tests and curated study are measured on the server.",
        styles["body"],
    )]

    if not rows:
        blocks.append(Paragraph("This organization has no members.", styles["body"]))
        return section("1. Engagement with this organization's decks", blocks)

    table_rows = []

    for member_index, row in enumerate(rows):
        engagement = row.get("engagement") or {}
        counts = [format_count((engagement.get(key) or {}).get("total", 0)) for key, _ in ENGAGEMENT_COLUMNS]

        table_rows.append([
            safe(row.get("email")),
            safe(row.get("name"), ""),
            *counts,
            build_internal_link(build_member_destination_key(member_index), "Usage over time"),
        ])

    blocks.append(make_table(
        ["Member", "Name", *[label for _, label in ENGAGEMENT_COLUMNS], "Detail"],
        table_rows,
        [2.0, 1.4, 0.9, 1.0, 0.8, 0.9, 1.2],
        center_from_column=2,
    ))

    if report.get("organizationDeckCount", 0) == 0:
        blocks.append(Spacer(1, 6))
        blocks.append(Paragraph(
            "This organization has published no decks, so every engagement count above is necessarily zero.",
            styles["body"],
        ))

    return section("1. Engagement with this organization's decks", blocks)


def build_ai_usage_table(report):
    rows = report.get("rows") or []
    categories = report.get("aiCategories") or []

    blocks = [Paragraph(
        "How many times each member used each AI feature. These counts are for the member's whole account, "
        "not only this organization's decks — a member using AI on their own material spends the same balance.",
        styles["body"],
    )]

    if not categories:
        blocks.append(Paragraph("No member has used an AI feature in this period.", styles["body"]))
        return section("2. AI feature usage", blocks)

    table_rows = []

    for row in rows:
        totals_by_category = (row.get("aiUsage") or {}).get("totalsByCategory") or {}
        table_rows.append([
            safe(row.get("email")),
            format_count((row.get("aiUsage") or {}).get("totalCount", 0)),
            *[format_count(totals_by_category.get(category, 0)) for category in categories],
        ])

    column_ratios = [2.0, 0.9] + [1.0 for _ in categories]

    blocks.append(make_table(["Member", "Total uses", *categories], table_rows, column_ratios, center_from_column=1))

    return section("2. AI feature usage", blocks)


def build_member_destination_key(member_index):
    return f"member-{member_index}"


def build_member_page(report, row, member_index, document_maximum):
    """
    One member's usage over time: a heatmap per dated feature, and an honest
    statement for anything that has no per-day history to draw.
    """
    from_day = report.get("windowFromDayUtc")
    to_day = report.get("windowToDayUtc")

    blocks = [
        PageAnchor(build_member_destination_key(member_index), safe(row.get("email"), "Member")),
        Paragraph("Usage over time", styles["title"]),
        Paragraph(safe(row.get("email")), styles["subtitle"]),
        Paragraph(
            f"{safe(row.get('name'), 'No name recorded')} &nbsp;•&nbsp; {safe(from_day)} to {safe(to_day)}",
            styles["date"],
        ),
        Spacer(1, 8),
        HorizontalRule(CONTENT_WIDTH, 2, GOLD_ACCENT),
        Spacer(1, 10),
    ]

    if not row.get("bHasAccount"):
        blocks.append(make_callout(
            "This member has been invited but has not signed in yet, so there is nothing to show."
        ))
        return blocks

    if not row.get("bHoldsOrganizationDeck"):
        blocks.append(make_callout(
            "This member holds no licence to any of this organization's decks, so no engagement with your "
            "material is attributable to them. Their AI usage is still shown below."
        ))
        blocks.append(Spacer(1, 8))

    engagement = row.get("engagement") or {}

    for feature_key, feature_label in ENGAGEMENT_COLUMNS:
        feature = engagement.get(feature_key) or {}
        blocks.extend(build_feature_block(report, feature_label, feature, from_day, to_day, document_maximum))

    ai_series_by_category = (row.get("aiUsage") or {}).get("seriesByCategory") or {}

    for category_name in sorted(ai_series_by_category.keys()):
        feature = {"series": ai_series_by_category[category_name], "total": sum(ai_series_by_category[category_name].values()), "measurement": "OBSERVED"}
        blocks.extend(build_feature_block(report, f"{category_name} (AI)", feature, from_day, to_day, document_maximum))

    blocks.append(Spacer(1, 8))
    blocks.append(Paragraph(
        f"Darkest cell = {format_count(document_maximum)} in one day. The same scale is used for every member "
        f"in this report, so two pages can be compared directly.",
        styles["caption"],
    ))

    return blocks


def build_feature_block(report, feature_label, feature, from_day, to_day, document_maximum):
    """
    One feature's row on a member page: its heading, its total, and either a
    heatmap or a statement of why there is not one.
    """
    total_value = feature.get("total", 0)
    series = feature.get("series") or {}
    bDeviceReported = feature.get("measurement") == "DEVICE_REPORTED"

    heading = f"{html.escape(feature_label)} &nbsp;&mdash;&nbsp; {format_count(total_value)}"
    if bDeviceReported:
        heading += " <font size=8 color='#6E7681'>(reported by the member's device)</font>"

    blocks = [Paragraph(heading, styles["h3"])]

    if series:
        blocks.append(UsageHeatmap(series, from_day, to_day, document_maximum))
        blocks.append(Spacer(1, 7))
        return blocks

    # No series. Say WHICH kind of nothing this is — a feature that is never
    # dated, a rollup that had not started yet, or genuine inactivity. Drawing
    # an empty grid for all three would be a chart making a claim the data does
    # not support.
    reporting_started_on = report.get("deviceReportingStartedOn")

    if bDeviceReported and not reporting_started_on:
        explanation = ("No per-day history has been recorded yet — daily reporting begins when members next use "
                       f"the app. The lifetime total is {format_count(total_value)}.")
    elif bDeviceReported:
        explanation = (f"No activity recorded since daily reporting began on {safe(reporting_started_on)}. "
                       f"The lifetime total is {format_count(total_value)}.")
    else:
        explanation = "No activity in this period."

    blocks.append(Paragraph(explanation, styles["caption"]))
    blocks.append(Spacer(1, 7))

    return blocks


def build_story(report):
    story = []
    story.extend(build_header(report))
    story.extend(build_engagement_table(report))
    story.extend(build_ai_usage_table(report))

    document_maximum = resolve_document_maximum(report)
    rows = report.get("rows") or []

    for member_index, row in enumerate(rows):
        story.append(PageBreak())
        story.extend(build_member_page(report, row, member_index, document_maximum))

    story.append(Spacer(1, 10))
    story.append(HorizontalRule(CONTENT_WIDTH, 1.5, GOLD_ACCENT, top_padding=2))

    return story


def main():
    if len(sys.argv) != 3:
        print("usage: RenderOrganizationEngagementReport.py <engagement.json> <output.pdf>", file=sys.stderr)
        return 2

    input_path = sys.argv[1]
    output_path = sys.argv[2]

    with open(input_path, "r", encoding="utf-8") as input_file:
        report = json.load(input_file)

    document = BaseDocTemplate(
        output_path,
        pagesize=A4,
        leftMargin=LEFT_MARGIN,
        rightMargin=RIGHT_MARGIN,
        topMargin=TOP_MARGIN,
        bottomMargin=BOTTOM_MARGIN,
        title=f"{DOCUMENT_TITLE} — {report.get('organizationName', '')}",
        author="CogniumLearn",
    )

    frame = Frame(
        LEFT_MARGIN, BOTTOM_MARGIN, CONTENT_WIDTH, PAGE_HEIGHT - TOP_MARGIN - BOTTOM_MARGIN,
        id="content", showBoundary=0,
    )
    document.addPageTemplates([PageTemplate(id="main", frames=[frame], onPage=draw_page_chrome)])

    document.build(build_story(report))

    print(f"Wrote {output_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
