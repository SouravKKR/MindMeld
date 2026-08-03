import asyncio

from Globals.Classes.Automation.AutomationCaller import AutomationCaller
from Globals.Classes.Automation.AutomationContent import AutomationContent
from Globals.Classes.Automation.AutomationRequest import AutomationRequest
from Globals.Classes.Automation.Pools.ModelPool import ModelPool
from Globals.Classes.Automation.Pools.PromptPool import PromptPool
from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes
from Globals.Enumerations.VisualKinds import VisualKinds
from Globals.Utility.StripJsonMarkdown import strip_json_markdown

from Workflows.ProcessSyllabus.CoverageSummaryGenerator import CoverageSummaryGenerator


class VisualNeedInferrer:
    """
    Decides which topics need a visual that nobody explicitly asked for.

    Why this exists. Paid-deck mode's only input is a syllabus, and a syllabus
    lists topics — it does not say "put a ray diagram here". So the visuals
    DECLARED in the Phase 1 coverage summaries are, in practice, sparse: the
    summary model names one where the topic makes it unavoidable and says
    nothing on topics that are simply taught with pictures. Relying on
    declarations alone therefore ships a text-only deck for subjects that are
    inherently visual, which is not what a deck being sold should look like.

    This supplies the judgement the syllabus does not contain: given each
    topic's coverage specification, it asks what a competent textbook would
    illustrate, and adds only what is missing.

    Two properties are deliberate:

      1. DECLARED VISUALS ALWAYS SURVIVE. This only ever ADDS. Anything the
         syllabus or the coverage summary named is passed through untouched and
         is shown to the model as already-covered so it is not duplicated or
         "improved". An explicit instruction outranks an inference.

      2. "NONE" IS A FIRST-CLASS ANSWER. Most topics on a typical syllabus need
         no diagram, and the prompt says so repeatedly. A deck padded with
         decorative figures is worse than one without them — it wastes attention
         and teaches the reader to skip figures. Inferring a visual for every
         topic would be the easy implementation and the wrong one.

    Inferred visuals are marked as such (origin=INFERRED) all the way through to
    the audit trail, so the provenance record distinguishes "the specification
    asked for this" from "the pipeline judged it useful" rather than presenting
    both as the same kind of fact.
    """

    # Ceiling on visuals per topic, declared and inferred combined.
    #
    # This bounds INFERENCE, not the deck. A topic whose coverage summary already
    # declares more than this is simply not eligible below and keeps every one of
    # its declared visuals — so a syllabus or an author instruction that
    # prescribes six diagrams still gets six. What the number limits is how many
    # figures the pipeline may invent on top of what was asked for.
    #
    # Raised from three: a genuinely visual topic can warrant more than three, and
    # the counterweight is not this number but the prompt's insistence that most
    # topics need none. Note the value IS shown to the model
    # ({maximum_additional_visuals}), so it reads as an allowance rather than a
    # silent clamp — which is the reason not to set it far higher than the number
    # a topic should actually reach.
    MAXIMUM_VISUALS_PER_TOPIC = 5

    # Topics per request. Judgement improves when the model can see neighbouring
    # topics — it avoids proposing the same diagram twice across a unit — but a
    # large batch dilutes attention on each one.
    TOPICS_PER_REQUEST = 10

    MAXIMUM_CONCURRENT_REQUESTS = 4

    # Origin markers, carried onto every visual so downstream stages and the
    # audit report can tell the two apart.
    ORIGIN_DECLARED = "DECLARED"
    ORIGIN_INFERRED = "INFERRED"

    def __init__(self, subject_name: str, exam_name: str = "", action_log = None):
        self.__subject_name = (subject_name or "").strip() or "the subject"
        self.__exam_name = (exam_name or "").strip()
        self.__action_log = action_log

    async def augment(self, coverage_summaries: dict) -> dict:
        """
        Returns a copy of the coverage summaries whose topics carry both their
        declared visuals and any inferred additions.

        Never raises and never loses a declared visual: if inference fails for a
        batch, those topics come back with exactly what they started with, which
        is the same result as this stage not existing.
        """
        topic_summaries = list((coverage_summaries or {}).get("topics") or [])

        if not topic_summaries:
            return coverage_summaries or {"version": 1, "topics": []}

        # Stamp origin on everything already present before adding anything, so
        # a declared visual is never mistaken for an inferred one downstream.
        for topic_summary in topic_summaries:
            for visual in (topic_summary.get("visuals") or []):
                visual.setdefault("origin", VisualNeedInferrer.ORIGIN_DECLARED)

        eligible_topics = [
            topic_summary for topic_summary in topic_summaries
            if len(topic_summary.get("visuals") or []) < VisualNeedInferrer.MAXIMUM_VISUALS_PER_TOPIC
        ]

        if not eligible_topics:
            return {"version": 1, "topics": topic_summaries}

        batches = [
            eligible_topics[batch_start: batch_start + VisualNeedInferrer.TOPICS_PER_REQUEST]
            for batch_start in range(0, len(eligible_topics), VisualNeedInferrer.TOPICS_PER_REQUEST)
        ]

        semaphore = asyncio.Semaphore(VisualNeedInferrer.MAXIMUM_CONCURRENT_REQUESTS)

        async def infer_batch(batch):
            async with semaphore:
                return await self.__infer_for_batch(batch)

        batch_results = await asyncio.gather(*[infer_batch(batch) for batch in batches])

        inferred_by_chain_key = {}
        for batch_result in batch_results:
            inferred_by_chain_key.update(batch_result)

        inferred_total = 0
        for topic_summary in topic_summaries:
            chain_key = CoverageSummaryGenerator.build_chain_key(topic_summary.get("topicChain"))
            inferred_visuals = inferred_by_chain_key.get(chain_key) or []

            if not inferred_visuals:
                continue

            existing_visuals = topic_summary.get("visuals") or []
            remaining_slots = VisualNeedInferrer.MAXIMUM_VISUALS_PER_TOPIC - len(existing_visuals)

            if remaining_slots <= 0:
                continue

            accepted_visuals = inferred_visuals[:remaining_slots]
            topic_summary["visuals"] = existing_visuals + accepted_visuals
            inferred_total += len(accepted_visuals)

        print(
            f"[VisualNeedInferrer] Added {inferred_total} inferred visual(s) across "
            f"{len(eligible_topics)} eligible topic(s)."
        )

        return {"version": 1, "topics": topic_summaries}

    async def __infer_for_batch(self, batch: list) -> dict:
        topic_block = "\n\n".join(self.__render_topic(topic_summary) for topic_summary in batch)

        exam_context = (
            f"Exam: {self.__exam_name}. Judge against what this exam expects a student to be able to read and draw."
            if self.__exam_name
            else "Exam: none specified. Judge against a standard treatment of the subject."
        )

        model_string, provider_class = ModelPool.PAID_DECK_VISUAL_NEED_MODEL
        caller = AutomationCaller(provider_class())

        request = AutomationRequest(
            model_string,
            [
                AutomationContent(
                    AutomationContentTypes.SYSTEM,
                    PromptPool.PAID_DECK_VISUAL_NEED_SYSTEM
                        .replace("{maximum_additional_visuals}", str(VisualNeedInferrer.MAXIMUM_VISUALS_PER_TOPIC)),
                ),
                AutomationContent(
                    AutomationContentTypes.TEXT,
                    PromptPool.PAID_DECK_VISUAL_NEED_USER
                        .replace("{subject_name}", self.__subject_name)
                        .replace("{exam_context}", exam_context)
                        .replace("{topic_block}", topic_block),
                ),
            ],
        )

        try:
            response = await caller.call(request, validator = None)
        except Exception as call_error:
            print(f"[VisualNeedInferrer] Batch of {len(batch)} topic(s) failed: {call_error}")
            await self.__record(model_string, None, f"Failed for {len(batch)} topic(s): {call_error}", False)
            return {}

        if response is None:
            await self.__record(model_string, None, "No response from provider.", False)
            return {}

        parsed = strip_json_markdown(response.get_output(0).get_data())

        if not isinstance(parsed, dict) or not isinstance(parsed.get("topics"), list):
            await self.__record(model_string, response, "Unusable response shape.", False)
            return {}

        inferred_by_chain_key = {}
        for entry in parsed["topics"]:
            if not isinstance(entry, dict):
                continue
            topic_chain = entry.get("topicChain")
            if not isinstance(topic_chain, list) or not topic_chain:
                continue

            normalized_visuals = VisualNeedInferrer.__normalize_visuals(entry.get("visuals"))
            if normalized_visuals:
                inferred_by_chain_key[CoverageSummaryGenerator.build_chain_key(topic_chain)] = normalized_visuals

        await self.__record(
            model_string, response,
            f"{sum(len(visuals) for visuals in inferred_by_chain_key.values())} visual(s) inferred "
            f"across {len(inferred_by_chain_key)} of {len(batch)} topic(s).",
            True,
        )

        return inferred_by_chain_key

    @staticmethod
    def __render_topic(topic_summary: dict) -> str:
        """
        Presents one topic to the model: its chain, enough of its specification
        to judge whether a picture would help, and whatever visuals are already
        declared so it does not propose them again.
        """
        topic_chain = topic_summary.get("topicChain") or []
        lines = [f"- Topic: {' > '.join(str(segment) for segment in topic_chain)}"]

        overview = str(topic_summary.get("coverageSummary") or "").strip()
        if overview:
            lines.append(f"  Covers: {overview}")

        for section_title, section_key in [
            ("Derivations", "requiredDerivations"),
            ("Formulae/constants", "formulaeAndConstants"),
            ("Problem types", "standardProblemTypes"),
        ]:
            items = topic_summary.get(section_key) or []
            if items:
                lines.append(f"  {section_title}: {'; '.join(str(item) for item in items[:6])}")

        existing_visuals = topic_summary.get("visuals") or []
        if existing_visuals:
            declared = "; ".join(
                f"{visual.get('kind')} — {visual.get('description')}" for visual in existing_visuals
            )
            lines.append(f"  ALREADY DECLARED (do not repeat or vary): {declared}")
        else:
            lines.append("  ALREADY DECLARED: none")

        return "\n".join(lines)

    @staticmethod
    def __normalize_visuals(raw_visuals) -> list:
        """
        Keeps only visuals with a usable description, resolves each kind, and
        stamps them as inferred.

        An unrecognised kind resolves to GEOMETRIC_CONSTRUCTION for the same
        reason it does in CoverageSummaryGenerator: that routes to the symbolic
        path, which can decline to draw something it cannot get right, whereas
        the raster path always returns a confident picture — including when the
        geometry is wrong.
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

            normalized_visuals.append({
                "description": description,
                "kind": resolved_kind,
                "origin": VisualNeedInferrer.ORIGIN_INFERRED,
            })

        return normalized_visuals

    async def __record(self, model_string, response, outcome, b_succeeded):
        if self.__action_log is None:
            return
        await self.__action_log.record_llm_call(
            phase_name = "VISUAL_GENERATION",
            model_identifier = model_string,
            prompt_identifier = "PAID_DECK_VISUAL_NEED_SYSTEM",
            reasoning_effort = None,
            usage_metadata = response.get_usage_metadata() if response is not None else None,
            outcome = outcome,
            b_succeeded = b_succeeded,
        )
