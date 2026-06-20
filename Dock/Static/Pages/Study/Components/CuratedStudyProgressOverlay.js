import DialogBox from "../../../CommonComponents/DialogBox.js";
import PageNavigator from "../../../Globals/Classes/PageNavigator.js";


/**
 * CuratedStudyProgressOverlay
 *
 * Blocking full-screen overlay mounted while a curated-study
 * regeneration is running. Two surfaces:
 *
 *   - **Default progress**: a heading + status line + spinner +
 *     "Cancel and go back" escape. The escape detaches the overlay and
 *     calls PageNavigator.back(); the underlying analysis task keeps
 *     running silently in the background and the next sync will land
 *     its results.
 *   - **Error state**: when the caller invokes showError(), the overlay
 *     swaps to an error heading + the supplied message + a Close
 *     button. The cancel button is hidden in the error state.
 *
 * The caller drives status updates via the returned handle's
 * updateStatus({phase, taskTree?}) method. Recognised phases:
 *   - "queued" / "joined-existing-run" — task is in the queue
 *   - "progress"                       — task tree polled, update bar
 *   - "task-terminal"                  — task finished (success or fail)
 *   - "sync-complete"                  — post-task sync is done
 */
class CuratedStudyProgressOverlay
{
    /**
     * Mounts the overlay and returns a handle for the caller to drive.
     * @param {{
     *   title?: string,
     *   statusText?: string,
     *   onCancel?: function|null,
     *   onErrorClose?: function|null,    // fires after the user dismisses an error state
     *   bNavigateBackOnErrorClose?: boolean, // default false; when true the error-Close also runs PageNavigator.back()
     *   phaseLabels?: object|null,       // optional map of {phase: labelString} that overrides the curated-study-specific defaults; missing keys fall through to the defaults
     * }} options
     * @returns {{close, updateStatus, showError}}
     */
    static show(options = {})
    {
        const title = options.title || "Working…";
        const initialStatusText = options.statusText || "Starting up";
        const bNavigateBackOnErrorClose = options.bNavigateBackOnErrorClose === true;
        const phaseLabelOverrides = (options.phaseLabels && typeof options.phaseLabels === "object") ? options.phaseLabels : null;

        const dialog = DialogBox.modal(`
            <div class="curated-progress-overlay">
                <h2 class="curated-progress-title">${CuratedStudyProgressOverlay.#escapeHtml(title)}</h2>
                <div class="curated-progress-status-line">${CuratedStudyProgressOverlay.#escapeHtml(initialStatusText)}</div>
                <div class="curated-progress-bar-track">
                    <div class="curated-progress-bar-fill" style="width: 0%;"></div>
                </div>
                <div class="curated-progress-percent">0%</div>
                <div class="curated-progress-error" hidden></div>
                <div class="curated-progress-actions">
                    <button class="curated-progress-cancel">Cancel and go back</button>
                    <button class="curated-progress-close" hidden>Close</button>
                </div>
            </div>
        `);

        const statusLine    = dialog.querySelector(".curated-progress-status-line");
        const barFill       = dialog.querySelector(".curated-progress-bar-fill");
        const percentLabel  = dialog.querySelector(".curated-progress-percent");
        const errorBox      = dialog.querySelector(".curated-progress-error");
        const cancelButton  = dialog.querySelector(".curated-progress-cancel");
        const closeButton   = dialog.querySelector(".curated-progress-close");

        let bClosed = false;

        const detachOverlay = () =>
        {
            if (bClosed)
            {
                return;
            }
            bClosed = true;
            dialog.close();
        };

        cancelButton.addEventListener("click", () =>
        {
            detachOverlay();
            if (typeof options.onCancel === "function")
            {
                options.onCancel();
            }
            // Default escape behaviour — return to the previous page.
            // The underlying analysis task keeps running and syncs in
            // later. If the caller wants to override this, they should
            // override in onCancel and PageNavigator.back() is still
            // called below; idempotent so a no-op cancel handler is
            // fine.
            try
            {
                PageNavigator.back();
            }
            catch (navigationError)
            {
                // Stack may be empty — ignore. The overlay is already
                // detached so the user isn't stuck.
            }
        });

        closeButton.addEventListener("click", () =>
        {
            detachOverlay();
            if (typeof options.onErrorClose === "function")
            {
                try
                {
                    options.onErrorClose();
                }
                catch (errorCloseHandlerError)
                {
                    console.warn("[CuratedStudyProgressOverlay] onErrorClose threw:", errorCloseHandlerError);
                }
            }
            if (bNavigateBackOnErrorClose)
            {
                try
                {
                    PageNavigator.back();
                }
                catch (navigationError)
                {
                    // Stack may be empty — overlay is already detached
                    // and onErrorClose has fired, so the user isn't
                    // stuck.
                }
            }
        });

        // The dialog's close-button (top-right X) acts as cancel.
        const internalCloseButton = dialog.querySelector(".close-button");
        if (internalCloseButton)
        {
            internalCloseButton.addEventListener("click", () =>
            {
                detachOverlay();
                if (typeof options.onCancel === "function")
                {
                    options.onCancel();
                }
            });
        }

        return {
            close: detachOverlay,

            updateStatus(statusEvent)
            {
                if (bClosed || !statusEvent)
                {
                    return;
                }

                const phase = statusEvent.phase;
                // Caller-supplied overrides win when present so a non-curated
                // caller (e.g. mock-test evaluation wait) sees its own
                // domain-appropriate labels without forking the overlay.
                const overrideLabel = phaseLabelOverrides ? phaseLabelOverrides[phase] : null;
                const labelForPhase = (typeof overrideLabel === "string" && overrideLabel.length > 0)
                    ? overrideLabel
                    : CuratedStudyProgressOverlay.#labelForPhase(phase);
                if (labelForPhase)
                {
                    statusLine.textContent = labelForPhase;
                }

                const completionPercent = CuratedStudyProgressOverlay.#computePercent(statusEvent);
                if (completionPercent !== null)
                {
                    barFill.style.width = `${completionPercent}%`;
                    percentLabel.textContent = `${completionPercent}%`;
                }
            },

            showError(headingText, messageText)
            {
                if (bClosed)
                {
                    return;
                }
                const heading = dialog.querySelector(".curated-progress-title");
                if (heading)
                {
                    heading.textContent = headingText || "Something went wrong";
                }
                statusLine.textContent = "";
                barFill.style.width = "100%";
                barFill.classList.add("curated-progress-bar-fill--failed");
                percentLabel.textContent = "";
                errorBox.hidden = false;
                errorBox.textContent = messageText || "An unexpected error occurred.";
                cancelButton.hidden = true;
                closeButton.hidden = false;
            },
        };
    }

