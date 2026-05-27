class MuPdfBootstrap:
    """
    Silences MuPDF's C-level parser warnings (e.g. "syntax error: unknown
    keyword: '2.38E'" from PDFs that embed scientific-notation literals in
    their content streams). These warnings are non-fatal — text extraction
    still succeeds — but MuPDF writes them to C-level stderr, where the
    agent worker's subprocess pipe catches them and prefixes them as agent
    log noise.

    Each fitz-using workflow calls silence_parser_warnings() at the start of
    its run(); the call is idempotent (the silenced flag is process-wide
    MuPDF state) so multiple calls in one process are cheap. The fitz
    import is deferred to here so importing MuPdfBootstrap from Main.py
    or other entry-point code doesn't drag in PyMuPDF's ~0.5s native
    binding load for tasks that never touch a PDF.
    """

    __b_silenced = False

    @staticmethod
    def silence_parser_warnings():
        if MuPdfBootstrap.__b_silenced:
            return
        import fitz
        fitz.TOOLS.mupdf_display_errors(False)
        MuPdfBootstrap.__b_silenced = True
