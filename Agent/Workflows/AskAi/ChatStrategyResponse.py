from typing import List

from pydantic import BaseModel, Field


class ChatStrategyResponse(BaseModel):
    """
    Structured plan for retrieving deck content to answer a chat question.
    Produced by DetermineChatStrategy and consumed (after clamping) by the client
    retriever — it decides HOW MUCH deck content to pull and proposes alternate
    phrasings to widen the similarity search. It does NOT answer the question.
    """

    nearest_cards: int = Field(
        description=(
            "How many of the deck's flashcards to retrieve as context for THIS question. "
            "Use a small number (1-2) for simple or definitional questions, and a larger "
            "number (up to 10) for broad questions that ask to list, compare, or cover many "
            "items. Pick the smallest number that will answer the question well."
        )
    )

    nearest_materials: int = Field(
        description=(
            "How many of the deck's study materials (longer notes) to retrieve. Often 0-3; "
            "use more (up to 8) only for broad questions that need wider context."
        )
    )

    expanded_queries: List[str] = Field(
        description=(
            "Up to 4 short alternate phrasings of the SAME question — synonyms, the "
            "expanded form of any acronyms, or how the topic might be worded on a flashcard "
            "— to widen the similarity search. They MUST NOT change the meaning or add new "
            "sub-questions. Return an empty list if no useful rephrasing exists."
        )
    )
