class PdfTextLine:
    """
    One reconstructed line of text from a PDF page, composed of the typographic
    spans it is built from.

    A line's font size is the largest size among its spans and a line is bold if
    any span is — the same quantities the previous MuPDF-backed code derived
    from max(span["size"]) and the span bold flag across a line's spans.
    """

    def __init__(self, text, spans):
        self.__text = text
        self.__spans = spans

    def get_text(self):
        return self.__text

    def get_spans(self):
        return self.__spans

    def get_maximum_font_size(self):
        return max((span.get_font_size() for span in self.__spans), default = 0.0)

    def is_bold(self):
        return any(span.is_bold() for span in self.__spans)

    def __repr__(self):
        return (
            f"PdfTextLine(text={self.__text[:40]!r}, "
            f"spans={len(self.__spans)}, "
            f"maximum_font_size={self.get_maximum_font_size()})"
        )
