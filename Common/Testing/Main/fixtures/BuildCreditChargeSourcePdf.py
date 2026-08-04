# Renders credit-charge-source.pdf from its reviewable .txt source.
#
# The .txt is the thing to edit and review in a diff; the .pdf is a build
# artifact that happens to be committed, because the suite needs a real PDF and
# generating one at test time would add PyMuPDF to the Node suite's
# prerequisites for no benefit.
#
# Run from the Agent directory so PyMuPDF resolves from its venv:
#   Agent/.venv/Scripts/python.exe ../Common/Testing/Main/fixtures/BuildCreditChargeSourcePdf.py

import os
import sys

import fitz

FIXTURES_DIRECTORY = os.path.dirname(os.path.abspath(__file__))
SOURCE_TEXT_PATH = os.path.join(FIXTURES_DIRECTORY, "credit-charge-source.txt")
OUTPUT_PDF_PATH = os.path.join(FIXTURES_DIRECTORY, "credit-charge-source.pdf")

TEXT_RECTANGLE = fitz.Rect(56, 56, 540, 780)
FONT_SIZE = 9.5
FONT_NAME = "helv"

with open(SOURCE_TEXT_PATH, encoding = "utf-8") as source_file:
    source_text = source_file.read()

document = fitz.open()
page = document.new_page()

overflow = page.insert_textbox(TEXT_RECTANGLE, source_text, fontsize = FONT_SIZE, fontname = FONT_NAME, align = 0)

if overflow < 0:
    print(f"ERROR: the text does not fit on one page (overflow={overflow}). Shorten it or lower FONT_SIZE.")
    sys.exit(1)

document.save(OUTPUT_PDF_PATH, deflate = True)
document.close()

# Prove the text layer is real. PrepareForSimilaritySearch opens this with
# fitz.open(stream=..., filetype="pdf") and reads its text; a fixture whose text
# layer is missing would fail there with a confusing "no content" error rather
# than an obvious one here.
verification_document = fitz.open(OUTPUT_PDF_PATH)
extracted_text = verification_document[0].get_text().strip()
verification_document.close()

if len(extracted_text) < 500:
    print(f"ERROR: only {len(extracted_text)} characters are extractable — the text layer did not render.")
    sys.exit(1)

print(f"wrote {OUTPUT_PDF_PATH}")
print(f"pages = 1, extractable characters = {len(extracted_text)}")
