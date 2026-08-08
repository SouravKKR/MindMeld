"""
End-to-end verification for the DocLayout-YOLO -> Docling Heron migration.

Run from the Agent directory:
    .venv/Scripts/python.exe Verification/VerifyLayoutDetector.py    (Windows)
    .venv/bin/python Verification/VerifyLayoutDetector.py            (Linux)

Two tiers, so the default run needs no model download and no network:

  1. ALWAYS -- drives the REAL ImageExtractor with a scripted FakeLayoutDetector
     over ReportLab fixtures, pinning the whole contract the figure pipeline
     depends on: the six output keys, 0-indexed page numbers, caption text coming
     from the PDF TEXT LAYER rather than from the model, the Picture-only caption
     rule, the in-place caption union, detection ordering, every geometric filter,
     document-wide perceptual-hash dedup, and duplicate-box suppression.

  2. MODEL (opt-in: VERIFY_LAYOUT_MODEL=1) -- downloads the Heron weights and
     asserts the things that can only go wrong against the real model: that boxes
     land inside the page (the target_sizes height/width trap), that the processor
     really resizes to the trained 640, and that no two returned detections are
     duplicates of one another.

The pipeline this exercises is shared with VerifyPdfDocumentReader, which pins
the two fallback detectors; between them the extractor is covered end to end.
"""

import io
import os
import sys
from pathlib import Path

AGENT_DIRECTORY = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(AGENT_DIRECTORY))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from Globals.Classes.Layout.DoclingLayoutDetector import DoclingLayoutDetector
from Globals.Classes.Layout.LayoutDetection import LayoutDetection
from Globals.Classes.Layout.LayoutDetector import LayoutDetector
from Globals.Classes.Pdf.PdfDocumentReader import PdfDocumentReader
from Globals.Enumerations.LayoutRegionRoles import LayoutRegionRoles
from Workflows.PrepareImages.ImageExtractor import ImageExtractor


FAILURE_MESSAGES = []
PASS_COUNT = 0

RENDER_DPI = ImageExtractor._RENDER_DPI


def check(b_condition, description, detail = ""):
    global PASS_COUNT
    if b_condition:
        PASS_COUNT += 1
        print(f"  PASS  {description}")
    else:
        FAILURE_MESSAGES.append(f"{description}{(' -- ' + detail) if detail else ''}")
        print(f"  FAIL  {description}{(' -- ' + detail) if detail else ''}")


# ----------------------------------------------------------------------------
# Fixtures
# ----------------------------------------------------------------------------

FIGURE_CAPTION_TEXT = "Figure 7.3 Electrolytic cell schematic"
TABLE_CAPTION_TEXT = "Table 2.1 Standard electrode potentials"


class FakeLayoutDetector(LayoutDetector):
    """Replays a scripted detection list, keyed by page index."""

    def __init__(self, detections_by_page):
        self.__detections_by_page = detections_by_page
        self.__page_request_order = []

    def set_page_index(self, page_index):
        self.__current_page_index = page_index

    def get_page_request_order(self):
        return self.__page_request_order

    def detect(self, page_image, render_dpi):
        page_index = len(self.__page_request_order)
        self.__page_request_order.append(page_index)
        return list(self.__detections_by_page.get(page_index, []))


def build_page_with_regions_pdf_bytes():
    """
    One A4 page carrying, at known positions:
      * a solid picture block with a caption line directly beneath it
      * a table-shaped block with its own caption line directly beneath it
    The two caption lines are far apart, so a caption pairing to the wrong
    region is unambiguous rather than a near miss.
    """
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen import canvas
    from PIL import Image

    buffer = io.BytesIO()
    pdf_canvas = canvas.Canvas(buffer, pagesize = A4)
    _, page_height = A4

    picture = Image.new("RGB", (300, 200), (40, 90, 170))
    picture_buffer = io.BytesIO()
    picture.save(picture_buffer, format = "PNG")
    picture_buffer.seek(0)
    pdf_canvas.drawImage(
        ImageReader(picture_buffer), 70, page_height - 300, width = 300, height = 200, mask = None
    )
    pdf_canvas.setFont("Helvetica", 10)
    pdf_canvas.drawString(70, page_height - 320, FIGURE_CAPTION_TEXT)

    pdf_canvas.setFont("Helvetica", 10)
    for row_index in range(6):
        pdf_canvas.drawString(70, page_height - 480 - row_index * 16, "cell  cell  cell  cell")
    pdf_canvas.drawString(70, page_height - 600, TABLE_CAPTION_TEXT)

    pdf_canvas.showPage()
    pdf_canvas.save()
    return buffer.getvalue()


