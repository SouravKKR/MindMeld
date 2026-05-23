const TaskSettings = require("../../Globals/Classes/Task/TaskSettings");
const FlashcardGenerationSettings = require("../../Globals/Classes/Task/AutoGeneration/FlashcardGenerationSettings");
const GeneralGenerationSettings = require("../../Globals/Classes/Task/AutoGeneration/GeneralGenerationSettings");
const MockTestGenerationSettings = require("../../Globals/Classes/Task/AutoGeneration/MockTestGenerationSettings");
const StudyMaterialGenerationSettings = require("../../Globals/Classes/Task/AutoGeneration/StudyMaterialGenerationSettings");
const ExtractableInformationSource = require("../../Globals/Classes/Decorators/ExtractableInformationSource");
const InformationSource = require("../../Globals/Model/InformationSource");
const TaskDescriptor = require("../../Globals/Classes/Task/TaskDescriptor");
const { taskStatus } = require("../../Globals/Enumerations/TaskStatus");
const { taskTypes } = require("../../Globals/Enumerations/TaskTypes");
const { informationSourceTypes } = require("../../Globals/Enumerations/InformationSourceTypes");
const { validateGenerationSettings } = require("../Helpers/ValidateGenerationSettings");
const { normalizeInformationSources } = require("../Helpers/NormalizeInformationSources");
const TaskManager = require("../../Globals/Classes/Task/TaskManager");
const TaskHistoryQueryEngine = require("../../Globals/Classes/Database/TaskHistoryQueryEngine");
const { taskExecutionTargets } = require("../../Globals/Enumerations/TaskExecutionTargets");
const { getUser } = require("../Helpers/GetUser");
const { moveToDatabase } = require("../Helpers/MoveToDatabase");


const VIRTUAL_WEB_SOURCE_TYPES = [
    informationSourceTypes.REPUTED_EXTERNAL_SOURCES,
    informationSourceTypes.ANYWHERE_ON_THE_INTERNET,
    informationSourceTypes.AI_GENERATED,
];


function buildVirtualWebSource(sourceTypeValue)
{
    return new ExtractableInformationSource({
        informationSource: new InformationSource({
            sourceType: sourceTypeValue,
            name: `virtual-${sourceTypeValue}`,
        }),
        pageRanges: [],
    });
}


