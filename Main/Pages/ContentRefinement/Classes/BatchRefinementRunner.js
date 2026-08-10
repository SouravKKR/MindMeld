import DialogBox from "../../../CommonComponents/DialogBox.js";
import SyncManager from "../../../Globals/Classes/SyncManager.js";
import ContentRefinementClient from "./ContentRefinementClient.js";
import RefinementProposalDialog from "../../../CommonComponents/RefinementProposalDialog.js";
import RefinementProgressOverlay from "../Components/RefinementProgressOverlay.js";

/**
 * BatchRefinementRunner — applies one instruction across a selection of
 * entities, one at a time.
 *
 * The batch lives entirely on the client. /Refine/Content/Proposal and
 * /Refine/Content/Apply each take exactly one entity id, and they were left that
 * way deliberately: a server-side batch would have to decide what a partial
 * failure means for the whole set, and the honest answer — "the ones that
 * worked are written and the ones that did not are not" — is precisely what N
 * independent calls already give, with a review gate in front of each.
 *
 * SEQUENTIAL, not concurrent. Every proposal spawns a one-shot Python worker
 * (RefinementProposalRunner), so N concurrent proposals would be N concurrent
 * model-loading processes. The wall-clock saving is not worth putting the
 * generation host into swap.
 *
 * Two failures end the run and the rest do not. A 402 (out of credits) and a 403
 * (feature not in this plan) will refuse every remaining item for the same
 * reason, so continuing would be N identical dialogs telling the reviewer
 * something they already know. A 409 (the passage changed underneath the
 * proposal) or a worker timeout is specific to one entity, so it is recorded and
 * the run moves on.
 */
