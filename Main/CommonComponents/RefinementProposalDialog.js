import DialogBox from "./DialogBox.js";
import HtmlSanitizer from "../Globals/Classes/HtmlSanitizer.js";
import HtmlDiffBuilder from "../Globals/Classes/HtmlDiffBuilder.js";
import GeneratedVisualRenderer from "../Globals/Classes/GeneratedVisualRenderer.js";

/**
 * RefinementProposalDialog — the "View Before and After" review surface.
 *
 * Every AI correction in the product passes through here. The model proposes,
 * this shows what would change, and only a person clicking Apply writes
 * anything. That ordering is the whole design: a correction pipeline that
 * decides and writes in one step is not a review gate with an assistant, it is
 * an autopilot with a progress bar.
 *
 * Two comparison modes, because the two kinds of change are checked with
 * different senses. TEXT is read, so it gets a word-level diff with the changed
 * words marked. A DIAGRAM is looked at, so both versions are RENDERED side by
 * side — a diff of SVG path data tells a reviewer nothing about whether the new
 * figure is right.
 *
 * The visual mode also shows the vision-review verdict. A redrawn diagram has
 * already been examined by a vision model against the description it was drawn
 * from, and that verdict is the only evidence a reviewer has about labels they
 * cannot verify by eye at dialog size. Hiding it would mean asking someone to
 * approve pixels they cannot judge.
 *
 * BOTH panes are sanitised before rendering. The "after" markup has passed only
 * the Python screen in the generator; HtmlSanitizer is the client's own boundary
 * and applies to model output exactly as it does to anything else. That was
 * true of the visual pane and false of the text one for as long as the text
 * diff emitted its own escaped string — the moment it started returning real
 * markup, the sanitiser had to be there, and the claim in this paragraph became
 * something the code actually does.
 *
 * A RUN of proposals passes through the same dialog rather than a second review
 * surface of its own. Reviewing thirty changes is the same act thirty times, and
 * a batch-only screen would be a second place for the sanitising, the diff and
 * the vision verdict to drift out of step with this one. `batchContext` adds a
 * position line and the two decisions that only exist inside a run — apply the
 * rest unseen, or stop here — and changes nothing when it is absent, which is
 * every single-entity refinement in the product.
 */
class RefinementProposalDialog
{
    static RESULT_APPLIED = "APPLIED";
    static RESULT_REFINE_AGAIN = "REFINE_AGAIN";
    static RESULT_DISCARDED = "DISCARDED";

    // Run-only outcomes. Both mean the current proposal was applied or abandoned
    // AND that the caller should change how it treats the remaining ones.
    static RESULT_APPLIED_ALL_REMAINING = "APPLIED_ALL_REMAINING";
    static RESULT_STOPPED = "STOPPED";

