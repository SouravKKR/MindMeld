class PdfTextSpan:
    """
    A run of consecutive characters on one line sharing the same font size and
    weight.

    This mirrors what MuPDF called a "span" inside its get_text("dict") output.
    PDFium reports typography per character rather than per span, so spans are
    reconstructed by grouping consecutive characters with matching typography —
    which is exactly how MuPDF derived them in the first place. Preserving the
    span boundary matters because the syllabus body-text baseline counts words
    per span, and collapsing a mixed-size line to a single size would bias that
    histogram towards the larger size.
    """

    def __init__(self, text, font_size, b_bold):
        self.__text = text
        self.__font_size = font_size
        self.__b_bold = b_bold

    def get_text(self):
        return self.__text

    def get_font_size(self):
        return self.__font_size

    def is_bold(self):
        return self.__b_bold

    def get_word_count(self):
        return len(self.__text.strip().split())

    def __repr__(self):
        return (
            f"PdfTextSpan(text={self.__text[:30]!r}, "
            f"font_size={self.__font_size}, b_bold={self.__b_bold})"
        )
