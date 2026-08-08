import DialogBox from "../../../CommonComponents/DialogBox.js";
import VerificationFlagAutoFixer from "./VerificationFlagAutoFixer.js";

/**
 * PaidDeckVerificationDialog
 *
 * The review surface for a paid deck's generation provenance: what it was
 * generated from, which models produced it, and every factual-verification flag
 * the pipeline raised — with the two decisions that clear a blocking one.
 *
 * This is the half of the review gate that was missing. The server has always
 * been able to refuse a publish over an unresolved blocking flag and to expose
 * the flags through /Admin/PaidDecks/Provenance, but nothing in the app ever
 * called that endpoint. A gate that can refuse and cannot be answered is not a
 * gate an administrator can pass, so a firing gate would have meant a deck that
 * could never be published at all.
 *
 * Resolutions are appended, never edited. The stored record keeps showing both
 * what verification found and what a named person decided about it — the
 * distinction between a review gate and a dismiss button — so this dialog
 * offers no way to delete a flag or a past resolution.
 *
 * The publish decision is always taken from the server's response rather than
 * recomputed here. The panel that explains a refusal must not be able to
 * disagree with the server that issues it.
 */
class PaidDeckVerificationDialog
{
    static #PROVENANCE_ENDPOINT = "/Admin/PaidDecks/Provenance";
    static #RESOLVE_ENDPOINT = "/Admin/PaidDecks/ResolveVerificationFlag";

    static RESOLUTION_FIXED = "FIXED";
    static RESOLUTION_NOT_A_PROBLEM = "NOT_A_PROBLEM";

    static SEVERITY_BLOCKING = "blocking";

    static async show(deck)
    {
        if (!deck || typeof deck.id !== "string" || deck.id.length === 0)
        {
            await DialogBox.alert("No deck selected", "This row has no deck ID to look a verification record up by.");
            return;
        }

        let provenanceResponse = null;
        try
        {
            provenanceResponse = await fetch(`${PaidDeckVerificationDialog.#PROVENANCE_ENDPOINT}?deckId=${encodeURIComponent(deck.id)}`);
        }
        catch (fetchError)
        {
            await DialogBox.alert("Couldn't load verification", fetchError.message);
            return;
        }

        if (provenanceResponse.status === 404)
        {
            // Not an error to paper over. Decks made by hand, or by the ordinary
            // generation pipeline, have no paid-deck verification record and are
            // deliberately not gated on one.
            await DialogBox.alert
            (
                "No verification record",
                "This deck has no generation-provenance record, which means it was not produced by the "
                + "paid-deck generation pipeline. There are no verification flags to review."
            );
            return;
        }

        if (!provenanceResponse.ok)
        {
            const errorJson = await provenanceResponse.json().catch(() => ({}));
            await DialogBox.alert("Couldn't load verification", errorJson.error || `HTTP ${provenanceResponse.status}.`);
            return;
        }

        const responseJson = await provenanceResponse.json().catch(() => ({}));

        return new Promise((resolve) =>
        {
            const dialog = DialogBox.modal(`
                <div class="paid-deck-verification-dialog">
                    <div class="title-section">Verification — ${PaidDeckVerificationDialog.#escape(deck.title || deck.id)}</div>
                    <div data-role="verification-body"></div>
                </div>
            `);

            const bodyElement = dialog.querySelector('[data-role="verification-body"]');

            // Every run that put content into this deck. A deck generated into
            // more than once has one record per run, and the gate refuses until
            // every one of them is answered — so showing only the first would
            // leave a reviewer looking at a "Publishing is blocked" banner with
            // no flag on screen to explain it.
            const provenanceRecords = Array.isArray(responseJson.provenanceRecords) && responseJson.provenanceRecords.length > 0
                ? responseJson.provenanceRecords
                : [responseJson.provenance].filter(Boolean);

            PaidDeckVerificationDialog.#render(bodyElement, deck.id, provenanceRecords, responseJson.publishDecision);

            const closeButton = dialog.querySelector(".close-button");
            if (closeButton)
            {
                closeButton.addEventListener("click", () => resolve());
            }
        });
    }

