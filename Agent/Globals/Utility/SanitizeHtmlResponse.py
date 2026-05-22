import json
import re


def sanitize_html_response(data: str) -> str:
    """
    Sanitizes a string that should be raw HTML but may have been incorrectly
    wrapped by an LLM in a JSON object (e.g. {"html": "...", "htmlContent": "..."}).
    Also strips markdown code fences (```html ... ```) if present.

    Returns the extracted/cleaned HTML string on success, or the original
    stripped data if no known wrapper pattern is detected.
    """

    if not data:
        return ""

    cleaned = data.strip()

    # ── 1. Strip markdown code fences (```html ... ``` or ``` ... ```) ────────
    code_fence_match = re.match(r"^```(?:html)?\s*\n?(.*?)\n?```$", cleaned, re.DOTALL)

    if code_fence_match:
        cleaned = code_fence_match.group(1).strip()

    # ── 2. Check if the entire response is a JSON object wrapping the HTML ────
    if cleaned.startswith("{"):
        try:
            parsed = json.loads(cleaned)

            if isinstance(parsed, dict):
                # Common keys Gemini uses when wrapping HTML
                candidate_keys = [
                    "html",
                    "htmlContent",
                    "html_content",
                    "content",
                    "text",
                    "output",
                    "response",
                    "result",
                ]

                for key in candidate_keys:
                    if key in parsed and isinstance(parsed[key], str):
                        return parsed[key].strip()

                # If none of the above matched, try the first string value in the dict
                for value in parsed.values():
                    if isinstance(value, str) and len(value) > 20:
                        return value.strip()

        except (json.JSONDecodeError, ValueError):
            pass

    # ── 3. Check if the response is a JSON array wrapping a single HTML string
    if cleaned.startswith("["):
        try:
            parsed = json.loads(cleaned)

            if isinstance(parsed, list):
                for item in parsed:
                    if isinstance(item, str) and "<" in item:
                        return item.strip()

        except (json.JSONDecodeError, ValueError):
            pass

    return cleaned
