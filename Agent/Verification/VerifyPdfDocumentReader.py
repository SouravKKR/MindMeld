"""
End-to-end verification harness for the PyMuPDF -> PDFium migration.

Run from the Agent directory:
    .venv/Scripts/python.exe Verification/VerifyPdfDocumentReader.py    (Windows)
    .venv/bin/python Verification/VerifyPdfDocumentReader.py            (Linux)

Two tiers, so the harness keeps working after PyMuPDF has been uninstalled:

  1. ALWAYS -- builds synthetic PDFs exercising every feature the workflows
     depend on (an embedded table of contents, mixed heading/body font sizes,
     bold runs, vector paths, an embedded raster image, and a page whose text
     sits in a known rectangle), then drives the REAL workflow entry points
     (extract_text_with_page_map, extract_structure, SyllabusPlausibilityCheck,
     ImageExtractor's geometry helpers, SvgRasterizer) against them and asserts
     the results. Also asserts at source level that no first-party Agent module
     imports an AGPL PDF library -- that is the regression this migration
     exists to prevent.

  2. PARITY (opt-in: VERIFY_PDF_PARITY=1, requires PyMuPDF still installed) --
     runs the same documents through PyMuPDF and diffs page count, per-page
     text, table of contents, the font-size histogram, vector-path bounding
     boxes and embedded-image bounding boxes against PdfDocumentReader. This is
     the tier that proves the port is like-for-like; it is opt-in because the
     whole point of the migration is that PyMuPDF is no longer installed.
"""

import io
import os
import re
import sys
from pathlib import Path

AGENT_DIRECTORY = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(AGENT_DIRECTORY))

from Globals.Classes.Pdf.PdfDocumentReader import PdfDocumentReader
from Globals.Classes.Pdf.PdfRectangle import PdfRectangle
from Globals.Classes.Pdf.SvgRasterizer import SvgRasterizer


FAILURE_MESSAGES = []
PASS_COUNT = 0


def check(b_condition, description, detail = ""):
    global PASS_COUNT
    if b_condition:
        PASS_COUNT += 1
        print(f"  PASS  {description}")
    else:
        FAILURE_MESSAGES.append(f"{description}{(' -- ' + detail) if detail else ''}")
        print(f"  FAIL  {description}{(' -- ' + detail) if detail else ''}")


# ----------------------------------------------------------------------------
# Synthetic documents
# ----------------------------------------------------------------------------

KNOWN_HEADINGS = [
    "Chapter One Thermodynamics",
    "Chapter Two Electrochemistry",
    "Chapter Three Organic Reactions",
]
BODY_SENTENCE = (
    "The enthalpy change of a reaction is the heat absorbed or released when "
    "the reaction proceeds at constant pressure and the system does no work."
)
CAPTION_TEXT = "Figure 4.2 Reaction coordinate diagram"


def build_structured_pdf_bytes():
    """
    A three-page document with a real embedded outline, heading text at 22pt,
    body text at 10pt, a bold run, vector paths and one embedded raster image.
    """
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen import canvas
    from PIL import Image

    buffer = io.BytesIO()
    pdf_canvas = canvas.Canvas(buffer, pagesize = A4)
    page_width, page_height = A4

    for page_index, heading in enumerate(KNOWN_HEADINGS):
        pdf_canvas.setFont("Helvetica", 22)
        pdf_canvas.drawString(60, page_height - 80, heading)

        bookmark_key = f"heading-{page_index}"
        pdf_canvas.bookmarkPage(bookmark_key)
        pdf_canvas.addOutlineEntry(heading, bookmark_key, level = 0)

        pdf_canvas.setFont("Helvetica", 10)
        text_object = pdf_canvas.beginText(60, page_height - 130)
        for _ in range(6):
            text_object.textLine(BODY_SENTENCE)
        pdf_canvas.drawText(text_object)

        pdf_canvas.setFont("Helvetica-Bold", 10)
        pdf_canvas.drawString(60, page_height - 260, "Key definition in bold type")

        # Vector paths: several boxes close enough to merge into ONE cluster at
        # the extractor's 30px gap (78pt pitch minus 70pt width leaves an 8pt
        # gap, about 22px at 200 DPI) while still re-clustering into 4 distinct
        # tight components. That is the flowchart geometry the drawing fallback
        # exists to catch.
        for box_index in range(4):
            pdf_canvas.rect(60 + box_index * 78, 300, 70, 50, stroke = 1, fill = 0)

        # An embedded raster image.
        raster = Image.new("RGB", (240, 160), (32, 96, 160))
        raster_buffer = io.BytesIO()
        raster.save(raster_buffer, format = "PNG")
        raster_buffer.seek(0)
        pdf_canvas.drawImage(
            ImageReader(raster_buffer), 60, 120, width = 240, height = 160, mask = None
        )

        pdf_canvas.setFont("Helvetica", 9)
        pdf_canvas.drawString(60, 100, CAPTION_TEXT)

        pdf_canvas.showPage()

    pdf_canvas.save()
    return buffer.getvalue()


