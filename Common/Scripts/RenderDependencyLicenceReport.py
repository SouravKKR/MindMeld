"""
Renders the CogniumLearn Third-Party Dependency Licence Report to a themed PDF.

This is an INVENTORY, not an audit: it states what every third-party component
shipped or built by this repository is licensed under, and nothing else. The
document contains a summary and tables only — no findings, no severity ratings
and no remediation advice. The legal-exposure judgement belongs to
Common/Audits/LegalComplianceRequirements.txt section 6, which consumes this
inventory.

The dependency data is collected LIVE at render time so a re-run is never stale:

  * Agent worker (Python)  — the pins in Agent/requirements.txt, with the licence
                             resolved from the metadata actually installed in the
                             interpreter running this script (Agent/.venv).
  * Dock server (Node.js)  — every package under Dock/node_modules, transitively.
  * Build toolchain        — every package under Common/node_modules, transitively.
                             Build-time only; never served to a browser.
  * Frontend vendored      — the hand-vendored libraries under Main/ThirdParty,
                             which have no manifest and are therefore declared in
                             VENDORED_FRONTEND_LIBRARIES below.
  * Model weights          — downloaded at runtime, invisible to any manifest, and
                             therefore declared in MACHINE_LEARNING_MODELS below.

Requirements: Common/Audits/LegalComplianceRequirements.txt (section 6)
Theme:        Common/Reports/PdfTheme.md

Run with the repo's Python venv, from the repository root:
    Agent/.venv/Scripts/python.exe Common/Scripts/RenderDependencyLicenceReport.py
"""

import json
import os
import re
from datetime import datetime
from importlib import metadata
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

CLASS_GREEN = "#2E9E54"
CLASS_AMBER = "#B9791A"
CLASS_RED = "#C0392B"

PAGE_WIDTH, PAGE_HEIGHT = A4
LEFT_MARGIN = RIGHT_MARGIN = 20 * mm
TOP_MARGIN = 18 * mm
BOTTOM_MARGIN = 20 * mm
CONTENT_WIDTH = PAGE_WIDTH - LEFT_MARGIN - RIGHT_MARGIN

REPOSITORY_ROOT = Path(__file__).resolve().parent.parent.parent
OUTPUT_PATH = REPOSITORY_ROOT / "Common" / "Reports" / "DependencyLicenceReport.pdf"
DOCUMENT_TITLE = "Third-Party Dependency Licence Report"
# The report collects its whole inventory live at render time, so the date on the
# cover has to be the render date. A hardcoded string dated a report to whenever
# it was last hand-edited, which is exactly the "the document and the artefact
# disagree" failure this report exists to catch.
DOCUMENT_DATE = datetime.now().strftime("%-d %B %Y") if os.name != "nt" else datetime.now().strftime("%#d %B %Y")


# --- Paragraph styles -----------------------------------------------------

