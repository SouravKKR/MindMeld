import asyncio

from Globals.Classes.Automation.AutomationCaller import AutomationCaller
from Globals.Classes.Automation.AutomationContent import AutomationContent
from Globals.Classes.Automation.AutomationRequest import AutomationRequest
from Globals.Classes.Automation.Pools.ModelPool import ModelPool
from Globals.Classes.Automation.Pools.PromptPool import PromptPool
from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes
from Globals.Utility.StripJsonMarkdown import strip_json_markdown

from Workflows.ProcessSyllabus.CoverageSummaryGenerator import CoverageSummaryGenerator


class KnowledgeChunkGenerator:
    """
    Produces the per-topic content chunks that every downstream worker consumes,
    written from model knowledge against the topic's Phase 1 coverage summary.

    This REPLACES retrieval and nothing else. In a normal run,
    MapTopicsWithContent embeds an uploaded PDF and matches passages to topics;
    here there is no PDF, so the chunks are written instead. The output contract
    is byte-identical — same per-topic JSON, same task-bucket paths, same
    topicChain / chunks / sourcePages / weight fields — which is why
    StudyMaterialGenerationWorker, FlashcardGenerationWorker and
    MockTestGenerationWorker need no changes at all. sourcePages is empty
    throughout, and every consumer already reads it as .get("sourcePages", []).

    Two hard rules, both structural rather than advisory:

      1. NO SOURCE CHUNKS, EVER. Phase 0 guarantees no document was accepted, so
         there is nothing to fall back to — and this class has no code path that
         would read one. That absence is the point: the independent-creation
         position depends on it being impossible, not merely unused.

      2. WEB CONTENT NEVER BECOMES CHUNK CONTENT. Web access in paid-deck mode
         exists for verification (coverage reconciliation, currency checks) and
         is confined to those stages. Nothing fetched there reaches this class.

    SOURCE_EXPRESSION_RULES is composed as the leading SYSTEM part, exactly as
    StudyMaterialGenerationWorker and FlashcardGenerationWorker already do, so
    the accuracy constraints on formulae, constants and standard definitions are
    the same ones the rest of the pipeline writes under.
    """

    # Chunks requested per topic. The downstream workers size their own output
    # from the chunk set, and this is roughly what a retrieved topic yields from
    # a textbook, so the generated corpus lands in the same shape they are tuned
    # for.
    TARGET_CHUNKS_PER_TOPIC = 6

    # Concurrent topics in flight. The provider's Redis semaphore is the real
    # cap; this bounds how much of the syllabus is queued at once.
    MAXIMUM_CONCURRENT_TOPICS = 6

    def __init__(self, subject_name: str, exam_name: str, coverage_summaries: dict, action_log = None):
        self.__subject_name = (subject_name or "").strip() or "the subject"
        self.__exam_name = (exam_name or "").strip()
        self.__action_log = action_log
        self.__summaries_by_chain_key = KnowledgeChunkGenerator.__index_summaries(coverage_summaries)

    @staticmethod
    def __index_summaries(coverage_summaries: dict) -> dict:
        summaries_by_chain_key = {}
        for topic_summary in ((coverage_summaries or {}).get("topics") or []):
            chain_key = CoverageSummaryGenerator.build_chain_key(topic_summary.get("topicChain"))
            summaries_by_chain_key[chain_key] = topic_summary
        return summaries_by_chain_key

    async def generate(self, leaves: list, on_topic_completed = None) -> dict:
        """
        Returns {leaf_index: [chunk strings]}. A topic whose generation failed is
        absent from the map rather than present with an empty list, so the caller
        can tell "produced nothing" from "was never attempted".

        on_topic_completed is an optional coroutine invoked after each topic so
        the caller can creep the progress bar — the existing progress reporting,
        reused rather than replaced.
        """
        semaphore = asyncio.Semaphore(KnowledgeChunkGenerator.MAXIMUM_CONCURRENT_TOPICS)
        chunks_by_leaf_index = {}

        async def generate_one(leaf_index, leaf):
            async with semaphore:
                chunks = await self.__generate_for_topic(leaf)

            if chunks:
                chunks_by_leaf_index[leaf_index] = chunks

            if on_topic_completed is not None:
                await on_topic_completed()

        await asyncio.gather(*[
            generate_one(leaf_index, leaf) for leaf_index, leaf in enumerate(leaves)
        ])

        return chunks_by_leaf_index

    async def __generate_for_topic(self, leaf: dict) -> list:
        topic_chain = leaf["path"] + [leaf["topic"]]
        chain_key = CoverageSummaryGenerator.build_chain_key(topic_chain)
        topic_summary = self.__summaries_by_chain_key.get(chain_key)

        exam_context = (
            f"Exam: {self.__exam_name}. Pitch depth and problem types at what this exam assesses."
            if self.__exam_name
            else "Exam: none specified. Use a standard treatment of the subject."
        )

        model_string, provider_class = ModelPool.PAID_DECK_KNOWLEDGE_CHUNK_MODEL
        caller = AutomationCaller(provider_class())

        request = AutomationRequest(
            model_string,
            [
                # Leading SYSTEM part, matching how the study-material and
                # flashcard workers compose it — accuracy on formulae, constants
                # and standard definitions is not a per-stage preference.
                AutomationContent(AutomationContentTypes.SYSTEM, PromptPool.SOURCE_EXPRESSION_RULES),
                AutomationContent(
                    AutomationContentTypes.SYSTEM,
                    PromptPool.PAID_DECK_KNOWLEDGE_CHUNK_SYSTEM
                        .replace("{target_chunk_count}", str(KnowledgeChunkGenerator.TARGET_CHUNKS_PER_TOPIC)),
                ),
                AutomationContent(
                    AutomationContentTypes.TEXT,
                    PromptPool.PAID_DECK_KNOWLEDGE_CHUNK_USER
                        .replace("{subject_name}", self.__subject_name)
                        .replace("{exam_context}", exam_context)
                        .replace("{topic_chain}", " > ".join(topic_chain))
                        .replace("{coverage_specification}", KnowledgeChunkGenerator.__render_specification(topic_summary)),
                ),
            ],
        )

        try:
            response = await caller.call(request, validator = None)
        except Exception as call_error:
            print(f"[KnowledgeChunkGenerator] {' > '.join(topic_chain)} failed: {call_error}")
            await self.__record(topic_chain, model_string, None, f"Generation failed: {call_error}", False)
            return []

        if response is None:
            await self.__record(topic_chain, model_string, None, "No response from provider.", False)
            return []

        parsed = strip_json_markdown(response.get_output(0).get_data())
        chunks = []

        if isinstance(parsed, dict) and isinstance(parsed.get("chunks"), list):
            chunks = [str(chunk).strip() for chunk in parsed["chunks"] if str(chunk).strip()]

        if not chunks:
            await self.__record(topic_chain, model_string, response, "Returned no usable chunks.", False)
            return []

        await self.__record(topic_chain, model_string, response, f"Generated {len(chunks)} chunk(s).", True)
        return chunks

    @staticmethod
    def __render_specification(topic_summary) -> str:
        """
        Flattens the coverage summary into the checklist the writer works
        through. Sections with nothing in them are omitted rather than printed
        empty, so the model is not handed headings it will feel obliged to fill.
        """
        if not isinstance(topic_summary, dict):
            return (
                "No coverage specification is available for this topic. Write a complete standard "
                "treatment and say so in the first chunk."
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

        # Visuals are deliberately NOT rendered here. They are produced in Phase 4
        # from this same summary; naming them to the chunk writer only invites it
        # to describe a figure the chunks do not contain.

        return "\n\n".join(rendered_sections) if rendered_sections else (
            "The coverage specification for this topic is empty. Write a complete standard treatment "
            "and say so in the first chunk."
        )

    async def __record(self, topic_chain, model_string, response, outcome, b_succeeded):
        if self.__action_log is None:
            return
        await self.__action_log.record_llm_call(
            phase_name = "KNOWLEDGE_CHUNK_GENERATION",
            model_identifier = model_string,
            prompt_identifier = "PAID_DECK_KNOWLEDGE_CHUNK_SYSTEM",
            reasoning_effort = None,
            usage_metadata = response.get_usage_metadata() if response is not None else None,
            outcome = f"{' > '.join(topic_chain)}: {outcome}",
            b_succeeded = b_succeeded,
        )
