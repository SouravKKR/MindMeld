const crypto = require("crypto");
const GenerationProvenanceQueryEngine = require("../Database/GenerationProvenanceQueryEngine");
const PaidDeckVerificationSourceQueryEngine = require("../Database/PaidDeckVerificationSourceQueryEngine");
const Persistence = require("../Persistence");
const TaskDescriptor = require("../Task/TaskDescriptor");
const TaskManager = require("../Task/TaskManager");
const PersistenceConstants = require("../../Constants/PersistenceConstants");
const { joinPath } = require("../../UtilityFunctions.js/JoinPath");
const { taskExecutionTargets } = require("../../Enumerations/TaskExecutionTargets");
const { taskTypes } = require("../../Enumerations/TaskTypes");

/**
 * SourceVerificationRunner — starts a source-grounded verification pass for one
 * deck, and reports on it while it runs.
 *
 * WHY THIS IS NOT AWAITED BY THE REQUEST. The pass reads every attached source
 * and checks every generated item against it, which takes minutes on a real
 * deck. Holding the HTTP request open for that would time out in the browser
 * and leave the administrator with no idea whether the run was still going.
 *
 * WHY THE IN-PROCESS MARKER IS SAFE DESPITE BEING EPHEMERAL. The running/idle
 * marker lives in this process and is lost on a Dock restart, which would
 * normally be a correctness problem — the administrator would press the button
 * again and get a second pass appending a second copy of every flag, and a
 * duplicated blocking flag has to be resolved twice to stop blocking, which
 * reads as the gate being broken. It is safe here because DURABILITY LIVES
 * ELSEWHERE: each run carries a passId, the Agent writes its report under that
 * id, and GenerationProvenanceQueryEngine.appendSourceVerificationFlags is
 * idempotent on it. So the marker is only ever an optimisation that stops the
 * obvious double-click; losing it costs a wasted model call, never a corrupted
 * record.
 *
 * The durable outcome is the provenance record, which is what the status
 * endpoint reports once the run has finished.
 */
class SourceVerificationRunner
{
    static STATE_IDLE = "IDLE";
    static STATE_RUNNING = "RUNNING";
    static STATE_FINISHED = "FINISHED";
    static STATE_FAILED = "FAILED";

    /**
     * deckId -> {passId, state, startedAt, finishedAt, flagsRaised, detail}
     *
     * Bounded by the number of decks with a pass in flight, which is bounded by
     * the number of administrators pressing the button.
     */
    static #runsByDeckId = new Map();

    static getRunStatus(deckId)
    {
        return SourceVerificationRunner.#runsByDeckId.get(deckId) || null;
    }

    static isRunning(deckId)
    {
        const run = SourceVerificationRunner.#runsByDeckId.get(deckId);
        return run !== undefined && run.state === SourceVerificationRunner.STATE_RUNNING;
    }