    static #labelForPhase(phase)
    {
        switch (phase)
        {
            case "queued":               return "Queued the analysis task…";
            case "joined-existing-run":  return "Joining the analysis run already in progress…";
            case "progress":             return "Generating curated materials and flashcards…";
            case "task-terminal":        return "Task complete, syncing your library…";
            case "sync-complete":        return "Ready — opening your new batch.";
            default:                     return null;
        }
    }

    static #computePercent(statusEvent)
    {
        if (statusEvent.phase === "sync-complete")
        {
            return 100;
        }
        if (statusEvent.phase === "queued" || statusEvent.phase === "joined-existing-run")
        {
            return 5;
        }
        if (statusEvent.phase === "task-terminal")
        {
            return 95;
        }
        if (statusEvent.phase !== "progress" || !statusEvent.taskTree)
        {
            return null;
        }

        // ANALYZE_DECK_PERFORMANCE flips its own completion to 1.0 the
        // moment it spawns its GENERATE_CURATED_STUDY_MATERIAL
        // children — so reading only the root would have the bar shoot
        // to ~90% in the first few seconds and then stall there for the
        // rest of the run (the children doing the actual material +
        // flashcard work). Average across the entire task tree so the
        // bar tracks the real progress.
        const aggregate = CuratedStudyProgressOverlay.#aggregateTreeCompletion(statusEvent.taskTree);
        if (aggregate.nodeCount === 0)
        {
            return null;
        }
        const averageCompletion = aggregate.completionSum / aggregate.nodeCount;
        return Math.max(5, Math.min(90, Math.round(averageCompletion * 90)));
    }

    static #aggregateTreeCompletion(node)
    {
        if (!node)
        {
            return { completionSum: 0, nodeCount: 0 };
        }
        const nodeCompletion = typeof node.completion === "number" && Number.isFinite(node.completion) ? node.completion : 0;
        let completionSum = nodeCompletion;
        let nodeCount = 1;
        const children = Array.isArray(node.children) ? node.children : [];
        for (const childNode of children)
        {
            const childAggregate = CuratedStudyProgressOverlay.#aggregateTreeCompletion(childNode);
            completionSum += childAggregate.completionSum;
            nodeCount += childAggregate.nodeCount;
        }
        return { completionSum, nodeCount };
    }

    static #escapeHtml(value)
    {
        if (typeof value !== "string")
        {
            return "";
        }
        return value
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }
}

export default CuratedStudyProgressOverlay;
