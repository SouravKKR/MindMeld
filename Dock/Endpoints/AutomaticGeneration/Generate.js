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
const CreditPreflight = require("../../Globals/Classes/Credits/CreditPreflight");
const TaskStateManager = require("../../Globals/Classes/Task/TaskStateManager");
const { taskExecutionTargets } = require("../../Globals/Enumerations/TaskExecutionTargets");
const { getUser } = require("../Helpers/GetUser");
const { moveToDatabase } = require("../Helpers/MoveToDatabase");
const GenerationOutcomeInspector = require("../Helpers/GenerationOutcomeInspector");
const { clearPartialCompletionOnDecks } = require("../Helpers/ClearPartialCompletion");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");
const MaintenanceGate = require("../../Globals/Classes/Maintenance/MaintenanceGate");
const PlanEntitlementGate = require("../../Globals/Classes/Plans/PlanEntitlementGate");
const { planFeatures } = require("../../Globals/Enumerations/PlanFeatures");
const NotificationDispatcher = require("../../Globals/Classes/Notifications/NotificationDispatcher");
const NotificationContent = require("../../Globals/Classes/Notifications/NotificationContent");
const { notificationChannels } = require("../../Globals/Enumerations/NotificationChannels");
const PaidDeckGenerationGate = require("../../Globals/Classes/Generation/PaidDeckGenerationGate");


const VIRTUAL_WEB_SOURCE_TYPES = [
    informationSourceTypes.REPUTED_EXTERNAL_SOURCES,
    informationSourceTypes.ANYWHERE_ON_THE_INTERNET,
    informationSourceTypes.AI_GENERATED,
];


// Main task ids of generations THIS Dock process is actively orchestrating (its
// background pipeline below is alive). A resumable snapshot is saved at the start
// of every run so a restart-orphaned run can be recovered — but while the run is
// still being driven here it must NOT be presented to the user as "interrupted".
// The /TaskState endpoint consults this so the home PausedTaskBanner suppresses
// the interrupted prompt for a live run (the user watches it from Activity
// instead). After a restart this set is empty, so a genuinely orphaned run does
// surface the resume prompt. In-process only — correct because the orchestration
// it tracks is also in-process.
const activeGenerationMainTaskIds = new Set();

function isGenerationRunning(mainTaskId)
{
    return typeof mainTaskId === "string" && activeGenerationMainTaskIds.has(mainTaskId);
}


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


/**
 * Builds a /Generate request body that re-runs ONLY the output scopes that
 * failed, merging into the same parent deck (so SyllabusFingerprintMatcher
 * reuses the existing partial subtree and the dedup in GeneratedEntityUpserter
 * suppresses any overlap with what was already kept). The general settings are
 * carried forward verbatim — re-mapping topics is required to regenerate the
 * missing content type.
 *
 * @param {string} parentDeckId
 * @param {object} generalGenerationJson
 * @param {string[]} failedScopes  subset of the scope body-keys
 * @param {{ [scopeKey: string]: (object|null) }} scopeJsonByKey
 * @returns {object}
 */
function buildRetryBody(parentDeckId, generalGenerationJson, failedScopes, scopeJsonByKey)
{
    const retryBody =
    {
        parentDeckId: parentDeckId,
        generalGeneration: generalGenerationJson,
    };

    for (const scopeKey of failedScopes)
    {
        if (scopeJsonByKey[scopeKey] !== null && typeof scopeJsonByKey[scopeKey] === "object")
        {
            retryBody[scopeKey] = scopeJsonByKey[scopeKey];
        }
    }

    return retryBody;
}


