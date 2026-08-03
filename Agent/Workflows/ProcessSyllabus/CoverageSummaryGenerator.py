import asyncio
import json

from Globals.Classes.Automation.AutomationCaller import AutomationCaller
from Globals.Classes.Automation.AutomationContent import AutomationContent
from Globals.Classes.Automation.AutomationRequest import AutomationRequest
from Globals.Classes.Automation.Pools.ModelPool import ModelPool
from Globals.Classes.Automation.Pools.PromptPool import PromptPool
from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes
from Globals.Enumerations.VisualKinds import VisualKinds
from Globals.Utility.StripJsonMarkdown import strip_json_markdown


class CoverageSummaryGenerator:
    """
    Produces one coverage summary per syllabus leaf topic: an explicit
    enumeration of the derivations, formulae, constants, definitions, problem
    types, misconceptions and visuals a complete treatment of that topic must
    contain.

    Why enumeration rather than a prose brief. Every downstream stage writes
    against this summary, and a generator asked for "a good treatment of
    refraction" reliably produces a plausible overview that silently omits the
    derivation, the sign convention and the critical-angle case. Nothing that is
    not named here gets written. The summary is therefore a checklist, not a
    description, and it is deliberately verbose.

    Why the visual "kind" matters more than anything else in the record. Phase 4
    routes on it: a RAY_DIAGRAM becomes inline SVG (exact coordinates, real text
    labels), an ILLUSTRATIVE_OR_CONCEPTUAL becomes a raster image. Get that
    backwards and a diagram whose whole value is a correct angle comes back as a
    picture with the angle wrong and the labels garbled — which students then
    memorise. An unrecognised or missing kind is therefore NOT silently defaulted
    to the raster path; it falls back to the symbolic path, which degrades to a
    labelled description rather than to a confident wrong picture.

    This runs only in paid-deck mode. Normal-mode runs never invoke it and their
    Syllabus.json is untouched, which is why the summaries live in their own file
    rather than being folded into the syllabus taxonomy.
    """

    # Topics per LLM call. Small enough that the model can be exhaustive about
    # each one (the whole point), large enough that a 200-leaf syllabus does not
    # become 200 round trips.
    TOPICS_PER_REQUEST = 8

    # Concurrent in-flight requests. The provider's Redis semaphore is the real
    # cap; this just avoids queueing the entire syllabus at once.
    MAXIMUM_CONCURRENT_REQUESTS = 4

    # A topic whose summary could not be produced still needs an entry, so
    # downstream stages find a record for every leaf rather than skipping it
    # silently. The empty summary is visible in the audit trail as a gap.
    EMPTY_SUMMARY_NOTE = "Coverage summary generation failed for this topic."

    def __init__(self, subject_name: str, exam_name: str, additional_instructions: str = "", action_log = None):
        self.__subject_name = (subject_name or "").strip() or "the subject"
        self.__exam_name = (exam_name or "").strip()
        # The ONLY channel through which a human can influence what this deck
        # must contain. Everything else this stage sees is topic names, the
        # subject and the exam — ProcessSyllabus reduces the uploaded syllabus to
        # a tree of names, so any prose around it (an exam board prescribing a
        # specific set of diagrams, for instance) is gone by the time visuals are
        # decided. Without this, a requirement the admin knows about has nowhere
        # to enter the pipeline.
        self.__additional_instructions = (additional_instructions or "").strip()
        self.__action_log = action_log

    async def generate(self, leaves: list) -> dict:
        """
        Returns the coverage-summary document:
        {"version": 1, "topics": [ {...}, ... ]} — one entry per leaf, in leaf
        order, whether or not its summary succeeded.
        """
        batches = [
            leaves[batch_start: batch_start + CoverageSummaryGenerator.TOPICS_PER_REQUEST]
            for batch_start in range(0, len(leaves), CoverageSummaryGenerator.TOPICS_PER_REQUEST)
        ]

        semaphore = asyncio.Semaphore(CoverageSummaryGenerator.MAXIMUM_CONCURRENT_REQUESTS)

        async def run_batch(batch):
            async with semaphore:
                return await self.__generate_for_batch(batch)

        batch_results = await asyncio.gather(*[run_batch(batch) for batch in batches])

        summaries_by_chain_key = {}
        for batch_result in batch_results:
            summaries_by_chain_key.update(batch_result)

        topics = []
        for leaf in leaves:
            topic_chain = leaf["path"] + [leaf["topic"]]
            chain_key = CoverageSummaryGenerator.build_chain_key(topic_chain)
            topics.append(
                summaries_by_chain_key.get(chain_key)
                or CoverageSummaryGenerator.__build_empty_summary(topic_chain)
            )

        return {"version": 1, "topics": topics}

    @staticmethod
    def build_chain_key(topic_chain: list) -> str:
        """
        Normalised join used to match an LLM-returned topicChain back to the leaf
        it belongs to. Case and whitespace are normalised because the model
        occasionally re-cases a chain even when told to copy it verbatim.
        """
        return " > ".join(
            (segment if isinstance(segment, str) else "").strip().lower()
            for segment in (topic_chain or [])
        )

    @staticmethod
    def __build_empty_summary(topic_chain: list) -> dict:
        return {
            "topicChain": topic_chain,
            "coverageSummary": CoverageSummaryGenerator.EMPTY_SUMMARY_NOTE,
            "requiredDerivations": [],
            "formulaeAndConstants": [],
            "definitions": [],
            "standardProblemTypes": [],
            "commonMisconceptions": [],
            "visuals": [],
        }

    async def __generate_for_batch(self, batch: list) -> dict:
        topic_block = "\n".join(
            f"- {' > '.join(leaf['path'] + [leaf['topic']])}"
            for leaf in batch
        )

        exam_context = (
            f"Exam: {self.__exam_name}. Scope every summary to what this exam actually assesses."
            if self.__exam_name
            else "Exam: none specified. Scope every summary to a standard treatment of the subject."
        )

        # Rendered as a whole block (heading included) or omitted entirely, so a
        # run with no instructions does not ship a dangling empty heading that
        # the model then tries to interpret.
        additional_instructions_block = (
            "ADDITIONAL REQUIREMENTS FROM THE DECK AUTHOR — these are explicit and outrank your own "
            f"judgement about what a topic needs:\n{self.__additional_instructions}\n"
            if self.__additional_instructions
            else ""
        )

        model_string, provider_class = ModelPool.PAID_DECK_COVERAGE_SUMMARY_MODEL
        caller = AutomationCaller(provider_class())

        request = AutomationRequest(
            model_string,
            [
                AutomationContent(AutomationContentTypes.SYSTEM, PromptPool.PAID_DECK_COVERAGE_SUMMARY_SYSTEM),
                AutomationContent(
                    AutomationContentTypes.TEXT,
                    PromptPool.PAID_DECK_COVERAGE_SUMMARY_USER
                        .replace("{subject_name}", self.__subject_name)
                        .replace("{exam_context}", exam_context)
                        .replace("{additional_instructions_block}", additional_instructions_block)
                        .replace("{topic_block}", topic_block),
                ),
            ],
        )

        try:
            response = await caller.call(request, validator = None)
        except Exception as call_error:
            print(f"[CoverageSummaryGenerator] Batch of {len(batch)} topic(s) failed: {call_error}")
            await self.__record_failure(batch, model_string, str(call_error))
            return {}

        if response is None:
            print(f"[CoverageSummaryGenerator] Batch of {len(batch)} topic(s) returned no response.")
            await self.__record_failure(batch, model_string, "No response from provider.")
            return {}

        parsed = strip_json_markdown(response.get_output(0).get_data())

        if not isinstance(parsed, dict) or not isinstance(parsed.get("topics"), list):
            # Log a bounded slice of what actually came back. Recording only
            # "unusable shape" throws away the one piece of evidence that
            # distinguishes the causes — a truncated response, a prose preamble
            # around the JSON, or a correctly-formed object under a different
            # top-level key all reach this branch and look identical afterwards.
            raw_output = response.get_output(0).get_data()
            raw_preview = str(raw_output)[:400] if raw_output is not None else "<no text>"
            print(
                f"[CoverageSummaryGenerator] Batch of {len(batch)} topic(s) returned an unusable shape. "
                f"Parsed as {type(parsed).__name__}; first 400 characters of the raw response: {raw_preview!r}"
            )
            await self.__record_failure(batch, model_string, "Unusable response shape.")
            return {}

        summaries_by_chain_key = {}
        for entry in parsed["topics"]:
            normalized = CoverageSummaryGenerator.__normalize_entry(entry)
            if normalized is None:
                continue
            summaries_by_chain_key[CoverageSummaryGenerator.build_chain_key(normalized["topicChain"])] = normalized

        await self.__record_success(batch, model_string, response, len(summaries_by_chain_key))

        return summaries_by_chain_key

    @staticmethod
    def __normalize_entry(entry) -> dict | None:
        if not isinstance(entry, dict):
            return None

        topic_chain = entry.get("topicChain")
        if not isinstance(topic_chain, list) or not topic_chain:
            return None

        return {
            "topicChain": [str(segment) for segment in topic_chain],
            "coverageSummary": str(entry.get("coverageSummary") or "").strip(),
            "requiredDerivations": CoverageSummaryGenerator.__normalize_string_list(entry.get("requiredDerivations")),
            "formulaeAndConstants": CoverageSummaryGenerator.__normalize_string_list(entry.get("formulaeAndConstants")),
            "definitions": CoverageSummaryGenerator.__normalize_string_list(entry.get("definitions")),
            "standardProblemTypes": CoverageSummaryGenerator.__normalize_string_list(entry.get("standardProblemTypes")),
            "commonMisconceptions": CoverageSummaryGenerator.__normalize_string_list(entry.get("commonMisconceptions")),
            "visuals": CoverageSummaryGenerator.__normalize_visuals(entry.get("visuals")),
        }

    @staticmethod
    def __normalize_string_list(raw_value) -> list:
        if not isinstance(raw_value, list):
            return []
        return [str(item).strip() for item in raw_value if isinstance(item, (str, int, float)) and str(item).strip()]

    @staticmethod
    def __normalize_visuals(raw_visuals) -> list:
        """
        Keeps only visuals with a usable description, and resolves each declared
        kind to a VisualKinds name.

        An unrecognised or missing kind resolves to GEOMETRIC_CONSTRUCTION rather
        than ILLUSTRATIVE_OR_CONCEPTUAL. That is deliberate and is the safer of
        the two defaults: the symbolic route can decline a diagram it cannot draw
        accurately and emit a labelled description instead, whereas the raster
        route always returns a confident picture — including when the geometry is
        wrong. Defaulting toward the route that can say "I can't" is the whole
        point.
        """
        if not isinstance(raw_visuals, list):
            return []

        normalized_visuals = []
        for raw_visual in raw_visuals:
            if not isinstance(raw_visual, dict):
                continue

            description = str(raw_visual.get("description") or "").strip()
            if not description:
                continue

            declared_kind = str(raw_visual.get("kind") or "").strip().upper()
            resolved_kind = declared_kind if declared_kind in VisualKinds.__members__ else VisualKinds.GEOMETRIC_CONSTRUCTION.name

            if declared_kind and declared_kind != resolved_kind:
                print(
                    f"[CoverageSummaryGenerator] Unrecognised visual kind '{declared_kind}' — "
                    f"routing via {resolved_kind} (symbolic), which can decline rather than guess."
                )

            normalized_visuals.append({"description": description, "kind": resolved_kind})

        return normalized_visuals

    async def __record_success(self, batch, model_string, response, produced_count):
        if self.__action_log is None:
            return
        await self.__action_log.record_llm_call(
            phase_name = "COVERAGE_SUMMARY",
            model_identifier = model_string,
            prompt_identifier = "PAID_DECK_COVERAGE_SUMMARY_SYSTEM",
            reasoning_effort = None,
            usage_metadata = response.get_usage_metadata(),
            outcome = f"Produced {produced_count} of {len(batch)} requested coverage summaries.",
            b_succeeded = True,
        )

    async def __record_failure(self, batch, model_string, reason):
        if self.__action_log is None:
            return
        await self.__action_log.record_llm_call(
            phase_name = "COVERAGE_SUMMARY",
            model_identifier = model_string,
            prompt_identifier = "PAID_DECK_COVERAGE_SUMMARY_SYSTEM",
            reasoning_effort = None,
            usage_metadata = None,
            outcome = f"Failed for {len(batch)} topic(s): {reason}",
            b_succeeded = False,
        )
