"""
Minimal logging shim for Agent workers.

Dock owns the aggregated log file. Each worker just writes to stdout; Dock captures
stdout line-by-line, timestamps it, and routes it to console + file.

If `--debug` is NOT in argv, `print` is replaced with a no-op so production runs
have zero logging overhead. If it IS present, `print` is patched only to set
`flush=True` by default so lines reach Dock immediately instead of sitting in
the pipe buffer.
"""

import builtins
import io
import sys


_enabled = "--debug" in sys.argv
_initialized = False


def initialize():
    global _initialized
    if _initialized:
        return
    _initialized = True

    if not _enabled:
        builtins.print = lambda *args, **kwargs: None
        return

    # Ensure stdout/stderr use UTF-8 on Windows where the default pipe encoding is charmap.
    if hasattr(sys.stdout, "buffer"):
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "buffer"):
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

    _original_print = builtins.print

    def _flushing_print(*args, **kwargs):
        kwargs.setdefault("flush", True)
        _original_print(*args, **kwargs)

    builtins.print = _flushing_print


def is_enabled() -> bool:
    return _enabled
