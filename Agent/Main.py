import asyncio
import sys
from dotenv import load_dotenv

from Globals.Utility.AgentLogger import initialize as initialize_agent_logger

# Must run before any other module prints — installs the no-op `print` in production
# and the flushing `print` in debug mode.
initialize_agent_logger()

# MuPDF parser-warning silencing used to live here unconditionally, which
# paid the ~0.5s fitz native-binding cost on every agent subprocess launch
# even for tasks that never touch a PDF (analysis, embedding-only,
# curated-study, etc.). Each fitz-using workflow now calls
# MuPdfBootstrap.silence_parser_warnings() at the start of its run() —
# the call is idempotent and lazy-imports fitz on first invocation, so
# the cost is only paid where it's needed.


from Globals.Enumerations.TaskStatus import TaskStatus
from Globals.Classes.Task.TaskDescriptor import TaskDescriptor
from Globals.Classes.Task.TaskManager import TaskManager
from Globals.Enumerations.TaskTypes import TaskTypes
from Globals.Classes.Credits.CreditConfigurationStore import CreditConfigurationStore
from Globals.Classes.Credits.CreditLedger import CreditLedger
from Globals.Classes.Credits.TaskCreditCharger import TaskCreditCharger
from Workflows.Workflow import Workflow

from Globals.Utility.ArgumentParser import argument_parser
from Globals.Utility.SetupEnvironment import setup_environment

import json

load_dotenv()


async def evaluate_credit_gate(task_descriptor: TaskDescriptor, task_type: TaskTypes) -> dict:
    """
    Decides what the credit subsystem should do for this task:
      - {"action": "allow_free"}  — no rule configured → run unmetered.
      - {"action": "deny", "error": ...}  — rule disabled (SERVICE_DISABLED) or
        the user lacks the minimum balance to run (INSUFFICIENT_CREDITS).
      - {"action": "charge", "charger": TaskCreditCharger}  — enabled rule.
    Never raises — a credit-subsystem fault must not take a task down, so it
    falls back to allowing the task.
    """
    try:
        configuration = await CreditConfigurationStore.load()
        if configuration is None:
            return {"action": "allow_free"}

        rule = configuration.get_rule_for_task(int(task_type.value))

        # No rule configured at all → unmetered → run free.
        if rule is None:
            return {"action": "allow_free"}

        # Rule present but disabled → the service is denied, not free.
        if not rule.get_enabled():
            return {"action": "deny", "error": "SERVICE_DISABLED"}

        user_id = task_descriptor.get_user_id()

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
        return {"action": "allow_free"}