    /**
     * Repaints the whole body from the deck's provenance records and a publish
     * decision. Re-rendering wholesale rather than patching the one row that
     * changed keeps the summary banner, the per-flag state and the resolution
     * list from drifting apart after a resolution is recorded.
     *
     * Each run gets its own block. They are not merged: two runs are two acts of
     * generation with their own sources, models and verification outcome, and a
     * flag index only means anything inside the run that raised it.
     */
    static #render(bodyElement, paidDeckId, provenanceRecords, publishDecision)
    {
        if (!bodyElement)
        {
            return;
        }

        const records = Array.isArray(provenanceRecords) ? provenanceRecords : [];

        const runBlocks = records.map((provenanceRecord, runIndex) =>
        {
            const verification = provenanceRecord?.verification || null;
            const flags = Array.isArray(verification?.flags) ? verification.flags : [];
            const resolvedFlagIndices = PaidDeckVerificationDialog.#collectResolvedFlagIndices(provenanceRecord?.flagResolutions);

            return `
                <div class="verification-run">
                    ${records.length > 1 ? `<div class="verification-run-heading">Generation run ${runIndex + 1} of ${records.length}</div>` : ""}
                    ${PaidDeckVerificationDialog.#buildSummaryMarkup(provenanceRecord, verification)}
                    ${PaidDeckVerificationDialog.#buildFlagsMarkup(flags, resolvedFlagIndices, provenanceRecord?.mainTaskId || "")}
                </div>
            `;
        }).join("");

        bodyElement.innerHTML = `
            ${PaidDeckVerificationDialog.#buildDecisionMarkup(publishDecision)}
            ${runBlocks}
        `;

        PaidDeckVerificationDialog.#wireResolutionButtons(bodyElement, paidDeckId, records);
        PaidDeckVerificationDialog.#wireAutoFixButtons(bodyElement, paidDeckId, records);
    }

    /**
     * Wires the per-flag "Auto fix with AI" buttons.
     *
     * The flow is: propose, show the reviewer a before/after, write only if they
     * accept — and then STOP. The flag stays unresolved, and the reviewer clicks
     * Mark fixed themselves with the refinement id already in the note.
     *
     * That last step is not friction to be optimised away. This gate exists
     * because the codebase has twice shipped controls that were stamped and
     * never read; a gate whose own fix button clears it is a gate that answers
     * itself. One deliberate click by a person who has seen the diff is the
     * difference between a review and an autopilot.
     */
    static #wireAutoFixButtons(bodyElement, paidDeckId, provenanceRecords)
    {
        const autoFixContainers = bodyElement.querySelectorAll(".verification-flag-autofix");

        for (const autoFixContainer of autoFixContainers)
        {
            const flagIndex = Number(autoFixContainer.dataset.flagIndex);
            const mainTaskId = autoFixContainer.dataset.mainTaskId || "";
            const autoFixButton = autoFixContainer.querySelector('[data-role="auto-fix"]');

            autoFixButton.addEventListener("click", async () =>
            {
                autoFixButton.disabled = true;
                autoFixButton.textContent = "Preparing…";

                try
                {
                    await VerificationFlagAutoFixer.run({
                        paidDeckId: paidDeckId,
                        mainTaskId: mainTaskId,
                        flagIndex: flagIndex,
                        onApplied: (refinementId) =>
                            PaidDeckVerificationDialog.#prefillResolutionNote(bodyElement, flagIndex, refinementId),
                    });
                }
                finally
                {
                    autoFixButton.disabled = false;
                    autoFixButton.textContent = "Auto fix with AI";
                }
            });
        }
    }

    /**
     * Puts the refinement id into the resolution note after a fix lands, so the
     * decision the reviewer records points at the evidence for it rather than
     * being an unexplained "FIXED".
     */
    static #prefillResolutionNote(bodyElement, flagIndex, refinementId)
    {
        const actionContainer = bodyElement.querySelector(`.verification-flag-actions[data-flag-index="${flagIndex}"]`);

        if (!actionContainer || !refinementId)
        {
            return;
        }

        const noteInput = actionContainer.querySelector('[data-role="resolution-note"]');

        if (noteInput && noteInput.value.trim().length === 0)
        {
            noteInput.value = `Corrected via AI fix (refinement ${refinementId}).`;
        }
    }

    static #buildDecisionMarkup(publishDecision)
    {
        if (!publishDecision)
        {
            return "";
        }

        if (publishDecision.allowed === true)
        {
            return `<div class="verification-decision verification-decision-allowed">Publishing is allowed. No unresolved blocking flags.</div>`;
        }

        return `
            <div class="verification-decision verification-decision-blocked">
                <strong>Publishing is blocked.</strong>
                <div>${PaidDeckVerificationDialog.#escape(publishDecision.detail || "")}</div>
            </div>
        `;
    }

