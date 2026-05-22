import json
import re

def strip_json_markdown(data: str) -> str:
    if not data:
        return "{}"

    # 1. Clean whitespace
    cleaned = data.strip()
    
    if cleaned.startswith("```"):

        parts = cleaned.split("```")
        if len(parts) >= 2:
            cleaned = parts[1]
            if cleaned.startswith("json"):
                cleaned = cleaned[4:]
            elif cleaned.startswith("python"):
                cleaned = cleaned[6:]
    
    cleaned = cleaned.strip()

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        return None

