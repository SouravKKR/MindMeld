def headings_to_outline(headings: list[dict]) -> str:
    """
    Converts a flat headings list into an indented plain-text outline.
    Indentation encodes hierarchy depth using spaces only — no prefix characters.

    Example output:
        Storage Fundamentals
          Disk Drive Components
            Performance Metrics
          Direct-Attached Storage
    """
    lines = []
    for h in headings:
        indent = "  " * (h["level"] - 1)
        lines.append(f"{indent}{h['title']}")
    return "\n".join(lines)