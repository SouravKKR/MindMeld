const crypto = require("crypto");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");
const { taskTypes } = require("../../../Globals/Enumerations/TaskTypes");
const { planFeatures } = require("../../../Globals/Enumerations/PlanFeatures");
const { refinementTargetKinds } = require("../../../Globals/Enumerations/RefinementTargetKinds");
const { creditTransactionTypes } = require("../../../Globals/Enumerations/CreditTransactionTypes");
const MaintenanceGate = require("../../../Globals/Classes/Maintenance/MaintenanceGate");
const PlanEntitlementGate = require("../../../Globals/Classes/Plans/PlanEntitlementGate");
const CreditPreflight = require("../../../Globals/Classes/Credits/CreditPreflight");
const CreditLedger = require("../../../Globals/Classes/Credits/CreditLedger");
const CreditConfigurationStore = require("../../../Globals/Classes/Credits/CreditConfigurationStore");
const RefinedEntityWriter = require("../../../Globals/Classes/Generation/RefinedEntityWriter");
const RefinementProposalRunner = require("../../../Globals/Classes/Generation/RefinementProposalRunner");
const ContentRefinementApplier = require("../../../Globals/Classes/Generation/ContentRefinementApplier");
const InformationSourceQueryEngine = require("../../../Globals/Classes/Database/InformationSourceQueryEngine");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");
const Logger = require("../../../Globals/Classes/Logger");
const LogTitles = require("../../../Globals/Classes/Logging/LogTitles");
const { logCategory } = require("../../../Globals/Enumerations/LogCategory");

/**
 * ContentRefinementRunner — the metered, user-facing half of content refinement.
 *
 * Gate order matches AutoFillOptionsRunner deliberately: maintenance, then plan
 * entitlement, then credits. Entitlement before credits so a user on a plan that
 * does not include AI generation sees an upgrade prompt rather than a confusing
 * "you need more credits" for something they could not buy their way into.
 *
 * Two proposal endpoints and one apply endpoint. Proposals cost credits because
 * they cost a model call; the apply is free because it is a database write the
 * user already paid to have proposed. Charging for the apply as well would
 * make "look at the comparison and decide" the expensive step, which is exactly
 * the step that should never be discouraged.
 */
class ContentRefinementRunner
{
    static #MAXIMUM_INSTRUCTION_LENGTH = 4000;

