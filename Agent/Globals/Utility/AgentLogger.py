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
import os
import sys


_enabled = "--debug" in sys.argv
_initialized = False


class _BrokenPipeSafeStream:
    """
    Wraps a text stream so a write/flush to a closed or broken pipe is swallowed
    instead of raising BrokenPipeError up into a running workflow. Third-party
    libraries (huggingface_hub / tqdm download bars) write progress straight to
    sys.stderr, bypassing the no-op `print` shim; on a non-interactive worker
    pipe that surfaced as a raw `[Errno 32] Broken pipe` that crashed the task
    (e.g. MapTopicsWithContent mid model-load). Losing a log line is acceptable;
    failing the generation because a log write broke is not. All other attribute
    access (isatty, fileno, buffer, encoding, …) is delegated unchanged so the
    wrapped stream behaves identically to libraries that introspect it.
    """

    def __init__(self, wrapped_stream):
        self.__wrapped_stream = wrapped_stream

    def write(self, text):
        try:
            return self.__wrapped_stream.write(text)
        except (BrokenPipeError, OSError, ValueError):
            return 0

    def flush(self):
        try:
            return self.__wrapped_stream.flush()
        except (BrokenPipeError, OSError, ValueError):
            return None

    def __getattr__(self, attribute_name):
        return getattr(self.__wrapped_stream, attribute_name)


def _configure_third_party_quiet():
    """
    Disable library progress bars that write directly to sys.stderr — chiefly
    huggingface_hub model-download bars during SentenceTransformer / CrossEncoder
    loads. setdefault so an explicit operator override still wins. Must run before
    huggingface_hub / transformers are first imported (they read these at import),
    which holds because both Agent entrypoints call initialize() before any
    workflow lazily imports sentence_transformers.
    """
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    os.environ.setdefault("TRANSFORMERS_NO_ADVISORY_WARNINGS", "1")
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")


def initialize():
    global _initialized
    if _initialized:
        return
    _initialized = True

    _configure_third_party_quiet()

    if not _enabled:
        builtins.print = lambda *args, **kwargs: None
        # Even with print shimmed out, libraries write progress straight to
        # sys.stderr — guard those writes so a broken worker pipe can't kill a
        # task. sys.__stdout__/__stderr__ stay untouched for AgentWorker.__log.
        sys.stdout = _BrokenPipeSafeStream(sys.stdout)
        sys.stderr = _BrokenPipeSafeStream(sys.stderr)
        return

    # Ensure stdout/stderr use UTF-8 on Windows where the default pipe encoding is charmap.
    if hasattr(sys.stdout, "buffer"):
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "buffer"):
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

    # Same broken-pipe guard as production — debug worker output is still piped to
    # Dock, so a dropped reader must not crash the task.
    sys.stdout = _BrokenPipeSafeStream(sys.stdout)
    sys.stderr = _BrokenPipeSafeStream(sys.stderr)

    _original_print = builtins.print

    def _flushing_print(*args, **kwargs):
        kwargs.setdefault("flush", True)
        _original_print(*args, **kwargs)

    builtins.print = _flushing_print


def is_enabled() -> bool:
    return _enabled
