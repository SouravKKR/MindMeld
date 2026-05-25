import re
import base64
from html import escape as html_escape
from urllib.parse import urlparse

from Globals.Classes.ImageProcessing.ImageCompressor import ImageCompressor


# Styling contract for any HTML this module emits:
#   - Allowed inline styles: STRUCTURAL only -- margin, padding, width,
#     max-width, height, display, flex/grid, font-size, word-wrap.
#   - Forbidden inline styles: APPEARANCE -- colour, background, border-colour,
#     border-radius, opacity, box-shadow, text-transform, letter-spacing,
#     font-weight, font-family, text-decoration.
#   Appearance lives in Main/CommonStyles/GeneratedContent.css and is driven
#   by --content-* variables in Main/CommonStyles/Theme.css so the user can
#   re-theme generated content without a backend redeploy.
class HtmlInjector:

    _BLOCK_ELEMENT_PATTERN = re.compile(
        r'(<(?:p|h2|h3|h4|blockquote)[^>]*>)(.*?)(</(?:p|h2|h3|h4|blockquote)>)',
        re.DOTALL | re.IGNORECASE
    )

    _SENTENCE_SPLIT_PATTERN = re.compile(r'(?<=[.!?])\s+')

    _HTML_TAG_PATTERN = re.compile(r'<[^>]+>')

    _MIN_SENTENCE_CHARACTER_LENGTH = 10

    @staticmethod
    def extract_block_elements(html_content: str) -> list[dict]:
        """
        Finds all top-level prose block elements in HTML and splits their text into sentences.
        Returns list of {start, end, text, sentences} dicts.
        start/end are character positions of the full element (opening tag to closing tag inclusive).
        """
        extracted_blocks = []

        for regex_match in HtmlInjector._BLOCK_ELEMENT_PATTERN.finditer(html_content):
            inner_html = regex_match.group(2)
            plain_text = HtmlInjector._HTML_TAG_PATTERN.sub("", inner_html).strip()

            if not plain_text:
                continue

            raw_sentences = HtmlInjector._SENTENCE_SPLIT_PATTERN.split(plain_text.strip())
            meaningful_sentences = [
                sentence.strip()
                for sentence in raw_sentences
                if len(sentence.strip()) >= HtmlInjector._MIN_SENTENCE_CHARACTER_LENGTH
            ]

            if not meaningful_sentences:
                continue

            extracted_blocks.append({
                "start": regex_match.start(),
                "end": regex_match.end(),
                "text": plain_text,
                "sentences": meaningful_sentences,
            })

        return extracted_blocks

    # Images are extracted from rendered PDF pages at this DPI (see
    # ImageExtractor._RENDER_DPI). To convert a bounding-box width in
    # rendering pixels back to the size the image actually occupied in the
    # source document, divide by RENDER_DPI / CSS_REFERENCE_DPI.
    _IMAGE_EXTRACTION_RENDER_DPI = 200
    _CSS_REFERENCE_DPI = 96
    _FALLBACK_MAX_WIDTH_PIXELS = 500
    _ABSOLUTE_MAX_WIDTH_PIXELS = 720

    @staticmethod
    def _compute_display_max_width_pixels(bounding_box) -> int:
        """
        Converts a [x0, y0, x1, y1] bounding box (in PDF-page rendering
        pixels at _IMAGE_EXTRACTION_RENDER_DPI) into a sensible CSS-pixel
        max-width so injected images render close to their original
        in-document size instead of stretching to fill the container.

        Falls back to _FALLBACK_MAX_WIDTH_PIXELS for web-sourced figures
        (no bounding box) or malformed inputs. Caps at
        _ABSOLUTE_MAX_WIDTH_PIXELS so a full-page extraction can't blow
        out the layout.
        """
        if not bounding_box or len(bounding_box) < 4:
            return HtmlInjector._FALLBACK_MAX_WIDTH_PIXELS

        try:
            pixel_width = float(bounding_box[2]) - float(bounding_box[0])
        except (TypeError, ValueError):
            return HtmlInjector._FALLBACK_MAX_WIDTH_PIXELS

        if pixel_width <= 0:
            return HtmlInjector._FALLBACK_MAX_WIDTH_PIXELS

        css_pixel_width = int(round(
            pixel_width * (HtmlInjector._CSS_REFERENCE_DPI / HtmlInjector._IMAGE_EXTRACTION_RENDER_DPI)
        ))

        return max(120, min(css_pixel_width, HtmlInjector._ABSOLUTE_MAX_WIDTH_PIXELS))

    @staticmethod
    def build_figure_html(
        image_bytes:    bytes,
        caption_text:   str,
        figure_number:  int,
        source_url:     str = None,
        source_page_url: str = None,
        bounding_box:   list = None,
    ) -> str:
        """
        Builds the self-contained HTML snippet for an extracted figure.
        The image is embedded as a base64 data URL so no external serving is required.
        The figcaption shows the caption extracted from the source PDF when available,
        or falls back to a plain "Fig. N" label.
        When source_url and/or source_page_url is provided (web-sourced images),
        an attribution line is appended to the figcaption for fair use.

        bounding_box, when provided, is the [x0, y0, x1, y1] rectangle in the
        rendered-PDF pixel space the image was cropped from; it lets the
        injected `<img>` carry a max-width that matches its original
        in-document size rather than stretching to the container width.
        """
        # Compress before base64-embedding. Raw PDF-extracted figures are
        # routinely 1-3 MB; without this the encoded HTML balloons past
        # 20 MB per deck and breaks sync. Originals remain untouched in
        # GCS / the figures collection -- this only affects the inline
        # copy that ships to the user.
        compressed_image_bytes = ImageCompressor.compress_for_embedding(image_bytes)
        base64_encoded_image = base64.b64encode(compressed_image_bytes).decode("utf-8")

        display_caption = caption_text.strip() if caption_text and caption_text.strip() else f"Fig. {figure_number}"

        attribution_html = ""
        if source_url or source_page_url:
            host_display_url = source_page_url or source_url
            host_name        = (urlparse(host_display_url).hostname or "web").lower()
            link_target      = source_page_url or source_url
            attribution_html = (
                f'<div class="figure-attribution" style="font-size: 0.75em;'
                f' margin-top: 0.25em;">'
                f'Source: <a href="{html_escape(link_target, quote=True)}" target="_blank" rel="noopener noreferrer">'
                f'{html_escape(host_name)}</a>'
                f'</div>'
            )

        image_max_width_pixels = HtmlInjector._compute_display_max_width_pixels(bounding_box)

        # width: 100% + max-width: Xpx means the image renders at min(container, Xpx)
        # so it shrinks on narrow screens but never blows up past its source size.
        # height: auto preserves aspect ratio under both constraints.
        image_style = (
            f'width: 100%;'
            f' max-width: {image_max_width_pixels}px;'
            f' height: auto;'
            f' display: block;'
            f' margin: 0 auto;'
        )

        return (
            f'<figure class="extracted-figure" style="margin: 1em 0;">'
            f'<img src="data:image/jpeg;base64,{base64_encoded_image}"'
            f' style="{image_style}" alt="Figure {figure_number}">'
            f'<figcaption style="font-size: 0.85em;'
            f' margin-top: 0.4em; word-wrap: break-word;">'
            f'{display_caption}'
            f'{attribution_html}'
            f'</figcaption>'
            f'</figure>'
        )

    @staticmethod
    def inject_figure_after_block(html_content: str, block_end_position: int, figure_html: str) -> str:
        """
        Inserts figure_html on a new line immediately after the closing tag
        of a block element at block_end_position in html_content.
        """
        return (
            html_content[:block_end_position]
            + "\n"
            + figure_html
            + html_content[block_end_position:]
        )