def build_prose_pdf_bytes(page_count):
    """A textbook-shaped document: many pages of continuous prose, no outline."""
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    buffer = io.BytesIO()
    pdf_canvas = canvas.Canvas(buffer, pagesize = A4)
    _, page_height = A4

    for _ in range(page_count):
        pdf_canvas.setFont("Helvetica", 11)
        text_object = pdf_canvas.beginText(60, page_height - 70)
        for _ in range(30):
            text_object.textLine(BODY_SENTENCE)
        pdf_canvas.drawText(text_object)
        pdf_canvas.showPage()

    pdf_canvas.save()
    return buffer.getvalue()


# ----------------------------------------------------------------------------
# Tier 1 -- reader behaviour
# ----------------------------------------------------------------------------

def verify_reader_basics(structured_pdf_bytes):
    print("\n[1] PdfDocumentReader basics")

    with PdfDocumentReader(structured_pdf_bytes) as pdf_reader:
        check(pdf_reader.get_page_count() == 3, "page count is 3",
              f"got {pdf_reader.get_page_count()}")

        page_text = pdf_reader.get_page_text(0)
        check(KNOWN_HEADINGS[0] in page_text, "heading text present on page 1")
        check("enthalpy change" in page_text, "body text present on page 1")
        check("\r" not in page_text,
              "CRLF normalised to LF (PDFium emits CRLF, MuPDF emitted LF)",
              "a stray carriage return would corrupt every splitlines() caller")

        outline_entries = pdf_reader.get_outline_entries()
        check(len(outline_entries) == 3, "outline has 3 entries",
              f"got {len(outline_entries)}")
        if outline_entries:
            check(outline_entries[0]["level"] == 1,
                  "outline level is 1-based (matches the old get_toc contract)",
                  f"got {outline_entries[0]['level']}")
            check(outline_entries[0]["title"] == KNOWN_HEADINGS[0],
                  "outline title round-trips")
            check(outline_entries[0]["page_index"] == 0,
                  "outline page_index is 0-based",
                  f"got {outline_entries[0]['page_index']}")
            check([entry["page_index"] for entry in outline_entries] == [0, 1, 2],
                  "outline entries map to their own pages")

        text_lines = pdf_reader.get_page_text_lines(0)
        check(len(text_lines) > 0, "text lines reconstructed")
        heading_lines = [
            line for line in text_lines if KNOWN_HEADINGS[0] in line.get_text()
        ]
        check(len(heading_lines) == 1, "heading isolated to exactly one line",
              f"got {len(heading_lines)}")
        if heading_lines:
            check(round(heading_lines[0].get_maximum_font_size()) == 22,
                  "heading font size is 22pt",
                  f"got {heading_lines[0].get_maximum_font_size()}")

        bold_lines = [line for line in text_lines if line.is_bold()]
        check(any("Key definition" in line.get_text() for line in bold_lines),
              "bold run detected via font weight / name")
        check(all("Key definition" in line.get_text() for line in bold_lines),
              "body text is not misreported as bold",
              f"bold lines: {[line.get_text()[:40] for line in bold_lines]}")

        span_sizes = {
            round(span.get_font_size())
            for line in text_lines
            for span in line.get_spans()
        }
        check(22 in span_sizes and 10 in span_sizes,
              "spans preserve distinct heading and body sizes",
              f"sizes seen: {sorted(span_sizes)}")
        check(1 not in span_sizes,
              "PDFium synthetic 1.0pt characters excluded from the histogram",
              "they would otherwise become the most common 'body' size")


