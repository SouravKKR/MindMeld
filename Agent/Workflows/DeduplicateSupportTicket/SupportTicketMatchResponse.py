from typing import Optional

from pydantic import BaseModel, Field


class SupportTicketMatchResponse(BaseModel):
    """
    The single structured answer the deduplication step asks the model for.

    One call decides all four things — whether the new report duplicates an
    existing ticket, whether it adds anything new, what the merged description
    should say, and what the ticket should be called — because they are one
    judgement, not four, and splitting them would multiply cost and latency for a
    task that runs on every submission.
    """

    matched_ticket_id: Optional[str] = Field(
        default = None,
        description = (
            "The id of the candidate ticket the new report is a duplicate of, copied EXACTLY "
            "from one of the supplied candidate ids. Return null unless the new report describes "
            "the SAME underlying defect as that ticket — not merely the same feature, screen, or "
            "general area. Two reports about different problems in the same part of the product "
            "are NOT duplicates. When in doubt, return null: wrongly merging two distinct problems "
            "buries one of them and sends the wrong resolution to the wrong person, whereas a "
            "wrongly separate ticket is only untidy."
        )
    )

    has_new_aspect: bool = Field(
        default = False,
        description = (
            "True only when the new report contains concrete detail the matched ticket does not "
            "already cover — a different reproduction step, an additional symptom, another affected "
            "device or screen. False when it simply restates what the ticket already says. Ignored "
            "when matched_ticket_id is null."
        )
    )

    new_aspect_text: str = Field(
        default = "",
        description = (
            "The genuinely new detail from the report, written as one or two plain sentences. "
            "Empty string when has_new_aspect is false. Do not repeat anything already present in "
            "the matched ticket's description. Keep it under 1000 characters."
        )
    )

    updated_description: str = Field(
        default = "",
        description = (
            "The canonical description the ticket should carry after this report is folded in: the "
            "matched ticket's existing description plus the new detail, rewritten as one coherent "
            "account of the problem rather than a list of separate reports. When matched_ticket_id "
            "is null, this is instead a clean description of the NEW ticket written from the report "
            "alone. Written impersonally about the problem, not about who reported it. Keep it "
            "under 8000 characters."
        )
    )

    suggested_title: str = Field(
        default = "",
        description = (
            "A short, specific title for the ticket — what is broken and where, e.g. "
            "'Flashcard generation stalls on scanned PDFs'. Avoid vague titles like 'Bug' or "
            "'Issue with the app'. Plain text, no markdown or quotes. Keep it under 200 characters."
        )
    )
