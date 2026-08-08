import re


class FigureLocator:
    """
    Finds ONE <figure> element inside a passage so it can be redrawn or removed
    without disturbing anything else.

    Addressing is layered because the content predates the address. Figures
    generated from now on carry a data-visual-id (HtmlInjector stamps the
    perceptual hash the pipeline already computed), and that is an exact,
    position-independent handle. Everything generated before that carries no id
    at all, so those are addressed by ordinal position among the figures in the
    passage — which is correct at the moment the reviewer looked at it and
    becomes wrong the instant anything above it changes.

    The caption is therefore carried as a CONFIRMATION, not as a search key. An
    ordinal that resolves to a figure whose caption does not match what the
    reviewer was looking at means the passage moved underneath them, and this
    class refuses rather than redrawing whichever figure happens to sit at that
    index now. Silently redrawing the wrong diagram is the failure this guard
    exists to prevent, and it is not one a reviewer would reliably catch in a
    before/after comparison of a long lesson.
    """

    __FIGURE_PATTERN = re.compile(r"<figure\b[^>]*>.*?</figure>", re.IGNORECASE | re.DOTALL)
    __VISUAL_ID_PATTERN = re.compile(r'data-visual-id\s*=\s*"([^"]*)"', re.IGNORECASE)
    __CAPTION_PATTERN = re.compile(r"<figcaption\b[^>]*>(.*?)</figcaption>", re.IGNORECASE | re.DOTALL)
    __TAG_PATTERN = re.compile(r"<[^>]+>")

    @staticmethod
    def list_figures(html_content: str) -> list:
        """
        Every figure in the passage, in document order, as
        {ordinal, visualId, captionText, markup, start, end}.
        """
        figures = []

        for ordinal, match in enumerate(FigureLocator.__FIGURE_PATTERN.finditer(html_content or "")):
            markup = match.group(0)
            visual_id_match = FigureLocator.__VISUAL_ID_PATTERN.search(markup)

            figures.append({
                "ordinal": ordinal,
                "visualId": visual_id_match.group(1) if visual_id_match else "",
                "captionText": FigureLocator.extract_caption_text(markup),
                "markup": markup,
                "start": match.start(),
                "end": match.end(),
            })

        return figures

    @staticmethod
    def extract_caption_text(figure_markup: str) -> str:
        """
        The figcaption's visible text, tags stripped and whitespace collapsed.
        Composite plates carry per-panel captions inside the grid as well; only
        the figure's own trailing figcaption is taken, which is the last one.
        """
        caption_matches = FigureLocator.__CAPTION_PATTERN.findall(figure_markup or "")

        if not caption_matches:
            return ""

        stripped = FigureLocator.__TAG_PATTERN.sub(" ", caption_matches[-1])
        return " ".join(stripped.split())

    @staticmethod
    def locate(html_content: str, visual_id: str = "", ordinal: int = None, expected_caption_text: str = ""):
        """
        Resolves an address to one figure.

        Returns (figure, None) on success or (None, reason) on failure, where
        reason is a short phrase suitable for showing to the reviewer.
        """
        figures = FigureLocator.list_figures(html_content)

        if not figures:
            return None, "this passage contains no figures"

        cleaned_visual_id = (visual_id or "").strip()

        if cleaned_visual_id:
            for figure in figures:
                if figure["visualId"] == cleaned_visual_id:
                    return figure, None
            # An id that was present when the reviewer opened the passage and is
            # absent now means the figure was already replaced or removed. That
            # is a stale address, not a missing figure, and falling back to the
            # ordinal here would redraw whatever took its place.
            return None, "the figure this refers to is no longer in the passage — reload and try again"

        if ordinal is None:
            return None, "no figure was identified"

        if ordinal < 0 or ordinal >= len(figures):
            return None, f"there is no figure {ordinal + 1} in this passage (it has {len(figures)})"

        figure = figures[ordinal]

        cleaned_expected_caption = " ".join((expected_caption_text or "").split())

        if cleaned_expected_caption and figure["captionText"] != cleaned_expected_caption:
            return None, "the passage changed since this figure was listed — reload and try again"

        return figure, None

    @staticmethod
    def replace(html_content: str, figure: dict, replacement_markup: str) -> str:
        return html_content[: figure["start"]] + replacement_markup + html_content[figure["end"]:]

    @staticmethod
    def remove(html_content: str, figure: dict) -> str:
        return FigureLocator.replace(html_content, figure, "")