async function handleGenerate(request, response)
{
    console.log("Generating...");
    const body = await request.getBody();

    const user = await getUser(request);

    if (!user)
    {
        response.statusCode = 401;
        response.end("Unauthorised.");
        return;
    }

    const { userRoles } = require("../../Globals/Enumerations/UserRoles");
    if (user.getRole() !== userRoles.ADMIN && user.getRole() !== userRoles.CREATOR)
    {
        response.statusCode = 403;
        response.end("Generation is restricted to authorized roles.");
        return;
    }

    const deckId = body["parentDeckId"] || "0";
    const userId = user.getId();

    let generalGenerationSettings = null;
    let flashcardGenerationSettings = null;
    let studyMaterialGenerationSettings = null;
    let mockTestGenerationSettings = null;

    const generalGenerationSettingsJson = body["generalGeneration"];
    generalGenerationSettings = GeneralGenerationSettings.fromJson(generalGenerationSettingsJson);

    const flashcardGenerationSettingsJson = body["flashcardGeneration"];
    if (flashcardGenerationSettingsJson !== null && typeof flashcardGenerationSettingsJson === "object")
    {
        flashcardGenerationSettings = FlashcardGenerationSettings.fromJson(flashcardGenerationSettingsJson);
    }

    const studyMaterialGenerationSettingsJson = body["studyMaterialGeneration"];
    if (studyMaterialGenerationSettingsJson !== null && typeof studyMaterialGenerationSettingsJson === "object")
    {
        studyMaterialGenerationSettings = StudyMaterialGenerationSettings.fromJson(studyMaterialGenerationSettingsJson);
    }

    const mockTestGenerationSettingsJson = body["mockTestGeneration"];
    if (mockTestGenerationSettingsJson !== null && typeof mockTestGenerationSettingsJson === "object")
    {
        mockTestGenerationSettings = MockTestGenerationSettings.fromJson(mockTestGenerationSettingsJson);
    }

    if (flashcardGenerationSettings === null && studyMaterialGenerationSettings === null && mockTestGenerationSettings === null)
    {
        response.statusCode = 400;
        response.end("No generation settings provided.");
        return;
    }

    try
    {
        validateGenerationSettings(
            generalGenerationSettings,
            flashcardGenerationSettings,
            studyMaterialGenerationSettings,
            mockTestGenerationSettings,
        );
    }
    catch (error)
    {
        response.statusCode = 400;
        response.end(error.message || String(error));
        return;
    }

    // ── Normalize: merge duplicate-hash entries, union overlapping page ranges ────
    const normalizedInformationSources = normalizeInformationSources(generalGenerationSettings.getInformationSources() || []);
    const normalizedImageSources = normalizeInformationSources(generalGenerationSettings.getImageSources() || []);

    // ── Description-only: when the user supplies no info sources, auto-enable web/AI ──
    let effectiveInformationSources = normalizedInformationSources;
    if (effectiveInformationSources.length === 0)
    {
        effectiveInformationSources = VIRTUAL_WEB_SOURCE_TYPES.map(sourceTypeValue => buildVirtualWebSource(sourceTypeValue));
        console.log("[Generate] No information sources provided — auto-enabling web/reputed/AI sources for description-driven generation.");
    }

    generalGenerationSettings.setInformationSources(effectiveInformationSources);
    generalGenerationSettings.setImageSources(normalizedImageSources);

    // Re-serialize so downstream tasks see the normalized payload
    const normalizedGeneralGenerationJson = generalGenerationSettings.toJson();

    // ── Build per-document similarity-search prep tasks (uploaded PDFs only) ─────
    // OCR is performed at upload time and the GCS object is already the
    // OCR'd copy by the time we get here — Generate.js no longer schedules
    // OCR_PDF tasks. Every chunker/image-extractor/topic-mapper just reads
    // the same GCS path and transparently sees the OCR'd bytes.
    const prepareForSimilaritySearchTasks = [];

    for (const extractableSource of effectiveInformationSources)
    {
        const sourceType = extractableSource.getInformationSource().getSourceType();

        if (sourceType !== informationSourceTypes.PROVIDED_DOCUMENTS)
        {
            continue;
        }

        const sourcePayload = extractableSource.toJson();

        const prepareForSimilaritySearchTask = new TaskDescriptor({
            type: taskTypes.PREPARE_FOR_SIMILARITY_SEARCH,
            executionTarget: taskExecutionTargets.LOCAL,
            payload: sourcePayload,
            nextTaskIds: [],
        });

        await TaskManager.setTask(prepareForSimilaritySearchTask);
        prepareForSimilaritySearchTasks.push(prepareForSimilaritySearchTask);
    }

    const mapTopicToContentTask = new TaskDescriptor({
        type: taskTypes.MAP_TOPICS_WITH_CONTENT,
        executionTarget: taskExecutionTargets.LOCAL,
        payload: normalizedGeneralGenerationJson,
        nextTaskIds: [],
    });

    await TaskManager.setTask(mapTopicToContentTask);

    const preparationSuccessorTaskIds = prepareForSimilaritySearchTasks.map(task => task.getId());

    const processSyllabusTaskDescriptor = new TaskDescriptor({
        type: taskTypes.PROCESS_SYLLABUS,
        executionTarget: taskExecutionTargets.LOCAL,
        payload: normalizedGeneralGenerationJson,
        nextTaskIds: [mapTopicToContentTask.getId(), ...preparationSuccessorTaskIds],
    });

    await TaskManager.setTask(processSyllabusTaskDescriptor);

    const mainTaskDescriptor = new TaskDescriptor({
        type: taskTypes.PREPARE_FOR_GENERATION,
        executionTarget: taskExecutionTargets.LOCAL,
        userId: userId,
        payload: normalizedGeneralGenerationJson,
        nextTaskIds: [processSyllabusTaskDescriptor.getId()],
    });

    await TaskManager.setTask(mainTaskDescriptor);
    await TaskManager.trackForUser(userId, mainTaskDescriptor.getId());

    let flashcardGenerationTask = null;
    let studyMaterialGenerationTask = null;
    let mockTestGenerationTask = null;

    // ── Image sources: respect inherit-image-curriculum (now pageRanges-aware) ────
    const inheritImageCurriculum = generalGenerationSettings.getInheritImageCurriculumFromInformationSources() !== false;

    const resolvedImageSourceJsons = normalizedImageSources.map(imageSource =>
    {
        const imageSourceJson = imageSource.toJson();

        if (!inheritImageCurriculum)
        {
            return imageSourceJson;
        }

        const imagePageRanges = imageSource.getPageRanges() || [];
        const imageHasExplicitRange = imagePageRanges.length > 0 && imagePageRanges.some(pageRange => !(pageRange.getStartPage() === 0 && pageRange.getEndPage() === 0));

        if (imageHasExplicitRange)
        {
            return imageSourceJson;
        }

        const matchingInfoSource = effectiveInformationSources.find(infoSource =>
        {
            return infoSource.getInformationSource().getHash() === imageSource.getInformationSource().getHash();
        });

        if (!matchingInfoSource)
        {
            return imageSourceJson;
        }

        const infoSourcePageRanges = matchingInfoSource.getPageRanges() || [];
        const infoHasExplicitRange = infoSourcePageRanges.length > 0 && infoSourcePageRanges.some(pageRange => !(pageRange.getStartPage() === 0 && pageRange.getEndPage() === 0));

        if (!infoHasExplicitRange)
        {
            return imageSourceJson;
        }

        return {
            ...imageSourceJson,
            pageRanges: infoSourcePageRanges.map(pageRange => pageRange.toJson()),
        };
    });

    // Web sources can also contribute images (downloaded into Tasks/<id>/web_cache/images/
    // by FetchWebContent and consumed by PrepareImages without touching the figures MongoDB
    // collection). Schedule PrepareImages whenever PDF image sources OR web sources are active.
    const hasWebImageSource = effectiveInformationSources.some(extractableSource =>
    {
        const sourceType = extractableSource.getInformationSource().getSourceType();
        return (
            sourceType === informationSourceTypes.ANYWHERE_ON_THE_INTERNET
            || sourceType === informationSourceTypes.REPUTED_EXTERNAL_SOURCES
        );
    });

    // Master kill-switch: when the user unchecked "Capture Images / Diagrams"
    // in the generation page we skip PrepareImages entirely, even if image
    // sources or web sources happen to be present.
    const captureImagesEnabled = generalGenerationSettings.getCaptureImagesEnabled() !== false;

    const shouldPrepareImages = captureImagesEnabled && (normalizedImageSources.length > 0 || hasWebImageSource);

    // "Enhance Images" runs AFTER PrepareImages and re-synthesizes each
    // embedded <figure> through Gemini so the published artwork is no
    // longer a direct copy of the source asset. The original bytes still
    // land in GCS / the figures collection (that work happens inside
    // PrepareImages, before EnhanceImages ever runs) -- only the inline
    // base64 inside flashcard.question/answer and studyMaterial.content
    // is rewritten.
    const enhanceImagesEnabled = generalGenerationSettings.getEnhanceImages() === true;

    // Single image-pipeline tasks shared across both scopes (flashcards +
    // study materials). Both source PDFs and the Gemini work are identical
    // for the two outputs -- running them in two separate per-scope tasks
    // wasted PDF rendering AND doubled the Gemini cost of EnhanceImages.
    // The unified tasks are scheduled here but NOT chained into the gen
    // subtree (fan-in from flashcardGen + studyMaterialGen would
    // double-execute, since the executor has no claim/dedup guard). They
    // are kicked off manually in the post-execute callback below, after
    // the entire gen tree resolves.
    const hasFlashcardScope = (flashcardGenerationSettings !== null);
    const hasStudyMaterialScope = (studyMaterialGenerationSettings !== null);

    let prepareImagesTask = null;
    let enhanceImagesTask = null;

    if (shouldPrepareImages && (hasFlashcardScope || hasStudyMaterialScope))
    {
        if (enhanceImagesEnabled)
        {
            enhanceImagesTask = new TaskDescriptor({
                type: taskTypes.ENHANCE_IMAGES,
                executionTarget: taskExecutionTargets.LOCAL,
                payload: {
                    generateFlashcards: hasFlashcardScope,
                    generateStudyMaterials: hasStudyMaterialScope,
                },
                nextTaskIds: [],
            });

            await TaskManager.setTask(enhanceImagesTask);
        }

        prepareImagesTask = new TaskDescriptor({
            type: taskTypes.PREPARE_IMAGES,
            executionTarget: taskExecutionTargets.LOCAL,
            payload: {
                imageSources: resolvedImageSourceJsons,
                generateFlashcards: hasFlashcardScope,
                generateStudyMaterials: hasStudyMaterialScope,
            },
            nextTaskIds: enhanceImagesTask ? [enhanceImagesTask.getId()] : [],
        });

        await TaskManager.setTask(prepareImagesTask);
    }

    if (flashcardGenerationSettings !== null)
    {
        console.log("Generating flashcards...");

        flashcardGenerationTask = new TaskDescriptor({
            type: taskTypes.GENERATE_FLASHCARDS,
            executionTarget: taskExecutionTargets.LOCAL,
            payload: flashcardGenerationSettingsJson,
            nextTaskIds: [],
        });

        mapTopicToContentTask.setNextTaskIds([...mapTopicToContentTask.getNextTaskIds(), flashcardGenerationTask.getId()]);

        await TaskManager.setTask(flashcardGenerationTask);
        await TaskManager.updateTask(mapTopicToContentTask);
    }

    if (studyMaterialGenerationSettings !== null)
    {
        console.log("Generating study materials...");

        studyMaterialGenerationTask = new TaskDescriptor({
            type: taskTypes.GENERATE_STUDY_MATERIAL,
            executionTarget: taskExecutionTargets.LOCAL,
            payload: studyMaterialGenerationSettingsJson,
            nextTaskIds: [],
        });

        mapTopicToContentTask.setNextTaskIds([...mapTopicToContentTask.getNextTaskIds(), studyMaterialGenerationTask.getId()]);

        await TaskManager.setTask(studyMaterialGenerationTask);
        await TaskManager.updateTask(mapTopicToContentTask);
    }

    if (mockTestGenerationSettings !== null)
    {
        console.log("Generating mock tests...");

        mockTestGenerationTask = new TaskDescriptor({
            type: taskTypes.GENERATE_MOCK_TESTS,
            executionTarget: taskExecutionTargets.LOCAL,
            payload: mockTestGenerationSettingsJson,
            nextTaskIds: [],
        });

        mapTopicToContentTask.setNextTaskIds([...mapTopicToContentTask.getNextTaskIds(), mockTestGenerationTask.getId()]);

        await TaskManager.setTask(mockTestGenerationTask);
        await TaskManager.updateTask(mapTopicToContentTask);
    }

    const mainTaskId = mainTaskDescriptor.getId();

    response.sendJson({taskId: mainTaskId});

    TaskManager.execute(mainTaskDescriptor)
    .then(async () =>
    {
        console.log(`[Generate] Pipeline complete for task ${mainTaskId}. Moving to database...`);

        const completedTask = await TaskManager.getTask(mainTaskId);

        if (generalGenerationSettings.getGoodQualityDeckShortNames())
        {
            try
            {
                const beautifyDeckShortNamesTask = new TaskDescriptor({
                    type: taskTypes.BEAUTIFY_DECK_SHORT_NAMES,
                    executionTarget: taskExecutionTargets.LOCAL,
                    userId: userId,
                    payload: {},
                    nextTaskIds: [],
                });

                await TaskManager.setTask(beautifyDeckShortNamesTask);
                await TaskManager.execute(beautifyDeckShortNamesTask, 0, completedTask, mainTaskId);

                console.log(`[Generate] Beautified deck short names for task ${mainTaskId}.`);
            }
            catch (beautificationError)
            {
                console.warn(`[Generate] Deck short name beautification failed for ${mainTaskId} — falling back to deterministic names: ${beautificationError.message}`);
            }
        }

        // Run the unified image pipeline AFTER the gen tree resolves and
        // BEFORE moveToDatabase, so the JSON files moveToDatabase reads
        // already carry the enhanced base64 (when "Enhance Images" was
        // checked) or the injected originals (when only "Capture Images"
        // was checked). Same parent-task-id pattern as
        // beautifyDeckShortNamesTask above so the activity tree nests
        // the image work under the main task.
        if (prepareImagesTask)
        {
            try
            {
                await TaskManager.execute(prepareImagesTask, 0, completedTask, mainTaskId);
                console.log(`[Generate] Image pipeline complete for task ${mainTaskId}.`);
            }
            catch (imagePipelineError)
            {
                console.error(`[Generate] Image pipeline failed for ${mainTaskId}: ${imagePipelineError.message}`);
                // Continue to moveToDatabase so the user still gets a deck
                // with whatever image state was reached. The failed image
                // task is visible in the activity tree.
            }
        }

        await moveToDatabase(
            userId,
            mainTaskId,
            deckId,
            completedTask,
            flashcardGenerationSettings,
            studyMaterialGenerationSettings,
            mockTestGenerationSettings,
        );

        console.log(`[Generate] Database move complete for task ${mainTaskId}.`);

        try
        {
            await TaskHistoryQueryEngine.recordCompletion(completedTask);
        }
        catch (historyError)
        {
            console.error(`[Generate] Failed to record taskHistory for ${mainTaskId}: ${historyError.message}`);
        }
        await TaskManager.untrackForUser(userId, mainTaskId);
    })
    .catch(async (error) =>
    {
        console.error(`[Generate] Background pipeline error for task ${mainTaskId}:`, error);
        try
        {
            const failedTask = await TaskManager.getTask(mainTaskId);
            await TaskHistoryQueryEngine.recordCompletion(failedTask);
        }
        catch (historyError)
        {
            console.error(`[Generate] Failed to record taskHistory (failure path) for ${mainTaskId}: ${historyError.message}`);
        }
        await TaskManager.untrackForUser(userId, mainTaskId);
    });
}


module.exports = {handleGenerate};
