from Globals.Classes.Automation.AutomationCaller import AutomationCaller
from Globals.Classes.Automation.AutomationContent import AutomationContent
from Globals.Classes.Automation.AutomationRequest import AutomationRequest
from Globals.Classes.Automation.Pools.ModelPool import ModelPool
from Globals.Classes.Automation.Pools.PromptPool import PromptPool
from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes
from Globals.Enumerations.WebFetchReasons import WebFetchReasons
from Globals.Utility.StripJsonMarkdown import strip_json_markdown


class CoverageReconciler:
    """
    Phase 2: audits the extracted syllabus tree against the current examination
    pattern and reports gaps and out-of-scope topics.

    Web search is enabled for this stage and ONLY for this stage's purpose.
    Examination patterns are revised on their own schedule and a model's sense of
    "the current syllabus" goes stale silently, so checking is the only way the
    audit means anything. The distinction that matters — and the reason every
    fetch is logged with WebFetchReasons.COVERAGE_CHECK rather than as a bare URL
    — is that this is verification of a tree that already exists, not sourcing of
    content. Nothing fetched here becomes deck content: the reconciliation report
    is a separate file, read by a human at the review gate, and no generation
    stage consumes it.

    The report is ADVISORY. It does not add topics, remove topics, or alter the
    syllabus in any way. Acting on it is a decision for whoever reviews the deck
    before publication — a model rewriting the syllabus on the strength of its
    own web search is exactly the kind of unattended change this feature should
    not make.
    """

    # Leaves sent for audit. The pattern-level question ("does this tree cover
    # what the exam assesses") does not need every leaf, and a very long tree
    # crowds out the model's attention on the comparison itself.
    MAXIMUM_AUDITED_LEAVES = 250

    def __init__(self, subject_name: str, exam_name: str, action_log = None):
        self.__subject_name = (subject_name or "").strip() or "the subject"
        self.__exam_name = (exam_name or "").strip()
        self.__action_log = action_log

    async def reconcile(self, leaves: list) -> dict:
        """
        Returns the reconciliation report, always with the same shape so the
        review gate and the audit PDF can render it unconditionally:

        {"version": 1, "attempted": bool, "patternSummary": str,
         "patternConfidence": str, "gaps": [...], "outOfScope": [...],
         "consultedUrls": [...], "failureReason": str|None}
        """
        audited_leaves = leaves[: CoverageReconciler.MAXIMUM_AUDITED_LEAVES]
        b_truncated = len(leaves) > len(audited_leaves)

        topic_block = "\n".join(
            f"- {' > '.join(leaf['path'] + [leaf['topic']])}"
            for leaf in audited_leaves
        )

        exam_context = (
            f"Exam: {self.__exam_name}."
            if self.__exam_name
            else "Exam: none specified. Audit against the standard curriculum for this subject and level."
        )

        model_string, provider_class = ModelPool.PAID_DECK_COVERAGE_RECONCILIATION_MODEL
        caller = AutomationCaller(provider_class())

        request = AutomationRequest(
            model_string,
            [
                AutomationContent(AutomationContentTypes.SYSTEM, PromptPool.PAID_DECK_COVERAGE_RECONCILIATION_SYSTEM),
                AutomationContent(
                    AutomationContentTypes.TEXT,
                    PromptPool.PAID_DECK_COVERAGE_RECONCILIATION_USER
                        .replace("{subject_name}", self.__subject_name)
                        .replace("{exam_context}", exam_context)
                        .replace("{topic_count}", str(len(audited_leaves)))
                        .replace("{topic_block}", topic_block),
                    # Verification only. The provider turns this into the
                    # server-side web-search tool; the prompt above forbids using
                    # anything it returns as content.
                    {"enable_search": True},
                ),
            ],
        )

        try:
            response = await caller.call(request, validator = None)
        except Exception as call_error:
            print(f"[CoverageReconciler] Reconciliation failed: {call_error}")
            await self.__record(model_string, None, f"Failed: {call_error}", False)
            return CoverageReconciler.__build_failed_report(str(call_error))

        if response is None:
            await self.__record(model_string, None, "No response from provider.", False)
            return CoverageReconciler.__build_failed_report("No response from provider.")

        parsed = strip_json_markdown(response.get_output(0).get_data())

        if not isinstance(parsed, dict):
            await self.__record(model_string, response, "Unusable response shape.", False)
            return CoverageReconciler.__build_failed_report("Unusable response shape.")

        report = {
            "version": 1,
            "attempted": True,
            "patternSummary": str(parsed.get("patternSummary") or "").strip(),
            "patternConfidence": str(parsed.get("patternConfidence") or "").strip().upper() or "LOW",
            "gaps": CoverageReconciler.__normalize_gaps(parsed.get("gaps")),
            "outOfScope": CoverageReconciler.__normalize_out_of_scope(parsed.get("outOfScope")),
            "consultedUrls": CoverageReconciler.__normalize_urls(parsed.get("consultedUrls")),
            "auditedLeafCount": len(audited_leaves),
            "leafCountTruncated": b_truncated,
            "failureReason": None,
        }

        await self.__record_consulted_urls(report["consultedUrls"])
        await self.__record(
            model_string,
            response,
            f"{len(report['gaps'])} gap(s), {len(report['outOfScope'])} out-of-scope topic(s); "
            f"pattern confidence {report['patternConfidence']}.",
            True,
        )

        return report

    @staticmethod
    def __build_failed_report(failure_reason: str) -> dict:
        # A failed audit is reported as a failed audit, never as a clean one. The
        # review gate shows "not audited" so the reviewer knows the check did not
        # run, rather than reading empty gap lists as a pass.
        return {
            "version": 1,
            "attempted": False,
            "patternSummary": "",
            "patternConfidence": "LOW",
            "gaps": [],
            "outOfScope": [],
            "consultedUrls": [],
            "auditedLeafCount": 0,
            "leafCountTruncated": False,
            "failureReason": failure_reason,
        }

    @staticmethod
    def __normalize_gaps(raw_gaps) -> list:
        if not isinstance(raw_gaps, list):
            return []
        normalized_gaps = []
        for raw_gap in raw_gaps:
            if not isinstance(raw_gap, dict):
                continue
            topic = str(raw_gap.get("topic") or "").strip()
            if not topic:
                continue
            normalized_gaps.append({
                "topic": topic,
                "reason": str(raw_gap.get("reason") or "").strip(),
                "suggestedParent": str(raw_gap.get("suggestedParent") or "").strip(),
            })
        return normalized_gaps

    @staticmethod
    def __normalize_out_of_scope(raw_entries) -> list:
        if not isinstance(raw_entries, list):
            return []
        normalized_entries = []
        for raw_entry in raw_entries:
            if not isinstance(raw_entry, dict):
                continue
            topic_chain = raw_entry.get("topicChain")
            if not isinstance(topic_chain, list) or not topic_chain:
                continue
            normalized_entries.append({
                "topicChain": [str(segment) for segment in topic_chain],
                "reason": str(raw_entry.get("reason") or "").strip(),
            })
        return normalized_entries

    @staticmethod
    def __normalize_urls(raw_urls) -> list:
        if not isinstance(raw_urls, list):
            return []
        seen_urls = []
        for raw_url in raw_urls:
            url = str(raw_url or "").strip()
            if url and url not in seen_urls:
                seen_urls.append(url)
        return seen_urls

    async def __record_consulted_urls(self, consulted_urls: list) -> None:
        if self.__action_log is None:
            return
        for url in consulted_urls:
            await self.__action_log.record_web_fetch(
                phase_name = "COVERAGE_RECONCILIATION",
                url = url,
                reason_name = WebFetchReasons.COVERAGE_CHECK.name,
                outcome = "Consulted to establish the current examination pattern.",
            )

    async def __record(self, model_string, response, outcome, b_succeeded):
        if self.__action_log is None:
            return
        await self.__action_log.record_llm_call(
            phase_name = "COVERAGE_RECONCILIATION",
            model_identifier = model_string,
            prompt_identifier = "PAID_DECK_COVERAGE_RECONCILIATION_SYSTEM",
            reasoning_effort = None,
            usage_metadata = response.get_usage_metadata() if response is not None else None,
            outcome = outcome,
            b_succeeded = b_succeeded,
        )
