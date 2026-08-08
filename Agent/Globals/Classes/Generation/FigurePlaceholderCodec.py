import re


class FigurePlaceholderCodec:
    """
    Swaps <figure> elements out of a passage for compact placeholders before it
    is sent to a model, and swaps them back into the model's answer afterwards.

    Two problems, one mechanism.

    SIZE. A generated study material embeds its imagery directly in the content
    string — a PDF-extracted figure is a base64 data URL, routinely hundreds of
    kilobytes each. Sending that to a text model to fix a wrong constant spends
    the entire context window on pixels the model cannot see and must not
    change. Stripped, the same passage is a few kilobytes of prose.

    FIDELITY. The refinement prompt tells the model to reproduce every figure
    byte for byte. That instruction is necessary and not sufficient: a model
    that re-emits a 200 KB base64 blob will occasionally drop a character, and a
    corrupted image is not obviously corrupted in a diff. A figure the model
    never sees is a figure it cannot damage.

    Nesting is not handled, and does not occur: HtmlInjector emits <figure>
    elements as flat siblings spliced after block elements, never one inside
    another. A hand-authored passage with nested figures would have its outer
    figure captured whole, which is still correct — just coarser.
    """

    # data-refine-figure rather than a comment or a sentinel string: it survives
    # a model that reformats whitespace or re-quotes attributes, and an element
    # that leaks through unrestored renders as nothing rather than as visible
    # junk in the middle of a lesson.
    PLACEHOLDER_PATTERN = re.compile(r'<figure\s+data-refine-figure="(\d+)"\s*></figure>')

    __FIGURE_PATTERN = re.compile(r"<figure\b[^>]*>.*?</figure>", re.IGNORECASE | re.DOTALL)

    @staticmethod
    def extract(html_content: str):
        """
        Returns (stripped_html, original_figures) where original_figures is a
        list indexed by placeholder number.
        """
        original_figures = []

        def replace_with_placeholder(match):
            original_figures.append(match.group(0))
            return f'<figure data-refine-figure="{len(original_figures) - 1}"></figure>'

        stripped_html = FigurePlaceholderCodec.__FIGURE_PATTERN.sub(replace_with_placeholder, html_content or "")

        return stripped_html, original_figures

    @staticmethod
    def restore(html_content: str, original_figures: list):
        """
        Puts the original figures back where their placeholders sit.

        Returns (restored_html, dropped_figure_count). A model that deleted a
        placeholder gets its figure appended at the end rather than lost, and
        the count is reported to the caller so the reviewer is told the figure
        moved. Silently discarding it would let an approved-looking revision
        take a diagram out of a lesson.
        """
        restored_indices = set()

        def replace_with_figure(match):
            figure_index = int(match.group(1))
            if figure_index < 0 or figure_index >= len(original_figures):
                return ""
            restored_indices.add(figure_index)
            return original_figures[figure_index]

        restored_html = FigurePlaceholderCodec.PLACEHOLDER_PATTERN.sub(replace_with_figure, html_content or "")

        dropped_figures = [
            original_figure
            for figure_index, original_figure in enumerate(original_figures)
            if figure_index not in restored_indices
        ]

        if dropped_figures:
            restored_html = restored_html + "".join(dropped_figures)

        return restored_html, len(dropped_figures)
