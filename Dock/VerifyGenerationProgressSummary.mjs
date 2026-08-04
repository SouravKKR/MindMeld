/**
 * Verification harness for the generation progress summary + visibility rules.
 *
 * Run from the Dock directory:
 *     node VerifyGenerationProgressSummary.mjs
 *
 * What it protects:
 *
 *   1. The overall roll-up moved from the browser to the server when normal
 *      users stopped receiving the task tree. The numbers below are hand-computed
 *      from the phase weights, so a change to the weights or to the
 *      accumulating-parent rule fails here rather than silently showing every
 *      user a wrong percentage.
 *
 *   2. A non-administrator must never receive the per-task tree, and must still
 *      receive every root flag the recoverable-stop flows depend on — losing one
 *      of those would turn a resumable pause into a dead end.
 *
 * Two tiers, self-gating so the default run needs no external services:
 *
 *   1. ALWAYS — pure arithmetic over hand-built fixture trees. No Redis, no
 *      Mongo, no network.
 *
 *   2. HTTP (opt-in: VERIFY_PROGRESS_HTTP=1 + VERIFY_PROGRESS_TASK_ID=<a task id
 *      belonging to somebody else> + VERIFY_PROGRESS_COOKIE=<sessionId cookie>)
 *      — checks that /Generate/Progress refuses a task the caller does not own.
 *      Skips by default.
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

const require = createRequire(import.meta.url);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

require("dotenv").config({ path: path.join(currentDirectory, ".env") });

const GenerationProgressSummarizer = require("./Globals/Classes/Task/GenerationProgressSummarizer");
const ProgressVisibilityFilter = require("./Globals/Classes/Task/ProgressVisibilityFilter");
const { taskStatus } = require("./Globals/Enumerations/TaskStatus");
const { taskTypes } = require("./Globals/Enumerations/TaskTypes");
const { userRoles } = require("./Globals/Enumerations/UserRoles");

let passedCount = 0;
let failedCount = 0;
let skippedCount = 0;

function assert(condition, description)
{
    if (condition)
    {
        passedCount = passedCount + 1;
        console.log(`  PASS  ${description}`);
    }
    else
    {
        failedCount = failedCount + 1;
        console.log(`  FAIL  ${description}`);
    }
}

function skip(description)
{
    skippedCount = skippedCount + 1;
    console.log(`  SKIP  ${description}`);
}

function section(title)
{
    console.log(`\n=== ${title} ===`);
}

/** Two decimal places is well inside any weight change worth catching. */
function isClose(actualValue, expectedValue)
{
    return Math.abs(actualValue - expectedValue) < 0.0001;
}

function buildNode(overrides)
{
    return Object.assign(
    {
        id: "node",
        type: taskTypes.PROCESS_SYLLABUS,
        status: taskStatus.NOT_STARTED,
        completion: 0,
        parentTaskId: null,
        error: null,
        children: []
    }, overrides);
}