def verify_geometry(structured_pdf_bytes):
    print("\n[2] Geometry and the bottom-left -> top-left flip")

    render_dpi = 200
    with PdfDocumentReader(structured_pdf_bytes) as pdf_reader:
        page_height_in_points = pdf_reader.get_page_height_in_points(0)

        path_boxes = pdf_reader.get_vector_path_pixel_boxes(0, render_dpi)
        check(len(path_boxes) >= 4, "vector path objects found",
              f"got {len(path_boxes)}")

        image_boxes = pdf_reader.get_embedded_image_pixel_boxes(0, render_dpi)
        check(len(image_boxes) == 1, "exactly one embedded image found",
              f"got {len(image_boxes)}")

        # The image is drawn at y=120..280 from the page bottom. Flipped, its
        # top edge must sit at (page_height - 280) * scale from the page top.
        if image_boxes:
            scale = render_dpi / 72.0
            expected_y0 = int((page_height_in_points - 280) * scale)
            expected_y1 = int((page_height_in_points - 120) * scale)
            actual_x0, actual_y0, actual_x1, actual_y1 = image_boxes[0]
            check(abs(actual_y0 - expected_y0) <= 2 and abs(actual_y1 - expected_y1) <= 2,
                  "embedded image y-flip lands on the correct pixel rows",
                  f"expected y {expected_y0}..{expected_y1}, got {actual_y0}..{actual_y1}")
            check(abs(actual_x0 - int(60 * scale)) <= 2,
                  "embedded image x offset is unflipped and correct",
                  f"expected x0 {int(60 * scale)}, got {actual_x0}")

        # Round-tripping a pixel box back to PDF units must be the identity.
        original_box = (100, 200, 400, 500)
        rectangle = PdfRectangle.from_pixel_box(original_box, page_height_in_points, render_dpi)
        round_tripped = rectangle.to_pixel_box(page_height_in_points, render_dpi)
        check(all(abs(a - b) <= 1 for a, b in zip(original_box, round_tripped)),
              "pixel box -> PDF rect -> pixel box round-trips",
              f"{original_box} -> {round_tripped}")

        # The caption sits at y=100 from the bottom, x=60. Ask for the text in
        # that band and expect the caption, not the body paragraph.
        caption_pixel_box = (
            int(50 * render_dpi / 72.0),
            int((page_height_in_points - 112) * render_dpi / 72.0),
            int(400 * render_dpi / 72.0),
            int((page_height_in_points - 92) * render_dpi / 72.0),
        )
        region_text = pdf_reader.get_text_in_pixel_box(0, caption_pixel_box, render_dpi)
        check(CAPTION_TEXT in region_text,
              "region text extraction returns the caption at that rectangle",
              f"got {region_text[:80]!r}")
        check("enthalpy" not in region_text,
              "region text does not leak the body paragraph",
              f"got {region_text[:80]!r}")


def verify_rendering(structured_pdf_bytes):
    print("\n[3] Rendering")

    from PIL import Image

    with PdfDocumentReader(structured_pdf_bytes) as pdf_reader:
        rendered_image = pdf_reader.render_page_to_image(0, 200)
        check(rendered_image.mode == "RGB", "rendered page is RGB")
        check(rendered_image.width > 1600 and rendered_image.height > 2300,
              "A4 at 200dpi is about 1654x2339",
              f"got {rendered_image.size}")

        png_bytes = pdf_reader.render_page_to_png_bytes(0, 200)
        check(png_bytes[:8] == b"\x89PNG\r\n\x1a\n", "PNG magic bytes correct")
        reopened = Image.open(io.BytesIO(png_bytes))
        check(reopened.size == rendered_image.size,
              "PNG bytes decode to the same dimensions")

        # The embedded image is a solid blue block; sample inside it.
        scale = 200 / 72.0
        page_height_in_points = pdf_reader.get_page_height_in_points(0)
        sample_x = int(180 * scale)
        sample_y = int((page_height_in_points - 200) * scale)
        red, green, blue = rendered_image.convert("RGB").getpixel((sample_x, sample_y))
        check(blue > red and blue > 100,
              "raster content lands where the flip says it should",
              f"sampled RGB ({red}, {green}, {blue}) at ({sample_x}, {sample_y})")


# ----------------------------------------------------------------------------
# Tier 1 -- real workflow entry points
# ----------------------------------------------------------------------------

