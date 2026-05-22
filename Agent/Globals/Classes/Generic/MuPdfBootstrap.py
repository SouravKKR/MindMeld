import fitz


class MuPdfBootstrap:
    """
    Silences MuPDF's C-level parser warnings (e.g. "syntax error: unknown
    keyword: '2.38E'" from PDFs that embed scientific-notation literals in
    their content streams). These warnings are non-fatal — text extraction
    still succeeds — but MuPDF writes them to C-level stderr, where the
    agent worker's subprocess pipe catches them and prefixes them as agent
    log noise.

    Calling silence_parser_warnings() once per agent subprocess (from
    Agent/Main.py near startup) silences every subsequent fitz operation in
    the process. The warnings remain queryable via fitz.TOOLS.mupdf_warnings()
    when debugging.
    """

    @staticmethod
    def silence_parser_warnings():
        fitz.TOOLS.mupdf_display_errors(False)
