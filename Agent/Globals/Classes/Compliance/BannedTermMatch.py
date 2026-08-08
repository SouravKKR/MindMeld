class BannedTermMatch:
    """
    One occurrence of a banned term inside a piece of model-generated text,
    carrying everything the later stages need so neither the verifier nor the
    redactor has to touch the source string again.

    Three pieces, and every index is into the ORIGINAL text (never a lowercased
    or normalised copy — the redactor slices with them):

      - term span      where the matched characters sit. Used to clamp a removal
                       inward when the sentence around it would otherwise cross
                       an HTML tag boundary.
      - sentence span  the sentence the term sits in, the span removed when the
                       verdict says the usage is abusive.
      - context        the +/- 25 word window handed to the verification model,
                       sliced verbatim from the source so punctuation and line
                       breaks survive.
    """

    def __init__(
        self,
        term: str,
        matched_text: str,
        start_index: int,
        end_index: int,
        sentence_start_index: int,
        sentence_end_index: int,
        context_snippet: str,
    ):
        self.__term = term
        self.__matched_text = matched_text
        self.__start_index = start_index
        self.__end_index = end_index
        self.__sentence_start_index = sentence_start_index
        self.__sentence_end_index = sentence_end_index
        self.__context_snippet = context_snippet

    def get_term(self) -> str:
        # The canonical list entry, lowercase. Logged and shown to the verifier.
        return self.__term

    def get_matched_text(self) -> str:
        # The characters as they actually appear, preserving the original case.
        return self.__matched_text

    def get_start_index(self) -> int:
        return self.__start_index

    def get_end_index(self) -> int:
        return self.__end_index

    def get_sentence_span(self) -> tuple[int, int]:
        return (self.__sentence_start_index, self.__sentence_end_index)

    def get_context_snippet(self) -> str:
        return self.__context_snippet