def verify_workflow_entry_points(structured_pdf_bytes):
    print("\n[4] Real workflow entry points")

    from Workflows.MapTopicsWithContent.ExtractText import extract_text_with_page_map
    from Workflows.ProcessSyllabus.ExtractStructure import extract_structure

    full_text, page_spans = extract_text_with_page_map(structured_pdf_bytes)
    check(len(full_text) > 500, "extract_text_with_page_map returns substantial text",
          f"got {len(full_text)} chars")
    check(len(page_spans) == 3, "one page span per page", f"got {len(page_spans)}")
    check([span[1] for span in page_spans] == [0, 1, 2],
          "page spans are 0-indexed and ordered",
          f"got {[span[1] for span in page_spans]}")
    for heading in KNOWN_HEADINGS:
        check(f"=== {heading} ===" in full_text,
              f"bookmark heading marker injected for {heading!r}")
    for character_offset, page_index in page_spans:
        check(0 <= character_offset <= len(full_text),
              f"page span offset for page {page_index} is inside the text",
              f"offset {character_offset} vs length {len(full_text)}")

    ranged_text, ranged_spans = extract_text_with_page_map(
        structured_pdf_bytes, start_page = 2, end_page = 2
    )
    check(KNOWN_HEADINGS[1] in ranged_text, "page range 2-2 contains page 2's heading")
    check(KNOWN_HEADINGS[0] not in ranged_text,
          "page range 2-2 excludes page 1's heading")
    check([span[1] for span in ranged_spans] == [1],
          "page range 2-2 reports only page index 1",
          f"got {[span[1] for span in ranged_spans]}")

    headings = extract_structure(structured_pdf_bytes)
    heading_titles = [entry["title"] for entry in headings]
    check(len(headings) == 3, "extract_structure finds 3 outline headings",
          f"got {heading_titles}")
    check(all(entry["level"] == 1 for entry in headings),
          "outline headings are level 1",
          f"got {[entry['level'] for entry in headings]}")
    for heading in KNOWN_HEADINGS:
        check(heading in heading_titles, f"extract_structure kept {heading!r}")

    ranged_headings = extract_structure(structured_pdf_bytes, start_page = 2, end_page = 2)
    ranged_titles = [entry["title"] for entry in ranged_headings]
    check(KNOWN_HEADINGS[1] in ranged_titles,
          "page-range filter keeps the heading printed in range",
          f"got {ranged_titles}")
    check(KNOWN_HEADINGS[0] not in ranged_titles,
          "page-range filter drops headings outside the range",
          f"got {ranged_titles}")


def verify_font_heuristics_without_outline():
    print("\n[5] Font-heuristic fallback (no embedded outline)")

    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas
    from Workflows.ProcessSyllabus.ExtractStructure import extract_structure

    buffer = io.BytesIO()
    pdf_canvas = canvas.Canvas(buffer, pagesize = A4)
    _, page_height = A4
    for heading in KNOWN_HEADINGS:
        pdf_canvas.setFont("Helvetica", 24)
        pdf_canvas.drawString(60, page_height - 80, heading)
        pdf_canvas.setFont("Helvetica", 10)
        text_object = pdf_canvas.beginText(60, page_height - 130)
        for _ in range(25):
            text_object.textLine(BODY_SENTENCE)
        pdf_canvas.drawText(text_object)
        pdf_canvas.showPage()
    pdf_canvas.save()
    no_outline_pdf_bytes = buffer.getvalue()

    with PdfDocumentReader(no_outline_pdf_bytes) as pdf_reader:
        check(len(pdf_reader.get_outline_entries()) == 0,
              "control document genuinely has no outline")

    headings = extract_structure(no_outline_pdf_bytes)
    heading_titles = [entry["title"] for entry in headings]
    for heading in KNOWN_HEADINGS:
        check(heading in heading_titles,
              f"font heuristics recovered {heading!r} without an outline",
              f"got {heading_titles[:6]}")
    check(not any(BODY_SENTENCE[:40] in title for title in heading_titles),
          "body prose is not misdetected as a heading",
          f"got {heading_titles[:6]}")