    /**
     * Proposes a revision of one passage. Charges on success only.
     */
    static async proposeContentRevision({ userId, request, response })
    {
        const gateFailure = await ContentRefinementRunner.#runGates(userId, request, response, taskTypes.REFINE_CONTENT);
        if (gateFailure)
        {
            return;
        }

        const body = await request.getBody();
        const targetKind = ContentRefinementRunner.#readTargetKind(body);
        const entityId = typeof body?.entityId === "string" ? body.entityId : "";
        const instruction = ContentRefinementRunner.#clampInstruction(body?.instruction);

        if (targetKind === null || entityId.length === 0 || instruction.length === 0)
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ error: ErrorCodes.MISSING_FIELDS });
            return;
        }

        // The content the proposal is built from is read from the DATABASE, not
        // taken from the request. The client's copy may be stale, and the hash
        // recorded on the proposal has to describe what the apply will actually
        // be compared against or the concurrency guard checks nothing.
        const currentState = await RefinedEntityWriter.readTargetContent(userId, entityId, targetKind);

        if (!currentState.bFound)
        {
            response.statusCode = httpStatus.NOT_FOUND;
            response.sendJson({ error: ErrorCodes.REFINEMENT_TARGET_NOT_FOUND });
            return;
        }

        const attachedSource = await ContentRefinementRunner.#resolveAttachedSource(userId, body?.informationSourceId);

        if (attachedSource === undefined)
        {
            response.statusCode = httpStatus.FORBIDDEN;
            response.sendJson({ error: ErrorCodes.INFORMATION_SOURCE_NOT_OWNED });
            return;
        }

        let workerResult;

        try
        {
            workerResult = await RefinementProposalRunner.proposeContentRevision({
                targetKind: ContentRefinementRunner.#nameForTargetKind(targetKind),
                beforeHtml: currentState.contentValue,
                instruction: instruction,
                subjectName: typeof body?.subjectName === "string" ? body.subjectName : "",
                topicChain: Array.isArray(body?.topicChain) ? body.topicChain : [],
                referenceSourceUrl: typeof body?.referenceSourceUrl === "string" ? body.referenceSourceUrl : "",
                referenceSourceStoragePath: attachedSource ? attachedSource.storagePath : "",
                referenceSourceMimeType: attachedSource ? attachedSource.mimeType : "",
            });
        }
        catch (workerError)
        {
            ContentRefinementRunner.#recordWorkerFailure("RefineContent", userId, entityId, targetKind, workerError);
            response.statusCode = httpStatus.BAD_GATEWAY;
            response.sendJson({ error: ErrorCodes.REFINEMENT_FAILED, detail: workerError.message });
            return;
        }

        await ContentRefinementRunner.#chargeForCompletedProposal(userId, taskTypes.REFINE_CONTENT, "RefineContent");

        response.statusCode = httpStatus.OK;
        response.sendJson({
            success: true,
            proposal: {
                targetKind: targetKind,
                entityId: entityId,
                beforeHtml: currentState.contentValue,
                afterHtml: workerResult.revisedHtml,
                baseContentHash: currentState.contentHash,
                summary: workerResult.summary || "",
                concerns: workerResult.concerns || "",
                consultedUrls: Array.isArray(workerResult.consultedUrls) ? workerResult.consultedUrls : [],
                modelIdentifier: workerResult.modelIdentifier || "",
                visionReviewOutcome: "",
                visualMethod: "",
            },
        });
    }

    /**
     * Proposes a redraw, replacement or removal of one diagram inside a passage.
     *
     * A REMOVE makes no model call, so it is not charged — deleting an element
     * the reviewer pointed at is deterministic work, and billing for it would be
     * charging for a database round trip.
     */
    static async proposeVisualRevision({ userId, request, response })
    {
        const body = await request.getBody();
        const action = typeof body?.action === "string" ? body.action.trim().toUpperCase() : "";
        const bChargeable = action !== "REMOVE";

        const gateFailure = await ContentRefinementRunner.#runGates(
            userId,
            request,
            response,
            bChargeable ? taskTypes.REFINE_VISUAL : null,
        );
        if (gateFailure)
        {
            return;
        }

        const targetKind = ContentRefinementRunner.#readTargetKind(body);
        const entityId = typeof body?.entityId === "string" ? body.entityId : "";

        if (targetKind === null || entityId.length === 0 || action.length === 0)
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ error: ErrorCodes.MISSING_FIELDS });
            return;
        }

        const currentState = await RefinedEntityWriter.readTargetContent(userId, entityId, targetKind);

        if (!currentState.bFound)
        {
            response.statusCode = httpStatus.NOT_FOUND;
            response.sendJson({ error: ErrorCodes.REFINEMENT_TARGET_NOT_FOUND });
            return;
        }

        let workerResult;

        try
        {
            workerResult = await RefinementProposalRunner.proposeVisualRevision({
                action: action,
                beforeHtml: currentState.contentValue,
                visualId: typeof body?.visualId === "string" ? body.visualId : "",
                figureOrdinal: typeof body?.figureOrdinal === "number" ? body.figureOrdinal : null,
                expectedCaptionText: typeof body?.expectedCaptionText === "string" ? body.expectedCaptionText : "",
                description: typeof body?.description === "string" ? body.description : "",
                visualKind: typeof body?.visualKind === "string" ? body.visualKind : "",
                captionText: typeof body?.captionText === "string" ? body.captionText : "",
                subjectName: typeof body?.subjectName === "string" ? body.subjectName : "",
                examName: typeof body?.examName === "string" ? body.examName : "",
                topicChain: Array.isArray(body?.topicChain) ? body.topicChain : [],
            });
        }
        catch (workerError)
        {
            ContentRefinementRunner.#recordWorkerFailure("RefineVisual", userId, entityId, targetKind, workerError);
            response.statusCode = httpStatus.BAD_GATEWAY;
            response.sendJson({ error: ErrorCodes.REFINEMENT_FAILED, detail: workerError.message });
            return;
        }

        if (bChargeable)
        {
            await ContentRefinementRunner.#chargeForCompletedProposal(userId, taskTypes.REFINE_VISUAL, "RefineVisual");
        }

        response.statusCode = httpStatus.OK;
        response.sendJson({
            success: true,
            proposal: {
                targetKind: targetKind,
                entityId: entityId,
                beforeHtml: currentState.contentValue,
                afterHtml: workerResult.revisedHtml,
                baseContentHash: currentState.contentHash,
                summary: workerResult.summary || "",
                concerns: workerResult.concerns || "",
                consultedUrls: [],
                modelIdentifier: workerResult.modelIdentifier || "",
                visionReviewOutcome: workerResult.visionReviewOutcome || "",
                visualMethod: workerResult.visualMethod || "",
            },
        });
    }

    /**
     * Applies a proposal the user approved. Free — the model call was already
     * charged for.
     */
    static async applyProposal({ userId, request, response })
    {
        const activeMaintenanceWindow = await MaintenanceGate.getActiveWindow();
        if (activeMaintenanceWindow !== null)
        {
            response.statusCode = httpStatus.SERVICE_UNAVAILABLE;
            response.sendJson(MaintenanceGate.buildMaintenanceResponsePayload(activeMaintenanceWindow));
            return;
        }

        const body = await request.getBody();
        const targetKind = ContentRefinementRunner.#readTargetKind(body);
        const entityId = typeof body?.entityId === "string" ? body.entityId : "";
        const revisedContent = typeof body?.revisedContent === "string" ? body.revisedContent : "";
        const expectedBaseContentHash = typeof body?.baseContentHash === "string" ? body.baseContentHash : "";

        if (targetKind === null || entityId.length === 0 || revisedContent.length === 0 || expectedBaseContentHash.length === 0)
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ error: ErrorCodes.MISSING_FIELDS });
            return;
        }

        const attachedSource = await ContentRefinementRunner.#resolveAttachedSource(userId, body?.informationSourceId);

        if (attachedSource === undefined)
        {
            response.statusCode = httpStatus.FORBIDDEN;
            response.sendJson({ error: ErrorCodes.INFORMATION_SOURCE_NOT_OWNED });
            return;
        }

        // ownerUserId is the session user and nothing else. A request naming
        // another user's entity finds no row under this userId and 404s, which
        // is the same answer as a deleted entity — deliberately, so the endpoint
        // does not confirm that another user's id exists.
        const applyResult = await ContentRefinementApplier.apply({
            ownerUserId: userId,
            actorUserId: userId,
            entityId: entityId,
            targetKind: targetKind,
            revisedContent: revisedContent,
            expectedBaseContentHash: expectedBaseContentHash,
            instruction: ContentRefinementRunner.#clampInstruction(body?.instruction),
            summary: typeof body?.summary === "string" ? body.summary : "",
            concerns: typeof body?.concerns === "string" ? body.concerns : "",
            modelIdentifier: typeof body?.modelIdentifier === "string" ? body.modelIdentifier : "",
            consultedUrls: Array.isArray(body?.consultedUrls) ? body.consultedUrls : [],
            visionReviewOutcome: typeof body?.visionReviewOutcome === "string" ? body.visionReviewOutcome : "",
            visualMethodName: typeof body?.visualMethod === "string" ? body.visualMethod : "",
            referenceSourceUrl: typeof body?.referenceSourceUrl === "string" ? body.referenceSourceUrl : "",
            attachedSource: attachedSource,
            mainTaskId: null,
            flagIndex: null,
        });

        if (!applyResult.bApplied)
        {
            ContentRefinementRunner.sendApplyFailure(response, applyResult.reason);
            return;
        }

        response.statusCode = httpStatus.OK;
        response.sendJson({
            success: true,
            refinementId: applyResult.refinement ? applyResult.refinement.refinementId : null,
        });
    }

    /**
     * Shared failure rendering so the admin path and the user path answer a
     * stale proposal identically — the client has one 409 handler.
     */
    static sendApplyFailure(response, reason)
    {
        if (reason === "BASE_CONTENT_CHANGED")
        {
            response.statusCode = httpStatus.CONFLICT;
            response.sendJson({
                error: ErrorCodes.REFINEMENT_BASE_CONTENT_CHANGED,
                detail: "This passage changed after the suggestion was prepared, so applying it now would discard that "
                    + "change. Reload and ask again.",
            });
            return;
        }

        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.REFINEMENT_TARGET_NOT_FOUND });
    }

    /**
     * Maintenance, entitlement and (when a chargeable task type is given) credit
     * gates. Returns true when a response has already been sent.
     */
    static async #runGates(userId, request, response, chargeableTaskType)
    {
        if (typeof userId !== "string" || userId.length === 0)
        {
            response.sendStatusCode(httpStatus.UNAUTHORIZED);
            return true;
        }

        const activeMaintenanceWindow = await MaintenanceGate.getActiveWindow();
        if (activeMaintenanceWindow !== null)
        {
            response.statusCode = httpStatus.SERVICE_UNAVAILABLE;
            response.sendJson(MaintenanceGate.buildMaintenanceResponsePayload(activeMaintenanceWindow));
            return true;
        }

        const refinementEntitlement = await PlanEntitlementGate.requireFeatureForRequest(request, userId, planFeatures.AUTOMATIC_GENERATION);
        if (!refinementEntitlement.allowed)
        {
            response.statusCode = httpStatus.FORBIDDEN;
            response.sendJson({
                error: refinementEntitlement.reason,
                currentTier: refinementEntitlement.currentTier,
                requiredTier: refinementEntitlement.requiredTier,
            });
            return true;
        }

        if (chargeableTaskType === null)
        {
            return false;
        }

        const creditPreflight = await CreditPreflight.check(userId, chargeableTaskType);
        if (!creditPreflight.allowed)
        {
            response.statusCode = httpStatus.PAYMENT_REQUIRED;
            response.sendJson({ error: creditPreflight.reason, balance: creditPreflight.balance, required: creditPreflight.required });
            return true;
        }

        return false;
    }

    /**
     * Loads the attached reference source and confirms the caller owns it.
     *
     * Returns null when no source was named, undefined when one was named that
     * this user does not own, and the resolved source otherwise. The storage
     * path is built HERE from the stored row, never taken from the request — the
     * client names a source by id and gets whatever that row says, so no request
     * can point the reader at an arbitrary object.
     */
    static async #resolveAttachedSource(userId, informationSourceId)
    {
        if (typeof informationSourceId !== "string" || informationSourceId.length === 0)
        {
            return null;
        }

        const informationSource = await InformationSourceQueryEngine.getInformationSourceById(informationSourceId);

        if (informationSource === null || informationSource.getUserId() !== userId)
        {
            return undefined;
        }

        return {
            informationSourceId: informationSource.getId(),
            name: informationSource.getName(),
            contentHash: informationSource.getHash(),
            mimeType: informationSource.getMimeType(),
            sourceUrl: informationSource.getSourceUrl(),
            licenceType: informationSource.getLicenceType(),
            licenceNote: informationSource.getLicenceNote(),
            storagePath: `${informationSource.getDirectoryPath()}/${informationSource.getHash()}`,
        };
    }

    /**
     * Records a worker failure, with the worker's own stderr attached.
     *
     * This did not exist, and its absence was the expensive part of a recurring
     * production failure: the endpoint returned 502 with a sentence for the
     * reviewer and wrote nothing anywhere, so the only way to find out why
     * refinements were failing was to read the source and reason about it. An
     * error a user can see and an operator cannot is a bug that lasts.
     *
     * The entity is identified but its CONTENT is not logged, and neither is the
     * reviewer's instruction — the worker's stderr already reports both as
     * lengths, and a log store is the wrong place for a second copy of either.
     */
    static #recordWorkerFailure(workerName, userId, entityId, targetKind, workerError)
    {
        Logger.error
        (
            logCategory.AI_REQUEST,
            LogTitles.AI_GENERATION,
            `[${workerName}] ${workerError.message}`,
            {
                accountId: userId,
                errorCode: ErrorCodes.REFINEMENT_FAILED,
                additionalData:
                {
                    worker: workerName,
                    entityId: entityId,
                    targetKind: targetKind,
                    workerStandardError: workerError.workerStandardError || "",
                },
            },
        );
    }

    static async #chargeForCompletedProposal(userId, taskType, sourceName)
    {
        const configuration = await CreditConfigurationStore.load();
        const rule = configuration.getRuleForTask(taskType);

        if (rule === null || !rule.getEnabled())
        {
            return;
        }

        const chargeAmount = rule.evaluate({});
        if (chargeAmount <= 0)
        {
            return;
        }

        // One key per request. A retry from the client is a new proposal and a
        // new model call, so it is a new charge — the idempotency this guards is
        // a double-charge for one call, not a re-run.
        const referenceKey = `refine:${userId}:${crypto.randomUUID()}`;

        const chargeResult = await CreditLedger.charge(
            userId,
            chargeAmount,
            creditTransactionTypes.TASK_CHARGE,
            referenceKey,
            { taskType: taskType, source: sourceName },
            rule.getMinimumBalanceFloor(),
        );

        if (chargeResult.rejected)
        {
            Logger.log(`[ContentRefinement] charge of ${chargeAmount} rejected by balance floor for user ${userId} (${referenceKey}).`, "DOCK");
        }
    }

    static #readTargetKind(body)
    {
        const targetKind = body ? body.targetKind : null;

        if (typeof targetKind !== "number")
        {
            return null;
        }

        return RefinedEntityWriter.isWritableTargetKind(targetKind) ? targetKind : null;
    }

    static #nameForTargetKind(targetKind)
    {
        const matchedEntry = Object.entries(refinementTargetKinds).find(([, kindValue]) => kindValue === targetKind);
        return matchedEntry ? matchedEntry[0] : "";
    }

    static #clampInstruction(instruction)
    {
        if (typeof instruction !== "string")
        {
            return "";
        }

        const trimmed = instruction.trim();
        return trimmed.length > ContentRefinementRunner.#MAXIMUM_INSTRUCTION_LENGTH
            ? trimmed.substring(0, ContentRefinementRunner.#MAXIMUM_INSTRUCTION_LENGTH)
            : trimmed;
    }
}

module.exports = ContentRefinementRunner;
