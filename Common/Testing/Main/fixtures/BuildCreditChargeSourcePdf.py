# Renders credit-charge-source.pdf from its reviewable .txt source.
#
# The .txt is the thing to edit and review in a diff; the .pdf is a build
# artifact that happens to be committed, because the suite needs a real PDF and
# generating one at test time would add a PDF toolchain to the Node suite's
# prerequisites for no benefit.
#
# Writing uses ReportLab (BSD) — the repository's standard PDF generator — and
# the verification read-back uses the Agent's PdfDocumentReader (PDFium). Both
# replaced PyMuPDF, which was AGPL-3.0; see Deployment.md §2.2.1.
#
# Run from the Agent directory so both resolve from its venv:
#   Agent/.venv/Scripts/python.exe ../Common/Testing/Main/fixtures/BuildCreditChargeSourcePdf.py

import os
import sys

from reportlab.lib.pagesizes import A4
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas

AGENT_DIRECTORY = os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", "Agent")
)
sys.path.insert(0, AGENT_DIRECTORY)

from Globals.Classes.Pdf.PdfDocumentReader import PdfDocumentReader

FIXTURES_DIRECTORY = os.path.dirname(os.path.abspath(__file__))
SOURCE_TEXT_PATH = os.path.join(FIXTURES_DIRECTORY, "credit-charge-source.txt")
OUTPUT_PDF_PATH = os.path.join(FIXTURES_DIRECTORY, "credit-charge-source.pdf")

# The original PyMuPDF fixture used a top-left-origin rectangle of
# (56, 56, 540, 780) on an A4 page. ReportLab's origin is bottom-left, so the
# same box is expressed here as margins from each edge.
LEFT_MARGIN = 56
RIGHT_MARGIN = 540
TOP_MARGIN_FROM_TOP = 56
BOTTOM_MARGIN_FROM_TOP = 780

FONT_SIZE = 9.5
FONT_NAME = "Helvetica"
LINE_HEIGHT = FONT_SIZE * 1.25
MINIMUM_EXTRACTABLE_CHARACTERS = 500


def wrap_paragraph(paragraph_text, available_width):
    """Greedy word wrap at the fixture's font and width."""
    if not paragraph_text.strip():
        return [""]

    wrapped_lines = []
    current_line_words = []
    for word in paragraph_text.split():
        candidate_words = current_line_words + [word]
        candidate_width = stringWidth(" ".join(candidate_words), FONT_NAME, FONT_SIZE)
        if candidate_width <= available_width or not current_line_words:
            current_line_words = candidate_words
        else:
            wrapped_lines.append(" ".join(current_line_words))
            current_line_words = [word]

    if current_line_words:
        wrapped_lines.append(" ".join(current_line_words))
    return wrapped_lines


def main():
    with open(SOURCE_TEXT_PATH, encoding = "utf-8") as source_file:
        source_text = source_file.read()

    page_width, page_height = A4
    available_width = RIGHT_MARGIN - LEFT_MARGIN
    first_line_baseline = page_height - TOP_MARGIN_FROM_TOP - FONT_SIZE
    lowest_permitted_baseline = page_height - BOTTOM_MARGIN_FROM_TOP

    wrapped_lines = []
    for paragraph_text in source_text.splitlines():
        wrapped_lines.extend(wrap_paragraph(paragraph_text, available_width))

    required_height = len(wrapped_lines) * LINE_HEIGHT
    available_height = first_line_baseline - lowest_permitted_baseline
    if required_height > available_height:
        overflow_line_count = int((required_height - available_height) / LINE_HEIGHT) + 1
        print(
            f"ERROR: the text does not fit on one page "
            f"({overflow_line_count} line(s) over). Shorten it or lower FONT_SIZE."
        )
        return 1

    pdf_canvas = canvas.Canvas(OUTPUT_PDF_PATH, pagesize = A4)
    pdf_canvas.setFont(FONT_NAME, FONT_SIZE)
    text_object = pdf_canvas.beginText(LEFT_MARGIN, first_line_baseline)
    text_object.setLeading(LINE_HEIGHT)
    for wrapped_line in wrapped_lines:
        text_object.textLine(wrapped_line)
    pdf_canvas.drawText(text_object)
    pdf_canvas.showPage()
    pdf_canvas.save()

    # Prove the text layer is real. PrepareForSimilaritySearch opens this through
    # PdfDocumentReader and reads its text; a fixture whose text layer is missing
    # would fail there with a confusing "no content" error rather than an obvious
    # one here.
    with open(OUTPUT_PDF_PATH, "rb") as written_file:
        written_pdf_bytes = written_file.read()

    with PdfDocumentReader(written_pdf_bytes) as pdf_reader:
        page_count = pdf_reader.get_page_count()
        extracted_text = pdf_reader.get_page_text(0).strip()

    if page_count != 1:
        print(f"ERROR: expected a single page, wrote {page_count}.")
        return 1

    if len(extracted_text) < MINIMUM_EXTRACTABLE_CHARACTERS:
        print(
            f"ERROR: only {len(extracted_text)} characters are extractable — "
            f"the text layer did not render."
        )
        return 1

    print(f"wrote {OUTPUT_PDF_PATH}")
    print(f"pages = {page_count}, extractable characters = {len(extracted_text)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