def verify_syllabus_plausibility():
    print("\n[6] SyllabusPlausibilityCheck")

    from Globals.Classes.Generation.SyllabusPlausibilityCheck import SyllabusPlausibilityCheck

    thin_syllabus = build_structured_pdf_bytes()
    verdict = SyllabusPlausibilityCheck.evaluate(thin_syllabus)
    check(verdict["pageCount"] == 3, "page count reported through the new reader",
          f"got {verdict['pageCount']}")

    prose_textbook = build_prose_pdf_bytes(
        SyllabusPlausibilityCheck.PROSE_CHECK_MINIMUM_PAGE_COUNT + 4
    )
    prose_verdict = SyllabusPlausibilityCheck.evaluate(prose_textbook)
    check(prose_verdict["proseLineRatio"] is not None,
          "prose ratio measured (text layer readable through PDFium)",
          f"got {prose_verdict}")
    if prose_verdict["proseLineRatio"] is not None:
        check(prose_verdict["proseLineRatio"] > 0.5,
              "continuous prose scores a high prose-line ratio",
              f"got {prose_verdict['proseLineRatio']}")
        check(prose_verdict["plausible"] is False,
              "a wall of prose is rejected as a syllabus",
              f"got {prose_verdict}")

    corrupt_verdict = SyllabusPlausibilityCheck.evaluate(b"not a pdf at all")
    check(corrupt_verdict["plausible"] is True,
          "an unreadable PDF declines to judge rather than raising",
          f"got {corrupt_verdict}")


def verify_image_extractor_geometry(structured_pdf_bytes):
    print("\n[7] ImageExtractor geometry helpers (no model download)")

    from Workflows.PrepareImages.ImageExtractor import ImageExtractor

    render_dpi = ImageExtractor._RENDER_DPI
    with PdfDocumentReader(structured_pdf_bytes) as pdf_reader:
        drawing_detections = ImageExtractor._drawing_region_detections(
            pdf_reader, 0, render_dpi, []
        )
        check(len(drawing_detections) >= 1,
              "vector-drawing fallback finds the box cluster",
              f"got {len(drawing_detections)}")
        for detection in drawing_detections:
            box_x0, box_y0, box_x1, box_y1 = detection["box"]
            check(box_x1 > box_x0 and box_y1 > box_y0,
                  "drawing detection box is well-formed",
                  f"got {detection['box']}")

        embedded_detections = ImageExtractor._embedded_image_detections(
            pdf_reader, 0, render_dpi, []
        )
        check(len(embedded_detections) == 1,
              "embedded-image fallback finds the raster image",
              f"got {len(embedded_detections)}")

        # With the raster's own box supplied as an existing detection, the
        # overlap gate must suppress it.
        if embedded_detections:
            suppressed = ImageExtractor._embedded_image_detections(
                pdf_reader, 0, render_dpi, [list(embedded_detections[0]["box"])]
            )
            check(len(suppressed) == 0,
                  "overlap gate suppresses an already-detected image",
                  f"got {len(suppressed)}")

        caption_box = None
        for detection in embedded_detections:
            caption_box = detection["box"]
        if caption_box is not None:
            region_text = ImageExtractor._extract_region_text(
                pdf_reader, 0, caption_box, render_dpi
            )
            check(isinstance(region_text, str),
                  "region text helper returns a string through the new signature")