    /**
     * Starts a pass and returns immediately.
     *
     * @param {{provenanceDeckId: string, mainTaskId: string, ownerUserId: string, subjectName: string}} runRequest
     * @return {{started: boolean, passId: (string|null), reason: (string|null)}}
     */
    static start(runRequest)
    {
        const provenanceDeckId = runRequest.provenanceDeckId;

        if (SourceVerificationRunner.isRunning(provenanceDeckId))
        {
            return { started: false, passId: null, reason: "ALREADY_RUNNING" };
        }

        const passId = crypto.randomUUID();

        SourceVerificationRunner.#runsByDeckId.set(provenanceDeckId, {
            passId: passId,
            state: SourceVerificationRunner.STATE_RUNNING,
            startedAt: Date.now(),
            finishedAt: null,
            flagsRaised: 0,
            detail: null,
        });

        // Deliberately not awaited. The .catch is what stops a rejection here
        // from becoming an unhandled rejection that takes the process down —
        // this is background work started by a request that has already been
        // answered, so there is nobody left to reject to.
        SourceVerificationRunner.#runToCompletion(runRequest, passId)
            .catch(runError =>
            {
                console.error(`[SourceVerificationRunner] Pass ${passId} failed for deck ${provenanceDeckId}: ${runError?.message || runError}`);
                SourceVerificationRunner.#finish(provenanceDeckId, SourceVerificationRunner.STATE_FAILED, 0,
                    "The verification pass could not be completed.");
            });

        return { started: true, passId: passId, reason: null };
    }

    static async #runToCompletion(runRequest, passId)
    {
        const { provenanceDeckId, mainTaskId, ownerUserId, subjectName } = runRequest;

        const verificationSources = await PaidDeckVerificationSourceQueryEngine.findActiveByDeckId(provenanceDeckId);

        if (verificationSources.length === 0)
        {
            SourceVerificationRunner.#finish(provenanceDeckId, SourceVerificationRunner.STATE_FAILED, 0,
                "No verification sources are attached to this deck.");
            return;
        }

        const verificationTask = new TaskDescriptor({
            type: taskTypes.PAID_DECK_SOURCE_VERIFICATION,
            executionTarget: taskExecutionTargets.LOCAL,
            userId: ownerUserId,
            payload:
            {
                deckId: provenanceDeckId,
                mainTaskId: mainTaskId,
                passId: passId,
                subjectName: subjectName || "",
            },
            nextTaskIds: [],
        });

        await TaskManager.setTask(verificationTask);
        await TaskManager.execute(verificationTask, 0, verificationTask, mainTaskId);

        const appendResult = await SourceVerificationRunner.applyReport(mainTaskId, passId);

        if (!appendResult.applied)
        {
            SourceVerificationRunner.#finish(provenanceDeckId, SourceVerificationRunner.STATE_FAILED, 0, appendResult.detail);
            return;
        }

        SourceVerificationRunner.#finish(provenanceDeckId, SourceVerificationRunner.STATE_FINISHED,
            appendResult.flagsRaised, null);
    }

    /**
     * Reads the pass's report and appends its flags to the run's provenance
     * record.
     *
     * Separate from the run above so it can also be called on its own — a report
     * that was written but never appended (Dock restarted between the two) is
     * recoverable by calling this again, and the append is idempotent on passId
     * so calling it twice is harmless.
     *
     * @return {Promise<{applied: boolean, flagsRaised: number, detail: (string|null)}>}
     */
    static async applyReport(mainTaskId, passId)
    {
        const reportPath = joinPath(
            "/",
            PersistenceConstants.TASKS_DIRECTORY,
            mainTaskId,
            PersistenceConstants.PAID_DECK_SOURCE_VERIFICATION_DIRECTORY,
            `${passId}.json`,
        );

        let report;

        try
        {
            const reportBytes = await Persistence.read(reportPath);
            report = JSON.parse(reportBytes.toString("utf8"));
        }
        catch (readError)
        {
            // No report means the pass did not get far enough to write one. That
            // is reported as a failure rather than as a clean run with no
            // findings — the two look identical from the outside and only one of
            // them means the deck was checked.
            return {
                applied: false,
                flagsRaised: 0,
                detail: `The verification pass did not produce a report (${readError?.message || readError}).`,
            };
        }

        const flags = Array.isArray(report.flags) ? report.flags : [];

        const appendOutcome = await GenerationProvenanceQueryEngine.appendSourceVerificationFlags(mainTaskId, passId, flags);

        if (!appendOutcome.appended)
        {
            if (appendOutcome.reason === "PASS_ALREADY_APPENDED")
            {
                // Already recorded — the run succeeded, this is just a repeat.
                return { applied: true, flagsRaised: flags.length, detail: null };
            }

            return {
                applied: false,
                flagsRaised: 0,
                detail: appendOutcome.reason === "RUN_NOT_VERIFIED"
                    ? "This generation run has no verification result to add to. Run the standard verification first."
                    : "The generation record for this run could not be found.",
            };
        }

        return { applied: true, flagsRaised: flags.length, detail: null };
    }

    static #finish(deckId, state, flagsRaised, detail)
    {
        const run = SourceVerificationRunner.#runsByDeckId.get(deckId);

        if (run === undefined)
        {
            return;
        }

        run.state = state;
        run.finishedAt = Date.now();
        run.flagsRaised = flagsRaised;
        run.detail = detail;
    }
}

module.exports = SourceVerificationRunner;
