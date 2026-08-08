import DialogBox from "../../../CommonComponents/DialogBox.js";
import RefinementProposalDialog from "../../../CommonComponents/RefinementProposalDialog.js";
import ErrorCodes from "../../../Globals/Constants/ErrorCodes.js";

/**
 * VerificationFlagAutoFixer — drives the "Auto fix with AI" flow for one flag.
 *
 * Split out of PaidDeckVerificationDialog so the dialog stays a rendering of the
 * provenance record. The dialog's job is to show what verification found and
 * what people decided about it; the two-step propose-then-apply conversation
 * with the server is a separate concern with its own failure modes.
 *
 * Three refusals get their own handling because each has a different right
 * answer for the administrator:
 *
 *   AMBIGUOUS — the quoted text matched several passages. A picker is shown.
 *     Choosing for them would eventually correct a passage nobody reviewed,
 *     since near-duplicate wording across sibling topics is normal in generated
 *     content rather than exceptional.
 *
 *   NOT_EDITABLE — the flag is about a mock test, whose content this pipeline
 *     does not treat as a refinable field. Said plainly, so the administrator
 *     resolves the flag with a note instead of concluding the button is broken.
 *
 *   NOT_FOUND — the quoted text is gone, which usually means it was already
 *     corrected. The useful next action is to resolve the flag, not to retry.
 */
class VerificationFlagAutoFixer
{
    static #PROPOSAL_ENDPOINT = "/Admin/PaidDecks/AutoFixFlagProposal";
    static #APPLY_ENDPOINT = "/Admin/PaidDecks/AutoFixFlagApply";

    /**
     * @param {object} runRequest — paidDeckId, mainTaskId, flagIndex, onApplied
     */
    static async run(runRequest)
    {
        let chosenCandidate = null;

        // Two attempts at most: the first may come back ambiguous, and the
        // second carries the administrator's choice. A loop would invite an
        // endless picker on a deck where every topic reads alike.
        for (let attemptIndex = 0; attemptIndex < 2; attemptIndex += 1)
        {
            const proposalOutcome = await VerificationFlagAutoFixer.#requestProposal(runRequest, chosenCandidate);

            if (proposalOutcome.bAmbiguous && chosenCandidate === null)
            {
                chosenCandidate = await VerificationFlagAutoFixer.#promptForCandidate(proposalOutcome.candidates);

                if (chosenCandidate === null)
                {
                    return;
                }

                continue;
            }

            if (!proposalOutcome.proposal)
            {
                return;
            }

            await VerificationFlagAutoFixer.#reviewAndApply(runRequest, proposalOutcome.proposal);
            return;
        }
    }

    static async #requestProposal(runRequest, chosenCandidate)
    {
        let response;

        try
        {
            response = await fetch(VerificationFlagAutoFixer.#PROPOSAL_ENDPOINT,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify
                ({
                    deckId: runRequest.paidDeckId,
                    mainTaskId: runRequest.mainTaskId,
                    flagIndex: runRequest.flagIndex,
                    entityId: chosenCandidate ? chosenCandidate.entityId : undefined,
                    targetKind: chosenCandidate ? chosenCandidate.targetKind : undefined,
                }),
            });
        }
        catch (networkError)
        {
            await DialogBox.alert("Could not prepare a fix", networkError.message);
            return { proposal: null, bAmbiguous: false, candidates: [] };
        }

        if (response.ok)
        {
            const responseJson = await response.json();
            return { proposal: responseJson.proposal, bAmbiguous: false, candidates: [] };
        }

        const errorJson = await response.json().catch(() => ({}));

        if (errorJson.error === ErrorCodes.REFINEMENT_TARGET_AMBIGUOUS)
        {
            return { proposal: null, bAmbiguous: true, candidates: errorJson.candidates || [] };
        }

        if (errorJson.error === ErrorCodes.REFINEMENT_TARGET_NOT_EDITABLE)
        {
            await DialogBox.alert("This one cannot be auto-fixed", errorJson.detail);
            return { proposal: null, bAmbiguous: false, candidates: [] };
        }

        if (errorJson.error === ErrorCodes.REFINEMENT_TARGET_NOT_FOUND)
        {
            await DialogBox.alert(
                "The flagged text is not there any more",
                errorJson.detail || "It may already have been corrected. If so, resolve the flag directly.",
            );
            return { proposal: null, bAmbiguous: false, candidates: [] };
        }