def build_text_only_pdf_bytes(page_count = 1):
    """
    Pages carrying ONLY text — no embedded images and no vector paths — so the
    vector-drawing and embedded-image fallbacks stay silent and a scripted model
    detection is the only thing that can produce a figure. Without this the
    filter assertions would be measuring the fallbacks, not the filters.
    """
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    buffer = io.BytesIO()
    pdf_canvas = canvas.Canvas(buffer, pagesize = A4)
    _, page_height = A4

    for _ in range(page_count):
        pdf_canvas.setFont("Helvetica", 11)
        text_object = pdf_canvas.beginText(70, page_height - 90)
        for line_index in range(40):
            text_object.textLine(
                f"Line {line_index:02d} of ordinary body prose with no graphics on the page at all."
            )
        pdf_canvas.drawText(text_object)
        pdf_canvas.showPage()

    pdf_canvas.save()
    return buffer.getvalue()


def page_pixel_size(pdf_bytes, page_index = 0):
    with PdfDocumentReader(pdf_bytes) as pdf_reader:
        return pdf_reader.render_page_to_image(page_index, RENDER_DPI).size


def pixel_box_for_points(left_points, top_points, right_points, bottom_points):
    """
    Converts a rectangle expressed in PDF points measured from the page's
    TOP-LEFT corner into the render-DPI pixel box the detector speaks in.

    ReportLab draws from the bottom-left, so a fixture drawn at
    `y = page_height - 300` is at 300 points from the top and is written here as
    top_points = 300. Mixing the two origins is the single easiest way to write
    a test that passes for the wrong reason.
    """
    scale = RENDER_DPI / 72.0
    return (
        int(left_points * scale), int(top_points * scale),
        int(right_points * scale), int(bottom_points * scale),
    )


def detection(role, pixel_box, confidence_score = 0.9, label = "scripted"):
    return LayoutDetection(role, label, confidence_score, pixel_box)


# ----------------------------------------------------------------------------
# 1 -- output contract
# ----------------------------------------------------------------------------

def verify_output_contract():
    print("\n[1] Figure-dict contract through the real pipeline")

    pdf_bytes = build_page_with_regions_pdf_bytes()
    page_width_pixels, page_height_pixels = page_pixel_size(pdf_bytes)

    # Top-left-origin points: the picture occupies 100..300 down the page and the
    # caption line sits just beneath it at 310..326.
    picture_box = pixel_box_for_points(70, 100, 370, 300)
    caption_box = pixel_box_for_points(70, 310, 370, 328)

    fake_detector = FakeLayoutDetector({0: [
        detection(LayoutRegionRoles.FIGURE, picture_box),
        detection(LayoutRegionRoles.CAPTION, caption_box),
    ]})
    figures = ImageExtractor(layout_detector = fake_detector).extract_figures(pdf_bytes)

    check(len(figures) >= 1, "at least one figure produced", f"got {len(figures)}")
    if not figures:
        return

    figure = figures[0]
    expected_keys = {
        "pageNumber", "boundingBoxCoordinates", "captionText",
        "figureRef", "perceptualImageHash", "imageBytes",
    }
    check(set(figure.keys()) == expected_keys,
          "figure dict has exactly the six contract keys",
          f"got {sorted(figure.keys())}")
    check(figure["pageNumber"] == 0, "pageNumber is 0-indexed",
          f"got {figure['pageNumber']}")
    check(isinstance(figure["boundingBoxCoordinates"], list)
          and len(figure["boundingBoxCoordinates"]) == 4
          and all(isinstance(value, int) for value in figure["boundingBoxCoordinates"]),
          "boundingBoxCoordinates is a list of four ints",
          f"got {figure['boundingBoxCoordinates']}")
    check(isinstance(figure["imageBytes"], bytes)
          and figure["imageBytes"][:8] == b"\x89PNG\r\n\x1a\n",
          "imageBytes is PNG bytes")
    check(isinstance(figure["perceptualImageHash"], str) and figure["perceptualImageHash"],
          "perceptualImageHash is a non-empty string")

    check(FIGURE_CAPTION_TEXT.split()[0] in figure["captionText"],
          "captionText was read from the PDF text layer, not from the model",
          f"got {figure['captionText']!r}")
    check(figure["figureRef"] == "7.3",
          "figureRef normalised from the caption",
          f"got {figure['figureRef']!r}")

    box = figure["boundingBoxCoordinates"]
    check(box[3] >= caption_box[3],
          "caption box was unioned into the figure box",
          f"figure bottom {box[3]} vs caption bottom {caption_box[3]}")
    check(0 <= box[0] and box[2] <= page_width_pixels and box[3] <= page_height_pixels,
          "figure box is clamped inside the page",
          f"box {box} vs page {page_width_pixels}x{page_height_pixels}")


