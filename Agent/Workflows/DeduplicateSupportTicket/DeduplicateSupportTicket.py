import asyncio
import datetime
import time
import uuid

from Workflows.Workflow import Workflow
from Workflows.DeduplicateSupportTicket.SupportTicketMatchResponse import SupportTicketMatchResponse
from Workflows.PrepareForSimilaritySearch.EmbedPages import load_model
from Globals.Classes.Automation.AutomationCaller import AutomationCaller
from Globals.Classes.Automation.AutomationContent import AutomationContent
from Globals.Classes.Automation.AutomationRequest import AutomationRequest
from Globals.Classes.Automation.Providers.GoogleEnterpriseAiProvider import GoogleEnterpriseAiProvider
from Globals.Classes.Database.SupportTicketQueryEngine import SupportTicketQueryEngine
from Globals.Classes.Task.TaskManager import TaskManager
from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes
from Globals.Enumerations.SupportTicketStatus import SupportTicketStatus
from Globals.Enumerations.SupportTicketReportStatus import SupportTicketReportStatus
from Globals.Enumerations.SupportTicketTypes import SupportTicketTypes


class DeduplicateSupportTicket(Workflow):
    """
    Groups one newly submitted support report onto an existing ticket, or opens a
    new one.

    This runs on the Agent rather than in Dock because it needs the embedding model
    (nomic-embed-text-v1, the same one the RAG pipeline uses) and an LLM call —
    neither of which Dock can do. Dock stores the report, answers the reporter
    immediately, and hands the id here.

    The shape is: embed the report, pull the most similar ACTIVE tickets, ask the
    model in ONE structured call whether it is a duplicate and what the merged
    ticket should say, then either fold it in or create a ticket.
    """

    # Every LLM operation in this workflow — the similarity judgement, the
    # new-aspect detection, the merged-description rewrite and the title — is a
    # cheap classification over short text and runs on flash-lite. Declared once so
    # the model choice cannot drift across the file.
    MODEL_NAME = "gemini-2.5-flash-lite"

    CANDIDATE_TICKET_COUNT = 5

    # nomic-embed-text-v1 is trained with these task prefixes; using the wrong one
    # measurably degrades retrieval. Stored ticket text is a "document", the
    # incoming report is the "query" searching against them.
    EMBEDDING_DOCUMENT_PREFIX = "search_document: "
    EMBEDDING_QUERY_PREFIX = "search_query: "

    # Hand-mirrored from Dock/Globals/Classes/Support/SupportTicketLimits.js. The
    # constant codegen does not cover that file, so these two copies must be kept
    # in step. LLM output is CLAMPED against them rather than rejected — failing a
    # deduplication run over a cosmetic overrun would be the worse outcome.
    MAXIMUM_TICKET_DESCRIPTION_LENGTH = 8000
    MAXIMUM_ASPECT_LENGTH = 1000
    MAXIMUM_TITLE_LENGTH = 200
    MAXIMUM_ASPECTS_PER_TICKET = 50

    # Bounded wait for the deduplication mutex. The total (40 x 15s = 10 minutes)
    # deliberately matches the lease length, so a report queued behind a genuinely
    # slow run waits it out instead of giving up while the holder is still working.
    # Finite so a wedged lease cannot hang a worker forever — and giving up now
    # flags the report rather than silently abandoning it.
    LOCK_RETRY_COUNT = 40
    LOCK_RETRY_DELAY_SECONDS = 15

    def __init__(self, payload = {}):
        super().__init__(payload)

    async def __update_progress(self, completion: float):
        task = await TaskManager.get_current_task()

        if task is None:
            return

        task.set_completion(completion)
        await TaskManager.set_task(task)

    async def run(self, args = {}):
        report_id = self._payload.get("reportId") if isinstance(self._payload, dict) else None

        if not report_id:
            print("[DeduplicateSupportTicket] No reportId in the payload — nothing to group.")
            return

        await self.__update_progress(0.05)

        report = await SupportTicketQueryEngine.get_report(report_id)

        if report is None:
            print(f"[DeduplicateSupportTicket] Report {report_id} no longer exists — nothing to group.")
            return

        # Idempotence: a requeued or retried task must not group the same report
        # twice, which would double-count a reporter on the ticket.
        if int(report.get("groupingStatus", SupportTicketReportStatus.PENDING_GROUPING)) == int(SupportTicketReportStatus.GROUPED):
            print(f"[DeduplicateSupportTicket] Report {report_id} is already grouped — skipping.")
            await self.__update_progress(1.0)
            return

        owner_token = await self.__acquire_lock_with_retries()

        if owner_token is None:
            # Grouping without the mutex is not an option — it is the only thing
            # stopping two concurrent reports of one problem from creating two
            # tickets. But returning quietly would strand the report in
            # PENDING_GROUPING forever: nothing re-queues it, no admin screen would
            # list it, and the reporter would see "Under review" indefinitely.
            # Flag it and fail loudly so the task is recorded as FAILED and the
            # report surfaces in the admin's ungrouped-reports list.
            print(f"[DeduplicateSupportTicket] Could not acquire the deduplication lock for report {report_id} after "
                  f"{DeduplicateSupportTicket.LOCK_RETRY_COUNT} attempts; flagging it for the admin.")
            await SupportTicketQueryEngine.mark_report_grouping_failed(report_id)
            raise RuntimeError(f"Could not acquire the support-ticket deduplication lock for report {report_id}")

        try:
            await self.__group_report(report)
        except Exception as groupingError:
            print(f"[DeduplicateSupportTicket] Grouping failed for report {report_id}: {groupingError}")
            await SupportTicketQueryEngine.mark_report_grouping_failed(report_id)
            raise
        finally:
            await SupportTicketQueryEngine.release_deduplication_lock(owner_token)

        await self.__update_progress(1.0)

    async def __acquire_lock_with_retries(self):
        for attemptIndex in range(DeduplicateSupportTicket.LOCK_RETRY_COUNT):
            owner_token = await SupportTicketQueryEngine.acquire_deduplication_lock()

            if owner_token is not None:
                return owner_token

            await asyncio.sleep(DeduplicateSupportTicket.LOCK_RETRY_DELAY_SECONDS)

        return None

    async def __group_report(self, report: dict) -> None:
        report_id = report["id"]
        report_text = self.__build_report_text(report)

        embedding_model = load_model()
        report_embedding = embedding_model.encode(
            [DeduplicateSupportTicket.EMBEDDING_QUERY_PREFIX + report_text],
            convert_to_numpy = True,
            show_progress_bar = False
        )[0].tolist()

        await self.__update_progress(0.35)

        candidate_tickets = await SupportTicketQueryEngine.vector_search_active_tickets(
            report_embedding,
            DeduplicateSupportTicket.CANDIDATE_TICKET_COUNT
        )

        await self.__update_progress(0.55)

        match_response = await self.__ask_for_match(report, report_text, candidate_tickets)

        await self.__update_progress(0.8)

        # The model is told to copy an id verbatim from the candidate list, but a
        # hallucinated or stale id must never be written to a report's ticketId —
        # so the answer is validated against the candidates we actually supplied.
        candidate_ids = { candidate["id"] for candidate in candidate_tickets }
        matched_ticket_id = match_response.matched_ticket_id if match_response.matched_ticket_id in candidate_ids else None

        if matched_ticket_id is not None:
            matched_candidate = next(candidate for candidate in candidate_tickets if candidate["id"] == matched_ticket_id)
            bMerged = await self.__merge_into_ticket(report, matched_candidate, match_response, embedding_model)

            if bMerged:
                await SupportTicketQueryEngine.mark_report_grouped(report_id, matched_ticket_id)
                print(f"[DeduplicateSupportTicket] Report {report_id} merged into ticket {matched_ticket_id}.")
                return

            # The ticket was resolved or declined between the search and the merge.
            # Falling through to create a new ticket is correct: the problem was
            # reported again after being closed, and the closed ticket's reporters
            # have already been notified and compensated.
            print(f"[DeduplicateSupportTicket] Ticket {matched_ticket_id} was closed mid-flight; creating a new ticket for report {report_id} instead.")

        new_ticket_id = await self.__create_ticket(report, match_response, embedding_model)
        await SupportTicketQueryEngine.mark_report_grouped(report_id, new_ticket_id)
        print(f"[DeduplicateSupportTicket] Report {report_id} opened new ticket {new_ticket_id}.")

    def __build_report_text(self, report: dict) -> str:
        """
        The text that gets embedded and shown to the model. The issue type is
        included because a "billing" report and a "sync" report that use similar
        wording are rarely the same defect, and the category is a strong, free
        signal towards that.
        """
        issue_type_name = self.__issue_type_name(report.get("issueType", 0))
        description = str(report.get("description", "")).strip()
        return f"[{issue_type_name}] {description}"

    def __issue_type_name(self, issue_type_value) -> str:
        try:
            return SupportTicketTypes(int(issue_type_value)).name.replace("_", " ").title()
        except (ValueError, TypeError):
            return "Other"

    async def __ask_for_match(self, report: dict, report_text: str, candidate_tickets: list) -> SupportTicketMatchResponse:
        provider = GoogleEnterpriseAiProvider()
        caller = AutomationCaller(provider)

        system_prompt = (
            "You are triaging incoming support reports for a learning application, deciding whether a new "
            "report describes a problem that has already been reported.\n\n"
            "Your bias must be towards SEPARATION, not merging. Two reports belong to the same ticket only "
            "when fixing one would fix the other. Reports that touch the same feature, screen, or workflow "
            "but describe different failures are DIFFERENT tickets. If you are not confident, return null "
            "for matched_ticket_id.\n\n"
            "A wrong merge is expensive: the buried report never gets fixed, and its reporter is later told "
            "that an unrelated problem was resolved. A wrong split costs nothing but a duplicate row an "
            "administrator can see and handle.\n\n"
            "When you do match, decide whether the new report adds any concrete detail the existing ticket "
            "does not already cover, and rewrite the ticket's description so it reads as one account of the "
            "problem rather than a pile of separate reports."
        )

        user_prompt = self.__build_user_prompt(report_text, candidate_tickets)

        request = AutomationRequest(
            DeduplicateSupportTicket.MODEL_NAME,
            [
                AutomationContent(AutomationContentTypes.SYSTEM, system_prompt),
                AutomationContent(
                    AutomationContentTypes.TEXT,
                    user_prompt,
                    metadata = { "response_schema": SupportTicketMatchResponse },
                ),
            ]
        )

        response = await caller.call(request, None, retries = 2)
        raw_output = response.get_output().get_data()

        return SupportTicketMatchResponse.model_validate_json(raw_output)

    def __build_user_prompt(self, report_text: str, candidate_tickets: list) -> str:
        if not candidate_tickets:
            return (
                "There are no existing open tickets to compare against, so this report opens a new ticket.\n"
                "Return matched_ticket_id = null, and write a clean title and description for the new ticket "
                "based only on the report below.\n\n"
                f"NEW REPORT:\n{report_text}\n"
            )

        candidate_lines = []
        for candidate in candidate_tickets:
            aspects = candidate.get("aspects") or []
            aspect_text = " ".join(str(aspect.get("text", "")) for aspect in aspects if isinstance(aspect, dict))

            candidate_lines.append(
                f"- id: {candidate['id']}\n"
                f"  type: {self.__issue_type_name(candidate.get('issueType', 0))}\n"
                f"  title: {candidate.get('title', '')}\n"
                f"  description: {candidate.get('description', '')}\n"
                f"  additional details already recorded: {aspect_text if aspect_text else '(none)'}\n"
                f"  reporters so far: {candidate.get('reportCount', 0)}"
            )

        return (
            f"NEW REPORT:\n{report_text}\n\n"
            f"EXISTING OPEN TICKETS (the only ids you may return):\n" + "\n".join(candidate_lines) + "\n\n"
            "Decide whether the new report is the SAME underlying problem as exactly one of these tickets. "
            "Return that ticket's id, or null if it is a different problem."
        )

    async def __merge_into_ticket(self, report: dict, matched_candidate: dict, match_response: SupportTicketMatchResponse, embedding_model) -> bool:
        now_milliseconds = int(time.time() * 1000)
        existing_aspects = matched_candidate.get("aspects") or []
        bAspectSaturated = len(existing_aspects) >= DeduplicateSupportTicket.MAXIMUM_ASPECTS_PER_TICKET

        new_aspect = None
        updated_description = str(matched_candidate.get("description", ""))
        updated_title = str(matched_candidate.get("title", ""))

        # Past the aspect ceiling the ticket stops absorbing text but keeps counting
        # reporters. Fifty distinct aspects means the grouping has become too coarse
        # and needs a human to split it, not more prose appended to it.
        if match_response.has_new_aspect and not bAspectSaturated:
            aspect_text = self.__clamp(match_response.new_aspect_text, DeduplicateSupportTicket.MAXIMUM_ASPECT_LENGTH)

            if aspect_text:
                new_aspect = { "text": aspect_text, "addedAt": now_milliseconds, "reportId": report["id"] }
                updated_description = self.__clamp(match_response.updated_description, DeduplicateSupportTicket.MAXIMUM_TICKET_DESCRIPTION_LENGTH) or updated_description
                updated_title = self.__clamp(match_response.suggested_title, DeduplicateSupportTicket.MAXIMUM_TITLE_LENGTH) or updated_title

        updated_fields = {
            "title": updated_title,
            "description": updated_description,
            "updatedAt": now_milliseconds,
            "lastReportedAt": now_milliseconds,
        }

        # Re-embedding is only worth its cost when the text actually moved; a merge
        # that added nothing new leaves the vector exactly as accurate as it was.
        if new_aspect is not None:
            updated_fields["embedding"] = self.__embed_document(embedding_model, f"{updated_title}. {updated_description}")
            updated_fields["embeddingUpdatedAt"] = now_milliseconds

        return await SupportTicketQueryEngine.merge_report_into_ticket(matched_candidate["id"], updated_fields, new_aspect)

    async def __create_ticket(self, report: dict, match_response: SupportTicketMatchResponse, embedding_model) -> str:
        now_milliseconds = int(time.time() * 1000)
        ticket_id = str(uuid.uuid4())

        description = self.__clamp(match_response.updated_description, DeduplicateSupportTicket.MAXIMUM_TICKET_DESCRIPTION_LENGTH)
        title = self.__clamp(match_response.suggested_title, DeduplicateSupportTicket.MAXIMUM_TITLE_LENGTH)

        # The reporter's own words are the fallback for both fields. An LLM that
        # returned nothing usable must not produce a blank, unreadable ticket.
        if not description:
            description = self.__clamp(str(report.get("description", "")), DeduplicateSupportTicket.MAXIMUM_TICKET_DESCRIPTION_LENGTH)
        if not title:
            title = self.__clamp(str(report.get("description", "")), DeduplicateSupportTicket.MAXIMUM_TITLE_LENGTH)

        ticket_document = {
            "id": ticket_id,
            "title": title,
            "description": description,
            "aspects": [],
            "issueType": int(report.get("issueType", 0)),
            "status": int(SupportTicketStatus.ACTIVE),
            "reportCount": 1,
            "embedding": self.__embed_document(embedding_model, f"{title}. {description}"),
            "embeddingUpdatedAt": now_milliseconds,
            "createdAt": now_milliseconds,
            "createdAtIsoString": self.__iso_string(now_milliseconds),
            "updatedAt": now_milliseconds,
            "lastReportedAt": now_milliseconds,
            "resolvedAt": None,
            "resolvedByUserId": "",
            "resolutionMessage": "",
            "creditsPerReporter": 0,
            "declinedAt": None,
            "declinedByUserId": "",
            "declineMessage": "",
            "dispatchState": None,
        }

        await SupportTicketQueryEngine.create_ticket(ticket_document)
        return ticket_id

    def __embed_document(self, embedding_model, text: str) -> list:
        return embedding_model.encode(
            [DeduplicateSupportTicket.EMBEDDING_DOCUMENT_PREFIX + text],
            convert_to_numpy = True,
            show_progress_bar = False
        )[0].tolist()

    def __clamp(self, raw_text, maximum_length: int) -> str:
        """
        Truncates at the last word boundary at or before the limit, so clamped model
        output ends on a whole word. Mirrors
        SupportTicketLimits.clampToWordBoundary on the Dock side.
        """
        text = str(raw_text or "").strip()

        if len(text) <= maximum_length:
            return text

        hard_truncation = text[:maximum_length]
        last_space_index = hard_truncation.rfind(" ")

        if last_space_index > maximum_length / 2:
            return hard_truncation[:last_space_index].strip()

        return hard_truncation.strip()

    def __iso_string(self, utc_milliseconds: int) -> str:
        return datetime.datetime.utcfromtimestamp(utc_milliseconds / 1000).isoformat(timespec = "milliseconds") + "Z"
