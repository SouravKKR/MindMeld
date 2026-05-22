import re


class ReferenceNormalizer:
    """
    Extracts and normalizes figure reference numbers from text.
    Handles variants like "Figure 3.2", "Fig. 1a", "Diagram 3", etc.
    Normalization strips whitespace, lowercases, and removes trailing punctuation
    so "Fig. 3.2" and "figure3.2" both resolve to "3.2".
    """

    _CAPTION_LEAD_PATTERN = re.compile(
        r'^(?:fig(?:ure)?|diagram|image|plate|illustration)s?\.?\s*'
        r'(\d+(?:\.\d+)*[a-zA-Z]?)',
        re.IGNORECASE,
    )

    _INLINE_REFERENCE_PATTERNS = [
        re.compile(r'(?i)fig(?:ure)?s?\.?\s*(\d+(?:\.\d+)*[a-zA-Z]?)'),
        re.compile(r'(?i)diagrams?\s*(\d+(?:\.\d+)*[a-zA-Z]?)'),
        re.compile(r'(?i)plates?\s*(\d+(?:\.\d+)*[a-zA-Z]?)'),
        re.compile(r'(?i)illustrations?\s*(\d+(?:\.\d+)*[a-zA-Z]?)'),
    ]

    @staticmethod
    def _normalize(raw_number: str) -> str:
        return re.sub(r'\s+', '', raw_number).lower().rstrip('.')

    @classmethod
    def extract_from_text(cls, text: str) -> list[str]:
        """
        Return all normalized figure reference numbers found in text.
        Example: 'as shown in Figure 3.2 and Fig. 1a' → ['3.2', '1a']
        """
        found: set[str] = set()
        for pattern in cls._INLINE_REFERENCE_PATTERNS:
            for match in pattern.finditer(text):
                found.add(cls._normalize(match.group(1)))
        return list(found)

    @classmethod
    def extract_from_caption(cls, caption_text: str) -> str | None:
        """
        Extract the primary figure number from a caption string.
        Example: 'Figure 3.2: ATP Synthesis diagram' → '3.2'
        Returns None if the caption does not start with a recognized figure label.
        """
        match = cls._CAPTION_LEAD_PATTERN.match(caption_text.strip())
        if match:
            return cls._normalize(match.group(1))
        return None