# ----------------------------------------------------------------------------
# 2 -- the Picture-only caption rule
# ----------------------------------------------------------------------------

def verify_picture_only_caption_rule():
    print("\n[2] Picture-only caption rule (Heron has ONE caption class)")

    pdf_bytes = build_page_with_regions_pdf_bytes()

    # The table rows run 470..570 down the page and their caption sits at
    # 590..606. The picture is far above, at 100..300.
    table_box = pixel_box_for_points(70, 470, 370, 570)
    table_caption_box = pixel_box_for_points(70, 590, 370, 608)
    distant_picture_box = pixel_box_for_points(70, 100, 370, 300)

    fake_detector = FakeLayoutDetector({0: [
        detection(LayoutRegionRoles.TABLE, table_box),
        detection(LayoutRegionRoles.FIGURE, distant_picture_box),
        detection(LayoutRegionRoles.CAPTION, table_caption_box),
    ]})
    figures = ImageExtractor(layout_detector = fake_detector).extract_figures(pdf_bytes)

    captions_seen = [(figure["captionText"] or "").strip() for figure in figures]
    check(all(TABLE_CAPTION_TEXT.split()[0] not in caption for caption in captions_seen),
          "a table's caption is dropped, not attached to the table",
          f"captions: {captions_seen}")
    check(all(TABLE_CAPTION_TEXT not in caption for caption in captions_seen),
          "a table's caption is NOT dragged onto a distant picture",
          f"captions: {captions_seen}")

    # The table's own box must be exactly its detection plus padding — proving
    # the caption was never unioned in. Padding alone can make a box overlap the
    # caption region, so asserting on overlap would pass for the wrong reason.
    page_width_pixels, page_height_pixels = page_pixel_size(pdf_bytes)
    padding_x = int(page_width_pixels * ImageExtractor._PAGE_PADDING_FRACTION_X)
    padding_y = int(page_height_pixels * ImageExtractor._PAGE_PADDING_FRACTION_Y)
    expected_table_box = [
        max(0, table_box[0] - padding_x),
        max(0, table_box[1] - padding_y),
        min(page_width_pixels, table_box[2] + padding_x),
        min(page_height_pixels, table_box[3] + padding_y),
    ]
    check(any(figure["boundingBoxCoordinates"] == expected_table_box for figure in figures),
          "the table box is its detection plus padding — the caption was NOT unioned in",
          f"expected {expected_table_box}, got "
          f"{[figure['boundingBoxCoordinates'] for figure in figures]}")


# ----------------------------------------------------------------------------
# 3 -- pairing mechanics
# ----------------------------------------------------------------------------

def verify_caption_pairing_mechanics():
    print("\n[3] Caption pairing mechanics")

    pdf_bytes = build_page_with_regions_pdf_bytes()

    picture_box = pixel_box_for_points(70, 100, 370, 300)
    first_caption_box = pixel_box_for_points(70, 310, 370, 328)
    second_caption_box = pixel_box_for_points(70, 590, 370, 608)

    fake_detector = FakeLayoutDetector({0: [
        detection(LayoutRegionRoles.FIGURE, picture_box),
        detection(LayoutRegionRoles.CAPTION, first_caption_box),
        detection(LayoutRegionRoles.CAPTION, second_caption_box),
    ]})
    figures = ImageExtractor(layout_detector = fake_detector).extract_figures(pdf_bytes)

    check(len(figures) == 1, "two captions on one figure still yield one figure",
          f"got {len(figures)}")
    if figures:
        box = figures[0]["boundingBoxCoordinates"]
        check(box[3] >= second_caption_box[3],
              "the in-place union grew the box to cover BOTH captions",
              f"box {box}, second caption bottom {second_caption_box[3]}")
        check(TABLE_CAPTION_TEXT.split()[0] in (figures[0]["captionText"] or ""),
              "last caption wins for the caption TEXT",
              f"got {figures[0]['captionText']!r}")


