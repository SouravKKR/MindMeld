import re
from Workflows.ProcessSyllabus.TextbookExtractionUtils import clean_text


_NOISE_RE = re.compile(
    r"^(\d+$"
    r"|figure|fig\.|table|appendix|exercise|example|problem\s*[\d\.]+"
    r"|references?|bibliography|index|glossary|preface|acknowledgements?"
    r"|continued|cont'd|\.\.\.)",
    re.IGNORECASE,
)

_SMALL_WORDS = {
    "a", "an", "the", "and", "but", "or", "for", "nor",
    "on", "at", "to", "by", "in", "of", "up", "as",
}


def clean_headings(headings: list[dict]) -> list[dict]:
    """
    Remove noise entries, apply title-case (preserving ALL-CAPS acronyms),
    and deduplicate while preserving order.
    """
    seen: set[str] = set()
    out = []
    for h in headings:
        title = clean_text(h["title"])
        if _NOISE_RE.match(title.strip()):
            continue
        title = _title_case(title)
        key = title.lower()
        if key not in seen:
            seen.add(key)
            out.append({**h, "title": title})
    return out


def _title_case(text: str) -> str:
    words = text.split()
    result = []
    for i, word in enumerate(words):
        if word.isupper() and len(word) >= 2:
            result.append(word)
        elif i == 0 or word.lower() not in _SMALL_WORDS:
            result.append(word.capitalize())
        else:
            result.append(word.lower())
    return " ".join(result)