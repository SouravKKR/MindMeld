import hashlib
import os


def redact_source_name(source_name: str) -> str:
    """
    Converts an uploaded document's filename into a stable pseudonym for logging.

    Uploaded filenames routinely carry third-party institute and publisher names
    ("Allen Physics Module 3.pdf"). Every Agent print is teed into Dock's log
    pipeline, persisted to MongoDB and the on-disk write-ahead log, and is
    downloadable through the admin log export — so logging the raw filename
    creates a durable, exportable record attributing named third-party material
    to the platform. The operational value of the literal name is low; the
    pseudonym below preserves everything that value actually rests on.

    The pseudonym is deterministic (same name always yields the same token), so
    log lines about one document still correlate across workflows and runs. The
    file extension is kept because it is diagnostically useful and carries no
    brand information.

        "Allen Physics Module 3.pdf"  ->  "src-4f2a9c71.pdf"

    Returns a placeholder for empty input rather than raising — a logging helper
    must never be the thing that fails a task.
    """
    if not source_name:
        return "src-unnamed"

    stem, extension = os.path.splitext(str(source_name))
    digest = hashlib.sha256(stem.strip().lower().encode("utf-8")).hexdigest()[:8]

    # The extension is lowercased alongside the stem so the same document
    # logged as ".PDF" and ".pdf" yields one token — the pseudonym is only
    # useful for correlation if casing cannot split it into two.
    return f"src-{digest}{extension.lower()}"
