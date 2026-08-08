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
 * and applies to model output exactly as it does to anything else.
 */
class RefinementProposalDialog
{
    static RESULT_APPLIED = "APPLIED";
    static RESULT_REFINE_AGAIN = "REFINE_AGAIN";
    static RESULT_DISCARDED = "DISCARDED";

    /**
     * Shows a proposal and resolves with what the reviewer decided.
     *
     * @param {object} proposal — beforeHtml, afterHtml, summary, concerns,
     *   consultedUrls, modelIdentifier, visionReviewOutcome, visualMethod
     * @param {object} options — bVisualComparison, applyLabel, onApply
     * @return {Promise<{result: string, refinementId: (string|null)}>}
     */
    static show(proposal, options = {})
    {
        return new Promise((resolve) =>
        {
            const bVisualComparison = options.bVisualComparison === true;

            const dialog = DialogBox.modal(`
                <div class="refinement-proposal-dialog">
                    <div class="title-section">Before and after</div>
                    <div class="refinement-proposal-body" data-role="proposal-body"></div>
                    <div class="refinement-proposal-error" data-role="proposal-error" hidden></div>
                    <div class="refinement-proposal-actions">
                        <button type="button" class="refinement-proposal-discard">Discard</button>
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

            const closeButton = dialog.querySelector(".close-button");
            if (closeButton)
            {
                closeButton.addEventListener("click", () => finalize(RefinementProposalDialog.RESULT_DISCARDED));
            }

            discardButton.addEventListener("click", () => finalize(RefinementProposalDialog.RESULT_DISCARDED));
            refineButton.addEventListener("click", () => finalize(RefinementProposalDialog.RESULT_REFINE_AGAIN));

            applyButton.addEventListener("click", async () =>
            {
                if (typeof options.onApply !== "function")
                {
                    finalize(RefinementProposalDialog.RESULT_APPLIED);
                    return;
                }

                applyButton.disabled = true;
                refineButton.disabled = true;
                applyButton.textContent = "Applying…";
                errorElement.hidden = true;

                try
                {
                    const applyOutcome = await options.onApply(proposal);
                    finalize(RefinementProposalDialog.RESULT_APPLIED, applyOutcome ? applyOutcome.refinementId : null);
                }
                catch (applyError)
                {
                    // Kept open on failure. The commonest failure here is a 409
                    // because the passage moved, and the useful next action is
                    // "Refine further" — which needs the dialog still on screen.
                    errorElement.textContent = applyError.message;
                    errorElement.hidden = false;
                    applyButton.disabled = false;
                    refineButton.disabled = false;
                    applyButton.textContent = options.applyLabel || "Apply this change";
                }
            });
        });
    }

    static #buildTextComparisonMarkup(proposal)
    {
        const difference = HtmlDiffBuilder.build(proposal.beforeHtml, proposal.afterHtml);

        const noChangeNotice = difference.bAnyChange
            ? ""
            : `<div class="refinement-proposal-notice">The wording is unchanged. Only formatting or figures differ.</div>`;

        return `
            ${RefinementProposalDialog.#buildSummaryMarkup(proposal)}
            ${noChangeNotice}
            <div class="refinement-comparison">
                <div class="refinement-pane">
                    <div class="refinement-pane-heading">Now</div>
                    <div class="refinement-pane-body">${difference.beforeHtml}</div>
                </div>
                <div class="refinement-pane">
                    <div class="refinement-pane-heading">Proposed</div>
                    <div class="refinement-pane-body">${difference.afterHtml}</div>
                </div>
            </div>
        `;
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