async function handleGenerate(request, response)
{
    console.log("Generating...");
    const body = await request.getBody();

    const user = await getUser(request);

    if (!user)
    {
        response.statusCode = httpStatus.UNAUTHORIZED;
        response.end("Unauthorised.");
        return;
    }

    // AI generation is open to every signed-in user — affordability is
    // enforced authoritatively below by CreditPreflight (and per-task by the
    // Agent). The closed-test admin/creator role lock has been retired now
    // that the credits system is live.

    // Scheduled-maintenance gate. Blocks STARTING new work only — tasks already
    // in flight are untouched (this runs at endpoint entry, never inside the DAG).
    const activeMaintenanceWindow = await MaintenanceGate.getActiveWindow();
    if (activeMaintenanceWindow !== null)
    {
        response.statusCode = httpStatus.SERVICE_UNAVAILABLE;
        response.sendJson(MaintenanceGate.buildMaintenanceResponsePayload(activeMaintenanceWindow));
        return;
    }

    const deckId = body["parentDeckId"] || "0";
    const userId = user.getId();

    // Checkpoint-resume: a resumed run carries the paused run's main task id so
    // the whole pipeline reuses the same Tasks/{mainTaskId}/ GCS namespace and
    // every already-generated item is found and skipped (continue from midway
    // instead of re-running). Null on a normal first run.
    const resumeMainTaskId = body["resumeMainTaskId"] || null;

    // A "retry the rest" run carries the ids of the partial decks to clear once
    // it succeeds (see PartialGenerationRetryFlow / MoveToDatabase). Its presence
    // also marks this as a retry, which lets the survivors fold back into the
    // existing partial subtree even when the user generated at the root deck.
    const clearPartialCompletionDeckIds = Array.isArray(body["clearPartialCompletionDeckIds"]) ? body["clearPartialCompletionDeckIds"] : [];
    const bIsRetry = clearPartialCompletionDeckIds.length > 0;

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
        response.statusCode = httpStatus.BAD_REQUEST;
        response.end("No generation settings provided.");
        return;
    }

    // ── Phase 0: paid-deck mode admission ─────────────────────────────────────
    // Re-authorised here against the STORED user record, the same way /Admin/*
    // routes are gated. Runs BEFORE validateGenerationSettings so a non-admin
    // gets "you can't use this mode" rather than a confusing message about
    // source types. The source restriction itself is enforced inside
    // validateGenerationSettings, so it also covers any other caller of it.
    const bPaidDeckMode = PaidDeckGenerationGate.isRequested(generalGenerationSettings);

    if (bPaidDeckMode)
    {
        const paidDeckAuthorization = PaidDeckGenerationGate.authorize(user);
        if (!paidDeckAuthorization.allowed)
        {
            response.statusCode = httpStatus.FORBIDDEN;
            response.sendJson({ error: paidDeckAuthorization.reason });
            return;
        }
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
        response.statusCode = httpStatus.BAD_REQUEST;
        response.end(error.message || String(error));
        return;
    }

    // Plan entitlement: automatic generation is a Pro-tier feature. Refuse a
    // lower tier with FEATURE_NOT_IN_PLAN (403) BEFORE the credit preflight so
    // the user sees an upgrade prompt rather than an out-of-credits message.
    // Re-authorized server-side against the stored plan; the client is never
    // trusted.
    const generationEntitlement = await PlanEntitlementGate.requireFeature(userId, planFeatures.AUTOMATIC_GENERATION);
    if (!generationEntitlement.allowed)
    {
        response.statusCode = httpStatus.FORBIDDEN;
        response.sendJson({ error: generationEntitlement.reason, currentTier: generationEntitlement.currentTier, requiredTier: generationEntitlement.requiredTier });
        return;
    }

    // ── Normalize: merge duplicate-hash entries, union overlapping page ranges ────
    const normalizedInformationSources = normalizeInformationSources(generalGenerationSettings.getInformationSources() || []);
    let normalizedImageSources = normalizeInformationSources(generalGenerationSettings.getImageSources() || []);

    // Paid-deck mode generates its own visuals and must never extract figures
    // from an uploaded document. Image sources are stripped here rather than
    // refused, because the generation page mirrors the information sources into
    // them whenever "inherit image sources" is on — the default — so refusing
    // would fail the request over a value the admin never chose. Clearing the
    // list is what actually guarantees PrepareImages has nothing to extract
    // from; the log records what was dropped.
    if (bPaidDeckMode)
    {
        const strippedImageSources = PaidDeckGenerationGate.stripImageSources(normalizedImageSources);
        if (strippedImageSources.droppedCount > 0)
        {
            console.log(
                `[Generate] Paid-deck mode: dropped ${strippedImageSources.droppedCount} inherited image source(s). ` +
                `Visuals are generated from the coverage summaries, never extracted from an upload.`,
            );
        }
        normalizedImageSources = strippedImageSources.imageSources;
    }

    // ── Description-only: when the user supplies no info sources, auto-enable web/AI ──
    // Paid-deck mode is deliberately excluded from this fallback. Auto-enabling
    // open web sources would put arbitrary third-party text back into content
    // that gets sold — the exact thing Phase 0 exists to make structurally
    // impossible. The gate already refuses a paid-deck run with no sources, so
    // this branch is unreachable there; the condition states the invariant
    // rather than relying on that.
    let effectiveInformationSources = normalizedInformationSources;
    if (!bPaidDeckMode && effectiveInformationSources.length === 0)
    {
        effectiveInformationSources = VIRTUAL_WEB_SOURCE_TYPES.map(sourceTypeValue => buildVirtualWebSource(sourceTypeValue));
        console.log("[Generate] No information sources provided — auto-enabling web/reputed/AI sources for description-driven generation.");
    }

    generalGenerationSettings.setInformationSources(effectiveInformationSources);
    generalGenerationSettings.setImageSources(normalizedImageSources);

    // Plan entitlement: image extraction ("Capture Images / Diagrams") is a
    // Pro Plus feature. Gate only when this run will actually produce images
    // — the master switch is on AND a PDF image source or a web image source
    // is present — so a lower tier generating from text is never blocked. This
    // mirrors the shouldPrepareImages decision below but runs BEFORE the credit
    // preflight (so a lower tier sees an upgrade prompt, not a 402) and before
    // any task is scheduled (so a rejection can never orphan a task).
    const runWillGenerateImages = generalGenerationSettings.getCaptureImagesEnabled() !== false
        && (normalizedImageSources.length > 0 || effectiveInformationSources.some(extractableSource =>
        {
            const sourceType = extractableSource.getInformationSource().getSourceType();
            return sourceType === informationSourceTypes.ANYWHERE_ON_THE_INTERNET
                || sourceType === informationSourceTypes.REPUTED_EXTERNAL_SOURCES;
        }));
    if (runWillGenerateImages)
    {
        const imageEntitlement = await PlanEntitlementGate.requireFeature(userId, planFeatures.IMAGE_GENERATION);
        if (!imageEntitlement.allowed)
        {
            response.statusCode = httpStatus.FORBIDDEN;
            response.sendJson({ error: imageEntitlement.reason, currentTier: imageEntitlement.currentTier, requiredTier: imageEntitlement.requiredTier });
            return;
        }
    }

    // Best-effort credit gate on the pipeline's entry task. The Agent
    // charges each task authoritatively; this just refuses an obviously
    // unaffordable generation up front. Runs AFTER the plan gates so a
    // tier-locked feature reports FEATURE_NOT_IN_PLAN (403) ahead of a 402.
    const creditPreflight = await CreditPreflight.check(userId, taskTypes.PREPARE_FOR_GENERATION);
    if (!creditPreflight.allowed)
    {
        // Out-of-credits is recoverable: save a resumable task state so the
        // user can resume this exact generation after topping up. A disabled
        // service is a permanent refusal, so it is NOT saved.
        const bIsResumable = creditPreflight.reason === ErrorCodes.INSUFFICIENT_CREDITS;
        if (bIsResumable)
        {
            try { await TaskStateManager.save({ userId: userId, taskType: taskTypes.PREPARE_FOR_GENERATION, route: "/Generate", payload: body, pausedReason: creditPreflight.reason }); }
            catch (saveError) { console.warn(`[Generate] Failed to save resumable task state: ${saveError.message}`); }

            // Leave a persistent in-app record so the user can find + resume this
            // later. In-app only — they already have the inline 402 on screen now.
            try { await NotificationDispatcher.dispatch(userId, NotificationContent.outOfCredits("generation"), notificationChannels.IN_APP); }
            catch (notifyError) { console.warn(`[Generate] Failed to dispatch out-of-credits notification: ${notifyError.message}`); }
        }
        response.statusCode = httpStatus.PAYMENT_REQUIRED;
        response.sendJson({ error: creditPreflight.reason, balance: creditPreflight.balance, required: creditPreflight.required, resumable: bIsResumable });
        return;
    }

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

    if (resumeMainTaskId)
    {
        // Reuse the paused run's id so this run reads/writes the same GCS
        // namespace. Clear any stale Redis state first so the fresh setTask(NX)
        // lands and the old paused (FAILED/USER_PAUSED) blob can't shadow it.
        mainTaskDescriptor._restoreId_id(resumeMainTaskId);
        await TaskManager.resetForResume(resumeMainTaskId);
    }

    await TaskManager.setTask(mainTaskDescriptor);
    await TaskManager.trackForUser(userId, mainTaskDescriptor.getId());

    // Save a resumable snapshot at the START so a run orphaned by a Dock
    // restart/crash (the in-process pipeline below dies with the server, so its
    // completion handler — which writes taskHistory and clears this state — never
    // runs) stays both visible and resumable from the home PausedTaskBanner.
    // Carries resumeMainTaskId so a resume reuses the same GCS namespace and
    // skips already-finished stages. Cleared on every outcome the handler below
    // actually reaches (success, partial, or handled failure); only a true
    // interruption leaves it behind. The credit/pause handlers overwrite it with
    // their own precise reason (single-slot per user), so this never hides those.
    try
    {
        await TaskStateManager.save({
            userId: userId,
            taskType: taskTypes.PREPARE_FOR_GENERATION,
            route: "/Generate",
            payload: { ...body, resumeMainTaskId: mainTaskDescriptor.getId() },
            pausedReason: TaskManager.INTERRUPTED_REASON,
        });
    }
    catch (startStateError)
    {
        console.warn(`[Generate] Failed to save start resumable state for ${mainTaskDescriptor.getId()}: ${startStateError.message}`);
    }

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

    // Paid-deck mode has no image sources and no web sources by construction, so
    // the normal predicate would skip PrepareImages entirely. It must still run:
    // in this mode the stage generates the visuals the Phase 1 coverage summaries
    // declared (symbolic diagrams, formulae, illustrations) instead of extracting
    // figures from a PDF, then places them through the SAME page-less placement
    // path web-sourced images already use. One stage, two sources of figures —
    // not a second image pipeline.
    const shouldPrepareImages = captureImagesEnabled
        && (bPaidDeckMode || normalizedImageSources.length > 0 || hasWebImageSource);

    // "Enhance Images" runs AFTER PrepareImages and re-synthesizes each
    // embedded <figure> through Gemini so the published artwork is no
    // longer a direct copy of the source asset. The original bytes still
    // land in GCS / the figures collection (that work happens inside
    // PrepareImages, before EnhanceImages ever runs) -- only the inline
    // base64 inside flashcard.question/answer and studyMaterial.content
    // is rewritten.
    //
    // Forced off in paid-deck mode: enhancement exists to stop source artwork
    // from being republished verbatim, and a visual this pipeline generated is
    // already first-party. Re-synthesising it would only risk degrading a
    // diagram that was produced — and vision-verified — to be exact.
    const enhanceImagesEnabled = !bPaidDeckMode && generalGenerationSettings.getEnhanceImages() === true;

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
                // Switches PrepareImages from "extract figures from the source
                // PDFs" to "generate the visuals the coverage summaries asked
                // for". Placement, vision verification and injection are shared.
                paidDeckMode: bPaidDeckMode,
                // Grounds generated visuals in the right discipline — "cell"
                // means something different in Biology and in Electronics.
                subjectName: generalGenerationSettings.getSubjectName() || "",
                // Scopes inferred visuals to what the target exam expects a
                // student to be able to read and draw.
                examName: generalGenerationSettings.getExamName() || "",
                // When enhance is enabled, PrepareImages writes a JSON
                // sidecar of figure assignments instead of injecting
                // the originals into the per-task study-material and
                // flashcard JSONs. EnhanceImages later reads the
                // sidecar, fetches each figure's bytes from GCS,
                // enhances them, and injects the enhanced figures
                // directly. This avoids the wasted write/re-rewrite
                // cycle and keeps un-enhanced source artwork out of
                // every intermediate JSON.
                enhanceImagesEnabled: enhanceImagesEnabled,
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

    // Bracket the entire pipeline (main tree + beautify + image work +
    // moveToDatabase) with a Redis marker so GetProgress can keep
    // reporting the tree as not-yet-complete until the very last
    // database write lands. Without this the frontend flips to "done"
    // the moment the main tree resolves, which is ~2 minutes before
    // the user's deck actually exists in Mongo.
    await TaskManager.markPostPipelinePending(mainTaskId);

    // Register the top-level post-pipeline task ids so GetProgress
    // can surface real per-stage progress (PREPARE_IMAGES →
    // ENHANCE_IMAGES, BEAUTIFY_DECK_SHORT_NAMES) instead of a flat
    // synthetic placeholder. prepareImagesTask already has
    // enhanceImagesTask chained as a nextTaskIds child, so storing
    // the prepareImages id alone surfaces the entire image subtree
    // when GetProgress walks it.
    const postPipelineTaskIds = [];
    if (prepareImagesTask)
    {
        postPipelineTaskIds.push(prepareImagesTask.getId());
    }
    if (postPipelineTaskIds.length > 0)
    {
        await TaskManager.registerPostPipelineTasks(mainTaskId, postPipelineTaskIds);
    }

    response.sendJson({taskId: mainTaskId});

    // Mark this run as actively driven by this process so its start-saved
    // resumable snapshot isn't shown as "interrupted" while it's still running.
    activeGenerationMainTaskIds.add(mainTaskId);

    TaskManager.execute(mainTaskDescriptor)
    .then(async (pipelineSucceeded) =>
    {
        // If the pipeline stopped because the user ran out of credits mid-run,
        // save a resumable snapshot of this exact generation and stop here.
        // Partial output must NOT be persisted to the user's library, and the
        // run is resumed (re-submitted) after a top-up via ProgressPage's
        // out-of-credits flow or the PausedTaskBanner.
        if (await TaskManager.hasInsufficientCreditsFailure(mainTaskId))
        {
            console.log(`[Generate] Task ${mainTaskId} paused — out of credits. Saving resumable state.`);

            try
            {
                await TaskStateManager.save({
                    userId: userId,
                    taskType: taskTypes.PREPARE_FOR_GENERATION,
                    route: "/Generate",
                    // Carry the main task id so Resume continues from midway,
                    // reusing every item already staged under Tasks/{mainTaskId}/.
                    payload: { ...body, resumeMainTaskId: mainTaskId },
                    pausedReason: TaskManager.INSUFFICIENT_CREDITS_REASON,
                });
            }
            catch (saveError)
            {
                console.warn(`[Generate] Failed to save resumable task state for ${mainTaskId}: ${saveError.message}`);
            }

            try
            {
                const pausedTask = await TaskManager.getTask(mainTaskId);
                if (pausedTask)
                {
                    await TaskHistoryQueryEngine.recordCompletion(pausedTask);
                }
            }
            catch (historyError)
            {
                console.error(`[Generate] Failed to record taskHistory (paused path) for ${mainTaskId}: ${historyError.message}`);
            }

            await TaskManager.untrackForUser(userId, mainTaskId);
            return;
        }

        // If the user manually paused this run, the chain stopped launching new
        // stages. Save a resumable snapshot (same machinery as the credit pause)
        // and stop here WITHOUT moving partial output to the user's library. The
        // root is flagged USER_PAUSED so the progress page shows a paused (not
        // failed) terminal state, and the home-screen banner offers Resume.
        //
        // Gate on pipelineSucceeded === false: the pause gate returns false only
        // when it actually skipped not-yet-started work. A pause clicked after
        // the run already finished leaves pipelineSucceeded true, so a completed
        // generation is never discarded by a late click.
        if (pipelineSucceeded === false && await TaskManager.isPaused(mainTaskId))
        {
            console.log(`[Generate] Task ${mainTaskId} paused by user. Saving resumable state.`);

            try
            {
                await TaskStateManager.save({
                    userId: userId,
                    taskType: taskTypes.PREPARE_FOR_GENERATION,
                    route: "/Generate",
                    // Carry the main task id so Resume continues from midway,
                    // reusing every item already staged under Tasks/{mainTaskId}/.
                    payload: { ...body, resumeMainTaskId: mainTaskId },
                    pausedReason: TaskManager.USER_PAUSED_REASON,
                });
            }
            catch (saveError)
            {
                console.warn(`[Generate] Failed to save resumable task state for paused ${mainTaskId}: ${saveError.message}`);
            }

            try
            {
                const pausedTask = await TaskManager.getTask(mainTaskId);
                if (pausedTask)
                {
                    pausedTask.setStatus(taskStatus.FAILED);
                    const existingPayload = pausedTask.getPayload() || {};
                    pausedTask.setPayload({ ...existingPayload, error: TaskManager.USER_PAUSED_REASON });
                    await TaskManager.updateTask(pausedTask);
                    await TaskHistoryQueryEngine.recordCompletion(pausedTask);
                }
            }
            catch (historyError)
            {
                console.error(`[Generate] Failed to settle paused task ${mainTaskId}: ${historyError.message}`);
            }

            await TaskManager.clearPaused(mainTaskId);
            await TaskManager.untrackForUser(userId, mainTaskId);
            return;
        }

        console.log(`[Generate] Pipeline complete for task ${mainTaskId}. Moving to database...`);

        // ── Per-scope outcome inspection ──────────────────────────────────────
        // A multi-output run (flashcards + study material + mock tests) can
        // have one sibling fail while the others succeed. The pipeline does NOT
        // abort the survivors, so their staged output is real and worth keeping.
        // Walk the finished task tree to classify each requested scope, then
        // (below) keep what exists and either stamp a partialCompletion marker
        // or, when nothing usable was produced, mark the whole run FAILED — so
        // partial output is never silently presented as a bare success/failure.
        const scopeTaskIdsByKey =
        {
            flashcardGeneration: flashcardGenerationTask ? flashcardGenerationTask.getId() : null,
            studyMaterialGeneration: studyMaterialGenerationTask ? studyMaterialGenerationTask.getId() : null,
            mockTestGeneration: mockTestGenerationTask ? mockTestGenerationTask.getId() : null,
        };

        const scopeOutcome = await GenerationOutcomeInspector.inspect(mainTaskId, scopeTaskIdsByKey);

        // pipelineSucceeded is the boolean TaskManager.execute resolves to; a
        // false here with no classified scope failure means an auxiliary task
        // (e.g. a similarity-search prep) failed without affecting any output
        // type, which we treat as success since the user got everything asked.
        if (pipelineSucceeded === false && scopeOutcome.failedScopes.length === 0)
        {
            console.warn(`[Generate] Task ${mainTaskId} reported a non-scope failure but every requested output type completed — treating as success.`);
        }

        let generationFailureContext = null;
        if (scopeOutcome.failedScopes.length > 0)
        {
            generationFailureContext =
            {
                mainTaskId: mainTaskId,
                completedScopes: scopeOutcome.completedScopes,
                failedScopes: scopeOutcome.failedScopes,
                retryBody: buildRetryBody(
                    deckId,
                    normalizedGeneralGenerationJson,
                    scopeOutcome.failedScopes,
                    {
                        flashcardGeneration: flashcardGenerationSettingsJson,
                        studyMaterialGeneration: studyMaterialGenerationSettingsJson,
                        mockTestGeneration: mockTestGenerationSettingsJson,
                    },
                ),
            };
        }

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
        //
        // IPR safety: when ENHANCE_IMAGES is part of the pipeline, an
        // image-pipeline failure means some figures still carry the
        // un-enhanced copyrighted source artwork. Persisting that
        // partial state would leak the originals into the user's
        // library, so we mark the entire Generate as FAILED and skip
        // moveToDatabase. The staged JSON files in Tasks/{mainTaskId}/
        // are left behind for the next retry to consume or for cleanup
        // to garbage-collect; the user's cards/studyMaterials
        // collections are unaffected.
        if (prepareImagesTask)
        {
            // TaskManager.execute resolves to a boolean (false on failure) and
            // does NOT throw for a task that ends FAILED — it swallows the error
            // internally and returns false. So the image outcome must be read from
            // the return value; the try/catch only guards an unexpected throw in
            // the call setup (which we also treat as "did not complete").
            let imagePipelineSucceeded = false;
            try
            {
                // No wall-clock cap here: a figure-heavy deck can legitimately take
                // a long time to enhance and MUST be allowed to finish (enhancement
                // is bounded-concurrent and each per-figure API call carries its own
                // timeout). The only backstops are execute()'s own — the 3h queue
                // await ceiling and the local-subprocess kill-timeout — both high
                // enough that they only ever trip a genuinely wedged run, never
                // legitimate slow work. A true wedge still resolves false and drops
                // into the resumable image-failure path below.
                imagePipelineSucceeded = await TaskManager.execute(prepareImagesTask, 0, completedTask, mainTaskId);
            }
            catch (imagePipelineError)
            {
                console.error(`[Generate] Image pipeline threw for ${mainTaskId}: ${imagePipelineError.message}`);
                imagePipelineSucceeded = false;
            }

            // Hold the whole run for resume ONLY in the reported case: every
            // requested text scope succeeded and just the images failed. When a
            // text scope ALSO failed (generationFailureContext set), fall through
            // to the existing partial-completion path below so the survivors are
            // still kept and a "retry the rest" is offered — that behaviour is
            // left unchanged.
            if (imagePipelineSucceeded === false && generationFailureContext === null)
            {
                // Every text stage succeeded but the post-pipeline image step did
                // not complete — either it failed (e.g. the image service was
                // disabled) or the user paused mid-image-step (execute's pause gate
                // also returns false). We must NOT run moveToDatabase: persisting
                // now would skip the images the user asked for and, when
                // EnhanceImages is in the pipeline, leak un-enhanced copyrighted
                // originals into the library. Instead of dead-ending the run, save
                // a resumable snapshot (the same machinery as the user-pause /
                // out-of-credits stops) so the user can Resume later — the resumed
                // run reuses this Tasks/{mainTaskId}/ GCS namespace, skips every
                // already-finished text stage, and re-runs only the image step.
                //
                // Distinguish the two causes so the banner words itself correctly
                // and a genuine pause clears its own flag. Both are resumable and
                // re-run identically.
                const bWasPaused = await TaskManager.isPaused(mainTaskId);
                const resumableReason = bWasPaused ? TaskManager.USER_PAUSED_REASON : TaskManager.IMAGE_PREPARATION_FAILED_REASON;

                console.error(`[Generate] Image pipeline did not complete for ${mainTaskId} (${bWasPaused ? "paused" : "failed"}) — saving a resumable snapshot so the images can be finished later.`);

                try
                {
                    await TaskStateManager.save({
                        userId: userId,
                        taskType: taskTypes.PREPARE_FOR_GENERATION,
                        route: "/Generate",
                        // Carry the main task id so Resume continues from midway,
                        // reusing every item already staged under Tasks/{mainTaskId}/.
                        payload: { ...body, resumeMainTaskId: mainTaskId },
                        pausedReason: resumableReason,
                    });
                }
                catch (saveError)
                {
                    console.warn(`[Generate] Failed to save resumable task state for image-incomplete ${mainTaskId}: ${saveError.message}`);
                }

                try
                {
                    const failedMainTask = await TaskManager.getTask(mainTaskId);
                    if (failedMainTask)
                    {
                        failedMainTask.setStatus(taskStatus.FAILED);
                        const existingPayload = failedMainTask.getPayload() || {};
                        failedMainTask.setPayload({ ...existingPayload, error: resumableReason });
                        await TaskManager.updateTask(failedMainTask);
                        await TaskHistoryQueryEngine.recordCompletion(failedMainTask);
                    }
                }
                catch (settleError)
                {
                    console.error(`[Generate] Failed to settle image-incomplete task ${mainTaskId}: ${settleError.message}`);
                }

                if (bWasPaused)
                {
                    await TaskManager.clearPaused(mainTaskId);
                }
                await TaskManager.untrackForUser(userId, mainTaskId);

                // Return (do NOT fall through): skips moveToDatabase (nothing
                // persisted — IPR-safe) and skips the success tail that would
                // delete the resumable snapshot. The .finally still clears the
                // post-pipeline marker and drops this run from the live-generation
                // set, so the home PausedTaskBanner surfaces the Resume prompt.
                return;
            }

            if (imagePipelineSucceeded)
            {
                console.log(`[Generate] Image pipeline complete for task ${mainTaskId}.`);
            }
            else
            {
                // Images did not complete AND a text scope also failed: fall
                // through to the partial-completion path below, which persists the
                // survivors and stamps the "retry the rest" marker (unchanged).
                console.warn(`[Generate] Image pipeline did not complete for ${mainTaskId}, but a text scope also failed — persisting survivors via the partial-completion path.`);
            }
        }

        // ── Phase 6: verification (paid-deck runs only) ───────────────────────
        // Runs after all content exists and after the image pipeline, so it sees
        // the same text a student would. Deliberately NOT allowed to fail the
        // run: a verification stage that can destroy a completed generation
        // creates pressure to switch it off. An unreachable verifier records
        // itself as an unverified gap instead, and the publish gate refuses to
        // publish a deck whose verification did not complete.
        if (bPaidDeckMode)
        {
            try
            {
                const verificationTask = new TaskDescriptor({
                    type: taskTypes.PAID_DECK_VERIFICATION,
                    executionTarget: taskExecutionTargets.LOCAL,
                    userId: userId,
                    payload: { subjectName: generalGenerationSettings.getSubjectName() || "" },
                    nextTaskIds: [],
                });

                await TaskManager.setTask(verificationTask);
                await TaskManager.execute(verificationTask, 0, completedTask, mainTaskId);

                console.log(`[Generate] Paid-deck verification complete for task ${mainTaskId}.`);
            }
            catch (verificationError)
            {
                console.error(`[Generate] Paid-deck verification failed for ${mainTaskId} (continuing to persist): ${verificationError.message}`);
            }
        }

        const moveResult = await moveToDatabase(
            userId,
            mainTaskId,
            deckId,
            completedTask,
            flashcardGenerationSettings,
            studyMaterialGenerationSettings,
            mockTestGenerationSettings,
            generationFailureContext,
            bIsRetry,
            generalGenerationSettings,
        );

        console.log(`[Generate] Database move complete for task ${mainTaskId}.`);

        // A retry that fully succeeded must drop the partial badge from the
        // decks the original partial run flagged — done explicitly by id so it
        // works even when this retry built no deck rows of its own (e.g. a
        // mock-tests-only retry whose bundle just attaches to an existing deck).
        if (bIsRetry && generationFailureContext === null)
        {
            try
            {
                await clearPartialCompletionOnDecks(userId, clearPartialCompletionDeckIds);
                console.log(`[Generate] Cleared partial-completion marker on ${clearPartialCompletionDeckIds.length} deck(s) after successful retry of ${mainTaskId}.`);
            }
            catch (clearError)
            {
                console.error(`[Generate] Failed to clear partial-completion markers for ${mainTaskId}: ${clearError.message}`);
            }
        }

        // ── Settle the run's terminal state for failed-sibling runs ───────────
        if (generationFailureContext !== null)
        {
            const partialCompletion = moveResult ? moveResult.partialCompletion : null;
            const settledTask = await TaskManager.getTask(mainTaskId);
            const existingPayload = settledTask.getPayload() || {};

            if (partialCompletion)
            {
                // Survivors were kept. The task's own work finished, so it stays
                // COMPLETED; the marker carries the failed-sibling story that the
                // frontend turns into a "kept N, retry the rest" prompt.
                settledTask.setPayload({ ...existingPayload, partialCompletion: partialCompletion });
                console.log(`[Generate] Task ${mainTaskId} completed partially — failed scopes: ${generationFailureContext.failedScopes.join(", ")}.`);
            }
            else
            {
                // A failure occurred and nothing usable was produced — a genuine
                // total failure.
                settledTask.setStatus(taskStatus.FAILED);
                settledTask.setPayload({ ...existingPayload, error: existingPayload.error || "Generation failed before any content could be created." });
                console.log(`[Generate] Task ${mainTaskId} failed — no usable content produced.`);
            }

            await TaskManager.updateTask(settledTask);
        }

        // Tracks whether this run genuinely produced content, so the
        // completion notification below fires only on real success (never on a
        // FAILED settle). Set inside the history try where the final status is
        // known.
        let bGenerationSucceeded = false;

        try
        {
            // Re-fetch so the archived record reflects any FAILED/partial status
            // just written above rather than the stale completedTask snapshot.
            const taskForHistory = await TaskManager.getTask(mainTaskId);

            // Settle a deep (spine) failure that the no-op root would otherwise
            // hide. A MapTopics failure makes execute() resolve false but leaves
            // every output SCOPE merely NOT_STARTED — so the failed-scope branch
            // above doesn't fire and the root stays COMPLETED, archiving a broken
            // run as "Completed" with no decks. Only flip to FAILED when a node
            // actually failed AND nothing usable was kept (no partialCompletion),
            // so a genuine success or a kept-partial run is never clobbered.
            if (taskForHistory && taskForHistory.getStatus() !== taskStatus.FAILED)
            {
                const settleRootPayload = (taskForHistory.getPayload && taskForHistory.getPayload()) || {};
                const bTreeHasFailure = (await TaskManager.computeActiveTreeStatus(mainTaskId)) === taskStatus.FAILED;
                if (bTreeHasFailure && !settleRootPayload.partialCompletion)
                {
                    taskForHistory.setStatus(taskStatus.FAILED);
                    taskForHistory.setPayload({ ...settleRootPayload, error: settleRootPayload.error || "Generation failed before any content could be created." });
                    await TaskManager.updateTask(taskForHistory);
                }
            }

            bGenerationSucceeded = taskForHistory && taskForHistory.getStatus() !== taskStatus.FAILED;

            await TaskHistoryQueryEngine.recordCompletion(taskForHistory);
        }
        catch (historyError)
        {
            console.error(`[Generate] Failed to record taskHistory for ${mainTaskId}: ${historyError.message}`);
        }
        await TaskManager.untrackForUser(userId, mainTaskId);

        // Notify the user their study set is ready on every channel. This is the
        // promise the progress page makes — it tells the user to close the page
        // and carry on studying — so it has to reach them once the app is shut,
        // and email is the only channel that reliably does today (device push
        // has no client-side token registration yet; see NotificationDispatcher).
        // Success only; never throws into the pipeline.
        if (bGenerationSucceeded)
        {
            try
            {
                await NotificationDispatcher.dispatch(userId, NotificationContent.generationComplete(deckId), NotificationDispatcher.IN_APP_AND_PUSH_AND_EMAIL);
            }
            catch (notifyError)
            {
                console.warn(`[Generate] Failed to dispatch generation-complete notification for ${mainTaskId}: ${notifyError.message}`);
            }
        }
        // The completion handler finished, so this run is NOT orphaned — clear the
        // start-saved resumable snapshot. (Credit/pause stops returned earlier and
        // keep their own saved state.)
        try { await TaskStateManager.delete(userId); }
        catch (clearError) { console.warn(`[Generate] Failed to clear resumable state for ${mainTaskId}: ${clearError.message}`); }
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
        // Handled failure (not an orphaned interruption) — clear the start-saved
        // resumable snapshot so a failed run doesn't leave a stale resume banner.
        try { await TaskStateManager.delete(userId); }
        catch (clearError) { console.warn(`[Generate] Failed to clear resumable state (failure path) for ${mainTaskId}: ${clearError.message}`); }
    })
    .finally(async () =>
    {
        // This process is no longer driving the run (it reached a terminal
        // handler). Drop it from the live set so /TaskState reflects reality.
        activeGenerationMainTaskIds.delete(mainTaskId);

        // Always clear the post-pipeline marker — both success and
        // failure paths reach here. If we leak this marker the
        // frontend's progress poll would hang forever on a synthetic
        // "Finalizing" child even though nothing is actually running.
        try
        {
            await TaskManager.markPostPipelineDone(mainTaskId);
        }
        catch (markerError)
        {
            console.error(`[Generate] Failed to clear post-pipeline marker for ${mainTaskId}: ${markerError.message}`);
        }
    });
}


module.exports = {handleGenerate, isGenerationRunning};
