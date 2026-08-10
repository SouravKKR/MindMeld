import asyncio

from Globals.Classes.Automation.AutomationCaller import AutomationCaller
from Globals.Classes.Automation.AutomationContent import AutomationContent
from Globals.Classes.Automation.AutomationRequest import AutomationRequest
from Globals.Classes.Automation.Pools.ModelPool import ModelPool
from Globals.Classes.Automation.Pools.PromptPool import PromptPool
from Globals.Classes.Generation.AdminSourceCorpus import AdminSourceCorpus
from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes
from Globals.Utility.StripJsonMarkdown import strip_json_markdown

from Workflows.ProcessSyllabus.CoverageSummaryGenerator import CoverageSummaryGenerator


class SourceGroundedChunkGenerator:
    """
    Produces the per-topic content chunks for topics a LICENSED SOURCE covers,
    written from passages of that source rather than from model knowledge.

    This is the sibling of KnowledgeChunkGenerator, not a replacement for it. The
    two split the syllabus between them: a topic the supplied documents speak to
    is written here, and a topic they say nothing about falls back to the other.
    The output contract is identical — same chunk list, same downstream
    consumers — because what differs is the BASIS of the content, not its shape.

    WHY THE TWO ARE SEPARATE CLASSES ON SEPARATE MODEL ENTRIES. They rest on
    different legal arguments, and the whole point is that neither is allowed to
    borrow the other's:

      - KnowledgeChunkGenerator's content is defensible because the pipeline
        demonstrably had no third-party document to work from. It runs on
        PAID_DECK_KNOWLEDGE_CHUNK_MODEL, inside the ROUTE BOUNDARY, and must
        never be handed a corpus.
      - This class's content is defensible because the publisher declared and
        retained a licence for the document behind it. It runs on
        SOURCE_GROUNDED_CHUNK_MODEL, deliberately OUTSIDE that boundary.

    Merging them would produce a deck that can cleanly claim neither. Keeping
    them apart means every topic's basis is a recorded fact — see
    SourceGroundedContent.json, and the "Licensed source content" section of the
    audit report.

    MULTIPLE SOURCES ARE THE NORMAL CASE. One corpus is loaded with every
    admitted content source, so retrieval ranks passages across all of them at
    once and a single topic can legitimately draw on two documents. The
    provenance records every source that contributed to each topic rather than
    naming one, because attributing a topic to the wrong licence would be worse
    than attributing it to none.

    SOURCE_EXPRESSION_RULES is composed as the leading SYSTEM part, exactly as
    KnowledgeChunkGenerator and the flashcard and study-material workers already
    do, so the accuracy constraints on formulae, constants and standard
    definitions are the same ones the rest of the pipeline writes under.
    """

    # Matches KnowledgeChunkGenerator so a source-written topic and a
    # model-written one arrive at the downstream workers in the same shape. The
    # workers size their own output from the chunk set, and a topic that
    # happened to be covered by a document should not produce a longer lesson
    # for that reason alone.
    TARGET_CHUNKS_PER_TOPIC = 6

    # Concurrent topics in flight. The provider's Redis semaphore is the real
    # cap; this bounds how much of the syllabus is queued at once.
    MAXIMUM_CONCURRENT_TOPICS = 6

    # A topic needs at least this many retrieved passages to be worth writing
    # from the source. One weak passage is usually a stray vocabulary match, and
    # writing a whole topic from it would produce content that claims a licensed
    # basis it does not really have — the fallback is the honest outcome there.
    MINIMUM_PASSAGES_FOR_GROUNDING = 2

    def __init__(self, subject_name: str, exam_name: str, coverage_summaries: dict, corpus, action_log = None):
        self.__subject_name = (subject_name or "").strip() or "the subject"
        self.__exam_name = (exam_name or "").strip()
        self.__corpus = corpus
        self.__action_log = action_log
        self.__summaries_by_chain_key = SourceGroundedChunkGenerator.__index_summaries(coverage_summaries)

    @staticmethod
    def __index_summaries(coverage_summaries: dict) -> dict:
        summaries_by_chain_key = {}
        for topic_summary in ((coverage_summaries or {}).get("topics") or []):
            chain_key = CoverageSummaryGenerator.build_chain_key(topic_summary.get("topicChain"))
            summaries_by_chain_key[chain_key] = topic_summary
        return summaries_by_chain_key

    async def generate(self, leaves: list, on_topic_completed = None) -> tuple:
        """
        Writes every topic the corpus covers.

        Returns (chunks_by_leaf_index, provenance_by_leaf_index,
        uncovered_leaf_indices):

          - chunks_by_leaf_index maps a leaf's index to its chunks. A topic that
            was attempted and failed is ABSENT rather than present-and-empty, so
            the caller can tell "produced nothing" from "was never attempted".
          - provenance_by_leaf_index maps a leaf's index to what was retrieved
            and which model wrote from it.
          - uncovered_leaf_indices lists the topics the corpus said nothing
            useful about, in leaf-index order, for the caller to pass to the
            model-knowledge fallback.

        on_topic_completed is invoked after each topic — including an uncovered
        one, whose work here is finished even though the fallback will write it —
        EXCEPT that an uncovered topic's completion is reported by the fallback
        instead. See the caller: each leaf must advance the bar exactly once.
        """
        semaphore = asyncio.Semaphore(SourceGroundedChunkGenerator.MAXIMUM_CONCURRENT_TOPICS)
        chunks_by_leaf_index = {}
        provenance_by_leaf_index = {}
        uncovered_leaf_indices = []

        async def generate_one(leaf_index, leaf):
            async with semaphore:
                chunks, provenance = await self.__generate_for_topic(leaf)

            if provenance is not None:
                provenance_by_leaf_index[leaf_index] = provenance

            if chunks:
                chunks_by_leaf_index[leaf_index] = chunks

                if on_topic_completed is not None:
                    await on_topic_completed()
            else:
                # Either the corpus was silent or the call failed. Both hand the
                # topic to the fallback, which will report its completion.
                uncovered_leaf_indices.append(leaf_index)

        await asyncio.gather(*[
            generate_one(leaf_index, leaf) for leaf_index, leaf in enumerate(leaves)
        ])

        # Sorted because asyncio.gather completes out of order, and the caller
        # maps these back onto the fallback's positional results.
        uncovered_leaf_indices.sort()

        return chunks_by_leaf_index, provenance_by_leaf_index, uncovered_leaf_indices

    async def __generate_for_topic(self, leaf: dict) -> tuple:
        topic_chain = leaf["path"] + [leaf["topic"]]
        chain_key = CoverageSummaryGenerator.build_chain_key(topic_chain)
        topic_summary = self.__summaries_by_chain_key.get(chain_key)
        coverage_specification = SourceGroundedChunkGenerator.__render_specification(topic_summary)

        # The retrieval query is the topic chain PLUS the coverage
        # specification. A bare topic name is a weak query for a lexical scorer;
        # the specification names the formulae, constants and definitions to look
        # for, which is exactly the rare vocabulary that identifies the right
        # pages. This is the single biggest quality lever in this class.
        passages = self.__corpus.select_passages(coverage_specification, topic_chain)

        if len(passages) < SourceGroundedChunkGenerator.MINIMUM_PASSAGES_FOR_GROUNDING:
            return [], {
                "topicChain": topic_chain,
                "path": "MODEL_KNOWLEDGE",
                "modelIdentifier": None,
                "chunkCount": 0,
                "passages": [],
            }

        exam_context = (
            f"Exam: {self.__exam_name}. Pitch depth and problem types at what this exam assesses."
            if self.__exam_name
            else "Exam: none specified. Use a standard treatment of the subject."
        )

        # ONE line reads the model entry, and it is this one. The verification
        # harness asserts there is exactly one, so there is exactly one line to
        # audit when someone asks which model saw a licensed document.
        model_string, provider_class = ModelPool.SOURCE_GROUNDED_CHUNK_MODEL
        caller = AutomationCaller(provider_class())

        request = AutomationRequest(
            model_string,
            [
                AutomationContent(AutomationContentTypes.SYSTEM, PromptPool.SOURCE_EXPRESSION_RULES),
                AutomationContent(
                    AutomationContentTypes.SYSTEM,
                    PromptPool.PAID_DECK_SOURCE_GROUNDED_CHUNK_SYSTEM
                        .replace("{target_chunk_count}", str(SourceGroundedChunkGenerator.TARGET_CHUNKS_PER_TOPIC)),
                ),
                AutomationContent(
                    AutomationContentTypes.TEXT,
                    PromptPool.PAID_DECK_SOURCE_GROUNDED_CHUNK_USER
                        .replace("{subject_name}", self.__subject_name)
                        .replace("{exam_context}", exam_context)
                        .replace("{topic_chain}", " > ".join(topic_chain))
                        .replace("{coverage_specification}", coverage_specification)
                        .replace("{reference_block}", SourceGroundedChunkGenerator.__build_reference_block(passages)),
                ),
            ],
        )

        provenance = {
            "topicChain": topic_chain,
            "path": "SOURCE_GROUNDED",
            "modelIdentifier": model_string,
            "chunkCount": 0,
            "passages": SourceGroundedChunkGenerator.__build_passage_provenance(passages),
        }

        try:
            response = await caller.call(request, validator = None)
        except Exception as call_error:
            print(f"[SourceGroundedChunkGenerator] {' > '.join(topic_chain)} failed: {call_error}")
            await self.__record(topic_chain, model_string, None, f"Generation failed: {call_error}", False)
            # Falls back to model knowledge, so the recorded basis must say so —
            # a topic the fallback ends up writing must never be reported as
            # source-grounded merely because this path was attempted for it.
            provenance["path"] = "MODEL_KNOWLEDGE"
            provenance["passages"] = []
            return [], provenance

        if response is None:
            await self.__record(topic_chain, model_string, None, "No response from provider.", False)
            provenance["path"] = "MODEL_KNOWLEDGE"
            provenance["passages"] = []
            return [], provenance

        parsed = strip_json_markdown(response.get_output(0).get_data())
        chunks = []

        if isinstance(parsed, dict) and isinstance(parsed.get("chunks"), list):
            chunks = [str(chunk).strip() for chunk in parsed["chunks"] if str(chunk).strip()]

        if not chunks:
            await self.__record(topic_chain, model_string, response, "Returned no usable chunks.", False)
            provenance["path"] = "MODEL_KNOWLEDGE"
            provenance["passages"] = []
            return [], provenance

        provenance["chunkCount"] = len(chunks)

        source_names = sorted({passage.get("sourceName") or "" for passage in passages if passage.get("sourceName")})
        await self.__record(
            topic_chain,
            model_string,
            response,
            f"Generated {len(chunks)} chunk(s) from {len(passages)} passage(s) of: {', '.join(source_names) or '(unnamed source)'}.",
            True,
        )

        return chunks, provenance

    @staticmethod
    def __build_reference_block(passages: list) -> str:
        """
        The passages as the model sees them, each labelled with its source and
        page so the citation it is asked to produce can be a real one.
        """
        rendered_passages = []

        for passage_index, passage in enumerate(passages):
            source_name = passage.get("sourceName") or "(unnamed source)"
            page_number = passage.get("pageNumber")

            # Pages are 0-indexed internally, to match the figure extractor.
            # Printed 1-indexed, because that is what is written on the page.
            page_label = f", p. {int(page_number) + 1}" if isinstance(page_number, int) else ""

            rendered_passages.append(
                f"--- PASSAGE {passage_index + 1} [Source: {source_name}{page_label}] ---\n"
                f"{passage.get('text') or ''}"
            )

        return "\n\n".join(rendered_passages)

    @staticmethod
    def __build_passage_provenance(passages: list) -> list:
        """
        What goes into the audit record for one topic: which document, which
        page, where in it, and a short excerpt showing it really does say this.
        """
        return [
            {
                "sourceId": passage.get("sourceId") or "",
                "sourceName": passage.get("sourceName") or "",
                "pageNumber": passage.get("pageNumber"),
                "characterStart": passage.get("characterStart"),
                "characterEnd": passage.get("characterEnd"),
                "score": passage.get("score"),
                "excerpt": AdminSourceCorpus.build_excerpt(passage.get("text")),
            }
            for passage in passages
        ]

    @staticmethod
    def __render_specification(topic_summary) -> str:
        """
        Flattens the coverage summary into the checklist the writer works
        through — and, here, into the retrieval query as well. Sections with
        nothing in them are omitted rather than printed empty, so the model is
        not handed headings it will feel obliged to fill.
        """
        if not isinstance(topic_summary, dict):
            return (
                "No coverage specification is available for this topic. Cover what the supplied passages "
                "establish about it, and say so in the first chunk."
            )

        section_definitions = [
            ("Required derivations", "requiredDerivations"),
            ("Formulae and constants that must appear (exactly as written)", "formulaeAndConstants"),
            ("Definitions that must be stated (exactly)", "definitions"),
            ("Standard problem types", "standardProblemTypes"),
            ("Common misconceptions to correct", "commonMisconceptions"),
        ]

        rendered_sections = []

        overview = str(topic_summary.get("coverageSummary") or "").strip()
        if overview:
            rendered_sections.append(f"Overview: {overview}")

        for section_title, section_key in section_definitions:
            items = topic_summary.get(section_key) or []
            if not items:
                continue
            item_lines = "\n".join(f"  - {item}" for item in items)
            rendered_sections.append(f"{section_title}:\n{item_lines}")

        return "\n\n".join(rendered_sections) if rendered_sections else (
            "The coverage specification for this topic is empty. Cover what the supplied passages establish "
            "about it, and say so in the first chunk."
        )

    async def __record(self, topic_chain, model_string, response, outcome, b_succeeded):
        if self.__action_log is None:
            return
        await self.__action_log.record_llm_call(
            phase_name = "SOURCE_GROUNDED_CHUNK_GENERATION",
            model_identifier = model_string,
            prompt_identifier = "PAID_DECK_SOURCE_GROUNDED_CHUNK_SYSTEM",
            reasoning_effort = None,
            usage_metadata = response.get_usage_metadata() if response is not None else None,
            outcome = f"{' > '.join(topic_chain)}: {outcome}",
            b_succeeded = b_succeeded,
        )