        await DialogBox.alert("Could not prepare a fix", errorJson.detail || errorJson.error || `HTTP ${response.status}.`);
        return { proposal: null, bAmbiguous: false, candidates: [] };
    }

    static #promptForCandidate(candidates)
    {
        return new Promise((resolve) =>
        {
            const dialog = DialogBox.modal(`
                <div class="verification-candidate-dialog">
                    <div class="title-section">Which passage is this flag about?</div>
                    <div class="message-section">
                        The quoted text appears in more than one place. Pick the one the flag refers to — nothing is
                        changed until you have seen the proposed correction.
                    </div>
                    <div class="verification-candidate-list">
                        ${candidates.map((candidate, candidateIndex) => `
                            <button type="button" class="verification-candidate" data-candidate-index="${candidateIndex}">
                                <span class="verification-candidate-heading">
                                    ${VerificationFlagAutoFixer.#escape(candidate.entityTypeName)}
                                    ${candidate.deckName ? `— ${VerificationFlagAutoFixer.#escape(candidate.deckName)}` : ""}
                                </span>
                                <span class="verification-candidate-preview">${VerificationFlagAutoFixer.#escape(candidate.previewText || "")}</span>
                            </button>
                        `).join("")}
                    </div>
                    <div class="button-section">
                        <button type="button" class="cancel-button">Cancel</button>
                    </div>
                </div>
            `);

            let bResolved = false;
            const finalize = (value) =>
            {
                if (bResolved)
                {
                    return;
                }
                bResolved = true;
                dialog.close();
                resolve(value);
            };

            dialog.querySelectorAll(".verification-candidate").forEach((candidateButton) =>
            {
                candidateButton.addEventListener("click", () =>
                    finalize(candidates[Number(candidateButton.dataset.candidateIndex)]));
            });

            dialog.querySelector(".cancel-button").addEventListener("click", () => finalize(null));

            const closeButton = dialog.querySelector(".close-button");
            if (closeButton)
            {
                closeButton.addEventListener("click", () => finalize(null));
            }
        });
    }

    static async #reviewAndApply(runRequest, proposal)
    {
        const reviewOutcome = await RefinementProposalDialog.show(proposal,
        {
            bVisualComparison: false,
            applyLabel: "Apply this correction",
            onApply: async () => await VerificationFlagAutoFixer.#applyProposal(runRequest, proposal),
        });

        if (reviewOutcome.result !== RefinementProposalDialog.RESULT_APPLIED)
        {
            return;
        }

        if (typeof runRequest.onApplied === "function")
        {
            runRequest.onApplied(reviewOutcome.refinementId);
        }

        // Says plainly that the flag is still open. An administrator who has
        // just watched a correction land will otherwise reasonably assume the
        // flag went with it, and then be surprised by the publish gate.
        await DialogBox.alert(
            "Correction applied",
            "The content has been corrected and recorded. The flag is still open — review the change and then "
                + "mark it fixed, so the record shows a person decided rather than a process.",
        );
    }

    static async #applyProposal(runRequest, proposal)
    {
        const response = await fetch(VerificationFlagAutoFixer.#APPLY_ENDPOINT,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify
            ({
                deckId: runRequest.paidDeckId,
                mainTaskId: proposal.mainTaskId,
                flagIndex: proposal.flagIndex,
                entityId: proposal.entityId,
                targetKind: proposal.targetKind,
                revisedContent: proposal.afterHtml,
                baseContentHash: proposal.baseContentHash,
                instruction: "Verification flag auto-fix.",
                summary: proposal.summary,
                concerns: proposal.concerns,
                modelIdentifier: proposal.modelIdentifier,
                consultedUrls: proposal.consultedUrls,
            }),
        });

        if (response.ok)
        {
            return await response.json();
        }

        const errorJson = await response.json().catch(() => ({}));

        if (response.status === 409 && errorJson.error === ErrorCodes.REFINEMENT_BASE_CONTENT_CHANGED)
        {
            throw new Error(errorJson.detail
                || "This passage changed after the correction was prepared. Close this and try again.");
        }

        throw new Error(errorJson.detail || errorJson.error || `Could not apply the correction (HTTP ${response.status}).`);
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

export default VerificationFlagAutoFixer;
