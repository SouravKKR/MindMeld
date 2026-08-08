import io


class SvgRasterizer:
    """
    Renders SVG markup to PNG bytes.

    This exists because PDFium — unlike MuPDF, which previously handled this —
    reads PDFs only and has no SVG support at all. The replacement path converts
    the SVG to a one-page PDF with ReportLab's pure-Python renderer and then
    rasterizes that page through PdfDocumentReader:

        SVG --svglib--> ReportLab drawing --renderPDF--> PDF --PDFium--> PNG

    Every link is permissively licensed: svglib is LGPL-3.0-or-later (no
    source-disclosure obligation for a hosted service, unlike the AGPL library
    this replaces), ReportLab is BSD, PDFium is BSD-3-Clause / Apache-2.0.

    ReportLab's own renderPM backend is deliberately NOT used — it requires the
    rlPyCairo native backend, which is not installed and which drags a cairo
    system library into the worker image. renderPDF is pure Python and needs
    nothing extra.
    """

    def __init__(self, render_dpi):
        self.__render_dpi = render_dpi

    def rasterize_to_png_bytes(self, svg_markup):
        """
        Returns PNG bytes, or None when the markup will not render — which is
        itself the verdict for a generated visual, not a missing nicety.
        """
        from Globals.Classes.Pdf.PdfDocumentReader import PdfDocumentReader

        try:
            from reportlab.graphics import renderPDF
            from svglib.svglib import svg2rlg

            drawing = svg2rlg(io.BytesIO(svg_markup.encode("utf-8")))
            if drawing is None:
                print("[SvgRasterizer] SVG did not parse into a drawable document.")
                return None

            # svglib does not raise on malformed markup — it returns a drawing of
            # zero extent. Rasterizing that yields a blank or degenerate image
            # that would sail through vision review as "renders fine", so the
            # empty case has to be caught explicitly.
            if drawing.width <= 0 or drawing.height <= 0:
                print("[SvgRasterizer] SVG parsed to a zero-sized drawing — treating as unrenderable.")
                return None

            intermediate_pdf_bytes = renderPDF.drawToString(drawing)

            with PdfDocumentReader(intermediate_pdf_bytes) as pdf_reader:
                if pdf_reader.get_page_count() == 0:
                    print("[SvgRasterizer] SVG produced an empty document.")
                    return None
                return pdf_reader.render_page_to_png_bytes(0, self.__render_dpi)
        except Exception as rasterize_error:
            print(f"[SvgRasterizer] SVG did not render: {rasterize_error}")
            return None