    /**
     * Shows a proposal and resolves with what the reviewer decided.
     *
     * @param {object} proposal — beforeHtml, afterHtml, summary, concerns,
     *   consultedUrls, modelIdentifier, visionReviewOutcome, visualMethod
     * @param {object} options — bVisualComparison, applyLabel, onApply,
     *   batchContext ({ currentIndex, totalCount }) when this is one proposal of
     *   a run
     * @return {Promise<{result: string, refinementId: (string|null)}>}
     */
    static show(proposal, options = {})
    {
        return new Promise((resolve) =>
        {
            const bVisualComparison = options.bVisualComparison === true;
            const batchContext = options.batchContext || null;

            const progressMarkup = batchContext
                ? `<span class="refinement-proposal-progress">Item ${batchContext.currentIndex} of ${batchContext.totalCount}</span>`
                : "";

            // "Skip" rather than "Discard" inside a run: the reviewer is
            // declining THIS change, not abandoning the whole set, and the two
            // read very differently when there are twenty-nine still to come.
            const discardLabel = batchContext ? "Skip this" : "Discard";

            const batchActionsMarkup = batchContext
                ? `
                    <button type="button" class="refinement-proposal-stop">Stop the run</button>
                    <button type="button" class="refinement-proposal-apply-remaining">Apply all remaining</button>
                `
                : "";

            const dialog = DialogBox.modal(`
                <div class="refinement-proposal-dialog">
                    <div class="title-section">Before and after${progressMarkup}</div>
                    <div class="refinement-proposal-body" data-role="proposal-body"></div>
                    <div class="refinement-proposal-error" data-role="proposal-error" hidden></div>
                    <div class="refinement-proposal-actions">
                        ${batchActionsMarkup}
                        <button type="button" class="refinement-proposal-discard">${discardLabel}</button>
                        <button type="button" class="refinement-proposal-refine">Refine further</button>
                        <button type="button" class="refinement-proposal-apply">${options.applyLabel || "Apply this change"}</button>
                    </div>
                </div>
            `);

            const bodyElement = dialog.querySelector('[data-role="proposal-body"]');
            const errorElement = dialog.querySelector('[data-role="proposal-error"]');
            const applyButton = dialog.querySelector(".refinement-proposal-apply");
            const refineButton = dialog.querySelector(".refinement-proposal-refine");
            const discardButton = dialog.querySelector(".refinement-proposal-discard");
            const stopButton = dialog.querySelector(".refinement-proposal-stop");
            const applyRemainingButton = dialog.querySelector(".refinement-proposal-apply-remaining");

            bodyElement.innerHTML = bVisualComparison
                ? RefinementProposalDialog.#buildVisualComparisonMarkup(proposal)
                : RefinementProposalDialog.#buildTextComparisonMarkup(proposal);

            // Rendered after insertion, in one pass over the whole dialog, so the
            // two panes' Mermaid blocks get their ids assigned in the same run
            // rather than colliding on a shared timestamp.
            GeneratedVisualRenderer.render(bodyElement);

            let bResolved = false;

            const finalize = (result, refinementId = null) =>
            {
                if (bResolved)
                {
                    return;
                }
                bResolved = true;
                dialog.close();
                resolve({ result: result, refinementId: refinementId });
            };

            // Inside a run the close control ends the RUN rather than skipping
            // one item. Treating it as a skip would mean a reviewer who wants
            // out of a thirty-item batch has to dismiss the dialog thirty times.
            const closeResult = batchContext
                ? RefinementProposalDialog.RESULT_STOPPED
                : RefinementProposalDialog.RESULT_DISCARDED;

            const closeButton = dialog.querySelector(".close-button");
            if (closeButton)
            {
                closeButton.addEventListener("click", () => finalize(closeResult));
            }

            discardButton.addEventListener("click", () => finalize(RefinementProposalDialog.RESULT_DISCARDED));
            refineButton.addEventListener("click", () => finalize(RefinementProposalDialog.RESULT_REFINE_AGAIN));

            if (stopButton)
            {
                stopButton.addEventListener("click", () => finalize(RefinementProposalDialog.RESULT_STOPPED));
            }

            /**
             * Both apply buttons write the SAME change through the same call and
             * differ only in what they say about the items after this one, so
             * they share one handler. A second copy would be a second place for
             * the disable-and-restore and the keep-open-on-failure rules to be
             * got wrong.
             */
            const performApply = async (triggerButton, resultOnSuccess) =>
            {
                if (typeof options.onApply !== "function")
                {
                    finalize(resultOnSuccess);
                    return;
                }

                const triggerLabel = triggerButton.textContent;
                const actionButtons = [applyButton, refineButton, stopButton, applyRemainingButton].filter(Boolean);

                actionButtons.forEach(actionButton => { actionButton.disabled = true; });
                triggerButton.textContent = "Applying…";
                errorElement.hidden = true;

                try
                {
                    const applyOutcome = await options.onApply(proposal);
                    finalize(resultOnSuccess, applyOutcome ? applyOutcome.refinementId : null);
                }
                catch (applyError)
                {
                    // Kept open on failure. The commonest failure here is a 409
                    // because the passage moved, and the useful next action is
                    // "Refine further" — which needs the dialog still on screen.
                    errorElement.textContent = applyError.message;
                    errorElement.hidden = false;
                    actionButtons.forEach(actionButton => { actionButton.disabled = false; });
                    triggerButton.textContent = triggerLabel;
                }
            };

            applyButton.addEventListener("click", async () =>
                await performApply(applyButton, RefinementProposalDialog.RESULT_APPLIED));

            if (applyRemainingButton)
            {
                applyRemainingButton.addEventListener("click", async () =>
                    await performApply(applyRemainingButton, RefinementProposalDialog.RESULT_APPLIED_ALL_REMAINING));
            }
        });
    }

    static #buildTextComparisonMarkup(proposal)
    {
        const difference = HtmlDiffBuilder.build(proposal.beforeHtml, proposal.afterHtml);

        return `
            ${RefinementProposalDialog.#buildSummaryMarkup(proposal)}
            ${RefinementProposalDialog.#buildComparisonNotice(difference)}
            <div class="refinement-comparison">
                <div class="refinement-pane">
                    <div class="refinement-pane-heading">Now</div>
                    <div class="refinement-pane-body refinement-rendered-passage">${HtmlSanitizer.sanitize(difference.beforeHtml)}</div>
                </div>
                <div class="refinement-pane">
                    <div class="refinement-pane-heading">Proposed</div>
                    <div class="refinement-pane-body refinement-rendered-passage">${HtmlSanitizer.sanitize(difference.afterHtml)}</div>
                </div>
            </div>
        `;
    }