# ----------------------------------------------------------------------------
# 4 -- geometric filters and dedup
# ----------------------------------------------------------------------------

def verify_geometric_filters():
    print("\n[4] Geometric filters (frozen across the migration)")

    # Text-only, so the ONLY thing that can produce a figure is the scripted
    # detection under test.
    pdf_bytes = build_text_only_pdf_bytes()
    page_width_pixels, page_height_pixels = page_pixel_size(pdf_bytes)

    control_detector = FakeLayoutDetector({})
    control_figures = ImageExtractor(layout_detector = control_detector).extract_figures(pdf_bytes)
    check(len(control_figures) == 0,
          "control: a text-only page yields no figures without a model detection",
          f"got {len(control_figures)} — the fallbacks are firing and the "
          f"filter assertions below would be meaningless")

    padding_x = int(page_width_pixels * ImageExtractor._PAGE_PADDING_FRACTION_X)
    padding_y = int(page_height_pixels * ImageExtractor._PAGE_PADDING_FRACTION_Y)

    # Padding is applied BEFORE every filter, so the smallest box the floor can
    # ever see is 2*padding on each axis. On A4 at 200 DPI that is 164x232, well
    # over the 80px floor — meaning the floor cannot reject anything, and the
    # aspect gate cannot either (a box thin enough to be 6:1 after padding is
    # already past the 5% area bypass). This is pre-existing behaviour, unchanged
    # by the model swap, and it is exactly why DoclingLayoutDetector carries its
    # own MINIMUM_REGION_DIMENSION_PIXELS: the detector is the only place a small
    # region can still be rejected at its true size.
    check(2 * padding_x >= ImageExtractor._MIN_FIGURE_DIMENSION_PIXELS
          and 2 * padding_y >= ImageExtractor._MIN_FIGURE_DIMENSION_PIXELS,
          "documented: padding makes the 80px floor unreachable on A4 at 200 DPI",
          f"minimum padded box is {2 * padding_x}x{2 * padding_y}")

    tiny_box = (400, 700, 440, 740)
    fake_detector = FakeLayoutDetector({0: [detection(LayoutRegionRoles.FIGURE, tiny_box)]})
    figures = ImageExtractor(layout_detector = fake_detector).extract_figures(pdf_bytes)
    check(len(figures) == 1,
          "a 40px region survives the extractor — the detector must gate it, not this",
          f"got {len(figures)}")
    check(DoclingLayoutDetector.MINIMUM_REGION_DIMENSION_PIXELS > 0,
          "the detector carries a pre-padding size gate to cover that hole",
          f"got {DoclingLayoutDetector.MINIMUM_REGION_DIMENSION_PIXELS}")

    # The margin gate IS reachable, but only for a region small enough to stay
    # under the area bypass.
    small_top_margin_box = (300, 0, 500, 100)
    fake_detector = FakeLayoutDetector({0: [detection(LayoutRegionRoles.FIGURE, small_top_margin_box)]})
    figures = ImageExtractor(layout_detector = fake_detector).extract_figures(pdf_bytes)
    check(len(figures) == 0,
          "a small region hard against the top margin is dropped",
          f"got {len(figures)}")

    # The same region, made large enough to clear the 5% area bypass, survives —
    # the bypass is what lets full-width diagrams near the page top through.
    large_top_box = (300, 0, 900, 300)
    fake_detector = FakeLayoutDetector({0: [detection(LayoutRegionRoles.FIGURE, large_top_box)]})
    figures = ImageExtractor(layout_detector = fake_detector).extract_figures(pdf_bytes)
    check(len(figures) == 1,
          "the same top-margin region survives once it clears the area bypass",
          f"got {len(figures)}")

    large_box = (200, 500, page_width_pixels - 200, 1400)
    fake_detector = FakeLayoutDetector({0: [detection(LayoutRegionRoles.FIGURE, large_box)]})
    figures = ImageExtractor(layout_detector = fake_detector).extract_figures(pdf_bytes)
    check(len(figures) == 1,
          "a large central region survives every filter",
          f"got {len(figures)}")


