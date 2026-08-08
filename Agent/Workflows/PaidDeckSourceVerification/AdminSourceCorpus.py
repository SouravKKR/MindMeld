import math
import re

from Globals.Classes.Generic.Persistence import Persistence
from Workflows.PrepareForSimilaritySearch.EmbedPages import _chunk_text, _clean_text


class AdminSourceCorpus:
    """
    The text an administrator's declared verification sources contribute, and
    the passages of it that are relevant to one piece of generated content.

    WHY RETRIEVAL RATHER THAN PASTING THE WHOLE THING. The refinement flow
    attaches one reviewer-chosen document to one passage and can afford to paste
    60 000 characters of it into the prompt. This pass checks a whole deck —
    hundreds of items — against what may be a textbook. Pasting the corpus per
    item would multiply a large document by a large item count, and the model
    would be reading mostly irrelevant text on every call, which is both
    expensive and a good way to get vague answers.

    WHY LEXICAL SCORING RATHER THAN EMBEDDINGS. The repository already embeds
    documents for similarity search, and reusing that was the obvious route. It
    was rejected on purpose: the embedding model is a CPU transformer loaded
    in-process, and the production box already runs out of memory when two
    workers load transformer models at once. Adding a third loader on the
    verification path would turn an occasional OOM into a reliable one, and a
    verification stage that kills the box is worse than no verification stage.

    The lexical scorer costs nothing, cannot OOM, and is deterministic — the same
    corpus and the same item always select the same passages, which matters for a
    pass whose output ends up in an audit trail. It is weaker than an embedding
    at matching paraphrase, and that weakness is the acceptable one here: this
    pass is looking for a passage that states the SAME FACT (a constant, a
    formula, a definition), and those share vocabulary with the content that
    states them.

    The chunk shape is deliberately the same as the similarity-search path's, by
    importing its helpers rather than re-deriving them, so a document chunked for
    one purpose in this repository looks like a document chunked for the other.
    """

    # How much of one source is read. A source larger than this is used up to the
    # budget and the shortfall is REPORTED, never silently dropped — a partial
    # check presented as a whole one is the failure this pass exists to catch.
    CHARACTER_BUDGET_PER_SOURCE = 400_000

    # Passages handed to the model for one item. Enough for the fact to be
    # present with its surrounding context, few enough that the model is not
    # asked to hold a chapter in view to check one sentence.
    PASSAGES_PER_ITEM = 6

    # A passage scoring below this shares almost nothing with the item, and
    # including it invites the model to compare unrelated text and report a
    # disagreement that is really an absence.
    MINIMUM_PASSAGE_SCORE = 0.02

    # Words that appear in every passage carry no signal and would let a long
    # passage outscore a relevant one purely by being long.
    STOP_WORDS = frozenset({
        "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can", "for", "from", "has",
        "have", "if", "in", "into", "is", "it", "its", "not", "of", "on", "or", "that", "the", "their",
        "then", "there", "these", "this", "to", "was", "were", "when", "which", "will", "with",
    })

    def __init__(self):
        self.__passages = []
        self.__source_names_by_passage_index = []
        self.__source_ids_by_passage_index = []
        self.__inverse_document_frequency = {}
        self.__passage_token_counts = []
        self.__loaded_source_names = []
        self.__problems = []

    def get_loaded_source_names(self) -> list:
        return list(self.__loaded_source_names)

    def get_problems(self) -> list:
        """
        Sources that could not be read, and sources read only in part.

        Surfaced by the workflow as advisory flags rather than logged and
        forgotten: "checked against three sources" is a false statement when one
        of them failed to open.
        """
        return list(self.__problems)

    def is_empty(self) -> bool:
        return len(self.__passages) == 0

    async def load(self, verification_sources: list) -> None:
        """
        Reads every attached source and indexes its passages.

        A source that cannot be read does not stop the pass — the other sources
        are still worth checking against — but it is recorded as a problem.

        @param verification_sources Stored paidDeckVerificationSources rows.
        """
        for verification_source in verification_sources:
            source_name = verification_source.get("name") or "(unnamed source)"
            content_hash = verification_source.get("contentHash") or ""

            if not content_hash:
                # A URL-only source contributes no text of ours. It reaches the
                # model as provider grounding instead, so it is not a problem —
                # it is simply not part of this corpus.
                continue

            source_text = await self.__read_source_text(verification_source, source_name)

            if source_text is None:
                continue

            if len(source_text) > AdminSourceCorpus.CHARACTER_BUDGET_PER_SOURCE:
                omitted_count = len(source_text) - AdminSourceCorpus.CHARACTER_BUDGET_PER_SOURCE
                source_text = source_text[: AdminSourceCorpus.CHARACTER_BUDGET_PER_SOURCE]
                self.__problems.append(
                    f"\"{source_name}\" is larger than the per-source reading budget; "
                    f"{omitted_count} character(s) of it were not checked against."
                )

            self.__index_source(source_text, source_name, verification_source.get("id") or "")

        self.__build_inverse_document_frequency()

    async def __read_source_text(self, verification_source: dict, source_name: str):
        # The path is taken from the stored row, which Dock resolved from the
        # information source when the administrator attached it. It is never
        # rebuilt here from parts, and never taken from anything a client sent.
        storage_path = verification_source.get("storagePath") or ""

        if not storage_path:
            self.__problems.append(
                f"\"{source_name}\" has no recorded storage path, so nothing was checked against it."
            )
            return None

        try:
            source_bytes = await Persistence.read(storage_path)
        except Exception as read_error:
            self.__problems.append(f"\"{source_name}\" could not be read ({read_error}), so nothing was checked against it.")
            return None

        if not source_bytes:
            self.__problems.append(f"\"{source_name}\" is empty, so nothing was checked against it.")
            return None

        mime_type = (verification_source.get("mimeType") or "").lower()

        if "pdf" in mime_type or source_bytes[:4] == b"%PDF":
            try:
                # Imported lazily: PDFium is a native binding with a real
                # cold-load cost, and a corpus of plain-text sources should not
                # pay it. Same reason EmbedPages defers the same import.
                from Workflows.MapTopicsWithContent.ExtractText import extract_text
                return extract_text(source_bytes)
            except Exception as extraction_error:
                self.__problems.append(
                    f"\"{source_name}\" is a PDF whose text could not be extracted ({extraction_error}), "
                    "so nothing was checked against it."
                )
                return None

        return source_bytes.decode("utf-8", errors = "replace")

    def __index_source(self, source_text: str, source_name: str, source_id: str) -> None:
        cleaned_text = _clean_text(source_text)

        for passage in _chunk_text(cleaned_text):
            if not passage.strip():
                continue

            self.__passages.append(passage)
            self.__source_names_by_passage_index.append(source_name)
            self.__source_ids_by_passage_index.append(source_id)
            self.__passage_token_counts.append(self.__count_tokens(passage))

        if source_name not in self.__loaded_source_names:
            self.__loaded_source_names.append(source_name)

    def __build_inverse_document_frequency(self) -> None:
        """
        How rare each word is across the corpus.

        Without it, an item about "the equation of state" matches every passage
        containing "the" and "of" — which is all of them — and the selection
        becomes arbitrary. Rare words are what actually identify a topic.
        """
        passage_count = len(self.__passages)

        if passage_count == 0:
            return

        containing_passage_counts = {}

        for token_counts in self.__passage_token_counts:
            for token in token_counts:
                containing_passage_counts[token] = containing_passage_counts.get(token, 0) + 1

        self.__inverse_document_frequency = {
            token: math.log(1 + (passage_count / count))
            for token, count in containing_passage_counts.items()
        }

    def select_passages(self, item_text: str, topic_chain: list) -> list:
        """
        The passages most likely to say something about this item.

        The topic chain is weighted alongside the item's own text because an
        item often states a fact without naming the topic it belongs to, and the
        chain is exactly the missing context.

        @return list of {"text": str, "sourceName": str, "sourceId": str}
        """
        if not self.__passages:
            return []

        query_tokens = self.__count_tokens(item_text)

        for topic_segment in (topic_chain or []):
            for token, count in self.__count_tokens(topic_segment).items():
                # Weighted up: the chain is short, so without this its terms are
                # drowned out by the item's much longer body text.
                query_tokens[token] = query_tokens.get(token, 0) + (count * 3)

        if not query_tokens:
            return []

        scored_passages = []

        for passage_index, passage_token_counts in enumerate(self.__passage_token_counts):
            score = self.__score_passage(query_tokens, passage_token_counts)

            if score >= AdminSourceCorpus.MINIMUM_PASSAGE_SCORE:
                scored_passages.append((score, passage_index))

        # Sorted by score, then by passage index, so equal scores resolve the
        # same way on every run. An audit artefact that changes between two runs
        # over identical inputs invites the question of what else changed.
        scored_passages.sort(key = lambda scored: (-scored[0], scored[1]))

        return [
            {
                "text": self.__passages[passage_index],
                "sourceName": self.__source_names_by_passage_index[passage_index],
                "sourceId": self.__source_ids_by_passage_index[passage_index],
            }
            for _, passage_index in scored_passages[: AdminSourceCorpus.PASSAGES_PER_ITEM]
        ]

    def __score_passage(self, query_tokens: dict, passage_token_counts: dict) -> float:
        """
        Cosine similarity over inverse-document-frequency-weighted term counts.

        Normalised by both vectors' magnitudes so a long passage does not
        outscore a precise one simply by containing more words.
        """
        shared_weight = 0.0

        for token, query_count in query_tokens.items():
            passage_count = passage_token_counts.get(token)

            if passage_count is None:
                continue

            token_weight = self.__inverse_document_frequency.get(token, 0.0)
            shared_weight += query_count * passage_count * token_weight * token_weight

        if shared_weight <= 0.0:
            return 0.0

        query_magnitude = self.__magnitude(query_tokens)
        passage_magnitude = self.__magnitude(passage_token_counts)

        if query_magnitude == 0.0 or passage_magnitude == 0.0:
            return 0.0

        return shared_weight / (query_magnitude * passage_magnitude)

    def __magnitude(self, token_counts: dict) -> float:
        total = 0.0

        for token, count in token_counts.items():
            token_weight = self.__inverse_document_frequency.get(token, 0.0)
            total += (count * token_weight) ** 2

        return math.sqrt(total)

    def __count_tokens(self, text: str) -> dict:
        token_counts = {}

        for token in re.findall(r"[a-z0-9]+", (text or "").lower()):
            # Single characters are almost always noise here — variable names, a
            # stray letter from a broken ligature — with one exception this pass
            # cares about a great deal: digits, which is what a wrong constant
            # looks like.
            if len(token) < 2 and not token.isdigit():
                continue

            if token in AdminSourceCorpus.STOP_WORDS:
                continue

            token_counts[token] = token_counts.get(token, 0) + 1

        return token_counts
