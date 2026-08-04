# Browser-suite fixtures

Committed input documents for the Puppeteer suites in `Common/Testing/Main`.

## `credit-charge-source.pdf`

The document `run_credit_charging_tests.js` uploads to drive a real AI
generation, so the suite can prove the account is actually charged for it.

| | |
|---|---|
| Source of truth | `credit-charge-source.txt` — edit and review **this** |
| Built by | `BuildCreditChargeSourcePdf.py` |
| Shape | 1 page, ~330 words, embedded Helvetica **text layer**, under 20 KB |

### Why it is a PDF and not a `.txt`

`Agent/Workflows/PrepareForSimilaritySearch/PrepareForSimilaritySearch.py` opens
uploaded sources with `fitz.open(stream = ..., filetype = "pdf")`. A `.txt`
fixture dies there. It also has to carry a **real text layer** rather than being
a scan, so the suite can leave OCR switched off — otherwise every run pays for
`ocrmypdf` in both wall-clock time and a native-binary dependency, for content
that was already machine-readable.

### Why the content is what it is

First-party prose, written for this purpose. The upload dialog's own IP notice
tells users not to upload third-party material, and a committed test fixture is
the last place to disregard that.

It deliberately reuses the vocabulary the critical-flow suite already asserts on
(the five phases, spaced repetition in Encode, mock tests in Validate), so a
human reading the generated deck can tell at a glance that it came from this
fixture and not from the model's own knowledge.

### Regenerating

```
cd Agent
.venv/Scripts/python.exe ../Common/Testing/Main/fixtures/BuildCreditChargeSourcePdf.py
```

The script refuses to write a PDF whose text overflows one page or whose text
layer did not render, so a bad edit fails here rather than halfway through a
generation run.

### The suite never uploads these bytes verbatim

`InformationSourceUpload.js` rejects a re-upload of content this account has
already stored with HTTP 409. A fixture uploaded byte-for-byte would therefore
work exactly once and fail on every run after it — surfacing as "the source card
went red", which looks nothing like the deduplication it actually is. The suite
appends a per-run comment after `%%EOF` into a temp copy, which changes the
content hash while leaving the document readable by every consumer.
