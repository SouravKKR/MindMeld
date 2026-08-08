import DialogBox from "../../../CommonComponents/DialogBox.js";
import CreditNotice from "../../../Globals/Classes/Credits/CreditNotice.js";
import AiFeatureGate from "../../../Globals/Classes/AiFeatureGate.js";
import MaintenanceNotice from "../../../Globals/Classes/MaintenanceNotice.js";
import ErrorCodes from "../../../Globals/Constants/ErrorCodes.js";

/**
 * ContentRefinementClient — the HTTP surface for content refinement.
 *
 * Split out of the page so the verification dialog in the admin panel and the
 * refinement page do not each grow their own copy of the status ladder. Every
 * refusal this feature can produce — maintenance, plan tier, credits, a stale
 * proposal — has a specific thing the user should do next, and a single handler
 * is what keeps all of them saying it.
 */
class ContentRefinementClient
{
    static #CONTENT_PROPOSAL_ENDPOINT = "/Refine/Content/Proposal";
    static #VISUAL_PROPOSAL_ENDPOINT = "/Refine/Visual/Proposal";
    static #APPLY_ENDPOINT = "/Refine/Content/Apply";

    /**
     * The diagram formats a reviewer can ask for. Mirrors VisualKinds, which is
     * what the generator routes on — a kind it does not recognise falls back to
     * inline SVG, so an unfamiliar choice degrades rather than fails.
     */
    static VISUAL_KIND_CHOICES =
    [
        { value: "RAY_DIAGRAM", label: "Ray diagram (optics)" },
        { value: "CIRCUIT_DIAGRAM", label: "Circuit diagram" },
        { value: "FREE_BODY_DIAGRAM", label: "Free-body / vector diagram" },
        { value: "GRAPH", label: "Graph or plotted axes" },
        { value: "GEOMETRIC_CONSTRUCTION", label: "Geometry or labelled solid" },
        { value: "FLOW_OR_PROCESS", label: "Flowchart or process" },
        { value: "HIERARCHY_OR_TAXONOMY", label: "Hierarchy or classification tree" },
        { value: "CHEMICAL_STRUCTURE", label: "Chemical structure" },
        { value: "EQUATION", label: "Typeset equation" },
        { value: "ILLUSTRATIVE_OR_CONCEPTUAL", label: "Illustrative picture (no exact geometry)" },
    ];

    static async proposeContentRevision(requestBody)
    {
        return await ContentRefinementClient.#postForProposal(ContentRefinementClient.#CONTENT_PROPOSAL_ENDPOINT, requestBody);
    }

    static async proposeVisualRevision(requestBody)
    {
        return await ContentRefinementClient.#postForProposal(ContentRefinementClient.#VISUAL_PROPOSAL_ENDPOINT, requestBody);
    }

