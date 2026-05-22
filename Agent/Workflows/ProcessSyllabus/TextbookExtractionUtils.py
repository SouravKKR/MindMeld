import re
import unicodedata


def clean_text(text: str) -> str:
    text = unicodedata.normalize("NFKC", text)
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)
    return re.sub(r"\s+", " ", text).strip()


def looks_like_heading(text: str) -> bool:
    t = text.strip()
    if len(t) < 3 or len(t) > 160:
        return False
    if re.fullmatch(r"[\d\s\.\-]+", t):
        return False
    if t.endswith((".", ",", ";", "?")) and len(t.split()) > 10:
        return False
    return True