function runRollUpChecks()
{
    section("Tier 1 — overall roll-up (always on)");

    // A finished phase must keep contributing its whole band while the next
    // phase is still at zero. Averaging across children instead would collapse
    // the bar to roughly nothing at every stage boundary.
    const boundaryTree = buildNode
    ({
        id: "root",
        type: taskTypes.PROCESS_SYLLABUS,
        status: taskStatus.COMPLETED,
        completion: 1,
        children: [buildNode({ id: "map", type: taskTypes.MAP_TOPICS_WITH_CONTENT, status: taskStatus.IN_PROGRESS, completion: 0 })]
    });
    assert(isClose(GenerationProgressSummarizer.summarize(boundaryTree).overallCompletion, 0.15), "A finished syllabus phase holds the bar at its full 0.15 band while map-topics is still at zero");

    // Accumulating parent: a workflow stamps itself COMPLETED the moment it
    // exits, which races ahead of the workers it spawned. The workers are the
    // truth.
    const accumulatingTree = buildNode
    ({
        id: "root",
        type: taskTypes.PROCESS_SYLLABUS,
        status: taskStatus.COMPLETED,
        completion: 1,
        children:
        [
            buildNode
            ({
                id: "map",
                type: taskTypes.MAP_TOPICS_WITH_CONTENT,
                status: taskStatus.COMPLETED,
                completion: 1,
                children:
                [
                    buildNode
                    ({
                        id: "flashcards",
                        type: taskTypes.GENERATE_FLASHCARDS,
                        status: taskStatus.COMPLETED,
                        completion: 1,
                        children:
                        [
                            buildNode({ id: "worker-a", type: taskTypes.FLASHCARD_GENERATION_WORKER, status: taskStatus.IN_PROGRESS, completion: 0.5, parentTaskId: "flashcards" }),
                            buildNode({ id: "worker-b", type: taskTypes.FLASHCARD_GENERATION_WORKER, status: taskStatus.NOT_STARTED, completion: 0, parentTaskId: "flashcards" })
                        ]
                    })
                ]
            })
        ]
    });
    const accumulatingSummary = GenerationProgressSummarizer.summarize(accumulatingTree);
    // 0.15 + 0.30 + 0.45 x ((0.5 + 0.0) / 2) = 0.5625
    assert(isClose(accumulatingSummary.overallCompletion, 0.5625), "A parent's completion comes from its workers, not from its own stored 1.0");
    assert(accumulatingSummary.overallStatus === taskStatus.IN_PROGRESS, "A parent with unfinished workers reports IN_PROGRESS despite its own COMPLETED status");
    assert(accumulatingSummary.bTerminal === false, "A run with unfinished workers is not terminal");

    // Sequential successors are NOT workers: they run after their parent, so
    // they must not drag its completion back down.
    const sequentialTree = buildNode
    ({
        id: "root",
        type: taskTypes.MAP_TOPICS_WITH_CONTENT,
        status: taskStatus.COMPLETED,
        completion: 1,
        children: [buildNode({ id: "flashcards", type: taskTypes.GENERATE_FLASHCARDS, status: taskStatus.NOT_STARTED, completion: 0, parentTaskId: null })]
    });
    // 0.30 (map-topics, whole) + 0.45 x 0 (flashcards) = 0.30
    assert(isClose(GenerationProgressSummarizer.summarize(sequentialTree).overallCompletion, 0.30), "A sequential successor does not reduce its predecessor's completion");

    // A finished run reads 100% even after the transient finalization node has
    // been dropped from the tree, which would otherwise leave it stuck at 0.90.
    const completedTree = buildNode({ id: "root", type: taskTypes.PROCESS_SYLLABUS, status: taskStatus.COMPLETED, completion: 1 });
    const completedSummary = GenerationProgressSummarizer.summarize(completedTree);
    assert(completedSummary.overallCompletion === 1, "A fully completed run reads exactly 1.0, not the phased sum");
    assert(completedSummary.bTerminal === true && completedSummary.overallStatus === taskStatus.COMPLETED, "A fully completed run is terminal and COMPLETED");

    // A deep failure has to win over a root that reads COMPLETED, and it has to
    // carry its reason — a user without the tree has nothing else to go on.
    const failedTree = buildNode
    ({
        id: "root",
        type: taskTypes.PROCESS_SYLLABUS,
        status: taskStatus.COMPLETED,
        completion: 1,
        children: [buildNode({ id: "map", type: taskTypes.MAP_TOPICS_WITH_CONTENT, status: taskStatus.FAILED, completion: 0.3, error: "The document could not be read" })]
    });
    const failedSummary = GenerationProgressSummarizer.summarize(failedTree);
    assert(failedSummary.overallStatus === taskStatus.FAILED, "A deep failure beats a root that reads COMPLETED");
    assert(failedSummary.bTerminal === true, "A failed run is terminal");
    assert(failedSummary.failureMessage === "The document could not be read", "The failure reason travels with the summary");

    // Nothing started yet, and nothing at all.
    assert(GenerationProgressSummarizer.summarize(buildNode({ id: "root" })).overallStatus === taskStatus.NOT_STARTED, "An unstarted run reports NOT_STARTED");
    const emptySummary = GenerationProgressSummarizer.summarize(null);
    assert(emptySummary.overallCompletion === 0 && emptySummary.bTerminal === false && emptySummary.failureMessage === null, "A null tree summarises to a safe zero rather than throwing");
}