async def main():
    command_line_args: dict = argument_parser(sys.argv)
    setup_environment(command_line_args)
    await TaskManager.initialize()

    workflow: Workflow = None

    task_descriptor: TaskDescriptor = await TaskManager.get_current_task()

    task_type: TaskTypes = task_descriptor.get_type() if task_descriptor is not None else TaskTypes.UNKNOWN

    # Mark as in progress before any work begins so the frontend shows the correct state
    task_descriptor.set_status(TaskStatus.IN_PROGRESS)
    await TaskManager.set_task(task_descriptor)

    # ── Credits: gate + per-task charging ──────────────────────────────────
    # The Agent subprocess is the only thing alive during the run, so all
    # per-task deduction timings are driven from here. A disabled rule denies
    # the task; an enabled one gates on the minimum-balance-to-run, then
    # charges per its timing (ON_START up front, AT_INTERVALS via a background
    # loop, ON_SUCCESS / ON_ANY_COMPLETION settled in the finally block).
    credit_charger = None
    credit_gate = await evaluate_credit_gate(task_descriptor, task_type)
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
        match task_type:
            case TaskTypes.PREPARE_FOR_GENERATION:
                print("PREPARE_FOR_GENERATION")
                from Workflows.PrepareForGeneration.PrepareForGeneration import PrepareForGeneration
                workflow = PrepareForGeneration(task_descriptor.get_payload())

            case TaskTypes.PROCESS_SYLLABUS:
                print("PROCESS_SYLLABUS")
                from Workflows.ProcessSyllabus.ProcessSyllabus import ProcessSyllabus
                workflow = ProcessSyllabus(task_descriptor.get_payload())

            case TaskTypes.MAP_TOPICS_WITH_CONTENT:
                print("MAP_TOPICS_WITH_CONTENT")
                from Workflows.MapTopicsWithContent.MapTopicsWithContent import MapTopicsWithContent
                workflow = MapTopicsWithContent(task_descriptor.get_payload())

            case TaskTypes.PREPARE_FOR_SIMILARITY_SEARCH:
                print("PREPARE_FOR_SIMILARITY_SEARCH")
                from Workflows.PrepareForSimilaritySearch.PrepareForSimilaritySearch import PrepareForSimilaritySearch
                workflow = PrepareForSimilaritySearch(task_descriptor.get_payload())

            case TaskTypes.GENERATE_FLASHCARDS:
                print("GENERATE_FLASHCARDS")
                from Workflows.GenerateFlashcards.GenerateFlashcards import GenerateFlashcards
                workflow = GenerateFlashcards(task_descriptor.get_payload())

            case TaskTypes.FLASHCARD_GENERATION_WORKER:
                print("FLASHCARD_GENERATION_WORKER")
                from Workflows.FlashcardGenerationWorker.FlashcardGenerationWorker import FlashcardGenerationWorker
                workflow = FlashcardGenerationWorker(task_descriptor.get_payload())

            case TaskTypes.GENERATE_STUDY_MATERIAL:
                print("GENERATE_STUDY_MATERIAL")
                from Workflows.GenerateStudyMaterial.GenerateStudyMaterial import GenerateStudyMaterial
                workflow = GenerateStudyMaterial(task_descriptor.get_payload())

            case TaskTypes.STUDY_MATERIAL_GENERATION_WORKER:
                print("STUDY_MATERIAL_GENERATION_WORKER")
                from Workflows.StudyMaterialGenerationWorker.StudyMaterialGenerationWorker import StudyMaterialGenerationWorker
                workflow = StudyMaterialGenerationWorker(task_descriptor.get_payload())

            case TaskTypes.GENERATE_MOCK_TESTS:
                print("GENERATE_MOCK_TESTS")
                from Workflows.GenerateMockTests.GenerateMockTests import GenerateMockTests
                workflow = GenerateMockTests(task_descriptor.get_payload())

            case TaskTypes.MOCK_TEST_GENERATION_WORKER:
                print("MOCK_TEST_GENERATION_WORKER")
                from Workflows.MockTestGenerationWorker.MockTestGenerationWorker import MockTestGenerationWorker
                workflow = MockTestGenerationWorker(task_descriptor.get_payload())

            case TaskTypes.PREPARE_IMAGES:
                print("PREPARE_IMAGES")
                from Workflows.PrepareImages.PrepareImages import PrepareImages
                workflow = PrepareImages(task_descriptor.get_payload())

            case TaskTypes.JUDGE_SHADOW_PAIRS:
                print("JUDGE_SHADOW_PAIRS")
                from Workflows.JudgeShadowPairs.JudgeShadowPairs import JudgeShadowPairs
                workflow = JudgeShadowPairs(task_descriptor.get_payload())

            case TaskTypes.FETCH_WEB_CONTENT:
                print("FETCH_WEB_CONTENT")
                from Workflows.FetchWebContent.FetchWebContent import FetchWebContent
                workflow = FetchWebContent(task_descriptor.get_payload())

            case TaskTypes.OCR_PDF:
                print("OCR_PDF")
                from Workflows.OcrPdf.OcrPdf import OcrPdf
                workflow = OcrPdf(task_descriptor.get_payload())

            case TaskTypes.BEAUTIFY_DECK_SHORT_NAMES:
                print("BEAUTIFY_DECK_SHORT_NAMES")
                from Workflows.BeautifyDeckShortNames.BeautifyDeckShortNames import BeautifyDeckShortNames
                workflow = BeautifyDeckShortNames(task_descriptor.get_payload())

            case TaskTypes.ANALYZE_DECK_PERFORMANCE:
                print("ANALYZE_DECK_PERFORMANCE")
                from Workflows.AnalyzeDeckPerformance.AnalyzeDeckPerformance import AnalyzeDeckPerformance
                workflow = AnalyzeDeckPerformance(task_descriptor.get_payload())

            case TaskTypes.GENERATE_CURATED_STUDY_MATERIAL:
                print("GENERATE_CURATED_STUDY_MATERIAL")
                from Workflows.GenerateCuratedStudyMaterial.GenerateCuratedStudyMaterial import GenerateCuratedStudyMaterial
                workflow = GenerateCuratedStudyMaterial(task_descriptor.get_payload())

            case TaskTypes.ENHANCE_IMAGES:
                print("ENHANCE_IMAGES")
                from Workflows.EnhanceImages.EnhanceImages import EnhanceImages
                workflow = EnhanceImages(task_descriptor.get_payload())

            case TaskTypes.EVALUATE_MOCK_TEST_ATTEMPT:
                print("EVALUATE_MOCK_TEST_ATTEMPT")
                from Workflows.EvaluateMockTestAttempt.EvaluateMockTestAttempt import EvaluateMockTestAttempt
                workflow = EvaluateMockTestAttempt(task_descriptor.get_payload())

            case _:
                print("Invalid workflow")

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

        if bFailed:
            task_descriptor.set_status(TaskStatus.FAILED)
        else:
            task_descriptor.set_status(TaskStatus.COMPLETED)
            task_descriptor.set_completion(1.0)
        await TaskManager.set_task(task_descriptor)
        return


if __name__ == "__main__":
    asyncio.run(main())