    static #buildSummaryMarkup(provenanceRecord, verification)
    {
        if (!provenanceRecord)
        {
            return "";
        }

        const sources = Array.isArray(provenanceRecord.sources) ? provenanceRecord.sources : [];
        const sourceMarkup = sources.length > 0
            ? sources.map(source => `<li>${PaidDeckVerificationDialog.#escape(source.name || "(unnamed)")} <span class="verification-muted">${PaidDeckVerificationDialog.#escape(source.declaredSourceType || "")}</span></li>`).join("")
            : `<li class="verification-muted">None recorded.</li>`;

        // Model identifiers are read off the action trail rather than a
        // dedicated field: the trail is what each stage actually recorded at the
        // time, and that is the whole evidential value of the record.
        const modelIdentifiers = PaidDeckVerificationDialog.#collectModelIdentifiers(provenanceRecord.actions);
        const modelMarkup = modelIdentifiers.length > 0
            ? modelIdentifiers.map(modelIdentifier => `<li>${PaidDeckVerificationDialog.#escape(modelIdentifier)}</li>`).join("")
            : `<li class="verification-muted">None recorded.</li>`;

        const verificationSummary = verification
            ? `${verification.blockingFlagCount || 0} blocking, ${verification.advisoryFlagCount || 0} advisory, across ${verification.verifiedEntityCount || 0} entities.`
            : "No verification result was recorded for this run.";

        const coverage = provenanceRecord.coverageReconciliation;

        return `
            <div class="verification-summary">
                <div class="verification-summary-row"><span>Generated deck</span><span>${PaidDeckVerificationDialog.#escape(provenanceRecord.deckName || provenanceRecord.deckId || "")}</span></div>
                <div class="verification-summary-row"><span>Run</span><span>${PaidDeckVerificationDialog.#escape(provenanceRecord.mainTaskId || "")}</span></div>
                <div class="verification-summary-row"><span>Verification</span><span>${PaidDeckVerificationDialog.#escape(verificationSummary)}</span></div>
                <div class="verification-summary-row"><span>Published</span><span>${provenanceRecord.publishedAt ? PaidDeckVerificationDialog.#escape(new Date(provenanceRecord.publishedAt).toLocaleString()) : "Not yet"}</span></div>
                <div class="verification-summary-block"><span>Sources</span><ul>${sourceMarkup}</ul></div>
                <div class="verification-summary-block"><span>Models</span><ul>${modelMarkup}</ul></div>
                ${coverage ? `<div class="verification-summary-block"><span>Coverage</span><pre>${PaidDeckVerificationDialog.#escape(JSON.stringify(coverage, null, 2))}</pre></div>` : ""}
            </div>
        `;
    }

    static #buildFlagsMarkup(flags, resolvedFlagIndices, mainTaskId)
    {
        if (flags.length === 0)
        {
            return `<div class="verification-muted">No verification flags were raised.</div>`;
        }

        const flagRows = flags.map((flag, flagIndex) =>
        {
            const bBlocking = flag.severity === PaidDeckVerificationDialog.SEVERITY_BLOCKING;
            const bResolved = resolvedFlagIndices.has(flagIndex);
            const bNeedsDecision = bBlocking && !bResolved;

            const topicChain = Array.isArray(flag.topicChain) ? flag.topicChain.join(" › ") : "";

            return `
                <div class="verification-flag ${bBlocking ? "verification-flag-blocking" : "verification-flag-advisory"} ${bResolved ? "verification-flag-resolved" : ""}">
                    <div class="verification-flag-header">
                        <span class="verification-flag-severity">${bBlocking ? "Blocking" : "Advisory"}</span>
                        <span class="verification-flag-category">${PaidDeckVerificationDialog.#escape(flag.category || "")}</span>
                        <span class="verification-muted">${PaidDeckVerificationDialog.#escape(flag.source || "")}</span>
                        ${bResolved ? `<span class="verification-flag-resolved-badge">Resolved</span>` : ""}
                    </div>
                    ${topicChain ? `<div class="verification-muted">${PaidDeckVerificationDialog.#escape(topicChain)}</div>` : ""}
                    <div class="verification-flag-problem">${PaidDeckVerificationDialog.#escape(flag.problem || "")}</div>
                    ${flag.quotedText ? `<blockquote>${PaidDeckVerificationDialog.#escape(flag.quotedText)}</blockquote>` : ""}
                    ${PaidDeckVerificationDialog.#buildCitedPassageMarkup(flag)}
                    ${flag.correctStatement ? `<div class="verification-flag-correction">Expected: ${PaidDeckVerificationDialog.#escape(flag.correctStatement)}</div>` : ""}
                    ${bResolved ? "" : PaidDeckVerificationDialog.#buildAutoFixControlMarkup(flagIndex, mainTaskId)}
                    ${bNeedsDecision ? PaidDeckVerificationDialog.#buildDecisionControlsMarkup(flagIndex, mainTaskId) : ""}
                </div>
            `;
        }).join("");

        return `<div class="verification-flags">${flagRows}</div>`;
    }

    /**
     * The passage a source-grounded flag rests on, and which source it came
     * from.
     *
     * Shown because these flags make a materially stronger claim than the rest.
     * A MODEL flag says another model disagrees; an ADMIN_SOURCE flag says a
     * document a named person cleared and declared a licence for says otherwise
     * — and a reviewer can only weigh the second if they can read the sentence
     * it rests on. A flag asserting a document's authority without quoting it is
     * an opinion wearing that authority.
     *
     * Rendered for any flag carrying a passage rather than gated on the source
     * value, so a future check that also cites evidence displays it without
     * needing this branch changed.
     */
    static #buildCitedPassageMarkup(flag)
    {
        const citedPassage = String(flag.citedPassage || "").trim();

        if (citedPassage.length === 0)
        {
            return "";
        }

        const sourceName = String(flag.sourceName || "").trim() || "an attached source";

        return `
            <div class="verification-flag-citation">
                <div class="verification-flag-citation-source">From ${PaidDeckVerificationDialog.#escape(sourceName)}</div>
                <blockquote>${PaidDeckVerificationDialog.#escape(citedPassage)}</blockquote>
            </div>
        `;
    }

    /**
     * Offered on every UNRESOLVED flag, blocking or advisory.
     *
     * The resolution controls below are restricted to blocking flags because
     * resolving an advisory one changes nothing about publishing. Fixing one
     * does change something: "imprecise, ambiguous or misleading" is still wrong
     * on content a student paid for, and there is no reason the cheap correction
     * should be reserved for the flags that happen to block.
     */
    static #buildAutoFixControlMarkup(flagIndex, mainTaskId)
    {
        return `
            <div class="verification-flag-autofix" data-flag-index="${flagIndex}" data-main-task-id="${PaidDeckVerificationDialog.#escape(mainTaskId)}">
                <button type="button" data-role="auto-fix">Auto fix with AI</button>
                <span class="verification-muted">Shows you the change before anything is written.</span>
            </div>
        `;
    }

    /**
     * Only blocking, unresolved flags get controls. An advisory flag does not
     * stop a publish, so offering to "resolve" one would invite a reviewer to
     * spend their attention where it changes nothing.
     */
    static #buildDecisionControlsMarkup(flagIndex, mainTaskId)
    {
        return `
            <div class="verification-flag-actions" data-flag-index="${flagIndex}" data-main-task-id="${PaidDeckVerificationDialog.#escape(mainTaskId)}">
                <input type="text" data-role="resolution-note" placeholder="Note (optional)" maxlength="2000">
                <button type="button" data-role="resolve-fixed" data-resolution="${PaidDeckVerificationDialog.RESOLUTION_FIXED}">Mark fixed</button>
                <button type="button" data-role="resolve-not-a-problem" data-resolution="${PaidDeckVerificationDialog.RESOLUTION_NOT_A_PROBLEM}">Not a problem</button>
            </div>
        `;
    }

    static #wireResolutionButtons(bodyElement, paidDeckId, provenanceRecords)
    {
        const actionContainers = bodyElement.querySelectorAll(".verification-flag-actions");

        for (const actionContainer of actionContainers)
        {
            const flagIndex = Number(actionContainer.dataset.flagIndex);
            // The run this flag belongs to travels with the button. Without it the
            // server would have to guess which record a decision applies to, and
            // on a deck built by two runs the guess clears the wrong flag.
            const mainTaskId = actionContainer.dataset.mainTaskId || "";
            const noteInput = actionContainer.querySelector('[data-role="resolution-note"]');
            const decisionButtons = actionContainer.querySelectorAll("button[data-resolution]");

            for (const decisionButton of decisionButtons)
            {
                decisionButton.addEventListener("click", async () =>
                {
                    const resolution = decisionButton.dataset.resolution;

                    const bConfirmed = await DialogBox.confirm
                    (
                        "Record this decision?",
                        resolution === PaidDeckVerificationDialog.RESOLUTION_FIXED
                            ? "This records that the flagged content was corrected. The flag stays on the record beside your decision."
                            : "This records that you examined the flag and judged it wrong. The flag stays on the record beside your decision."
                    );

                    if (!bConfirmed)
                    {
                        return;
                    }

                    for (const buttonToDisable of decisionButtons)
                    {
                        buttonToDisable.disabled = true;
                    }

                    await PaidDeckVerificationDialog.#recordResolution
                    (
                        bodyElement,
                        paidDeckId,
                        provenanceRecords,
                        mainTaskId,
                        flagIndex,
                        resolution,
                        noteInput ? noteInput.value.trim() : ""
                    );
                });
            }
        }
    }

    static async #recordResolution(bodyElement, paidDeckId, provenanceRecords, mainTaskId, flagIndex, resolution, note)
    {
        try
        {
            const response = await fetch(PaidDeckVerificationDialog.#RESOLVE_ENDPOINT,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ deckId: paidDeckId, mainTaskId: mainTaskId, flagIndex: flagIndex, resolution: resolution, note: note })
            });

            const responseJson = await response.json().catch(() => ({}));

            if (!response.ok)
            {
                await DialogBox.alert("Couldn't record the decision", responseJson.detail || responseJson.error || `HTTP ${response.status}.`);
                PaidDeckVerificationDialog.#render(bodyElement, paidDeckId, provenanceRecords, null);
                return;
            }

            // Mirror the appended resolution locally so the re-render reflects it
            // without a second round trip — onto THAT run's record only, since a
            // resolution belongs to the run whose flag it answers. The publish
            // decision, however, is the server's and is never re-derived here.
            const updatedRecords = provenanceRecords.map((provenanceRecord) =>
            {
                if (provenanceRecord.mainTaskId !== mainTaskId)
                {
                    return provenanceRecord;
                }

                return {
                    ...provenanceRecord,
                    flagResolutions:
                    [
                        ...(Array.isArray(provenanceRecord.flagResolutions) ? provenanceRecord.flagResolutions : []),
                        { flagIndex: flagIndex, resolution: resolution, note: note || null, resolvedAt: Date.now() }
                    ]
                };
            });

            PaidDeckVerificationDialog.#render(bodyElement, paidDeckId, updatedRecords, responseJson.publishDecision);
        }
        catch (resolutionError)
        {
            await DialogBox.alert("Couldn't record the decision", resolutionError.message);
        }
    }

    /**
     * Mirrors PaidDeckPublishGate's rule: only FIXED and NOT_A_PROBLEM clear a
     * flag. Any other stored resolution leaves it blocking, so a future decision
     * type cannot silently start clearing flags in the UI before the gate agrees.
     */
    static #collectResolvedFlagIndices(flagResolutions)
    {
        const resolvedFlagIndices = new Set();

        for (const resolution of (flagResolutions || []))
        {
            if (typeof resolution.flagIndex !== "number")
            {
                continue;
            }
            if (resolution.resolution === PaidDeckVerificationDialog.RESOLUTION_FIXED
                || resolution.resolution === PaidDeckVerificationDialog.RESOLUTION_NOT_A_PROBLEM)
            {
                resolvedFlagIndices.add(resolution.flagIndex);
            }
        }

        return resolvedFlagIndices;
    }

    static #collectModelIdentifiers(actions)
    {
        const modelIdentifiers = new Set();

        for (const action of (actions || []))
        {
            if (typeof action.modelIdentifier === "string" && action.modelIdentifier.length > 0)
            {
                modelIdentifiers.add(action.modelIdentifier);
            }
        }

        return Array.from(modelIdentifiers);
    }

    static #escape(rawValue)
    {
        if (rawValue === null || rawValue === undefined) return "";
        return String(rawValue)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }
}

export default PaidDeckVerificationDialog;