def verify_svg_rasterizer():
    print("\n[8] SvgRasterizer (replaces MuPDF's SVG backend)")

    from PIL import Image

    svg_markup = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">'
        '<rect x="0" y="0" width="200" height="100" fill="#0b6b6b"/>'
        '</svg>'
    )
    rasterizer = SvgRasterizer(150)
    png_bytes = rasterizer.rasterize_to_png_bytes(svg_markup)
    check(png_bytes is not None, "valid SVG rasterizes to PNG")
    if png_bytes:
        check(png_bytes[:8] == b"\x89PNG\r\n\x1a\n", "SVG raster output is a PNG")
        rendered = Image.open(io.BytesIO(png_bytes)).convert("RGB")
        red, green, blue = rendered.getpixel((rendered.width // 2, rendered.height // 2))
        check(abs(red - 11) < 40 and abs(green - 107) < 40 and abs(blue - 107) < 40,
              "SVG fill colour survives rasterization",
              f"expected about (11, 107, 107), got ({red}, {green}, {blue})")

    check(rasterizer.rasterize_to_png_bytes("<svg not closed") is None,
          "malformed SVG returns None rather than raising")


def verify_real_repository_pdfs():
    """
    Smoke-runs every real PDF checked into the repository through the reader and
    the text workflow. Synthetic fixtures are built by the same ReportLab that
    the reader then parses, so they can flatter a port; these are genuine
    multi-page documents with running headers, symbol fonts and tables.
    """
    print("\n[9] Real repository PDF corpus")

    from Workflows.MapTopicsWithContent.ExtractText import extract_text_with_page_map

    reports_directory = AGENT_DIRECTORY.parent / "Common" / "Reports"
    report_paths = sorted(reports_directory.glob("*.pdf"))
    check(len(report_paths) > 0, "found real PDFs to exercise",
          f"looked in {reports_directory}")

    total_page_count = 0
    for report_path in report_paths:
        pdf_bytes = report_path.read_bytes()

        with PdfDocumentReader(pdf_bytes) as pdf_reader:
            page_count = pdf_reader.get_page_count()
            total_page_count += page_count

            empty_page_count = 0
            for page_index in range(page_count):
                page_text = pdf_reader.get_page_text(page_index)
                if "\r" in page_text:
                    check(False, f"{report_path.name} p{page_index + 1} has no stray CR")
                if not page_text.strip():
                    empty_page_count += 1

            check(empty_page_count == 0,
                  f"{report_path.name}: every page yields text",
                  f"{empty_page_count} of {page_count} pages empty")

        full_text, page_spans = extract_text_with_page_map(pdf_bytes)
        check(len(full_text) > 200,
              f"{report_path.name}: extract_text_with_page_map returns text",
              f"got {len(full_text)} chars")
        check(all(0 <= offset <= len(full_text) for offset, _ in page_spans),
              f"{report_path.name}: every page span offset is in range")

    print(f"  ....  {len(report_paths)} document(s), {total_page_count} page(s) parsed")


def verify_no_agpl_pdf_imports():
    print("\n[9] Source-level licence gate")

    # One pattern, actually used. An earlier revision of this file defined a
    # broader `forbidden_pattern` covering doclayout_yolo and then scanned with a
    # narrower one, so the AGPL layout-model half of this gate silently never
    # ran. Keep this as the single source of truth.
    pymupdf_import_pattern = re.compile(
        r"^\s*(?:import\s+(?:fitz|pymupdf)\b|from\s+(?:fitz|pymupdf)\b)",
        re.MULTILINE,
    )

    # This harness itself imports fitz inside the opt-in parity tier — that is
    # the whole point of the tier, so it is the one permitted exception.
    this_harness = Path(__file__).resolve()

    offending_files = []
    for python_file in AGENT_DIRECTORY.rglob("*.py"):
        if ".venv" in python_file.parts:
            continue
        if python_file.resolve() == this_harness:
            continue
        try:
            source = python_file.read_text(encoding = "utf-8")
        except Exception:
            continue
        if pymupdf_import_pattern.search(source):
            offending_files.append(str(python_file.relative_to(AGENT_DIRECTORY)))

    check(not offending_files,
          "no first-party module imports PyMuPDF",
          f"offenders: {offending_files}")

    requirements_text = (AGENT_DIRECTORY / "requirements.txt").read_text(encoding = "utf-8")
    requirement_names = {
        re.split(r"[=<>!~\[]", line.strip(), maxsplit = 1)[0].strip().lower()
        for line in requirements_text.splitlines()
        if line.strip() and not line.strip().startswith(("#", "-"))
    }
    check("pymupdf" not in requirement_names,
          "PyMuPDF removed from requirements.txt")
    check("pypdfium2" in requirement_names,
          "pypdfium2 pinned in requirements.txt")
    check("svglib" in requirement_names,
          "svglib pinned in requirements.txt (SVG rasterization path)")

    # Promoted from a printed NOTE to a real gate once the layout-model half of
    # the migration landed. VerifyLayoutDetector covers the import side; this
    # keeps the requirements side honest from both harnesses.
    remaining_agpl = sorted(
        name for name in requirement_names
        if name.startswith("doclayout") or name == "ultralytics"
    )
    check(not remaining_agpl,
          "no AGPL layout dependency remains in requirements.txt",
          f"found {remaining_agpl}")


# ----------------------------------------------------------------------------
# Tier 2 -- PyMuPDF parity (opt-in)
# ----------------------------------------------------------------------------

def verify_parity_against_pymupdf(structured_pdf_bytes):
    print("\n[10] PARITY against PyMuPDF (VERIFY_PDF_PARITY=1)")

    try:
        import fitz
    except ImportError:
        print("  SKIP  PyMuPDF is not installed -- parity tier unavailable.")
        return

    mupdf_document = fitz.open(stream = structured_pdf_bytes, filetype = "pdf")
    try:
        with PdfDocumentReader(structured_pdf_bytes) as pdf_reader:
            check(mupdf_document.page_count == pdf_reader.get_page_count(),
                  "page count matches PyMuPDF",
                  f"mupdf {mupdf_document.page_count} vs pdfium {pdf_reader.get_page_count()}")

            for page_index in range(mupdf_document.page_count):
                mupdf_text = mupdf_document.load_page(page_index).get_text("text")
                pdfium_text = pdf_reader.get_page_text(page_index)

                mupdf_words = mupdf_text.split()
                pdfium_words = pdfium_text.split()
                check(mupdf_words == pdfium_words,
                      f"page {page_index + 1} text matches PyMuPDF word-for-word",
                      f"mupdf {len(mupdf_words)} words vs pdfium {len(pdfium_words)}")

            mupdf_toc = mupdf_document.get_toc(simple = False)
            pdfium_toc = pdf_reader.get_outline_entries()
            check(len(mupdf_toc) == len(pdfium_toc),
                  "outline entry count matches PyMuPDF",
                  f"mupdf {len(mupdf_toc)} vs pdfium {len(pdfium_toc)}")
            for mupdf_entry, pdfium_entry in zip(mupdf_toc, pdfium_toc):
                check(mupdf_entry[0] == pdfium_entry["level"],
                      f"outline level matches for {mupdf_entry[1]!r}",
                      f"mupdf {mupdf_entry[0]} vs pdfium {pdfium_entry['level']}")
                check(mupdf_entry[1] == pdfium_entry["title"],
                      "outline title matches")
                check(mupdf_entry[2] - 1 == pdfium_entry["page_index"],
                      f"outline page matches for {mupdf_entry[1]!r}",
                      f"mupdf page {mupdf_entry[2]} vs pdfium index {pdfium_entry['page_index']}")

            # Font-size histogram: the quantity the body-text baseline is derived
            # from. Compare the WINNING size rather than exact counts, because
            # span segmentation legitimately differs between the engines.
            mupdf_histogram = {}
            for page_index in range(mupdf_document.page_count):
                for block in mupdf_document[page_index].get_text("dict")["blocks"]:
                    if block["type"] != 0:
                        continue
                    for line in block["lines"]:
                        for span in line["spans"]:
                            size = round(span["size"], 1)
                            mupdf_histogram[size] = (
                                mupdf_histogram.get(size, 0)
                                + len(span["text"].strip().split())
                            )

            pdfium_histogram = {}
            for page_index in range(pdf_reader.get_page_count()):
                for text_line in pdf_reader.get_page_text_lines(page_index):
                    for span in text_line.get_spans():
                        size = round(span.get_font_size(), 1)
                        pdfium_histogram[size] = (
                            pdfium_histogram.get(size, 0) + span.get_word_count()
                        )

            mupdf_body_size = max(mupdf_histogram, key = mupdf_histogram.get)
            pdfium_body_size = max(pdfium_histogram, key = pdfium_histogram.get)
            check(mupdf_body_size == pdfium_body_size,
                  "body-text font size baseline matches PyMuPDF",
                  f"mupdf {mupdf_body_size} vs pdfium {pdfium_body_size}")
            check(set(mupdf_histogram) == set(pdfium_histogram),
                  "the same set of font sizes is observed",
                  f"mupdf {sorted(mupdf_histogram)} vs pdfium {sorted(pdfium_histogram)}")

            # Geometry parity: vector paths and embedded images.
            render_dpi = 200
            scale = render_dpi / 72.0
            for page_index in range(mupdf_document.page_count):
                mupdf_page = mupdf_document[page_index]

                mupdf_path_boxes = sorted(
                    (
                        int(drawing["rect"].x0 * scale), int(drawing["rect"].y0 * scale),
                        int(drawing["rect"].x1 * scale), int(drawing["rect"].y1 * scale),
                    )
                    for drawing in mupdf_page.get_drawings()
                    if drawing.get("rect") is not None
                )
                pdfium_path_boxes = sorted(
                    pdf_reader.get_vector_path_pixel_boxes(page_index, render_dpi)
                )
                check(len(mupdf_path_boxes) == len(pdfium_path_boxes),
                      f"page {page_index + 1} vector path count matches PyMuPDF",
                      f"mupdf {len(mupdf_path_boxes)} vs pdfium {len(pdfium_path_boxes)}")

                # PDFium's path bounds include the stroke extent; MuPDF returned
                # the geometric path box. So the correct assertion is not
                # equality but CONTAINMENT: every MuPDF box must sit inside its
                # PDFium counterpart, expanded by no more than one stroke width.
                # A larger region only ever helps recall downstream.
                maximum_stroke_expansion_pixels = 6
                matched_path_count = 0
                worst_expansion = 0
                for mupdf_box in mupdf_path_boxes:
                    for pdfium_box in pdfium_path_boxes:
                        b_contains = (
                            pdfium_box[0] <= mupdf_box[0]
                            and pdfium_box[1] <= mupdf_box[1]
                            and pdfium_box[2] >= mupdf_box[2]
                            and pdfium_box[3] >= mupdf_box[3]
                        )
                        expansion = max(
                            mupdf_box[0] - pdfium_box[0], mupdf_box[1] - pdfium_box[1],
                            pdfium_box[2] - mupdf_box[2], pdfium_box[3] - mupdf_box[3],
                        )
                        if b_contains and expansion <= maximum_stroke_expansion_pixels:
                            matched_path_count += 1
                            worst_expansion = max(worst_expansion, expansion)
                            break
                check(matched_path_count == len(mupdf_path_boxes),
                      f"page {page_index + 1} vector path boxes contain PyMuPDF's within one stroke width",
                      f"{matched_path_count}/{len(mupdf_path_boxes)} matched, "
                      f"worst expansion {worst_expansion}px")

                mupdf_image_boxes = []
                for image_record in mupdf_page.get_images(full = True):
                    for image_rect in mupdf_page.get_image_rects(image_record[0]) or []:
                        mupdf_image_boxes.append((
                            int(image_rect.x0 * scale), int(image_rect.y0 * scale),
                            int(image_rect.x1 * scale), int(image_rect.y1 * scale),
                        ))
                pdfium_image_boxes = pdf_reader.get_embedded_image_pixel_boxes(
                    page_index, render_dpi
                )
                check(len(mupdf_image_boxes) == len(pdfium_image_boxes),
                      f"page {page_index + 1} embedded image count matches PyMuPDF",
                      f"mupdf {len(mupdf_image_boxes)} vs pdfium {len(pdfium_image_boxes)}")

                matched_image_count = sum(
                    1
                    for mupdf_box in sorted(mupdf_image_boxes)
                    if any(
                        all(abs(a - b) <= 2 for a, b in zip(mupdf_box, pdfium_box))
                        for pdfium_box in sorted(pdfium_image_boxes)
                    )
                )
                check(matched_image_count == len(mupdf_image_boxes),
                      f"page {page_index + 1} embedded image boxes align within 2px",
                      f"{matched_image_count}/{len(mupdf_image_boxes)} matched")
    finally:
        mupdf_document.close()


def main():
    print("=" * 74)
    print("PdfDocumentReader verification (PyMuPDF -> PDFium migration)")
    print("=" * 74)

    structured_pdf_bytes = build_structured_pdf_bytes()

    verify_reader_basics(structured_pdf_bytes)
    verify_geometry(structured_pdf_bytes)
    verify_rendering(structured_pdf_bytes)
    verify_workflow_entry_points(structured_pdf_bytes)
    verify_font_heuristics_without_outline()
    verify_syllabus_plausibility()
    verify_image_extractor_geometry(structured_pdf_bytes)
    verify_svg_rasterizer()
    verify_real_repository_pdfs()
    verify_no_agpl_pdf_imports()

    if os.getenv("VERIFY_PDF_PARITY") == "1":
        verify_parity_against_pymupdf(structured_pdf_bytes)
    else:
        print("\n[10] PARITY tier skipped (set VERIFY_PDF_PARITY=1 with PyMuPDF installed).")

    print("\n" + "=" * 74)
    if FAILURE_MESSAGES:
        print(f"FAILED -- {PASS_COUNT} passed, {len(FAILURE_MESSAGES)} failed")
        for failure_message in FAILURE_MESSAGES:
            print(f"  - {failure_message}")
        return 1

    print(f"PASSED -- {PASS_COUNT} checks")
    return 0


if __name__ == "__main__":
    sys.exit(main())