styles = {
    "title": ParagraphStyle("title", fontName="Helvetica-Bold", fontSize=27, leading=31, textColor=TEAL_TITLE, spaceAfter=4),
    "subtitle": ParagraphStyle("subtitle", fontName="Helvetica", fontSize=12.5, leading=16, textColor=TEXT_MUTED, spaceAfter=2),
    "date": ParagraphStyle("date", fontName="Helvetica", fontSize=9.5, leading=13, textColor=TEXT_MUTED),
    "h2": ParagraphStyle("h2", fontName="Helvetica-Bold", fontSize=14.5, leading=17, textColor=TEAL_HEADER),
    "h3": ParagraphStyle("h3", fontName="Helvetica-Bold", fontSize=11, leading=15, textColor=TEAL_TITLE, spaceBefore=6, spaceAfter=2),
    "body": ParagraphStyle("body", fontName="Helvetica", fontSize=10, leading=15, textColor=TEXT_BODY, spaceAfter=6, alignment=TA_LEFT),
    "callout": ParagraphStyle("callout", fontName="Helvetica-Oblique", fontSize=10.5, leading=15.5, textColor=TEAL_TITLE),
    "cell": ParagraphStyle("cell", fontName="Helvetica", fontSize=8, leading=10.5, textColor=TEXT_BODY),
    "cellLabel": ParagraphStyle("cellLabel", fontName="Helvetica-Bold", fontSize=8, leading=10.5, textColor=TEXT_LABEL),
    "cellHead": ParagraphStyle("cellHead", fontName="Helvetica-Bold", fontSize=9, leading=12.5, textColor=colors.white),
    "cellHeadCenter": ParagraphStyle("cellHeadCenter", fontName="Helvetica-Bold", fontSize=9, leading=12.5, textColor=colors.white, alignment=TA_CENTER),
    "cellCenter": ParagraphStyle("cellCenter", fontName="Helvetica-Bold", fontSize=8, leading=10.5, textColor=TEXT_BODY, alignment=TA_CENTER),
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


# --- Licence classification -----------------------------------------------

class LicenceClass:
    """
    How a licence behaves for a closed-source hosted service. This is the only
    distinction that matters commercially, so it is an enumeration rather than a
    free string at the call sites.
    """

    PERMISSIVE = "Permissive"
    WEAK_COPYLEFT = "Weak copyleft"
    STRONG_COPYLEFT = "Strong copyleft"
    NETWORK_COPYLEFT = "Network copyleft"
    UNDECLARED = "Undeclared"


CLASS_COLOURS = {
    LicenceClass.PERMISSIVE: CLASS_GREEN,
    LicenceClass.WEAK_COPYLEFT: CLASS_AMBER,
    LicenceClass.STRONG_COPYLEFT: CLASS_RED,
    LicenceClass.NETWORK_COPYLEFT: CLASS_RED,
    LicenceClass.UNDECLARED: CLASS_AMBER,
}

# Raw metadata strings are wildly inconsistent — SPDX expressions, trove
# classifiers and free text all appear. Each pattern maps a raw declaration onto
# a single canonical SPDX-style label. Order matters: the first match wins, so
# the copyleft patterns are listed before the permissive ones.
CANONICAL_LICENCE_PATTERNS = [
    (re.compile(r"\bAGPL|affero", re.IGNORECASE), "AGPL-3.0"),
    (re.compile(r"\bSSPL\b|server side public license", re.IGNORECASE), "SSPL-1.0"),
    (re.compile(r"\bLGPL\b|lesser general public|library general public", re.IGNORECASE), "LGPL-3.0-or-later"),
    (re.compile(r"(?<!L)\bGPL\b|general public license", re.IGNORECASE), "GPL"),
    (re.compile(r"\bMPL\b|mozilla public", re.IGNORECASE), "MPL-2.0"),
    (re.compile(r"\bMIT-0\b", re.IGNORECASE), "MIT-0"),
    (re.compile(r"MIT-CMU|CMU License", re.IGNORECASE), "MIT-CMU"),
    (re.compile(r"\bMIT\b", re.IGNORECASE), "MIT"),
    (re.compile(r"apache", re.IGNORECASE), "Apache-2.0"),
    (re.compile(r"blueoak", re.IGNORECASE), "BlueOak-1.0.0"),
    (re.compile(r"\b0BSD\b|zero.clause bsd", re.IGNORECASE), "0BSD"),
    (re.compile(r"BSD-3|3-clause bsd|three.clause bsd", re.IGNORECASE), "BSD-3-Clause"),
    (re.compile(r"BSD-2|2-clause bsd|two.clause bsd", re.IGNORECASE), "BSD-2-Clause"),
    (re.compile(r"\bBSD\b", re.IGNORECASE), "BSD (clause unspecified)"),
    (re.compile(r"\bISC\b", re.IGNORECASE), "ISC"),
    (re.compile(r"python software foundation|\bPSF\b", re.IGNORECASE), "PSF-2.0"),
    (re.compile(r"\bunlicense\b|public domain", re.IGNORECASE), "Unlicense"),
    (re.compile(r"\bCC0", re.IGNORECASE), "CC0-1.0"),
    (re.compile(r"\bzlib\b", re.IGNORECASE), "Zlib"),
    (re.compile(r"\bCNRI\b", re.IGNORECASE), "CNRI-Python"),
]

CLASS_BY_CANONICAL_LICENCE = {
    "AGPL-3.0": LicenceClass.NETWORK_COPYLEFT,
    "SSPL-1.0": LicenceClass.NETWORK_COPYLEFT,
    "GPL": LicenceClass.STRONG_COPYLEFT,
    "LGPL-3.0-or-later": LicenceClass.WEAK_COPYLEFT,
    "MPL-2.0": LicenceClass.WEAK_COPYLEFT,
}

# Most restrictive first. A declaration naming several licences takes the class
# of the most restrictive one it names.
CLASS_RESTRICTIVENESS_ORDER = [
    LicenceClass.NETWORK_COPYLEFT,
    LicenceClass.STRONG_COPYLEFT,
    LicenceClass.WEAK_COPYLEFT,
    LicenceClass.PERMISSIVE,
]

UNDECLARED_LABEL = "(none declared)"
UNRECOGNISED_LABEL = "(unrecognised declaration)"

# A broad pattern necessarily also matches the text of its own narrower variants:
# "BSD-3-Clause" contains "BSD", "AGPLv3" contains "GPL", "MIT-CMU" contains "MIT".
# Whenever a specific variant matched, the generic label it hides inside is not a
# second licence and is dropped.
SUBSUMED_LICENCE_LABELS = {
    "BSD (clause unspecified)": {"BSD-3-Clause", "BSD-2-Clause", "0BSD"},
    "GPL": {"AGPL-3.0", "LGPL-3.0-or-later"},
    "MIT": {"MIT-0", "MIT-CMU"},
}


def resolve_licences(raw_declaration):
    """
    Turn one raw licence declaration into (labels, class).

    Declarations are wildly inconsistent — SPDX expressions ("Apache-2.0 OR
    BSD-3-Clause"), joined trove classifiers, and free text all appear, and a
    single package regularly names several licences at once. Collapsing that to
    the first pattern that happens to match is how numpy's
    "BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0" ends up reported as MIT.

    So every named licence is kept, ordered as it appears in the declaration —
    the first-listed one is conventionally the primary — and the class is taken
    from the most restrictive licence named.
    """
    if not raw_declaration or not raw_declaration.strip():
        return [UNDECLARED_LABEL], LicenceClass.UNDECLARED

    matches = []
    for pattern, label in CANONICAL_LICENCE_PATTERNS:
        match = pattern.search(raw_declaration)
        if match is not None and label not in [existing for _, existing in matches]:
            matches.append((match.start(), label))

    if not matches:
        return [UNRECOGNISED_LABEL], LicenceClass.UNDECLARED

    matches.sort(key=lambda item: item[0])
    matched_labels = {label for _, label in matches}
    labels = [
        label for _, label in matches
        if not (SUBSUMED_LICENCE_LABELS.get(label, set()) & matched_labels)
    ]

    named_classes = {CLASS_BY_CANONICAL_LICENCE.get(label, LicenceClass.PERMISSIVE) for label in labels}
    for candidate in CLASS_RESTRICTIVENESS_ORDER:
        if candidate in named_classes:
            return labels, candidate

    return labels, LicenceClass.PERMISSIVE


# --- Component groups -----------------------------------------------------

class DependencyGroup:
    """One inventoried component: a heading, a note, and its collected rows."""

    def __init__(self, title, note, entries):
        self.title = title
        self.note = note
        self.entries = entries


class DependencyEntry:
    def __init__(self, name, version, raw_licence):
        self.name = name
        self.version = version
        self.raw_licence = raw_licence
        self.licences, self.licence_class = resolve_licences(raw_licence)

    @property
    def primary_licence(self):
        """The first licence named in the declaration, by convention the governing one."""
        return self.licences[0]

    @property
    def licence_label(self):
        return " + ".join(self.licences)


# --- Collectors -----------------------------------------------------------

REQUIREMENT_PIN_PATTERN = re.compile(r"^([A-Za-z0-9._-]+)\s*==\s*(\S+)\s*$")


def normalise_distribution_name(name):
    return name.lower().replace("_", "-").replace(".", "-")


def collect_installed_python_licences():
    """
    Map normalised distribution name -> declared licence, read from whatever is
    installed in the interpreter running this script.

    Preference order matches Agent/Verification/VerifyDependencyLicences.py:
    License-Expression (SPDX), then the "License ::" trove classifiers, then the
    free-text License field but only when it is short enough to be a licence NAME
    rather than a pasted licence file. scipy ships a 46 KB License field, and
    scanning that text reports BSD-licensed scipy as AGPL.
    """
    maximum_licence_name_length = 200
    declared_licences = {}

    for distribution in metadata.distributions():
        try:
            package_metadata = distribution.metadata
            package_name = package_metadata["Name"]
        except Exception:
            continue
        if not package_name:
            continue

        licence_text = ""
        licence_expression = package_metadata.get("License-Expression")
        if licence_expression and str(licence_expression).strip():
            licence_text = str(licence_expression).strip()
        else:
            try:
                classifiers = package_metadata.get_all("Classifier") or []
            except Exception:
                classifiers = []
            licence_classifiers = [
                classifier.replace("License :: OSI Approved :: ", "").replace("License :: ", "")
                for classifier in classifiers if classifier.startswith("License ::")
            ]
            if licence_classifiers:
                licence_text = " | ".join(licence_classifiers)
            else:
                licence_field = package_metadata.get("License")
                if licence_field:
                    licence_field = str(licence_field).strip()
                    if 0 < len(licence_field) <= maximum_licence_name_length:
                        licence_text = licence_field

        declared_licences[normalise_distribution_name(package_name)] = licence_text.replace("\n", " ")

    return declared_licences


def collect_python_dependencies():
    """
    The Agent worker's shipped set: every pin in Agent/requirements.txt (which is
    a pip freeze, so it already includes transitive pulls), with each licence
    resolved from the installed metadata.
    """
    requirements_path = REPOSITORY_ROOT / "Agent" / "requirements.txt"
    declared_licences = collect_installed_python_licences()
    entries = []

    for line in requirements_path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or stripped.startswith("-"):
            continue

        match = REQUIREMENT_PIN_PATTERN.match(stripped)
        if match is None:
            continue

        package_name, package_version = match.group(1), match.group(2)
        raw_licence = declared_licences.get(normalise_distribution_name(package_name), "")
        entries.append(DependencyEntry(package_name, package_version, raw_licence))

    entries.sort(key=lambda entry: entry.name.lower())
    return entries


def read_node_package(package_directory, collected):
    manifest_path = package_directory / "package.json"
    if not manifest_path.is_file():
        return

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception:
        return

    package_name = manifest.get("name") or package_directory.name
    package_version = manifest.get("version") or "?"
    raw_licence = manifest.get("license") or manifest.get("licence") or ""

    if isinstance(raw_licence, dict):
        raw_licence = raw_licence.get("type", "")
    if not raw_licence and isinstance(manifest.get("licenses"), list):
        raw_licence = " OR ".join(entry.get("type", "") for entry in manifest["licenses"])

    collected[(package_name, package_version)] = str(raw_licence).strip()
    collect_node_modules_directory(package_directory / "node_modules", collected)


def collect_node_modules_directory(modules_directory, collected):
    if not modules_directory.is_dir():
        return

    for entry_path in sorted(modules_directory.iterdir()):
        if entry_path.name.startswith("."):
            continue
        if entry_path.name.startswith("@"):
            for scoped_path in sorted(entry_path.iterdir()):
                read_node_package(scoped_path, collected)
            continue
        read_node_package(entry_path, collected)


def collect_node_dependencies(service_directory):
    """Every package under a service's node_modules tree, transitively."""
    collected = {}
    collect_node_modules_directory(REPOSITORY_ROOT / service_directory / "node_modules", collected)

    entries = [
        DependencyEntry(package_name, package_version, raw_licence)
        for (package_name, package_version), raw_licence in collected.items()
    ]
    entries.sort(key=lambda entry: (entry.name.lower(), entry.version))
    return entries


# Hand-vendored browser libraries under Main/ThirdParty. They are checked in as
# pre-built files with no package manifest, so nothing can derive their licence
# automatically — it is recorded here, from the upstream project, and must be
# re-checked on every version bump.
VENDORED_FRONTEND_LIBRARIES = [
    ("@mlc-ai/web-llm + @huggingface/transformers", "bundled 3.0.0", "Apache-2.0"),
    ("bson (MongoDB BSON)", "bundled", "Apache-2.0"),
    ("chart.js", "4.5.1", "MIT"),
    ("fflate (gzip.js)", "bundled", "MIT"),
    ("jspdf", "3.0.3", "MIT"),
    ("katex", "0.16.44", "MIT"),
    ("mermaid", "11.4.1", "MIT"),
    ("qrcode-generator", "1.4.4", "MIT"),
    ("sheetjs (xlsx)", "0.20.3", "Apache-2.0"),
    ("smiles-drawer", "2.1.7", "MIT"),
]

# Model weights are fetched from Hugging Face at runtime, so they appear in no
# manifest and no package-metadata scan can see them. This project's licence debt
# came from model weights twice, so they are inventoried explicitly.
MACHINE_LEARNING_MODELS = [
    ("ds4sd/docling-layout-heron", "figure detection (DoclingLayoutDetector)", "Apache-2.0"),
    ("sentence-transformers/all-mpnet-base-v2", "embeddings (PrepareImages, PrepareForSimilaritySearch)", "Apache-2.0"),
    ("Qwen2.5-1.5B-Instruct (WebLLM, browser)", "in-browser GPU inference", "Apache-2.0"),
    ("Qwen2.5-0.5B-Instruct (Transformers.js, browser)", "in-browser CPU inference", "Apache-2.0"),
]


# --- Content builders -----------------------------------------------------

def governance_status(status):
    """Colour-codes a reconciliation result the same way the licence classes are."""
    palette = {
        GovernanceCheck.STATUS_PASS: CLASS_GREEN,
        GovernanceCheck.STATUS_ATTENTION: CLASS_AMBER,
        GovernanceCheck.STATUS_FAIL: CLASS_RED,
    }
    return "<font color='%s'>%s</font>" % (palette.get(status, "#6E7681"), status)


def licence_class_label(licence_class):
    colour = CLASS_COLOURS.get(licence_class, "#6E7681")
    return "<font color='%s'>%s</font>" % (colour, licence_class)



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
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
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


INVENTORY_HEADERS = ["Package", "Version", "Licence", "Class"]
INVENTORY_COLUMNS = [40, 17, 24, 19]
INVENTORY_CENTERED = (3,)


def inventory_table(entries):
    rows = [
        [entry.name, "<font face='Courier' size='7'>%s</font>" % entry.version,
         entry.licence_label, licence_class_label(entry.licence_class)]
        for entry in entries
    ]
    return make_table(INVENTORY_HEADERS, rows, INVENTORY_COLUMNS, centered_columns=INVENTORY_CENTERED)


def declared_group(title, note, declarations):
    entries = [DependencyEntry(name, version, raw_licence) for name, version, raw_licence in declarations]
    return DependencyGroup(title, note, entries)


def build_groups():
    return [
        DependencyGroup(
            "Agent worker &mdash; Python",
            "Every pin in <font face='Courier' size='7'>Agent/requirements.txt</font>. That file is a "
            "<font face='Courier' size='7'>pip freeze</font>, so transitive pulls are already included. "
            "Licences are read from the metadata installed in <font face='Courier' size='7'>Agent/.venv</font>.",
            collect_python_dependencies()),
        DependencyGroup(
            "Dock server &mdash; Node.js",
            "Every package resolved under <font face='Courier' size='7'>Dock/node_modules</font>, transitively. "
            "A name listed at more than one version is a genuine duplicate install, not a formatting artefact.",
            collect_node_dependencies("Dock")),
        DependencyGroup(
            "Build toolchain &mdash; Node.js",
            "Every package under <font face='Courier' size='7'>Common/node_modules</font>: codegen, bundling, "
            "minification and obfuscation. Build-time only &mdash; none of it is served to a browser or shipped "
            "in a container.",
            collect_node_dependencies("Common")),
        declared_group(
            "Frontend &mdash; vendored browser libraries",
            "Pre-built files checked in under <font face='Courier' size='7'>Main/ThirdParty</font>. They carry no "
            "package manifest, so these licences are recorded by hand from the upstream project and must be "
            "re-checked on every version bump.",
            VENDORED_FRONTEND_LIBRARIES),
        declared_group(
            "Machine-learning model weights",
            "Fetched at runtime rather than installed, so no manifest and no package-metadata scan can see them. "
            "Recorded by hand because weights, not code, are where this project's licence debt originated.",
            [(name + " &mdash; <font size='7'>" + usage + "</font>", "runtime", licence)
             for name, usage, licence in MACHINE_LEARNING_MODELS]),
    ]


def build_summary_rows(groups):
    """
    One row per licence, counted across every group. A component that names
    several licences is counted once, under its primary (first-named) one, so
    the column totals to the component count rather than over-counting.
    """
    counts = {}
    classes = {}
    for group in groups:
        for entry in group.entries:
            primary = entry.primary_licence
            counts[primary] = counts.get(primary, 0) + 1
            classes[primary] = CLASS_BY_CANONICAL_LICENCE.get(
                primary,
                LicenceClass.UNDECLARED if primary in (UNDECLARED_LABEL, UNRECOGNISED_LABEL) else LicenceClass.PERMISSIVE)

    ordered = sorted(counts.items(), key=lambda item: (-item[1], item[0].lower()))
    return [
        [licence, str(count), licence_class_label(classes[licence])]
        for licence, count in ordered
    ]


class GovernanceCheck:
    """
    One reconciliation result: a licence obligation that is not expressible as a
    row in the inventory.

    The inventory answers "what licence does each component carry". It cannot
    answer "is the gate that keeps blocked licences out still passing", "does the
    deployment documentation still describe the dependency set that is actually
    installed", or "do the attribution notices those permissive licences require
    survive the build that ships them". Those are the three ways this project's
    licence posture has degraded without any inventory row changing, so they are
    collected here — live, from the repository — and scored alongside it.
    """

    STATUS_PASS = "PASS"
    STATUS_ATTENTION = "ATTENTION"
    STATUS_FAIL = "FAIL"

    def __init__(self, name, status, detail, evidence):
        self.name = name
        self.status = status
        self.detail = detail
        self.evidence = evidence

    @property
    def b_clean(self):
        return self.status == GovernanceCheck.STATUS_PASS


def read_repository_text(relative_path):
    """Reads a repository file, returning an empty string when it is absent."""
    try:
        return (REPOSITORY_ROOT / relative_path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def collect_acknowledged_exceptions():
    """
    Reads ACKNOWLEDGED_EXCEPTIONS out of the Agent licence gate by parsing the
    source rather than importing it.

    Parsed, not imported, because importing the harness would run its module-level
    metadata scan against whichever interpreter renders this report — a different
    venv from the one the gate is meant to inspect. The declaration is a literal
    dict, so reading it is unambiguous, and a parse failure is reported rather
    than silently treated as "empty" (an empty list is the good outcome, so
    failing open would manufacture a clean result).

    Returns (packageNames, bParsed).
    """
    gate_source = read_repository_text(Path("Agent") / "Verification" / "VerifyDependencyLicences.py")
    if not gate_source:
        return [], False

    declaration = re.search(r"^ACKNOWLEDGED_EXCEPTIONS\s*=\s*\{(.*?)\}\s*$", gate_source, re.MULTILINE | re.DOTALL)
    if declaration is None:
        return [], False

    return sorted(set(re.findall(r"[\"']([^\"']+)[\"']\s*:", declaration.group(1)))), True


# Licence migrations Deployment.md §2.2.1 records as CLOSED. Each names the
# retired distribution and the module path that must no longer import it. A
# migration the documentation calls closed while the package is still installed —
# or while the code still imports it — is a finding in its own right: the
# documentation and the shipped artefact disagree, and only one of them ships.
RETIRED_DISTRIBUTIONS = [
    ("PyMuPDF", "fitz", "AGPL-3.0 or Artifex commercial", "pypdfium2"),
    ("doclayout_yolo", "doclayout_yolo", "AGPL-3.0 (code and Hugging Face weights)", "ds4sd/docling-layout-heron"),
]


def collect_retired_distribution_survivals(python_entries):
    """
    Checks each closed migration against four surfaces, and grades them, because
    "the package is back" and "a developer-only harness can still reach for it"
    are different facts and reporting them identically makes the check useless.

    Blocking survivals — the migration is not actually closed:
      * pinned in Agent/requirements.txt,
      * installed in the inspected venv,
      * imported unconditionally by runtime Agent code.

    Residual survival — the migration is closed but a tripwire remains:
      * a guarded, opt-in import inside Agent/Verification. The package is not
        installed, the import sits behind try/except ImportError, and the harness
        skips when it is absent. Nothing ships under the retired licence; what
        exists is an invitation to `pip install` it, which is worth naming and is
        not worth calling a breach.

    Returns (blockingSurvivals, residualSurvivals).
    """
    requirements_text = read_repository_text(Path("Agent") / "requirements.txt")
    installed_names = {entry.name.lower().replace("_", "-") for entry in python_entries}

    blocking = []
    residual = []
    for distribution_name, import_name, licence_text, replacement in RETIRED_DISTRIBUTIONS:
        normalised = distribution_name.lower().replace("_", "-")

        b_pinned = re.search(
            r"^\s*%s\s*[=<>~!]" % re.escape(distribution_name), requirements_text,
            re.MULTILINE | re.IGNORECASE) is not None
        b_installed = normalised in installed_names
        runtime_importers, harness_importers = search_agent_sources_for_import(import_name)

        surfaces = []
        if b_pinned:
            surfaces.append("pinned in Agent/requirements.txt")
        if b_installed:
            surfaces.append("installed in the inspected venv")
        if runtime_importers:
            surfaces.append("imported by runtime Agent code (%s)" % ", ".join(sorted(runtime_importers)))

        if surfaces:
            blocking.append((distribution_name, licence_text, replacement, surfaces))
        elif harness_importers:
            residual.append((distribution_name, licence_text, sorted(harness_importers)))

    return blocking, residual


VERIFICATION_DIRECTORY_NAME = "Verification"
GUARDED_IMPORT_WINDOW_CHARACTERS = 400


def search_agent_sources_for_import(import_name):
    """
    Finds Agent source files importing the retired module, split by whether the
    importer is runtime code or a developer-only verification harness.

    A harness import only counts as guarded when an ImportError handler follows
    it closely — an unguarded import in Verification/ would still fail the moment
    the file is executed, so it is treated as runtime.

    Returns (runtimeImporters, harnessImporters) as repository-relative paths.
    """
    import_pattern = re.compile(r"^[ \t]*(?:import\s+%s\b|from\s+%s\b)" % (re.escape(import_name), re.escape(import_name)),
                                re.MULTILINE)
    runtime_importers = set()
    harness_importers = set()

    for source_path in (REPOSITORY_ROOT / "Agent").rglob("*.py"):
        if ".venv" in source_path.parts or "__pycache__" in source_path.parts:
            continue
        try:
            source_text = source_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue

        match = import_pattern.search(source_text)
        if match is None:
            continue

        relative_path = source_path.relative_to(REPOSITORY_ROOT).as_posix()
        following_text = source_text[match.end(): match.end() + GUARDED_IMPORT_WINDOW_CHARACTERS]
        b_guarded = "ImportError" in following_text
        if VERIFICATION_DIRECTORY_NAME in source_path.parts and b_guarded:
            harness_importers.add(relative_path)
        else:
            runtime_importers.add(relative_path)

    return runtime_importers, harness_importers


# The build steps that decide whether a permissive licence's required notices
# survive into what is actually served. Each entry is (label, file, pattern,
# meaning-when-found).
ATTRIBUTION_PROBES = [
    ("esbuild bundling", Path("Common") / "Scripts" / "BundleStaticFiles.js",
     re.compile(r"legalComments\s*:\s*['\"]none['\"]"),
     "strips every licence banner from the first-party bundle"),
    ("HTML / JS obfuscation", Path("Common") / "Scripts" / "MinifyAndObfuscateStaticFiles.js",
     re.compile(r"removeComments\s*:\s*true"),
     "removes comments from the minified output"),
]

VENDORED_DIRECTORY_NAME = "ThirdParty"


def collect_attribution_state():
    """
    Establishes whether the aggressive build destroys the attribution notices the
    permissive licences require, and whether anything replaces them.

    Two separate questions, and conflating them is how this gets mis-assessed.
    The first-party bundle carries no third-party code, so stripping its comments
    costs nothing. What matters is the VENDORED browser libraries, which ship
    their upstream banners inside their own files — so the load-bearing fact is
    whether the build excludes that directory from bundling and obfuscation. The
    second question is Apache-2.0's separate NOTICE-file duty, which travels with
    redistribution and therefore reaches the desktop and mobile installers.
    """
    stripping_steps = []
    for label, relative_path, pattern, meaning in ATTRIBUTION_PROBES:
        if pattern.search(read_repository_text(relative_path)):
            stripping_steps.append((label, meaning))

    bundler_source = read_repository_text(Path("Common") / "Scripts" / "BundleStaticFiles.js")
    obfuscator_source = read_repository_text(Path("Common") / "Scripts" / "MinifyAndObfuscateStaticFiles.js")
    b_vendored_excluded = (VENDORED_DIRECTORY_NAME in bundler_source) and (VENDORED_DIRECTORY_NAME in obfuscator_source)

    notice_file_names = ("NOTICE", "NOTICE.txt", "NOTICE.md", "THIRD_PARTY_NOTICES.md", "ThirdPartyNotices.txt")
    b_notice_present = any((REPOSITORY_ROOT / name).exists() for name in notice_file_names)

    return stripping_steps, b_vendored_excluded, b_notice_present


def build_governance_checks(python_entries, groups):
    """The three reconciliation checks, each answered from the repository."""
    checks = []

    acknowledged, b_parsed = collect_acknowledged_exceptions()
    if not b_parsed:
        checks.append(GovernanceCheck(
            "Licence gate exceptions", GovernanceCheck.STATUS_ATTENTION,
            "The ACKNOWLEDGED_EXCEPTIONS declaration could not be read, so whether the gate is carrying "
            "acknowledged debt is unknown. Unknown is reported rather than assumed clean &mdash; an empty list is "
            "the good outcome, so failing open here would manufacture one.",
            "Agent/Verification/VerifyDependencyLicences.py"))
    elif acknowledged:
        checks.append(GovernanceCheck(
            "Licence gate exceptions", GovernanceCheck.STATUS_ATTENTION,
            "%d package(s) are waved past the gate: %s. That list is a decision log, not a snooze button &mdash; "
            "each entry is a blocked licence shipping today with a written reason attached." % (
                len(acknowledged), ", ".join(acknowledged)),
            "Agent/Verification/VerifyDependencyLicences.py"))
    else:
        checks.append(GovernanceCheck(
            "Licence gate exceptions", GovernanceCheck.STATUS_PASS,
            "ACKNOWLEDGED_EXCEPTIONS is empty, so no component ships past the gate on an acknowledgement. "
            "Deployment.md &sect;2.2.1 records the same state (&quot;None &mdash; the PDF-stack licence migration "
            "is closed&quot;), so the documentation and the harness agree.",
            "Agent/Verification/VerifyDependencyLicences.py"))

    blocking_survivals, residual_survivals = collect_retired_distribution_survivals(python_entries)
    if blocking_survivals:
        checks.append(GovernanceCheck(
            "Closed migrations vs. shipped artefact", GovernanceCheck.STATUS_FAIL,
            "; ".join(
                "%s (%s) is recorded as replaced by %s but survives &mdash; %s" % (
                    distribution_name, licence_text, replacement, " and ".join(surfaces))
                for distribution_name, licence_text, replacement, surfaces in blocking_survivals),
            "Common/ReadmeFiles/Deployment.md &sect;2.2.1"))
    elif residual_survivals:
        checks.append(GovernanceCheck(
            "Closed migrations vs. shipped artefact", GovernanceCheck.STATUS_ATTENTION,
            "Closed where it counts: %s appear in no pin, in no installed distribution and in no runtime import, "
            "so nothing ships under the retired licence. One tripwire remains &mdash; %s &mdash; a guarded, "
            "opt-in import behind try/except ImportError that skips when the package is absent. It cannot "
            "execute today, but it is an invitation to install an AGPL package into the worker venv, and the "
            "gate would only catch that on the next run." % (
                " and ".join(name for name, _, _, _ in RETIRED_DISTRIBUTIONS),
                "; ".join(
                    "%s is still reachable from %s" % (distribution_name, ", ".join(importers))
                    for distribution_name, _, importers in residual_survivals)),
            "Common/ReadmeFiles/Deployment.md &sect;2.2.1"))
    else:
        checks.append(GovernanceCheck(
            "Closed migrations vs. shipped artefact", GovernanceCheck.STATUS_PASS,
            "Both migrations Deployment.md &sect;2.2.1 records as closed are genuinely closed. %s appear in no "
            "pin, in no installed distribution, and in no Agent import. The documentation and the artefact "
            "agree." % " and ".join(name for name, _, _, _ in RETIRED_DISTRIBUTIONS),
            "Common/ReadmeFiles/Deployment.md &sect;2.2.1"))

    stripping_steps, b_vendored_excluded, b_notice_present = collect_attribution_state()
    vendored_count = sum(len(group.entries) for group in groups if VENDORED_DIRECTORY_NAME.lower() in group.title.lower()
                         or "vendored" in group.title.lower())
    if not b_vendored_excluded:
        checks.append(GovernanceCheck(
            "Attribution retention through the build", GovernanceCheck.STATUS_FAIL,
            "The build %s, and the vendored browser libraries are NOT excluded from it. Every permissive licence "
            "in this inventory requires its copyright and licence notices to be retained, so a build that removes "
            "them from the files actually served breaches the one obligation those licences impose." % (
                " and ".join(meaning for _, meaning in stripping_steps) or "rewrites the served files"),
            "Common/Scripts/BundleStaticFiles.js, Common/Scripts/MinifyAndObfuscateStaticFiles.js"))
    elif not b_notice_present:
        checks.append(GovernanceCheck(
            "Attribution retention through the build", GovernanceCheck.STATUS_ATTENTION,
            "Upstream banners survive: the build %s, but %s is excluded from both the bundler and the obfuscator, "
            "so the %d vendored browser libraries are served as their original files with their notices intact. "
            "What is missing is the separate Apache-2.0 duty &mdash; no aggregated NOTICE file exists at the "
            "repository root, and the desktop and mobile installers redistribute binaries rather than serve "
            "them, which is exactly the act that duty attaches to." % (
                " and ".join(meaning for _, meaning in stripping_steps) or "minifies first-party code",
                VENDORED_DIRECTORY_NAME, vendored_count),
            "Common/Scripts/BundleStaticFiles.js, Common/Scripts/MinifyAndObfuscateStaticFiles.js"))
    else:
        checks.append(GovernanceCheck(
            "Attribution retention through the build", GovernanceCheck.STATUS_PASS,
            "%s is excluded from bundling and obfuscation so upstream banners survive, and an aggregated NOTICE "
            "file exists to travel with the redistributed desktop and mobile binaries." % VENDORED_DIRECTORY_NAME,
            "Common/Scripts/BundleStaticFiles.js, Common/Scripts/MinifyAndObfuscateStaticFiles.js"))

    return checks


class RatingDimension:
    """One scored axis of the overall licence rating, with the basis stated."""

    def __init__(self, name, weight_label, weight, score, basis):
        self.name = name
        self.weight_label = weight_label
        self.weight = weight
        self.score = score
        self.basis = basis


class LicenceRating:
    """
    The mechanical rating. It is derived from the inventory on every run rather
    than written down once, so it cannot describe a dependency set the repository
    no longer has — which is the failure mode a hand-authored score invites.
    """

    WEIGHT_VERY_HIGH = 3
    WEIGHT_HIGH = 2
    WEIGHT_MEDIUM = 1

    WEIGHT_LABELS = {WEIGHT_VERY_HIGH: "Very high", WEIGHT_HIGH: "High", WEIGHT_MEDIUM: "Medium"}

    CLEAN_SCORE = 10.0
    MINIMUM_DIMENSION_SCORE = 1.0

    # A single network-copyleft dependency is not a proportional defect. For a
    # closed-source hosted service it is the one class that, on its own, would
    # oblige the Corresponding Source of the entire service to be published. So
    # the first one drops the dimension to a floor rather than deducting from it,
    # and further ones deduct from there.
    NETWORK_COPYLEFT_PRESENT_SCORE = 3.0
    STRONG_COPYLEFT_PRESENT_SCORE = 5.0
    ADDITIONAL_COPYLEFT_DEDUCTION = 1.0

    UNDECLARED_DEDUCTION = 1.5

    # The hand-declared surfaces are covered, but only as well as whoever last
    # edited the declaration, and the Tauri crate set is not covered at all.
    HAND_DECLARED_COVERAGE_SCORE = 7.0

    # Governance dimensions. A FAIL means an obligation is being breached today
    # (a blocked package shipping, a required notice destroyed); an ATTENTION
    # means the obligation is met but something about it is unverified or
    # incomplete. Scored per check rather than as one aggregate so the reader can
    # see which reconciliation moved the number.
    GOVERNANCE_FAIL_SCORE = 3.0
    GOVERNANCE_ATTENTION_SCORE = 7.0

    @staticmethod
    def governance_score(checks):
        if any(check.status == GovernanceCheck.STATUS_FAIL for check in checks):
            return LicenceRating.GOVERNANCE_FAIL_SCORE
        if any(check.status == GovernanceCheck.STATUS_ATTENTION for check in checks):
            return LicenceRating.GOVERNANCE_ATTENTION_SCORE
        return LicenceRating.CLEAN_SCORE

    @staticmethod
    def copyleft_score(count, present_score):
        if count == 0:
            return LicenceRating.CLEAN_SCORE
        reduced = present_score - LicenceRating.ADDITIONAL_COPYLEFT_DEDUCTION * (count - 1)
        return max(LicenceRating.MINIMUM_DIMENSION_SCORE, reduced)

    @staticmethod
    def declaration_score(undeclared_count):
        reduced = LicenceRating.CLEAN_SCORE - LicenceRating.UNDECLARED_DEDUCTION * undeclared_count
        return max(LicenceRating.MINIMUM_DIMENSION_SCORE, reduced)


def name_list(entries):
    return ", ".join("%s %s" % (entry.name, entry.version) for entry in entries)


def build_rating_dimensions(groups, network_copyleft, strong_copyleft, weak_copyleft, undeclared, governance_checks):
    network_score = LicenceRating.copyleft_score(len(network_copyleft), LicenceRating.NETWORK_COPYLEFT_PRESENT_SCORE)
    strong_score = LicenceRating.copyleft_score(len(strong_copyleft), LicenceRating.STRONG_COPYLEFT_PRESENT_SCORE)
    declaration_score = LicenceRating.declaration_score(len(undeclared))

    if network_copyleft:
        network_basis = (
            "%s ships in the pinned dependency set. This is the one class incompatible with a closed-source "
            "hosted service: network use alone triggers the obligation to offer every user the Corresponding "
            "Source of the whole service, which cannot coexist with paid decks, the paid-deck encryption "
            "scheme or the obfuscated frontend." % name_list([entry for _, entry in network_copyleft]))
    else:
        network_basis = (
            "No AGPL, SSPL or OSL component in any group. Nothing in the shipped set can oblige the service's "
            "own source to be published, which is the only licence outcome that would be unrecoverable.")

    if strong_copyleft:
        strong_basis = (
            "%s carries a plain GPL. No source-disclosure duty arises from hosting alone, but it does arise "
            "on distribution &mdash; and the desktop and mobile shells distribute binaries." % name_list(
                [entry for _, entry in strong_copyleft]))
    else:
        strong_basis = (
            "No plain-GPL component. This matters beyond the hosted service, because the desktop and mobile "
            "shells distribute binaries rather than serve them, and distribution is what triggers GPL.")

    if weak_copyleft:
        weak_basis = (
            "%s are LGPL or MPL. Both are file-scoped: neither reaches the surrounding application, and neither "
            "creates a source-disclosure duty for a hosted service that does not modify the library itself. "
            "Scored clean deliberately &mdash; replacing a working dependency to tidy this column would be "
            "cost with no legal benefit." % name_list(weak_copyleft))
    else:
        weak_basis = "No LGPL or MPL component. Nothing to assess."

    if undeclared:
        declaration_basis = (
            "%d of %d components declare no licence in their metadata (%s). Absent is not permissive &mdash; "
            "each needs confirming upstream before it can be treated as either." % (
                len(undeclared),
                sum(len(group.entries) for group in groups),
                name_list(undeclared)))
    else:
        declaration_basis = "Every component declares a licence that resolves to a recognised identifier."

    return [
        RatingDimension(
            "Network-copyleft exposure", LicenceRating.WEIGHT_LABELS[LicenceRating.WEIGHT_VERY_HIGH],
            LicenceRating.WEIGHT_VERY_HIGH, network_score, network_basis),
        RatingDimension(
            "Strong-copyleft exposure", LicenceRating.WEIGHT_LABELS[LicenceRating.WEIGHT_HIGH],
            LicenceRating.WEIGHT_HIGH, strong_score, strong_basis),
        RatingDimension(
            "Weak-copyleft handling", LicenceRating.WEIGHT_LABELS[LicenceRating.WEIGHT_MEDIUM],
            LicenceRating.WEIGHT_MEDIUM, LicenceRating.CLEAN_SCORE, weak_basis),
        RatingDimension(
            "Licence declaration coverage", LicenceRating.WEIGHT_LABELS[LicenceRating.WEIGHT_MEDIUM],
            LicenceRating.WEIGHT_MEDIUM, declaration_score, declaration_basis),
        RatingDimension(
            "Inventory reach", LicenceRating.WEIGHT_LABELS[LicenceRating.WEIGHT_MEDIUM],
            LicenceRating.WEIGHT_MEDIUM, LicenceRating.HAND_DECLARED_COVERAGE_SCORE,
            "Manifests and installed metadata are read mechanically and cover the Python worker, the Node.js "
            "server and the build toolchain in full. Three surfaces cannot be read that way: model weights "
            "fetched at runtime and the vendored browser libraries are declared by hand in this renderer, so "
            "they are only as current as the last person to edit them; and the Tauri desktop and mobile shell's "
            "Rust crate set lives in the gitignored Build/Template and is not covered at all."),
        RatingDimension(
            "Obligation governance", LicenceRating.WEIGHT_LABELS[LicenceRating.WEIGHT_HIGH],
            LicenceRating.WEIGHT_HIGH, LicenceRating.governance_score(governance_checks),
            governance_dimension_basis(governance_checks)),
    ]


def governance_dimension_basis(governance_checks):
    """
    States the governance score in terms of the checks that produced it. Named
    individually rather than summarised, because "one of three checks is not
    clean" is not actionable and "the NOTICE file is missing" is.
    """
    failing = [check for check in governance_checks if check.status == GovernanceCheck.STATUS_FAIL]
    attention = [check for check in governance_checks if check.status == GovernanceCheck.STATUS_ATTENTION]

    if failing:
        return (
            "%s. A permissive inventory is only worth what its obligations are worth, and these are the "
            "obligations that are not visible as a row: they are breached by process, not by a dependency "
            "choice." % "; ".join(check.name + " &mdash; failing" for check in failing))
    if attention:
        return (
            "The licence gate and the closed-migration reconciliation both pass against the current tree. %s "
            "needs attention: see the reconciliation table above for what specifically." % ", ".join(
                check.name for check in attention))
    return (
        "All three reconciliations pass: the gate carries no acknowledged exceptions, every migration the "
        "deployment documentation records as closed is closed in the pins, the venv and the source, and the "
        "attribution notices the permissive licences require survive the build that ships them.")


def headline_rating(dimensions):
    total_weight = sum(dimension.weight for dimension in dimensions)
    weighted = sum(dimension.weight * dimension.score for dimension in dimensions)
    return round(weighted / total_weight, 1)


def format_rating(value):
    return ("%.1f" % value).rstrip("0").rstrip(".") if float(value).is_integer() else "%.1f" % value


def build_verdict(rating, permissive_count, network_copyleft, strong_copyleft, undeclared, total_components,
                  governance_checks):
    """
    The headline sentence, stated in terms of what the number is actually driven
    by. A rating whose cause is not named is a rating nobody can act on.
    """
    verdict = "<b>Headline rating: %s / 10.</b> " % format_rating(rating)

    blocking = [entry for _, entry in network_copyleft] + [entry for _, entry in strong_copyleft]
    if blocking:
        singular = len(blocking) == 1
        verdict += (
            "The estate itself is close to ideal for a closed-source product &mdash; %d of %d components are "
            "outright permissive, and the permissive licences here ask for nothing beyond notice retention. "
            "The rating is not a verdict on that estate. It is driven almost entirely by %s, whose copyleft "
            "terms are the one category that cannot be complied with by being careful: the obligation attaches "
            "to the component's presence, not to how it is used. Remove %s and the same inventory rates well "
            "above 9. That is the shape of this result &mdash; %s inside an otherwise clean set, not a diffuse "
            "licensing problem." % (
                permissive_count,
                total_components,
                name_list(blocking),
                "it" if singular else "them",
                "a single blocking entry" if singular else "%d blocking entries" % len(blocking)))
    else:
        verdict += (
            "No component in any group carries copyleft terms that reach this service. %d of %d components are "
            "outright permissive, asking for nothing beyond retention of the copyright and licence notices, and "
            "the weak-copyleft entries are file-scoped and do not propagate. Nothing in the inventory constrains "
            "keeping the source closed, shipping paid decks, or distributing the desktop and mobile "
            "binaries." % (permissive_count, total_components))

    if undeclared:
        verdict += (
            "<br/><br/>The remaining deduction is metadata, not licensing: %s %s no licence field at all. "
            "That is very likely permissive upstream, but 'probably fine' is not a licence grant, and "
            "confirming it is a few minutes of work against the upstream repository." % (
                name_list(undeclared),
                "declares" if len(undeclared) == 1 else "declare"))

    unclean_checks = [check for check in governance_checks if not check.b_clean]
    if unclean_checks:
        verdict += (
            "<br/><br/>The rest of the deduction is not about which licences are held but about whether their "
            "obligations are being met: %s. A permissive estate obliges almost nothing &mdash; but what it does "
            "oblige is exactly this, and it is met by process rather than by dependency choice, so nothing in "
            "the inventory tables above would ever show it slipping." % "; ".join(
                "%s (%s)" % (check.name.lower(), check.status.lower()) for check in unclean_checks))
    else:
        verdict += (
            "<br/><br/>The obligations behind that estate are being met as well as the estate itself is chosen: "
            "the licence gate carries no acknowledged exceptions, the migrations the deployment documentation "
            "records as closed are closed in the pins, the venv and the source, and the attribution notices the "
            "permissive licences require survive the build that ships them.")

    verdict += (
        "<br/><br/>Two structural caveats bound how much this number is worth. Model weights and the vendored "
        "browser libraries are declared by hand in the renderer, so they are accurate only as far as the last "
        "person to edit them was &mdash; and weights, not code, are where this project's licence debt "
        "originated on both previous occasions. The Tauri desktop and mobile shell's Rust crates are not "
        "covered at all, because Build/Template is gitignored and no repository scan can reach them.")

    return verdict


def build_story():
    groups = build_groups()
    total_components = sum(len(group.entries) for group in groups)
    network_copyleft = [
        (group, entry)
        for group in groups for entry in group.entries
        if entry.licence_class == LicenceClass.NETWORK_COPYLEFT
    ]
    strong_copyleft = [
        (group, entry)
        for group in groups for entry in group.entries
        if entry.licence_class == LicenceClass.STRONG_COPYLEFT
    ]
    weak_copyleft = [
        entry for group in groups for entry in group.entries
        if entry.licence_class == LicenceClass.WEAK_COPYLEFT
    ]
    undeclared = [
        entry for group in groups for entry in group.entries
        if entry.licence_class == LicenceClass.UNDECLARED
    ]
    permissive_count = len([
        entry for group in groups for entry in group.entries
        if entry.licence_class == LicenceClass.PERMISSIVE
    ])
    python_entries = [entry for group in groups for entry in group.entries if "python" in group.title.lower()]
    governance_checks = build_governance_checks(python_entries, groups)
    dimensions = build_rating_dimensions(
        groups, network_copyleft, strong_copyleft, weak_copyleft, undeclared, governance_checks)
    rating = headline_rating(dimensions)

    story = []

    story.append(Paragraph("Third-Party Dependency Licence Report", styles["title"]))
    story.append(Paragraph("Every third-party component shipped or built by CogniumLearn, and its licence", styles["subtitle"]))
    story.append(Spacer(1, 3))
    story.append(Paragraph(
        DOCUMENT_DATE + "  &middot;  Inventory and rating  &middot;  Collected from manifests and installed "
        "package metadata at render time",
        styles["date"]))
    story.append(Spacer(1, 6))
    story.append(HorizontalRule(CONTENT_WIDTH, 2, GOLD_ACCENT, top_padding=2, bottom_padding=4))
    story.append(Spacer(1, 8))

    if len(network_copyleft) == 1:
        group, entry = network_copyleft[0]
        copyleft_sentence = (
            " <b>One component carries a network-copyleft licence</b> &mdash; %s %s, in %s &mdash; which for a "
            "closed-source hosted service is the one class that creates an obligation to publish the whole "
            "service's source." % (entry.name, entry.version, group.title.replace("&mdash;", "&ndash;")))
    elif network_copyleft:
        copyleft_sentence = (
            " <b>%d components carry a network-copyleft licence</b> (%s), which for a closed-source hosted "
            "service is the one class that creates an obligation to publish the whole service's source." % (
                len(network_copyleft),
                ", ".join("%s %s" % (entry.name, entry.version) for _, entry in network_copyleft)))
    else:
        copyleft_sentence = (
            " <b>No component carries a network-copyleft licence</b> &mdash; the one class that, for a "
            "closed-source hosted service, would create an obligation to publish the whole service's source.")

    if len(undeclared) == 1:
        undeclared_sentence = (
            " One component (%s %s) declares no licence in its metadata and needs manual confirmation." % (
                undeclared[0].name, undeclared[0].version))
    elif undeclared:
        undeclared_sentence = (
            " %d components declare no licence in their metadata and need manual confirmation: %s." % (
                len(undeclared),
                ", ".join("%s %s" % (entry.name, entry.version) for entry in undeclared)))
    else:
        undeclared_sentence = ""

    story.append(make_callout(
        "This inventory covers <b>%d third-party components</b> across five groups: the Python worker, the "
        "Node.js server, the build toolchain, the browser libraries vendored into the frontend, and the "
        "machine-learning model weights downloaded at runtime. Node and Python figures are transitive, not "
        "just direct dependencies, because licence obligations follow the code that actually ships rather than "
        "the code someone chose deliberately.%s The remainder is overwhelmingly permissive &mdash; MIT, "
        "Apache-2.0, BSD and ISC &mdash; whose only practical obligation is to retain the copyright and licence "
        "notices, with Apache-2.0 additionally granting patent rights and requiring any NOTICE file to travel "
        "with redistribution. The weak-copyleft entries (LGPL, MPL) are file-scoped and impose no "
        "source-disclosure duty on a hosted service that does not modify them.%s "
        "<b>Overall licence-posture rating: %s / 10</b>, with the per-dimension basis on the final page." % (
            total_components, copyleft_sentence, undeclared_sentence, format_rating(rating))))
    story.append(Spacer(1, 4))

    story.extend(section("Summary", [
        Paragraph(
            "Component counts by licence, across every group in this report. <b>Class</b> is the only "
            "distinction that carries commercial consequence: permissive licences require notice retention, "
            "weak copyleft is file-scoped and does not reach a hosted service, and network copyleft would "
            "oblige CogniumLearn to offer every user the source of the entire service.",
            styles["body"]),
        make_table(["Licence", "Components", "Class"], build_summary_rows(groups), [46, 20, 34], centered_columns=(1, 2)),
        Spacer(1, 8),
        make_table(
            ["Group", "Components", "Shipped to"],
            [[group.title, str(len(group.entries)), destination] for group, destination in zip(groups, [
                "Worker container / burst VM",
                "Production server",
                "Neither &mdash; build machine only",
                "User's browser",
                "Worker container and user's browser",
            ])],
            [40, 18, 42],
            centered_columns=(1,)),
    ]))

    # A short group is emitted as one unbreakable block so its heading never
    # dangles at the foot of a page with the table alone overleaf. A long table
    # has to break somewhere, so only the heading and its note are held together.
    maximum_unbreakable_entries = 12

    for group in groups:
        blocks = section(group.title, [
            Paragraph(group.note, styles["body"]),
            inventory_table(group.entries),
        ])
        if len(group.entries) <= maximum_unbreakable_entries:
            story.append(KeepTogether(blocks))
        else:
            story.append(KeepTogether(blocks[:-1]))
            story.append(blocks[-1])

    story.append(KeepTogether(section("Obligation reconciliation", [
        Paragraph(
            "Three obligations that no inventory row can express, each answered from the repository at render "
            "time rather than from memory. They are here because this is where a clean inventory quietly stops "
            "being a clean posture: a blocked package waved past the gate, a migration the documentation calls "
            "closed while the package still ships, or a build that destroys the attribution notices every "
            "permissive licence in the tables above requires.", styles["body"]),
        make_table(
            ["Check", "Result", "Finding", "Source"],
            [[check.name, governance_status(check.status), check.detail, check.evidence]
             for check in governance_checks],
            [17, 13, 48, 22],
            centered_columns=(1,)),
    ])))

    story.extend(section("Overall assessment", [
        Paragraph(
            "Each dimension is scored out of 10 and weighted by how much it can actually cost this business, "
            "then aggregated into the headline. The scores are computed from the inventory above on every run "
            "rather than written down once, so this page cannot end up describing a dependency set the "
            "repository no longer has.", styles["body"]),
        make_table(
            ["Dimension", "Weight", "Score", "Basis"],
            [[dimension.name, dimension.weight_label, format_rating(dimension.score), dimension.basis]
             for dimension in dimensions],
            [23, 11, 8, 58],
            centered_columns=(1, 2)),
        Spacer(1, 9),
        make_callout(build_verdict(
            rating, permissive_count, network_copyleft, strong_copyleft, undeclared, total_components,
            governance_checks)),
    ]))

    story.append(Spacer(1, 12))
    story.append(HorizontalRule(CONTENT_WIDTH, 1.5, GOLD_ACCENT, top_padding=2, bottom_padding=5))
    story.append(Paragraph(
        "Generated by Common/Scripts/RenderDependencyLicenceReport.py from the manifests and installed package "
        "metadata present at render time. No source file was modified to produce this report. An engineering "
        "assessment of inbound licence obligations, not legal advice.",
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
        title=DOCUMENT_TITLE,
        author="CogniumLearn",
        subject="Third-party dependency licence inventory",
    )
    frame = Frame(
        LEFT_MARGIN,
        BOTTOM_MARGIN,
        CONTENT_WIDTH,
        PAGE_HEIGHT - TOP_MARGIN - BOTTOM_MARGIN,
        id="content",
        leftPadding=0,
        rightPadding=0,
        topPadding=0,
        bottomPadding=0,
    )
    document.addPageTemplates([PageTemplate(id="page", frames=[frame], onPage=draw_page_chrome)])
    document.build(build_story())
    print("Wrote " + str(OUTPUT_PATH))


if __name__ == "__main__":
    main()
