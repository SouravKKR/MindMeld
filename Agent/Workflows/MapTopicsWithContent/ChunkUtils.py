import re
import unicodedata


CHUNK_SIZE    = 1500
CHUNK_OVERLAP = 300


def get_chunks(text: str, chunk_size: int = CHUNK_SIZE) -> list[str]:
    if not text:
        return []
    step = max(chunk_size - CHUNK_OVERLAP, 1)
    return [text[i: i + chunk_size] for i in range(0, len(text), step)]


def extract_leaves(node, path: list = []) -> list[dict]:
    leaves = []
    if isinstance(node, list):
        for topic in node:
            leaves.append({"topic": topic, "path": list(path)})
    elif isinstance(node, dict):
        for key, value in node.items():
            leaves.extend(extract_leaves(value, path + [key]))
    return leaves


def is_garbage_chunk(text: str) -> tuple[bool, str]:
    """
    Conservative garbage filter — requires 2 independent signals.
    When in doubt the chunk is KEPT.
    """
    lines     = text.splitlines()
    non_empty = [l for l in lines if l.strip()]
    if len(non_empty) < 5:
        return False, ""

    short_ratio = sum(1 for l in non_empty if len(l.strip()) < 60) / len(non_empty)

    toc_pat   = re.compile(r'\.{3,}\s*\d+\s*$|[\s]{2,}\d{1,4}\s*$')
    toc_ratio = sum(1 for l in non_empty if toc_pat.search(l)) / len(non_empty)

    dbl_pat     = re.compile(r'([a-zA-Z0-9])\1{2,}')
    dbl_density = len(dbl_pat.findall(text)) / max(len(non_empty), 1)

    signal_short = short_ratio  > 0.80
    signal_toc   = toc_ratio    > 0.40
    signal_dbl   = dbl_density  > 2.0

    if sum([signal_short, signal_toc, signal_dbl]) >= 2:
        parts = []
        if signal_short: parts.append(f"short-line {short_ratio:.2f}")
        if signal_toc:   parts.append(f"TOC-pattern {toc_ratio:.2f}")
        if signal_dbl:   parts.append(f"artifacts {dbl_density:.2f}")
        return True, " | ".join(parts)
    return False, ""


def clean_chunk(text: str) -> str:
    """
    Normalise extracted PDF text for LLM consumption.
    """
    text = unicodedata.normalize("NFC", text)
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\xad\u200b\u200c\u200d\ufeff]", "", text)
    text = re.sub(r"-\n\s*", "", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def merge_consecutive_groups(chunk_list: list[dict]) -> list[list[dict]]:
    if not chunk_list:
        return []
    groups, current = [], [chunk_list[0]]
    for item in chunk_list[1:]:
        if item["chunkIndex"] == current[-1]["chunkIndex"] + 1:
            current.append(item)
        else:
            groups.append(current)
            current = [item]
    groups.append(current)
    return groups