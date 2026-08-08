import os
import time

from Globals.Enumerations.TaskStatus import TaskStatus
from Globals.Classes.Task.TaskDescriptor import TaskDescriptor
from Globals.Classes.Task.TaskManager import TaskManager
from Globals.Enumerations.TaskTypes import TaskTypes
from Globals.Classes.Credits.CreditConfigurationStore import CreditConfigurationStore
from Globals.Classes.Credits.CreditLedger import CreditLedger
from Globals.Classes.Credits.CreditMeter import CreditMeter
from Globals.Classes.Credits.TaskCreditCharger import TaskCreditCharger
from Globals.Classes.Credits.TaskUsageReporter import TaskUsageReporter
from Workflows.Workflow import Workflow


class TaskRunner:
    """
    The single, reusable task-execution path shared by both the one-shot
    Agent/Main.py launcher (local development and nested child subprocesses) and
    the long-lived Agent/Worker.py poller. It takes a fully-resolved
    TaskDescriptor as a parameter — it never reads the ambient TASK_ID — so the
    same dispatch logic works whether the descriptor came from a CLI argument or
    from a claimed queue envelope. The big workflow match block lives here exactly
    once.
    """

    @staticmethod
    async def _resolve_owning_user_id(task_descriptor: TaskDescriptor) -> str:
        """
        Resolves the account a task's usage belongs to. Child tasks in a
        generation tree are created without a userId — only the main task
        carries it — so an absent id is inherited from the main task. Without
        this a child task with a minimum-balance rule is wrongly denied
        (INSUFFICIENT_CREDITS), and any per-task charge silently no-ops because
        CreditLedger ignores an empty user.
        """
        user_id = task_descriptor.get_user_id()
        if user_id:
            return user_id

        main_task_id = os.getenv("MAIN_TASK_ID")
        if not main_task_id:
            return ""

        main_task = await TaskManager.get_task(main_task_id)
        if main_task is None:
            return ""

        return main_task.get_user_id() or ""

    @staticmethod
    async def _is_paid_deck_generation(task_descriptor: TaskDescriptor) -> bool:
        """
        True when this task belongs to a paid-deck generation run.

        Paid-deck generation is an ADMIN-side authoring operation — the operator
        is producing catalogue content, not consuming the product — so it is
        never charged. The flag lives on the run's GeneralGenerationSettings and
        reaches tasks two different ways: the main task's payload IS the
        settings JSON (see PrepareForGeneration.__init__), while some child
        payloads carry a copy of the flag directly (PrepareImages reads
        payload["paidDeckMode"]). Both are checked, because neither alone covers
        every task in the tree.
        """
        own_payload = task_descriptor.get_payload() or {}
        if own_payload.get("paidDeckMode") is True:
            return True

        main_task_id = os.getenv("MAIN_TASK_ID")
        if not main_task_id or main_task_id == task_descriptor.get_id():
            return False

        main_task = await TaskManager.get_task(main_task_id)
        if main_task is None:
            return False

        main_payload = main_task.get_payload() or {}
        return main_payload.get("paidDeckMode") is True

    @staticmethod
    async def _evaluate_credit_gate(task_descriptor: TaskDescriptor, task_type: TaskTypes) -> dict:
        """
        Decides what the credit subsystem should do for this task:
          - {"action": "allow_free", "reason": ...}  — no rule configured → run unmetered.
          - {"action": "exempt", "reason": ...}  — chargeable in principle, but this
            run is never billed (paid-deck authoring).
          - {"action": "deny", "error": ...}  — rule disabled (SERVICE_DISABLED) or
            the user lacks the minimum balance to run (INSUFFICIENT_CREDITS).
          - {"action": "charge", "charger": TaskCreditCharger}  — enabled rule.
        Never raises — a credit-subsystem fault must not take a task down, so it
        falls back to allowing the task.
        """
        try:
            # Checked FIRST, ahead of the rule lookup and the balance gate. A
            # paid-deck run must not be refused for a balance it should never
            # have needed, and the exemption is a property of the run rather
            # than of the pricing configuration.
            if await TaskRunner._is_paid_deck_generation(task_descriptor):
                return {"action": "exempt", "reason": TaskUsageReporter.BILLING_NOTE_PAID_DECK}

            configuration = await CreditConfigurationStore.load()
            if configuration is None:
                return {"action": "allow_free", "reason": TaskUsageReporter.BILLING_NOTE_NO_RULE}

            rule = configuration.get_rule_for_task(int(task_type.value))

            # No rule configured at all → unmetered → run free.
            if rule is None:
                return {"action": "allow_free", "reason": TaskUsageReporter.BILLING_NOTE_NO_RULE}

            # Rule present but disabled → the service is denied, not free.
            if not rule.get_enabled():
                return {"action": "deny", "error": "SERVICE_DISABLED"}

            user_id = await TaskRunner._resolve_owning_user_id(task_descriptor)

            # Entry requirement: the user must already hold at least this much.
            minimum_to_run = rule.get_minimum_balance_to_run()
            if minimum_to_run > 0:
                balance = await CreditLedger.get_balance(user_id)
                if balance is None or balance < minimum_to_run:
                    return {"action": "deny", "error": "INSUFFICIENT_CREDITS"}

            charger = TaskCreditCharger(
                user_id = user_id,
                task_id = task_descriptor.get_id(),
                task_type = int(task_type.value),
                rule = rule,
            )
            return {"action": "charge", "charger": charger}
        except Exception as credit_error:
            print(f"[Credits] gate evaluation failed: {credit_error}")
            return {"action": "allow_free", "reason": TaskUsageReporter.BILLING_NOTE_NO_RULE}


    @staticmethod
    def _build_workflow(task_type: TaskTypes, payload: dict) -> Workflow:
        """
        Constructs the workflow instance for the given task type. Imports are kept
        lazy (inside each branch) so a single task only pays the import cost of the
        one workflow it runs — matching the original Main.py behavior.
        """
        match task_type:
            case TaskTypes.PREPARE_FOR_GENERATION:
                print("PREPARE_FOR_GENERATION")
                from Workflows.PrepareForGeneration.PrepareForGeneration import PrepareForGeneration
                return PrepareForGeneration(payload)

            case TaskTypes.PROCESS_SYLLABUS:
                print("PROCESS_SYLLABUS")
                from Workflows.ProcessSyllabus.ProcessSyllabus import ProcessSyllabus
                return ProcessSyllabus(payload)

            case TaskTypes.MAP_TOPICS_WITH_CONTENT:
                print("MAP_TOPICS_WITH_CONTENT")
                from Workflows.MapTopicsWithContent.MapTopicsWithContent import MapTopicsWithContent
                return MapTopicsWithContent(payload)

            case TaskTypes.PREPARE_FOR_SIMILARITY_SEARCH:
                print("PREPARE_FOR_SIMILARITY_SEARCH")
                from Workflows.PrepareForSimilaritySearch.PrepareForSimilaritySearch import PrepareForSimilaritySearch
                return PrepareForSimilaritySearch(payload)

            case TaskTypes.GENERATE_FLASHCARDS:
                print("GENERATE_FLASHCARDS")
                from Workflows.GenerateFlashcards.GenerateFlashcards import GenerateFlashcards
                return GenerateFlashcards(payload)

            case TaskTypes.FLASHCARD_GENERATION_WORKER:
                print("FLASHCARD_GENERATION_WORKER")
                from Workflows.FlashcardGenerationWorker.FlashcardGenerationWorker import FlashcardGenerationWorker
                return FlashcardGenerationWorker(payload)

            case TaskTypes.GENERATE_STUDY_MATERIAL:
                print("GENERATE_STUDY_MATERIAL")
                from Workflows.GenerateStudyMaterial.GenerateStudyMaterial import GenerateStudyMaterial
                return GenerateStudyMaterial(payload)

            case TaskTypes.STUDY_MATERIAL_GENERATION_WORKER:
                print("STUDY_MATERIAL_GENERATION_WORKER")
                from Workflows.StudyMaterialGenerationWorker.StudyMaterialGenerationWorker import StudyMaterialGenerationWorker
                return StudyMaterialGenerationWorker(payload)

            case TaskTypes.GENERATE_MOCK_TESTS:
                print("GENERATE_MOCK_TESTS")
                from Workflows.GenerateMockTests.GenerateMockTests import GenerateMockTests
                return GenerateMockTests(payload)

            case TaskTypes.MOCK_TEST_GENERATION_WORKER:
                print("MOCK_TEST_GENERATION_WORKER")
                from Workflows.MockTestGenerationWorker.MockTestGenerationWorker import MockTestGenerationWorker
                return MockTestGenerationWorker(payload)

            case TaskTypes.PREPARE_IMAGES:
                print("PREPARE_IMAGES")
                from Workflows.PrepareImages.PrepareImages import PrepareImages
                return PrepareImages(payload)

            case TaskTypes.JUDGE_SHADOW_PAIRS:
                print("JUDGE_SHADOW_PAIRS")
                from Workflows.JudgeShadowPairs.JudgeShadowPairs import JudgeShadowPairs
                return JudgeShadowPairs(payload)

            case TaskTypes.FETCH_WEB_CONTENT:
                print("FETCH_WEB_CONTENT")
                from Workflows.FetchWebContent.FetchWebContent import FetchWebContent
                return FetchWebContent(payload)

            case TaskTypes.OCR_PDF:
                print("OCR_PDF")
                from Workflows.OcrPdf.OcrPdf import OcrPdf
                return OcrPdf(payload)

            case TaskTypes.BEAUTIFY_DECK_SHORT_NAMES:
                print("BEAUTIFY_DECK_SHORT_NAMES")
                from Workflows.BeautifyDeckShortNames.BeautifyDeckShortNames import BeautifyDeckShortNames
                return BeautifyDeckShortNames(payload)

            case TaskTypes.ANALYZE_DECK_PERFORMANCE:
                print("ANALYZE_DECK_PERFORMANCE")
                from Workflows.AnalyzeDeckPerformance.AnalyzeDeckPerformance import AnalyzeDeckPerformance
                return AnalyzeDeckPerformance(payload)

            case TaskTypes.GENERATE_CURATED_STUDY_MATERIAL:
                print("GENERATE_CURATED_STUDY_MATERIAL")
                from Workflows.GenerateCuratedStudyMaterial.GenerateCuratedStudyMaterial import GenerateCuratedStudyMaterial
                return GenerateCuratedStudyMaterial(payload)

            case TaskTypes.ENHANCE_IMAGES:
                print("ENHANCE_IMAGES")
                from Workflows.EnhanceImages.EnhanceImages import EnhanceImages
                return EnhanceImages(payload)

            case TaskTypes.EVALUATE_MOCK_TEST_ATTEMPT:
                print("EVALUATE_MOCK_TEST_ATTEMPT")
                from Workflows.EvaluateMockTestAttempt.EvaluateMockTestAttempt import EvaluateMockTestAttempt
                return EvaluateMockTestAttempt(payload)

            case TaskTypes.TRANSCRIBE_MOCK_TEST_ATTEMPT:
                print("TRANSCRIBE_MOCK_TEST_ATTEMPT")
                from Workflows.TranscribeMockTestAttempt.TranscribeMockTestAttempt import TranscribeMockTestAttempt
                return TranscribeMockTestAttempt(payload)

            case TaskTypes.DEDUPLICATE_SUPPORT_TICKET:
                print("DEDUPLICATE_SUPPORT_TICKET")
                from Workflows.DeduplicateSupportTicket.DeduplicateSupportTicket import DeduplicateSupportTicket
                return DeduplicateSupportTicket(payload)

            case TaskTypes.PAID_DECK_VERIFICATION:
                print("PAID_DECK_VERIFICATION")
                from Workflows.PaidDeckVerification.PaidDeckVerification import PaidDeckVerification
                return PaidDeckVerification(payload)

            case TaskTypes.PAID_DECK_SOURCE_VERIFICATION:
                print("PAID_DECK_SOURCE_VERIFICATION")
                from Workflows.PaidDeckSourceVerification.PaidDeckSourceVerification import PaidDeckSourceVerification
                return PaidDeckSourceVerification(payload)

            case _:
                print("Invalid workflow")
                return None


    @staticmethod
    async def run_task(task_descriptor: TaskDescriptor):
        """
        Runs a single task end to end: marks it IN_PROGRESS, applies the credit
        gate, builds and runs the matching workflow, then settles credits and
        writes the terminal status. Mirrors the original Main.py control flow
        exactly so behavior is unchanged for the one-shot path.
        """
        if task_descriptor is None:
            print("TaskRunner.run_task called with no task descriptor; nothing to do.")
            return

        task_type: TaskTypes = task_descriptor.get_type()
        task_start_time = time.time()

        # The meter is process-global and the long-lived Agent/Worker.py runs
        # task after task in one interpreter, so without this the next task
        # inherits the previous one's tokens and is billed for work it never
        # did. Reset before the gate, so even a task that is denied leaves a
        # clean meter behind it.
        CreditMeter.reset()

        # Mark as in progress before any work begins so the frontend shows the correct state
        task_descriptor.set_status(TaskStatus.IN_PROGRESS)
        await TaskManager.set_task(task_descriptor)

        # ── Credits: gate + per-task charging ──────────────────────────────────
        credit_charger = None
        credit_gate = await TaskRunner._evaluate_credit_gate(task_descriptor, task_type)
        if credit_gate["action"] == "deny":
            print(f"Task denied by credit gate: {credit_gate['error']}")
            task_descriptor.set_status(TaskStatus.FAILED)
            task_descriptor.set_payload({"error": credit_gate["error"]})
            await TaskManager.set_task(task_descriptor)
            return
        if credit_gate["action"] == "charge":
            credit_charger = credit_gate["charger"]
            bChargeAllowed = await credit_charger.charge_on_start()
            if not bChargeAllowed:
                print("Task refused before start: insufficient credits.")
                task_descriptor.set_status(TaskStatus.FAILED)
                task_descriptor.set_payload({"error": "INSUFFICIENT_CREDITS"})
                await TaskManager.set_task(task_descriptor)
                return
            credit_charger.begin_interval_charging()

        bFailed = False

        try:
            workflow = TaskRunner._build_workflow(task_type, task_descriptor.get_payload())

            if workflow is None:
                raise ValueError(f"No workflow registered for task type {task_type}")

            await workflow.run()
        except Exception as exception:
            print(f"Exception: {exception}")
            import traceback
            traceback.print_exc()
            task_descriptor.set_payload({"error": str(exception)})
            bFailed = True

        finally:
            # Settle the completion-time charge (and stop any interval loop)
            # before the task's final status is written.
            if credit_charger is not None:
                try:
                    await credit_charger.settle(bFailed)
                except Exception as settle_error:
                    print(f"[Credits] settle failed: {settle_error}")
            else:
                # Free task — unmetered (no spend rule) or exempt (paid-deck).
                # It still made real model calls, so its usage is reported with
                # credits = 0 and the reason it was not billed. Without this the
                # spend is invisible: TaskCreditCharger.settle is the only other
                # place an AI_REQUEST record is written, and it never runs here.
                await TaskUsageReporter.report(
                    user_id = await TaskRunner._resolve_owning_user_id(task_descriptor),
                    task_id = task_descriptor.get_id(),
                    task_type = int(task_type.value),
                    start_time = task_start_time,
                    credits_charged = 0,
                    b_failed = bFailed,
                    billing_note = credit_gate.get("reason", ""),
                )

            if bFailed:
                task_descriptor.set_status(TaskStatus.FAILED)
            else:
                task_descriptor.set_status(TaskStatus.COMPLETED)
                task_descriptor.set_completion(1.0)
            await TaskManager.set_task(task_descriptor)