def verify_perceptual_hash_dedup():
    print("\n[5] Document-wide perceptual-hash dedup")

    # Two IDENTICAL text-only pages: the same box cropped from each yields
    # byte-identical images, so any second copy can only survive if the
    # perceptual-hash dedup failed.
    repeated_pdf_bytes = build_text_only_pdf_bytes(page_count = 2)
    identical_box = pixel_box_for_points(70, 200, 470, 500)

    fake_detector = FakeLayoutDetector({
        0: [detection(LayoutRegionRoles.FIGURE, identical_box)],
        1: [detection(LayoutRegionRoles.FIGURE, identical_box)],
    })
    figures = ImageExtractor(layout_detector = fake_detector).extract_figures(repeated_pdf_bytes)
    check(len(figures) == 1,
          "the same figure on two pages is emitted once",
          f"got {len(figures)}")


# ----------------------------------------------------------------------------
# 6 -- fallbacks and ordering
# ----------------------------------------------------------------------------

def verify_fallbacks_and_ordering():
    print("\n[6] Fallback behaviour and detection ordering")

    verify_pdf_document_reader = __import__("VerifyPdfDocumentReader")
    structured_pdf_bytes = verify_pdf_document_reader.build_structured_pdf_bytes()

    empty_detector = FakeLayoutDetector({})
    figures = ImageExtractor(layout_detector = empty_detector).extract_figures(structured_pdf_bytes)
    check(len(figures) > 0,
          "with NO model detections the vector/embedded fallbacks still produce figures",
          f"got {len(figures)}")

    with PdfDocumentReader(structured_pdf_bytes) as pdf_reader:
        drawing_detections = ImageExtractor._drawing_region_detections(
            pdf_reader, 0, RENDER_DPI, []
        )
        embedded_detections = ImageExtractor._embedded_image_detections(
            pdf_reader, 0, RENDER_DPI, []
        )
    check(len(drawing_detections) >= 1 and len(embedded_detections) >= 1,
          "both fallback detectors still work unchanged after the swap",
          f"drawing={len(drawing_detections)} embedded={len(embedded_detections)}")

    with PdfDocumentReader(structured_pdf_bytes) as pdf_reader:
        page_image = pdf_reader.render_page_to_image(0, RENDER_DPI)
        model_box = (300, 500, 900, 1100)
        scripted_detector = FakeLayoutDetector({0: [
            detection(LayoutRegionRoles.FIGURE, model_box)
        ]})
        scripted_detector.set_page_index(0)
        detections = ImageExtractor._detect_figure_detections(
            scripted_detector, page_image, pdf_reader, 0, RENDER_DPI
        )
    check(len(detections) >= 1, "detections produced with a model hit present")
    check(tuple(detections[0]["box"]) == tuple(model_box),
          "model detections come FIRST, before the fallbacks",
          f"got {detections[0]['box']}")
    check(all(set(row.keys()) == {"box", "caption_box", "caption_text"} for row in detections),
          "every detection dict keeps exactly the three internal keys")


# ----------------------------------------------------------------------------
# 7 -- duplicate-box suppression
# ----------------------------------------------------------------------------