    /**
     * Applies a proposal. Throws with a readable message on refusal so the
     * dialog can show it inline and keep itself open.
     */
    static async applyProposal({ proposal, instruction, informationSourceId, referenceSourceUrl })
    {
        const response = await fetch(ContentRefinementClient.#APPLY_ENDPOINT,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify
            ({
                entityId: proposal.entityId,
                targetKind: proposal.targetKind,
                revisedContent: proposal.afterHtml,
                baseContentHash: proposal.baseContentHash,
                instruction: instruction,
                summary: proposal.summary,
                concerns: proposal.concerns,
                modelIdentifier: proposal.modelIdentifier,
                consultedUrls: proposal.consultedUrls,
                visionReviewOutcome: proposal.visionReviewOutcome,
                visualMethod: proposal.visualMethod,
                informationSourceId: informationSourceId || "",
                referenceSourceUrl: referenceSourceUrl || "",
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
                || "This passage changed after the suggestion was prepared. Close this and ask again.");
        }

        throw new Error(errorJson.detail || errorJson.error || `Could not apply the change (HTTP ${response.status}).`);
    }

    /**
     * Asks which format the redrawn diagram should take, defaulting to the one
     * the existing figure already uses.
     */
    static async promptForVisualKind(currentMethod)
    {
        const methodToKind =
        {
            SMILES: "CHEMICAL_STRUCTURE",
            MERMAID: "FLOW_OR_PROCESS",
            KATEX: "EQUATION",
            RASTER_IMAGE: "ILLUSTRATIVE_OR_CONCEPTUAL",
            INLINE_SVG: "GEOMETRIC_CONSTRUCTION",
        };

        const defaultKind = methodToKind[currentMethod] || "GEOMETRIC_CONSTRUCTION";

        return await new Promise((resolve) =>
        {
            const dialog = DialogBox.modal(`
                <div class="refinement-visual-kind-dialog">
                    <div class="title-section">What kind of diagram is this?</div>
                    <div class="message-section">
                        This decides how it is drawn. A figure whose correctness depends on exact geometry or exact
                        labels should not be an illustrative picture — that route produces an image, and an image with
                        a wrong angle is worse than no diagram.
                    </div>
                    <select class="refinement-visual-kind-select">
                        ${ContentRefinementClient.VISUAL_KIND_CHOICES.map(choice => `
                            <option value="${choice.value}"${choice.value === defaultKind ? " selected" : ""}>${choice.label}</option>
                        `).join("")}
                    </select>
                    <div class="button-section">
                        <button type="button" class="cancel-button">Cancel</button>
                        <button type="button" class="ok-button">Continue</button>
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

            dialog.querySelector(".ok-button").addEventListener("click", () =>
                finalize(dialog.querySelector(".refinement-visual-kind-select").value));
            dialog.querySelector(".cancel-button").addEventListener("click", () => finalize(""));

            const closeButton = dialog.querySelector(".close-button");
            if (closeButton)
            {
                closeButton.addEventListener("click", () => finalize(""));
            }
        });
    }

    /**
     * Turns a thrown refusal into the right prompt.
     *
     * The distinction that matters is 403 versus 402: a user whose plan does not
     * include AI generation cannot fix that by buying credits, and showing them
     * a credit purchase flow would sell them something that does not unblock
     * them.
     */
    static async explainFailure(refinementError)
    {
        if (refinementError.bAlreadyReported)
        {
            // The maintenance notice has already been shown; a second dialog on
            // top of it is noise, not information.
            return;
        }

        if (refinementError.creditDetail)
        {
            await CreditNotice.showInsufficientCredits(refinementError.creditDetail);
            return;
        }

        if (refinementError.entitlementDetail)
        {
            await AiFeatureGate.showFeatureNotInPlanAlert(refinementError.entitlementDetail, "content refinement");
            return;
        }

        await DialogBox.alert("Could not suggest a change", refinementError.message);
    }

    static async #postForProposal(endpointPath, requestBody)
    {
        const response = await fetch(endpointPath,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
        });

        if (await MaintenanceNotice.handleIfMaintenance(response))
        {
            throw ContentRefinementClient.#buildSilentFailure();
        }

        if (response.ok)
        {
            const responseJson = await response.json();
            return responseJson.proposal;
        }

        const errorJson = await response.json().catch(() => ({}));

        if (response.status === 402)
        {
            const creditFailure = new Error("Not enough credits.");
            creditFailure.creditDetail = errorJson;
            throw creditFailure;
        }

        if (response.status === 403)
        {
            const entitlementFailure = new Error("Not included in this plan.");
            entitlementFailure.entitlementDetail = errorJson;
            throw entitlementFailure;
        }

        throw new Error(errorJson.detail || errorJson.error || `Could not prepare a suggestion (HTTP ${response.status}).`);
    }

    /**
     * A failure the caller must not narrate — the maintenance notice has already
     * been shown, and a second dialog on top of it would be noise.
     */
    static #buildSilentFailure()
    {
        const silentFailure = new Error("");
        silentFailure.bAlreadyReported = true;
        return silentFailure;
    }
}

export default ContentRefinementClient;
