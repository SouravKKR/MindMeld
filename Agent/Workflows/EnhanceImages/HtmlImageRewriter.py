import base64
import re

import markdown as markdown_renderer


class HtmlImageRewriter:
    """
    Locates and rewrites `<figure class="extracted-figure">…</figure>`
    blocks that PrepareImages.HtmlInjector previously injected into
    flashcard / study-material HTML.

    Two rewrite modes are supported:

      - DIAGRAM:   substitute the embedded base64 image bytes with a
                   regenerated, brand-styled version (figcaption preserved).
      - TEXT_DATA: replace the whole figure block with markdown-rendered
                   HTML so tables become <table>, code becomes
                   <pre><code>, lists become <ul>/<ol>, etc.
    """

    # The <figure> shape produced by HtmlInjector.build_figure_html is
    # stable: <figure class="extracted-figure" style="..."><img ...><figcaption ...>...</figcaption></figure>.
    # Match it as a whole so we can locate, parse, and rebuild the entire block.
    _EXTRACTED_FIGURE_PATTERN = re.compile(
        r'<figure\s+class="extracted-figure"[^>]*>(.*?)</figure>',
        re.DOTALL | re.IGNORECASE,
    )

    _IMG_TAG_PATTERN = re.compile(
        r'<img\b[^>]*?\bsrc="data:image/(?P<mime_subtype>jpeg|jpg|png|webp);base64,(?P<base64_payload>[^"]+)"[^>]*>',
        re.IGNORECASE,
    )

    _FIGCAPTION_PATTERN = re.compile(
        r'<figcaption\b[^>]*>.*?</figcaption>',
        re.DOTALL | re.IGNORECASE,
    )

    # Conservative default width when we rebuild a <figure> block. Matches
    # HtmlInjector._FALLBACK_MAX_WIDTH_PIXELS so an enhanced figure renders at
    # the same nominal width as a web-sourced figure.
    DEFAULT_DIAGRAM_MAX_WIDTH_PIXELS = 500

    MARKDOWN_EXTENSIONS = ("fenced_code", "tables")

    @staticmethod
    def find_extracted_figures(html_content: str) -> list[dict]:
        """
        Scan `html_content` for HtmlInjector-style figure blocks. For each
        match return a dict with:

          - "start":            byte offset of the opening <figure tag
          - "end":              byte offset just past the closing </figure>
          - "imageBytes":       the decoded original base64 image bytes
          - "figcaptionHtml":   the literal <figcaption>…</figcaption>
                                substring, preserved verbatim so the figure
                                number / attribution survive a rewrite

        Figures whose <img> uses an external URL or a non-base64 src are
        skipped (this workflow only rewrites embedded base64 images injected
        by PrepareImages).
        """
        extracted_figures: list[dict] = []

        for figure_match in HtmlImageRewriter._EXTRACTED_FIGURE_PATTERN.finditer(html_content):
            inner_html = figure_match.group(1)

            image_match = HtmlImageRewriter._IMG_TAG_PATTERN.search(inner_html)
            if image_match is None:
                continue

            try:
                decoded_image_bytes = base64.b64decode(
                    image_match.group("base64_payload"),
                    validate = True,
                )
            except (ValueError, base64.binascii.Error) as decode_error:
                print(
                    f"[HtmlImageRewriter] Skipping figure with malformed base64 payload: "
                    f"{decode_error}"
                )
                continue

            figcaption_match = HtmlImageRewriter._FIGCAPTION_PATTERN.search(inner_html)
            figcaption_html = figcaption_match.group(0) if figcaption_match is not None else ""

            extracted_figures.append({
                "start": figure_match.start(),
                "end": figure_match.end(),
                "imageBytes": decoded_image_bytes,
                "figcaptionHtml": figcaption_html,
            })

        return extracted_figures

    @staticmethod
    def apply_replacements(html_content: str, replacements: list[dict]) -> str:
        """
        Apply a list of `{"start", "end", "newHtml"}` substitutions to
        `html_content`. The list is sorted right-to-left so offsets earlier
        in the string stay valid as each later region is replaced first
        (same trick HtmlInjector.inject_figure_after_block relies on when
        figure injections are walked in reverse).
        """
        if not replacements:
            return html_content

        sorted_replacements_right_to_left = sorted(
            replacements,
            key = lambda replacement: replacement["start"],
            reverse = True,
        )

        rewritten_html = html_content
        for replacement in sorted_replacements_right_to_left:
            rewritten_html = (
                rewritten_html[:replacement["start"]]
                + replacement["newHtml"]
                + rewritten_html[replacement["end"]:]
            )

        return rewritten_html

    @staticmethod
    def build_diagram_replacement_html(
        enhanced_image_bytes: bytes,
        figcaption_html: str,
    ) -> str:
        """
        Build a fresh <figure class="extracted-figure"> block carrying the
        regenerated image as a base64 JPEG. Re-uses the layout / styling
        conventions of HtmlInjector.build_figure_html so the rendered
        position inside the surrounding HTML is visually identical.
        """
        base64_encoded_image = base64.b64encode(enhanced_image_bytes).decode("utf-8")

        image_style = (
            f'width: 100%;'
            f' max-width: {HtmlImageRewriter.DEFAULT_DIAGRAM_MAX_WIDTH_PIXELS}px;'
            f' height: auto;'
            f' display: block;'
            f' margin: 0 auto;'
        )

        return (
            f'<figure class="extracted-figure" style="margin: 1em 0;">'
            f'<img src="data:image/jpeg;base64,{base64_encoded_image}"'
            f' style="{image_style}" alt="Enhanced figure">'
            f'{figcaption_html}'
            f'</figure>'
        )

    @staticmethod
    def build_text_data_replacement_html(markdown_text: str) -> str:
        """
        Render `markdown_text` to HTML via the Python `markdown` library so
        tables, fenced code blocks, lists, headings and other elements emit
        as their proper HTML counterparts. The whole rendered block is
        wrapped in a <div class="enhanced-extracted-text"> container so the
        surrounding <figure> styling (italic captions, narrow widths) does
        not bleed in.
        """
        if not isinstance(markdown_text, str):
            raise RuntimeError(
                "HtmlImageRewriter: TEXT_DATA replacement requires a string markdown payload."
            )

        rendered_html = markdown_renderer.markdown(
            markdown_text,
            extensions = list(HtmlImageRewriter.MARKDOWN_EXTENSIONS),
        )

        return f'<div class="enhanced-extracted-text">{rendered_html}</div>'
