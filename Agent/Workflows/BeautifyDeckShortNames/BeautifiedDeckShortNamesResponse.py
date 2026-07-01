from typing import List

from pydantic import BaseModel, Field


class BeautifiedDeckShortNameItem(BaseModel):

    index: int = Field(
        description = (
            "The 1-based index of the input deck path this short name corresponds to. "
            "Must match the number that prefixed the input line."
        )
    )

    short_name: str = Field(
        description = (
            "A concise, human-readable short name for the deck's leaf topic. Keep it short "
            "enough to fit the character limit stated in the request: omit less-important "
            "words and/or use widely-recognised abbreviations as needed, but always keep "
            "whole words or standard abbreviations — never cut a word off mid-way or return "
            "a fragment. Title Case. Plain text only — no markdown, no quotes, no surrounding "
            "punctuation."
        )
    )


class BeautifiedDeckShortNamesResponse(BaseModel):

    items: List[BeautifiedDeckShortNameItem] = Field(
        description = (
            "Exactly one entry per input deck path, in the same numbered order. "
            "Do not skip, merge, or reorder entries."
        )
    )