def verify_duplicate_box_suppression():
    print("\n[7] Duplicate-box suppression (RT-DETR has no NMS)")

    # Reached through the name-mangled private static on purpose: this is the
    # one behaviour with no YOLO analogue, and it must be pinned directly rather
    # than inferred from end-to-end counts.
    suppress = DoclingLayoutDetector._DoclingLayoutDetector__suppress_duplicate_boxes

    identical_box = (100, 100, 500, 400)
    detections = [
        LayoutDetection(LayoutRegionRoles.FIGURE, "picture", 0.80, identical_box),
        LayoutDetection(LayoutRegionRoles.TABLE, "table", 0.60, identical_box),
    ]
    kept = suppress(detections)
    check(len(kept) == 1, "the same box under two labels collapses to one",
          f"got {len(kept)}")
    if kept:
        check(kept[0].get_confidence_score() == 0.80,
              "the higher-scoring label survives",
              f"got {kept[0].get_confidence_score()}")

    distinct = [
        LayoutDetection(LayoutRegionRoles.FIGURE, "picture", 0.90, (100, 100, 500, 400)),
        LayoutDetection(LayoutRegionRoles.FIGURE, "picture", 0.70, (600, 100, 1000, 400)),
    ]
    check(len(suppress(distinct)) == 2, "genuinely separate boxes are both kept",
          f"got {len(suppress(distinct))}")

    # Containment suppression: the composite-and-its-parts case. Measured on the
    # reference chapter, 143 picture regions contained 136 nested pairs of which
    # IoU dedup caught 2 — without this every panel of a plate reaches the vision
    # model separately.
    nested = [
        LayoutDetection(LayoutRegionRoles.FIGURE, "picture", 0.90, (100, 100, 900, 800)),
        LayoutDetection(LayoutRegionRoles.FIGURE, "picture", 0.70, (150, 150, 500, 400)),
    ]
    kept_nested = suppress(nested)
    check(len(kept_nested) == 1,
          "a smaller region nested inside a higher-scoring one is suppressed",
          f"got {len(kept_nested)}")
    if kept_nested:
        check(kept_nested[0].get_pixel_box() == (100, 100, 900, 800),
              "the containing region is the one kept",
              f"got {kept_nested[0].get_pixel_box()}")

    # Cross-role containment must NOT suppress: a caption sits inside or against
    # its figure by definition, and losing it loses the caption text.
    caption_inside_figure = [
        LayoutDetection(LayoutRegionRoles.FIGURE, "picture", 0.90, (100, 100, 900, 800)),
        LayoutDetection(LayoutRegionRoles.CAPTION, "caption", 0.70, (150, 700, 800, 780)),
    ]
    check(len(suppress(caption_inside_figure)) == 2,
          "a CAPTION inside a FIGURE survives — suppression is same-role only",
          f"got {len(suppress(caption_inside_figure))}")

    # Partial overlap is not containment.
    overlapping = [
        LayoutDetection(LayoutRegionRoles.FIGURE, "picture", 0.90, (100, 100, 500, 500)),
        LayoutDetection(LayoutRegionRoles.FIGURE, "picture", 0.70, (400, 400, 800, 800)),
    ]
    check(len(suppress(overlapping)) == 2,
          "two partly-overlapping regions are both kept",
          f"got {len(suppress(overlapping))}")


# ----------------------------------------------------------------------------
# 8 -- licence gate
# ----------------------------------------------------------------------------

def verify_no_agpl_layout_imports():
    print("\n[8] Licence gate")

    import re
    forbidden_pattern = re.compile(
        r"^\s*(?:import\s+(?:doclayout_yolo|ultralytics)\b"
        r"|from\s+(?:doclayout_yolo|ultralytics)\b)",
        re.MULTILINE,
    )

    offending_files = []
    for python_file in AGENT_DIRECTORY.rglob("*.py"):
        if ".venv" in python_file.parts:
            continue
        try:
            source = python_file.read_text(encoding = "utf-8")
        except Exception:
            continue
        if forbidden_pattern.search(source):
            offending_files.append(str(python_file.relative_to(AGENT_DIRECTORY)))

    check(not offending_files, "no first-party module imports an AGPL layout model",
          f"offenders: {offending_files}")

    requirements_text = (AGENT_DIRECTORY / "requirements.txt").read_text(encoding = "utf-8")
    requirement_names = {
        re.split(r"[=<>!~\[]", line.strip(), maxsplit = 1)[0].strip().lower()
        for line in requirements_text.splitlines()
        if line.strip() and not line.strip().startswith(("#", "-"))
    }
    check("doclayout-yolo" not in requirement_names and "doclayout_yolo" not in requirement_names,
          "doclayout_yolo removed from requirements.txt")
    check("ultralytics" not in requirement_names, "ultralytics is not present either")
    check("transformers" in requirement_names,
          "transformers pinned — it now carries the layout detector")


# ----------------------------------------------------------------------------
# 9 -- opt-in real-model tier
# ----------------------------------------------------------------------------