class BatchRefinementRunner
{
    /**
     * @param {object} options — entities, instruction, subjectName,
     *   sourceAttachment
     * @returns {Promise<object>} the run outcome, for reportOutcome
     */
    static async run({ entities, instruction, subjectName, sourceAttachment })
    {
        const totalCount = entities.length;
        const runOutcome =
        {
            totalCount: totalCount,
            appliedCount: 0,
            skippedCount: 0,
            failures: [],
            bStopped: false,
            fatalFailure: null,
        };

        if (totalCount > 1 && !(await BatchRefinementRunner.#confirmBatch(totalCount)))
        {
            runOutcome.bStopped = true;
            return runOutcome;
        }

        const progressOverlay = new RefinementProgressOverlay();
        progressOverlay.open({ totalCount: totalCount, bAllowStop: totalCount > 1 });

        try
        {
            await BatchRefinementRunner.#runEntities(
                { entities, instruction, subjectName, sourceAttachment },
                runOutcome,
                progressOverlay,
            );
        }
        finally
        {
            // In a finally because a throw here must not leave a modal overlay
            // covering the failure dialog that is about to open behind it.
            progressOverlay.close();
        }

        return runOutcome;
    }

    static async #runEntities({ entities, instruction, subjectName, sourceAttachment }, runOutcome, progressOverlay)
    {
        const totalCount = entities.length;

        progressOverlay.setStatus({ statusText: "Fetching the latest copy…", totalCount: totalCount });

        // Synced ONCE, not per item. Applying to one entity cannot invalidate
        // another's base content, so the per-proposal sync the single-entity path
        // does would be N round trips buying nothing.
        await SyncManager.sync();

        const informationSourceId = sourceAttachment ? sourceAttachment.getInformationSourceId() : "";
        const referenceSourceUrl = sourceAttachment ? sourceAttachment.getReferenceUrl() : "";

        let bApplyAllRemaining = false;

        for (let entityIndex = 0; entityIndex < totalCount; entityIndex++)
        {
            const entity = entities[entityIndex];

            // Checked BETWEEN items only. There is nothing to stop mid-call —
            // the worker is already running and a proposal that completes is
            // charged whatever this client does next.
            if (progressOverlay.isStopRequested())
            {
                runOutcome.bStopped = true;
                break;
            }

            progressOverlay.setStatus({
                statusText: bApplyAllRemaining ? "Refining and applying…" : "Asking the model…",
                entityLabel: `${entity.label} · ${entity.deckName}`,
                currentIndex: entityIndex + 1,
                totalCount: totalCount,
            });

            let proposal = null;

            try
            {
                proposal = await ContentRefinementClient.proposeContentRevision({
                    entityId: entity.entityId,
                    targetKind: entity.targetKind,
                    instruction: instruction,
                    subjectName: subjectName,
                    topicChain: [entity.deckName],
                    informationSourceId: informationSourceId,
                    referenceSourceUrl: referenceSourceUrl,
                });
            }
            catch (refinementError)
            {
                if (BatchRefinementRunner.#isFatalFailure(refinementError))
                {
                    runOutcome.fatalFailure = refinementError;
                    runOutcome.bStopped = true;
                    break;
                }

                runOutcome.failures.push(BatchRefinementRunner.#buildFailure(entity, refinementError));
                continue;
            }

            if (bApplyAllRemaining)
            {
                try
                {
                    await ContentRefinementClient.applyProposal({
                        proposal: proposal,
                        instruction: instruction,
                        informationSourceId: informationSourceId,
                        referenceSourceUrl: referenceSourceUrl,
                    });

                    runOutcome.appliedCount += 1;
                }
                catch (applyError)
                {
                    runOutcome.failures.push(BatchRefinementRunner.#buildFailure(entity, applyError));
                }

                continue;
            }

            // The overlay comes DOWN for the review and back up afterwards.
            // Leaving it up would stack two modals with two backdrops, and the
            // one underneath would be claiming work is in progress while the
            // thing actually being waited on is the reviewer.
            progressOverlay.close();

            const reviewOutcome = await RefinementProposalDialog.show(proposal,
            {
                bVisualComparison: false,
                batchContext: totalCount > 1 ? { currentIndex: entityIndex + 1, totalCount: totalCount } : null,
                onApply: async () => await ContentRefinementClient.applyProposal({
                    proposal: proposal,
                    instruction: instruction,
                    informationSourceId: informationSourceId,
                    referenceSourceUrl: referenceSourceUrl,
                }),
            });

            const bMoreItemsFollow = entityIndex + 1 < totalCount;
            const bContinuing = reviewOutcome.result !== RefinementProposalDialog.RESULT_STOPPED;

            if (bMoreItemsFollow && bContinuing)
            {
                progressOverlay.open({ totalCount: totalCount, bAllowStop: true });
            }

            if (reviewOutcome.result === RefinementProposalDialog.RESULT_STOPPED)
            {
                runOutcome.bStopped = true;
                break;
            }

            if (reviewOutcome.result === RefinementProposalDialog.RESULT_APPLIED)
            {
                runOutcome.appliedCount += 1;
                continue;
            }

            if (reviewOutcome.result === RefinementProposalDialog.RESULT_APPLIED_ALL_REMAINING)
            {
                runOutcome.appliedCount += 1;

                // The item just reviewed is applied either way — that is what was
                // clicked. The confirmation governs only the ones that would go
                // through unseen, which is the part worth stopping to think about.
                bApplyAllRemaining = await BatchRefinementRunner.#confirmApplyAllRemaining(totalCount - (entityIndex + 1));
                continue;
            }

            // Discarded, or "Refine further" — which resolves the dialog without
            // re-proposing on the single-entity path too. In a run, both mean
            // "not this one" and the next item follows.
            runOutcome.skippedCount += 1;
        }

        return runOutcome;
    }

    /**
     * Narrates a finished run. A single-entity run keeps exactly the wording it
     * had before batching existed, because the overwhelming majority of runs are
     * one entity and a summary table for one row is worse than a sentence.
     */
    static async reportOutcome(runOutcome)
    {
        if (runOutcome.fatalFailure !== null)
        {
            await ContentRefinementClient.explainFailure(runOutcome.fatalFailure);

            const remainingCount = runOutcome.totalCount - runOutcome.appliedCount - runOutcome.skippedCount - runOutcome.failures.length;
            if (runOutcome.totalCount > 1 && remainingCount > 0)
            {
                await DialogBox.alert(
                    "Run stopped",
                    `${runOutcome.appliedCount} change${runOutcome.appliedCount === 1 ? " was" : "s were"} applied before the run stopped. `
                    + `${remainingCount} item${remainingCount === 1 ? " was" : "s were"} not attempted.`,
                );
            }
            return;
        }

        if (runOutcome.totalCount <= 1)
        {
            if (runOutcome.failures.length > 0)
            {
                await ContentRefinementClient.explainFailure(runOutcome.failures[0].refinementError);
                return;
            }

            if (runOutcome.appliedCount > 0)
            {
                await DialogBox.alert("Applied", "The change has been applied and recorded.");
            }
            return;
        }

        if (runOutcome.appliedCount === 0 && runOutcome.failures.length === 0 && runOutcome.bStopped)
        {
            return;
        }

        await DialogBox.alert("Refinement run finished", BatchRefinementRunner.#buildSummaryMarkup(runOutcome));
    }

    static #buildSummaryMarkup(runOutcome)
    {
        const failureRows = runOutcome.failures.map(failure => `
            <li>
                <strong>${BatchRefinementRunner.#escape(failure.label)} · ${BatchRefinementRunner.#escape(failure.deckName)}</strong>
                — ${BatchRefinementRunner.#escape(failure.message)}
            </li>
        `).join("");

        const failureSection = runOutcome.failures.length > 0
            ? `<p>These were not changed:</p><ul class="content-refinement-run-failures">${failureRows}</ul>`
            : "";

        const stoppedLine = runOutcome.bStopped
            ? `<p>The run was stopped before the end, so the remaining items were not attempted.</p>`
            : "";

        return `
            <p>
                Applied ${runOutcome.appliedCount} of ${runOutcome.totalCount}.
                ${runOutcome.skippedCount > 0 ? `Skipped ${runOutcome.skippedCount}.` : ""}
                ${runOutcome.failures.length > 0 ? `${runOutcome.failures.length} failed.` : ""}
            </p>
            ${stoppedLine}
            ${failureSection}
        `;
    }

    static async #confirmBatch(totalCount)
    {
        return await DialogBox.confirm(
            `Refine ${totalCount} items?`,
            `The same instruction will be sent for each item separately — ${totalCount} model calls, each charged on its own. `
            + `You will see the before and after for every one and decide it individually, and nothing is written until you do.`,
        );
    }

    static async #confirmApplyAllRemaining(remainingCount)
    {
        if (remainingCount <= 0)
        {
            return false;
        }

        return await DialogBox.confirm(
            `Apply the remaining ${remainingCount} without reviewing?`,
            `The suggestion for each of the remaining ${remainingCount} item${remainingCount === 1 ? "" : "s"} will be written as soon as it comes back, `
            + `without being shown to you first. Every change is still recorded and can be inspected afterwards.`,
        );
    }

    /**
     * True for the refusals that will repeat identically on every remaining
     * item. Maintenance has already shown its own notice, so it counts here too
     * rather than being narrated a second time per entity.
     */
    static #isFatalFailure(refinementError)
    {
        return Boolean(refinementError.creditDetail || refinementError.entitlementDetail || refinementError.bAlreadyReported);
    }

    static #buildFailure(entity, refinementError)
    {
        return {
            label: entity.label,
            deckName: entity.deckName,
            message: refinementError.message || "Unknown failure.",
            refinementError: refinementError,
        };
    }

    static #escape(rawValue)
    {
        return String(rawValue ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }
}

export default BatchRefinementRunner;