    /**
     * The one line above the panes that says what kind of comparison this is.
     *
     * Three states, not two. "Too large to compare" used to be indistinguishable
     * from "everything changed", which is the worst of both: the reviewer is
     * shown a wall of marks and told nothing about why.
     */
    static #buildComparisonNotice(difference)
    {
        if (difference.bComparisonTooLarge)
        {
            return `<div class="refinement-proposal-notice">This passage is too long to highlight word by word, so both versions are shown unmarked. Read them side by side.</div>`;
        }

        if (!difference.bAnyChange)
        {
            return `<div class="refinement-proposal-notice">The wording is unchanged. Only formatting or figures differ.</div>`;
        }

        return "";
    }

    static #buildVisualComparisonMarkup(proposal)
    {
        // Only the figures are shown, not the whole passage. A diagram
        // refinement changes one element inside a lesson that may run for
        // pages, and putting both full lessons side by side would bury the one
        // thing being decided.
        const beforeFigures = RefinementProposalDialog.#extractFiguresMarkup(proposal.beforeHtml);
        const afterFigures = RefinementProposalDialog.#extractFiguresMarkup(proposal.afterHtml);

        const visionVerdict = proposal.visionReviewOutcome
            ? `
                <div class="refinement-vision-verdict">
                    <div class="refinement-vision-heading">Visual review</div>
                    <div>${RefinementProposalDialog.#escape(proposal.visionReviewOutcome)}</div>
                </div>
            `
            : "";

        return `
            ${RefinementProposalDialog.#buildSummaryMarkup(proposal)}
            ${visionVerdict}
            <div class="refinement-comparison">
                <div class="refinement-pane">
                    <div class="refinement-pane-heading">Now</div>
                    <div class="refinement-pane-body">${HtmlSanitizer.sanitize(beforeFigures)}</div>
                </div>
                <div class="refinement-pane">
                    <div class="refinement-pane-heading">Proposed</div>
                    <div class="refinement-pane-body">${HtmlSanitizer.sanitize(afterFigures)}</div>
                </div>
            </div>
        `;
    }

    static #buildSummaryMarkup(proposal)
    {
        const summaryLine = proposal.summary
            ? `<div class="refinement-proposal-summary">${RefinementProposalDialog.#escape(proposal.summary)}</div>`
            : "";

        const concernsLine = proposal.concerns
            ? `<div class="refinement-proposal-concerns"><strong>Check this:</strong> ${RefinementProposalDialog.#escape(proposal.concerns)}</div>`
            : "";

        // Consulted URLs are what the provider reported retrieving, not what the
        // model claimed. Where a provider reports nothing the wording says "not
        // recorded" rather than implying nothing was consulted — those are
        // different facts and only one of them is known.
        const consultedUrls = Array.isArray(proposal.consultedUrls) ? proposal.consultedUrls : [];
        const consultedLine = consultedUrls.length > 0
            ? `
                <div class="refinement-proposal-sources">
                    <span>Consulted:</span>
                    ${consultedUrls.map(url => `<a href="${RefinementProposalDialog.#escape(url)}" target="_blank" rel="noopener noreferrer">${RefinementProposalDialog.#escape(RefinementProposalDialog.#shortenUrl(url))}</a>`).join(" ")}
                </div>
            `
            : `<div class="refinement-proposal-sources refinement-muted">Consulted pages: not recorded for this model.</div>`;

        const modelLine = proposal.modelIdentifier
            ? `<div class="refinement-proposal-model refinement-muted">Produced by ${RefinementProposalDialog.#escape(proposal.modelIdentifier)}</div>`
            : "";

        return `${summaryLine}${concernsLine}${consultedLine}${modelLine}`;
    }

    static #extractFiguresMarkup(htmlContent)
    {
        const parsedDocument = new DOMParser().parseFromString(htmlContent || "", "text/html");
        const figureElements = parsedDocument.querySelectorAll("figure");

        if (figureElements.length === 0)
        {
            return `<div class="refinement-proposal-notice">No figure here.</div>`;
        }

        return Array.from(figureElements).map(figureElement => figureElement.outerHTML).join("");
    }

    static #shortenUrl(url)
    {
        try
        {
            const parsedUrl = new URL(url);
            return parsedUrl.hostname + (parsedUrl.pathname.length > 1 ? parsedUrl.pathname : "");
        }
        catch (parseError)
        {
            return url;
        }
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

export default RefinementProposalDialog;
