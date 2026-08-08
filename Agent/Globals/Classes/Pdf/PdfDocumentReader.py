import io

from Globals.Classes.Pdf.PdfRectangle import PdfRectangle
from Globals.Classes.Pdf.PdfTextLine import PdfTextLine
from Globals.Classes.Pdf.PdfTextSpan import PdfTextSpan


class PdfDocumentReader:
    """
    The single gateway through which this codebase reads PDFs.

    Backed by pypdfium2 (PDFium — BSD-3-Clause / Apache-2.0). It replaces the
    former direct PyMuPDF usage, which was AGPL-3.0 and therefore incompatible
    with shipping a closed-source hosted service without an Artifex commercial
    licence. Nothing outside this package may import a PDF library directly.

    Two PDFium behaviours are normalised here so callers never have to think
    about them:

      * PDFium emits CRLF line breaks in extracted text; MuPDF emitted LF. Every
        string returned by this class is normalised to LF, because the syllabus
        heading matchers split on newlines and would otherwise see a trailing
        carriage return glued to every line.
      * PDFium reports geometry from a bottom-left origin. Every pixel box this
        class returns has already been flipped to the top-left origin that
        Pillow and the layout detector use, via PdfRectangle.

    Threading: PDFium is explicitly documented as not thread-safe — concurrent
    calls across threads are not permitted. All PDF work in the Agent runs
    synchronously on the worker's event-loop thread, which satisfies that
    constraint. Do not move a reader into asyncio.to_thread without giving each
    thread its own process or serialising access behind a lock.

    Use as a context manager so the native document handle is always released:

        with PdfDocumentReader(pdf_bytes) as reader:
            text = reader.get_page_text(0)
    """

    POINTS_PER_INCH = 72.0
    # PDF font-descriptor flag bit 19 (1 << 18) is ForceBold. PDFium surfaces the
    # descriptor flags verbatim through FPDFText_GetFontInfo.
    FONT_DESCRIPTOR_FORCE_BOLD_FLAG = 1 << 18
    # Weights at or above this are treated as bold. PDFium returns -1 for
    # synthetic characters and 0 for fonts that declare no weight, so this test
    # is a supplement to the font-name check rather than a replacement for it.
    BOLD_FONT_WEIGHT_THRESHOLD = 600
    FONT_NAME_BUFFER_LENGTH = 256
    # PDFium reports a nominal size of 1.0 for the synthetic characters it
    # inserts between text segments (line breaks and generated spaces). Letting
    # those into the font-size histogram would corrupt the body-text baseline
    # the heading heuristics derive, so they are excluded.
    SYNTHETIC_CHARACTER_FONT_SIZE = 1.0

    def __init__(self, pdf_bytes):
        import pypdfium2

        self.__document = pypdfium2.PdfDocument(pdf_bytes)
        self.__page_height_cache = {}

    def __enter__(self):
        return self

    def __exit__(self, exception_type, exception_value, exception_traceback):
        self.close()
        return False

    def close(self):
        if self.__document is not None:
            self.__document.close()
            self.__document = None

    def get_page_count(self):
        return len(self.__document)

    def get_page_height_in_points(self, page_index):
        if page_index not in self.__page_height_cache:
            _, page_height = self.__document.get_page_size(page_index)
            self.__page_height_cache[page_index] = page_height
        return self.__page_height_cache[page_index]

    def get_page_text(self, page_index):
        """
        Full text of one page, in PDFium's reading order, with CRLF normalised
        to LF. Returns an empty string when the page has no extractable text or
        cannot be parsed.
        """
        try:
            page = self.__document[page_index]
            text_page = page.get_textpage()
            try:
                # get_text_bounded defaults to the page bounding box and, unlike
                # get_text_range, is not limited to UCS-2 — so characters outside
                # the basic multilingual plane survive extraction.
                raw_text = text_page.get_text_bounded()
            finally:
                text_page.close()
        except Exception as page_text_error:
            print(
                f"  [WARN] Page {page_index + 1} unreadable — "
                f"{type(page_text_error).__name__}: {page_text_error}"
            )
            return ""

        return PdfDocumentReader.__normalise_line_breaks(raw_text or "")

    def get_page_text_lines(self, page_index):
        """
        The page's text split into lines, each carrying its largest font size and
        whether any of its characters are bold. This is the replacement for
        MuPDF's get_text("dict") span walk that the heading heuristics used.
        """
        import pypdfium2.raw as pdfium_raw

        try:
            page = self.__document[page_index]
            text_page = page.get_textpage()
        except Exception as text_lines_error:
            print(
                f"  [WARN] Page {page_index + 1} text layout unreadable — "
                f"{type(text_lines_error).__name__}: {text_lines_error}"
            )
            return []

        try:
            character_count = text_page.count_chars()
            text_lines = []
            line_span_builders = []
            b_previous_was_carriage_return = False

            for character_index in range(character_count):
                code_point = pdfium_raw.FPDFText_GetUnicode(text_page.raw, character_index)
                character = chr(code_point) if code_point else ""

                # PDFium normally emits CRLF, but a lone CR has to break a line
                # too — otherwise such a document would collapse into one giant
                # line and every heading heuristic would see nothing. The flag
                # stops CRLF from being counted as two breaks.
                if character == "\r":
                    text_line = PdfDocumentReader.__build_text_line(line_span_builders)
                    if text_line is not None:
                        text_lines.append(text_line)
                    line_span_builders = []
                    b_previous_was_carriage_return = True
                    continue

                if character == "\n":
                    if not b_previous_was_carriage_return:
                        text_line = PdfDocumentReader.__build_text_line(line_span_builders)
                        if text_line is not None:
                            text_lines.append(text_line)
                        line_span_builders = []
                    b_previous_was_carriage_return = False
                    continue

                b_previous_was_carriage_return = False

                font_size = pdfium_raw.FPDFText_GetFontSize(text_page.raw, character_index)
                if PdfDocumentReader.__is_measurable_character(character, font_size):
                    b_bold = PdfDocumentReader.__is_bold_character(text_page, character_index)
                    rounded_font_size = round(font_size, 1)
                else:
                    # Whitespace and PDFium's synthetic characters carry no
                    # typography of their own. They inherit the run they sit in
                    # so a space never splits a span, and start no run of their
                    # own when a line opens with one.
                    if not line_span_builders:
                        continue
                    rounded_font_size = line_span_builders[-1]["font_size"]
                    b_bold = line_span_builders[-1]["b_bold"]

                if (
                    line_span_builders
                    and line_span_builders[-1]["font_size"] == rounded_font_size
                    and line_span_builders[-1]["b_bold"] == b_bold
                ):
                    line_span_builders[-1]["characters"].append(character)
                else:
                    line_span_builders.append({
                        "characters": [character],
                        "font_size": rounded_font_size,
                        "b_bold": b_bold,
                    })

            final_text_line = PdfDocumentReader.__build_text_line(line_span_builders)
            if final_text_line is not None:
                text_lines.append(final_text_line)

            return text_lines
        finally:
            text_page.close()

    def get_outline_entries(self):
        """
        The embedded table of contents, as a list of
        {'level': int, 'title': str, 'page_index': int} dictionaries.

        level is 1-based to match the historical MuPDF get_toc() contract that
        the syllabus heading code is written against — pypdfium2 reports the top
        level as 0. page_index is 0-based; entries whose destination cannot be
        resolved report None so callers can decide how to treat them.
        """
        outline_entries = []
        try:
            for bookmark in self.__document.get_toc():
                try:
                    title = bookmark.get_title()
                    destination = bookmark.get_dest()
                    page_index = destination.get_index() if destination is not None else None
                except Exception:
                    continue
                outline_entries.append({
                    "level": bookmark.level + 1,
                    "title": title or "",
                    "page_index": page_index,
                })
        except Exception as outline_error:
            print(
                f"  [WARN] Table of contents unreadable — "
                f"{type(outline_error).__name__}: {outline_error}"
            )
            return []

        return outline_entries

    def render_page_to_image(self, page_index, render_dpi):
        """
        Rasterizes one page to a RGB Pillow image at render_dpi.
        PDFium takes a scale factor rather than a DPI, hence the conversion.
        """
        page = self.__document[page_index]
        scale = render_dpi / PdfDocumentReader.POINTS_PER_INCH
        return page.render(scale = scale).to_pil().convert("RGB")

    def render_page_to_png_bytes(self, page_index, render_dpi):
        rendered_image = self.render_page_to_image(page_index, render_dpi)
        png_buffer = io.BytesIO()
        rendered_image.save(png_buffer, format = "PNG")
        return png_buffer.getvalue()

    def get_text_in_pixel_box(self, page_index, pixel_box, render_dpi):
        """
        Text falling inside a top-left-origin pixel box on a page rasterized at
        render_dpi. Used to recover a figure's caption once the layout detector
        has located it.
        """
        page_height_in_points = self.get_page_height_in_points(page_index)
        rectangle = PdfRectangle.from_pixel_box(pixel_box, page_height_in_points, render_dpi)

        try:
            page = self.__document[page_index]
            text_page = page.get_textpage()
            try:
                region_text = text_page.get_text_bounded(
                    left = rectangle.get_left(),
                    bottom = rectangle.get_bottom(),
                    right = rectangle.get_right(),
                    top = rectangle.get_top(),
                )
            finally:
                text_page.close()
        except Exception:
            return ""

        return PdfDocumentReader.__normalise_line_breaks(region_text or "").strip()

    def get_vector_path_pixel_boxes(self, page_index, render_dpi):
        """
        Top-left-origin pixel boxes for every vector path drawn on the page.

        This replaces MuPDF's get_drawings(). The former code read only the
        bounding rectangle of each drawing and never touched path geometry, so
        the PDFium page-object bounds are a like-for-like substitute.

        One documented difference: PDFium's path bounds INCLUDE the stroke
        extent, where MuPDF returned the geometric path box. A stroked shape
        therefore reports roughly one stroke width larger on each side (about
        3px at 200 DPI for a 1pt stroke). That only ever grows a detected
        region, never shrinks it, so it cannot cost recall — and it is far below
        both the clustering gap and the minimum figure dimension the caller
        applies afterwards.
        """
        return self.__get_object_pixel_boxes(page_index, render_dpi, "path")

    def get_embedded_image_pixel_boxes(self, page_index, render_dpi):
        """
        Top-left-origin pixel boxes for every embedded raster image on the page.

        This replaces MuPDF's get_images(full=True) plus get_image_rects(xref).
        PDFium reports the placed bounds of each image object directly, so the
        xref round-trip — and the duplicate-xref dance it required — disappears.
        """
        return self.__get_object_pixel_boxes(page_index, render_dpi, "image")

    def __get_object_pixel_boxes(self, page_index, render_dpi, object_kind):
        import pypdfium2.raw as pdfium_raw

        object_type = (
            pdfium_raw.FPDF_PAGEOBJ_PATH if object_kind == "path"
            else pdfium_raw.FPDF_PAGEOBJ_IMAGE
        )

        try:
            page = self.__document[page_index]
            page_height_in_points = self.get_page_height_in_points(page_index)
            pixel_boxes = []
            for page_object in page.get_objects(filter = (object_type,)):
                try:
                    left, bottom, right, top = page_object.get_bounds()
                except Exception:
                    continue
                rectangle = PdfRectangle(left, bottom, right, top)
                pixel_boxes.append(
                    rectangle.to_pixel_box(page_height_in_points, render_dpi)
                )
            return pixel_boxes
        except Exception as page_object_error:
            print(
                f"  [WARN] Page {page_index + 1} objects unreadable — "
                f"{type(page_object_error).__name__}: {page_object_error}"
            )
            return []

    @staticmethod
    def __build_text_line(line_span_builders):
        if not line_span_builders:
            return None

        spans = [
            PdfTextSpan(
                "".join(span_builder["characters"]),
                span_builder["font_size"],
                span_builder["b_bold"],
            )
            for span_builder in line_span_builders
        ]

        text = "".join(span.get_text() for span in spans)
        if not text.strip():
            return None

        return PdfTextLine(text, spans)

    @staticmethod
    def __is_measurable_character(character, font_size):
        """
        Whitespace and PDFium's synthetic characters carry no meaningful
        typography and must not influence a line's font size or bold flag.
        """
        if not character.strip():
            return False
        return font_size > PdfDocumentReader.SYNTHETIC_CHARACTER_FONT_SIZE

    @staticmethod
    def __is_bold_character(text_page, character_index):
        import ctypes

        import pypdfium2.raw as pdfium_raw

        font_weight = pdfium_raw.FPDFText_GetFontWeight(text_page.raw, character_index)
        if font_weight >= PdfDocumentReader.BOLD_FONT_WEIGHT_THRESHOLD:
            return True

        font_name_buffer = ctypes.create_string_buffer(PdfDocumentReader.FONT_NAME_BUFFER_LENGTH)
        descriptor_flags = ctypes.c_int()
        try:
            written_length = pdfium_raw.FPDFText_GetFontInfo(
                text_page.raw,
                character_index,
                font_name_buffer,
                PdfDocumentReader.FONT_NAME_BUFFER_LENGTH,
                ctypes.byref(descriptor_flags),
            )
        except Exception:
            return False

        if descriptor_flags.value & PdfDocumentReader.FONT_DESCRIPTOR_FORCE_BOLD_FLAG:
            return True

        if written_length <= 0:
            return False

        font_name = font_name_buffer.value[:written_length].decode("utf-8", errors = "ignore")
        return "bold" in font_name.lower()

    @staticmethod
    def __normalise_line_breaks(text):
        return text.replace("\r\n", "\n").replace("\r", "\n")
