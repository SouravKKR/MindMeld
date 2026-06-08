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
from Workflows.Workflow import Workflow

from Globals.Utility.ArgumentParser import argument_parser
from Globals.Utility.SetupEnvironment import setup_environment

import json

load_dotenv()


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
        if bFailed:
            task_descriptor.set_status(TaskStatus.FAILED)
        else:
            task_descriptor.set_status(TaskStatus.COMPLETED)
            task_descriptor.set_completion(1.0)
        await TaskManager.set_task(task_descriptor)
        return


if __name__ == "__main__":
    asyncio.run(main())