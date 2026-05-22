def join_path(separator: str, *parts: str) -> str:
    normalized = [part.replace("\\", separator).strip(separator) for part in parts if part]
    return separator.join(normalized)