def verify_real_model():
    print("\n[9] REAL MODEL (VERIFY_LAYOUT_MODEL=1)")

    # A real document, not a synthetic fixture: the production thresholds are
    # tuned for real page layouts and a solid ReportLab rectangle does not look
    # like a textbook figure to the model. Using a real PDF also stops the box
    # assertions below from passing vacuously on an empty detection list.
    reports_directory = AGENT_DIRECTORY.parent / "Common" / "Reports"
    report_paths = sorted(reports_directory.glob("*.pdf"))
    check(len(report_paths) > 0, "found a real PDF to run the model against",
          f"looked in {reports_directory}")
    if not report_paths:
        return

    # Floors dropped for this tier only. The point here is to exercise the real
    # inference and post-processing path over many regions, not to re-validate the
    # tuned thresholds — those were measured against the full corpus offline.
    layout_detector = DoclingLayoutDetector(
        picture_confidence_threshold = 0.05,
        table_confidence_threshold = 0.05,
        caption_confidence_threshold = 0.05,
    )

    intersection_over_union = DoclingLayoutDetector._DoclingLayoutDetector__intersection_over_union

    detections = []
    with PdfDocumentReader(report_paths[0].read_bytes()) as pdf_reader:
        page_count = min(3, pdf_reader.get_page_count())
        for page_index in range(page_count):
            page_image = pdf_reader.render_page_to_image(page_index, RENDER_DPI)
            page_width, page_height = page_image.size
            page_detections = layout_detector.detect(page_image, RENDER_DPI)
            detections.extend(page_detections)

            check(all(0 <= det.get_pixel_box()[0] and det.get_pixel_box()[2] <= page_width
                      for det in page_detections),
                  f"p{page_index + 1}: every box is inside the page horizontally",
                  "a transposed target_sizes would break this")
            check(all(0 <= det.get_pixel_box()[1] and det.get_pixel_box()[3] <= page_height
                      for det in page_detections),
                  f"p{page_index + 1}: every box is inside the page vertically "
                  f"(target_sizes is height, width)")

            # Per page, never pooled: a running header occupies the same box on
            # every page, so pooling detections across pages reports duplicates
            # that suppression is not supposed to remove and never sees.
            duplicate_pairs = [
                (first.get_pixel_box(), second.get_pixel_box())
                for first_index, first in enumerate(page_detections)
                for second in page_detections[first_index + 1:]
                if intersection_over_union(first.get_pixel_box(), second.get_pixel_box())
                >= DoclingLayoutDetector.DUPLICATE_BOX_IOU_THRESHOLD
            ]
            check(not duplicate_pairs,
                  f"p{page_index + 1}: no duplicate boxes survive suppression",
                  f"{len(duplicate_pairs)} pair(s): {duplicate_pairs[:2]}")

    print(f"  ....  {len(detections)} detection(s) across {page_count} real page(s)")
    check(len(detections) > 0,
          "the real model actually returns detections — the assertions above are not vacuous",
          f"got {len(detections)}")
    check(all(det.get_region_role() is not LayoutRegionRoles.IGNORED for det in detections),
          "no IGNORED-role detection is ever returned")
    check(all(det.get_width() >= DoclingLayoutDetector.MINIMUM_REGION_DIMENSION_PIXELS
              and det.get_height() >= DoclingLayoutDetector.MINIMUM_REGION_DIMENSION_PIXELS
              for det in detections),
          "every detection clears the detector's own pre-padding size gate")

    with PdfDocumentReader(report_paths[0].read_bytes()) as pdf_reader:
        page_image = pdf_reader.render_page_to_image(0, RENDER_DPI)

    from transformers import AutoImageProcessor
    processor = AutoImageProcessor.from_pretrained(
        DoclingLayoutDetector.MODEL_REPOSITORY_ID, use_fast = True
    )
    model_inputs = processor(images = page_image, return_tensors = "pt")
    check(tuple(model_inputs["pixel_values"].shape[-2:])
          == (DoclingLayoutDetector.PROCESSOR_IMAGE_SIZE,
              DoclingLayoutDetector.PROCESSOR_IMAGE_SIZE),
          f"processor resizes to the trained {DoclingLayoutDetector.PROCESSOR_IMAGE_SIZE}px square",
          f"got {tuple(model_inputs['pixel_values'].shape[-2:])}")
    check(processor.do_normalize is False,
          "checkpoint's do_normalize=False survived from_pretrained",
          "constructing the processor directly would silently flip this")

    # Duplicate suppression is asserted per page inside the loop above.


def main():
    print("=" * 74)
    print("Layout detector verification (DocLayout-YOLO -> Docling Heron)")
    print("=" * 74)

    verify_output_contract()
    verify_picture_only_caption_rule()
    verify_caption_pairing_mechanics()
    verify_geometric_filters()
    verify_perceptual_hash_dedup()
    verify_fallbacks_and_ordering()
    verify_duplicate_box_suppression()
    verify_no_agpl_layout_imports()

    if os.getenv("VERIFY_LAYOUT_MODEL") == "1":
        verify_real_model()
    else:
        print("\n[9] REAL MODEL tier skipped (set VERIFY_LAYOUT_MODEL=1 to download weights).")

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