function runVisibilityChecks()
{
    section("Tier 1b — role-based visibility (always on)");

    const buildLiveTree = () => buildNode
    ({
        id: "root",
        type: taskTypes.PREPARE_FOR_GENERATION,
        status: taskStatus.IN_PROGRESS,
        completion: 0,
        outOfCredits: false,
        paused: false,
        partialCompletion: null,
        imagePreparationFailed: false,
        providerSlowdown: true,
        remainingTtlMillis: 12345,
        children: [buildNode({ id: "syllabus", type: taskTypes.PROCESS_SYLLABUS, status: taskStatus.COMPLETED, completion: 1 })]
    });

    const administrator = { getRole: () => userRoles.ADMIN };
    const normalUser = { getRole: () => userRoles.USER };
    const organizationAdministrator = { getRole: () => userRoles.ORG_ADMIN };

    const administratorTree = ProgressVisibilityFilter.apply(buildLiveTree(), administrator);
    assert(Array.isArray(administratorTree.children) && administratorTree.children.length === 1, "An administrator keeps the per-task tree");
    assert(administratorTree.summaryOnly === undefined, "An administrator's payload is not marked summary-only");
    assert(isClose(administratorTree.overallCompletion, 0.15), "An administrator also receives the server-computed roll-up");

    const userTree = ProgressVisibilityFilter.apply(buildLiveTree(), normalUser);
    assert(!Object.prototype.hasOwnProperty.call(userTree, "children"), "A normal user receives no per-task tree at all");
    assert(userTree.summaryOnly === true, "A normal user's payload is marked summary-only");
    assert(isClose(userTree.overallCompletion, 0.15) && userTree.overallStatus === taskStatus.IN_PROGRESS, "A normal user still receives the overall roll-up");
    assert(userTree.isTerminal === false && userTree.failureMessage === null, "A normal user still receives the terminal flag and failure slot");

    // Every one of these drives a recoverable-stop flow on the client. Losing
    // one turns a resumable pause into a dead end, so they are asserted by name.
    for (const flagName of ["type", "outOfCredits", "paused", "partialCompletion", "imagePreparationFailed", "providerSlowdown", "remainingTtlMillis"])
    {
        assert(Object.prototype.hasOwnProperty.call(userTree, flagName), `A normal user still receives the "${flagName}" root flag`);
    }

    const organizationAdministratorTree = ProgressVisibilityFilter.apply(buildLiveTree(), organizationAdministrator);
    assert(organizationAdministratorTree.summaryOnly === true, "An organization administrator is NOT a platform administrator and gets the summary view");

    const anonymousTree = ProgressVisibilityFilter.apply(buildLiveTree(), null);
    assert(anonymousTree.summaryOnly === true, "A missing user degrades to the restricted view rather than exposing the tree");

    const malformedTree = ProgressVisibilityFilter.apply(buildLiveTree(), { role: userRoles.ADMIN });
    assert(malformedTree.summaryOnly === true, "A user object without getRole() degrades to the restricted view");

    assert(ProgressVisibilityFilter.isAdministrator(administrator) === true && ProgressVisibilityFilter.isAdministrator(normalUser) === false, "isAdministrator agrees with the applied visibility");
}

function runWiredModuleSmoke()
{
    section("Tier 1c — wired modules load (always on)");

    const modulePaths =
    [
        "./Globals/Classes/Task/GenerationProgressSummarizer",
        "./Globals/Classes/Task/ProgressVisibilityFilter",
        "./Endpoints/AutomaticGeneration/GetProgress",
        "./Endpoints/Activity/GetActiveTaskProgress",
        "./Endpoints/Helpers/AppendPostPipelineProgress"
    ];

    let loadFailure = null;
    for (const modulePath of modulePaths)
    {
        try
        {
            require(modulePath);
        }
        catch (loadError)
        {
            loadFailure = `${modulePath}: ${loadError.message}`;
            break;
        }
    }

    assert(loadFailure === null, `All ${modulePaths.length} progress modules load (no syntax / circular-require breakage)${loadFailure ? ` — ${loadFailure}` : ""}`);
}

async function runHttpTier()
{
    section("Tier 2 — /Generate/Progress ownership (opt-in: VERIFY_PROGRESS_HTTP=1)");

    if (process.env.VERIFY_PROGRESS_HTTP !== "1")
    {
        skip("HTTP tier disabled (set VERIFY_PROGRESS_HTTP=1 + VERIFY_PROGRESS_TASK_ID + VERIFY_PROGRESS_COOKIE to check the 403)");
        return;
    }

    const baseUrl = process.env.VERIFY_PROGRESS_BASE_URL || "http://127.0.0.1:3000";
    const foreignTaskId = process.env.VERIFY_PROGRESS_TASK_ID;
    const sessionCookie = process.env.VERIFY_PROGRESS_COOKIE;

    if (!foreignTaskId || !sessionCookie)
    {
        skip("VERIFY_PROGRESS_TASK_ID and VERIFY_PROGRESS_COOKIE are both required for the ownership check");
        return;
    }

    try
    {
        const progressResponse = await fetch(`${baseUrl}/Generate/Progress?taskid=${encodeURIComponent(foreignTaskId)}`,
        {
            headers: { Cookie: `sessionId=${sessionCookie}` }
        });
        assert(progressResponse.status === 403, `Reading another user's task returns 403 (got ${progressResponse.status})`);
    }
    catch (requestError)
    {
        skip(`Dock unreachable at ${baseUrl} (${requestError.message})`);
    }
}

async function main()
{
    console.log("CogniumLearn — generation progress summary verification");

    runRollUpChecks();
    runVisibilityChecks();
    runWiredModuleSmoke();
    await runHttpTier();

    console.log("\n---------------------------------------------");
    console.log(`Passed: ${passedCount}   Failed: ${failedCount}   Skipped: ${skippedCount}`);
    process.exit(failedCount > 0 ? 1 : 0);
}

main().catch((unexpectedError) =>
{
    console.error("Harness crashed:", unexpectedError);
    process.exit(1);
});
