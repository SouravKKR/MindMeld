import json
import time

from Globals.Classes.Generic.Persistence import Persistence
from Globals.Constants.PersistenceConstants import PersistenceConstants
from Globals.Utility.JoinPath import join_path


class PaidDeckActionLog:
    """
    Append-only action trail for one paid-deck generation run.

    Written as JSON Lines into the run's own task bucket, one line per action, in
    the order the actions happened. Dock reads the whole file at persistence time
    and folds it into a single insert-only provenance document per deck (see
    GenerationProvenanceQueryEngine) — the file is the transport, the Mongo
    document is the record.

    Design constraints, each of which exists for a reason:

      - APPEND ONLY. There is no update or delete, here or in the query engine
        that consumes it. A trail that can be edited after the fact proves
        nothing; its entire value is that it was written as the run happened and
        has not been touched since.

      - FAILURES ARE RECORDED, not swallowed. A retry, a refused call, a topic
        whose summary could not be produced — all of them get a line. A trail
        with gaps where the awkward parts were invites exactly the question it
        was written to answer.

      - LOGGING NEVER FAILS THE RUN. Every write is best-effort and swallows its
        own errors. Losing a line is bad; losing a generated deck because the
        audit file could not be written would be worse, and the missing line is
        itself visible as a gap in the trail.

      - WEB FETCHES CARRY THEIR REASON. A bare list of URLs reads like sourcing.
        A URL plus "coverage-check" or "currency-verification" shows the fetch
        was a check against what had already been written, not an input to it.
        That distinction is the substance of the independent-creation position,
        so the reason is a required argument rather than an optional field.

    Timestamps are UTC milliseconds, matching the repo's storage/transport
    convention; only the audit PDF converts to a human-readable form, and it
    states UTC explicitly when it does.
    """

    LOG_VERSION = 1

    def __init__(self, main_task_id: str, stage_name: str):
        """
        stage_name scopes this log to one pipeline stage.

        Stages run in separate Agent processes and some run concurrently, so a
        single shared file would have them overwrite each other's entries. Each
        stage writes its own file; Dock globs the directory and merges every
        entry by timestamp into the one per-deck provenance document.
        """
        self.__main_task_id = main_task_id
        self.__stage_name = stage_name
        self.__pending_entries = []

    def get_log_path(self) -> str:
        return join_path(
            "/",
            PersistenceConstants.TASKS_DIRECTORY,
            self.__main_task_id,
            PersistenceConstants.PAID_DECK_ACTION_LOG_DIRECTORY,
            f"{self.__stage_name}.jsonl",
        )

    async def record_llm_call(
        self,
        phase_name: str,
        model_identifier: str,
        prompt_identifier: str,
        reasoning_effort: str | None,
        usage_metadata: dict | None,
        outcome: str,
        b_succeeded: bool,
    ) -> None:
        """
        One model call. reasoning_effort is None when the call took the API
        default — recorded as null rather than as the default's name, because
        "we did not set it" and "we set it to the value that happens to be the
        default" are different facts and the report should not conflate them.
        """
        await self.__append({
            "actionType": "LLM_CALL",
            "phase": phase_name,
            "modelIdentifier": model_identifier,
            "promptIdentifier": prompt_identifier,
            "reasoningEffort": reasoning_effort,
            "inputTokens": (usage_metadata or {}).get("inputTokens"),
            "outputTokens": (usage_metadata or {}).get("outputTokens"),
            "outcome": outcome,
            "succeeded": bool(b_succeeded),
        })

    async def record_web_fetch(self, phase_name: str, url: str, reason_name: str, outcome: str) -> None:
        """
        One web page fetched. reason_name is a WebFetchReasons key and is
        mandatory — see the class docstring for why a URL without its reason is
        the wrong record to keep.
        """
        await self.__append({
            "actionType": "WEB_FETCH",
            "phase": phase_name,
            "url": url,
            "reason": reason_name,
            "outcome": outcome,
            "succeeded": True,
        })

    async def record_visual(
        self,
        topic_chain: list,
        description: str,
        kind_name: str,
        method_name: str,
        model_identifier: str | None,
        reasoning_effort: str | None,
        vision_review_outcome: str | None,
        b_succeeded: bool,
        origin: str = "DECLARED",
    ) -> None:
        """
        One generated visual: what it was asked to show, the kind it was declared
        as, the method that kind routed to, and what the vision review said about
        the result. Recorded per visual because the routing decision is the thing
        most likely to be questioned later.

        `origin` separates DECLARED (the coverage specification asked for this
        visual) from INFERRED (the pipeline judged the topic needed one). The
        distinction belongs in the record: presenting a judgement the pipeline
        made as though it were an instruction it was given would overstate what
        the source material actually specified.
        """
        await self.__append({
            "actionType": "VISUAL",
            "phase": "VISUAL_GENERATION",
            "topicChain": topic_chain,
            "description": description,
            "kind": kind_name,
            "method": method_name,
            "origin": origin,
            "modelIdentifier": model_identifier,
            "reasoningEffort": reasoning_effort,
            "visionReviewOutcome": vision_review_outcome,
            "succeeded": bool(b_succeeded),
        })

    async def record_verification_flag(
        self,
        flag_category: str,
        subject: str,
        detail: str,
        b_blocking: bool,
    ) -> None:
        """
        One thing verification objected to. Flags are RAISED here and never
        auto-corrected — a model silently rewriting another model's output
        introduces errors as readily as it fixes them, and an unlogged
        "correction" is indistinguishable from an unnoticed one.
        """
        await self.__append({
            "actionType": "VERIFICATION_FLAG",
            "phase": "VERIFICATION",
            "flagCategory": flag_category,
            "subject": subject,
            "detail": detail,
            "blocking": bool(b_blocking),
            "succeeded": True,
        })

    async def record_note(self, phase_name: str, outcome: str, b_succeeded: bool = True) -> None:
        """
        A stage boundary or a decision worth stating that was not itself a model
        call — the source declaration, a skipped stage, a retry.
        """
        await self.__append({
            "actionType": "NOTE",
            "phase": phase_name,
            "outcome": outcome,
            "succeeded": bool(b_succeeded),
        })

    async def record_source_declaration(
        self,
        source_name: str,
        content_hash: str,
        declared_source_type_name: str,
    ) -> None:
        """
        The source declaration: what was uploaded, its content hash, and the type
        it was declared as. This is the single most important line in the trail —
        it is the evidence for what did and did not enter the pipeline — so it is
        recorded as its own action type rather than folded into a note.
        """
        await self.__append({
            "actionType": "SOURCE_DECLARATION",
            "phase": "MODE_GATE",
            "sourceName": source_name,
            "contentHash": content_hash,
            "declaredSourceType": declared_source_type_name,
            "outcome": "Accepted as a curriculum/syllabus source.",
            "succeeded": True,
        })

    async def __append(self, entry: dict) -> None:
        entry["timestampUtcMilliseconds"] = int(time.time() * 1000)
        entry["logVersion"] = PaidDeckActionLog.LOG_VERSION
        self.__pending_entries.append(entry)

        try:
            await self.__flush()
        except Exception as write_error:
            # Deliberately swallowed — see the class docstring. The entry stays in
            # __pending_entries so the next successful flush still carries it.
            print(f"[PaidDeckActionLog] Could not write the action trail (continuing): {write_error}")

    async def __flush(self) -> None:
        """
        Rewrites the whole file from the in-memory list.

        The store has no append primitive, so "append-only" is a property of the
        WRITER (entries are only ever added to the list, never modified or
        removed), not of the storage call. One writer per stage file means the
        rewrite can never lose another writer's entries.
        """
        serialized = "\n".join(json.dumps(entry, ensure_ascii = False) for entry in self.__pending_entries)
        await Persistence.write(self.get_log_path(), serialized)
