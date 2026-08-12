import DialogBox from "./DialogBox.js";
import { sourceLicenceTypes } from "../Globals/Enumerations/SourceLicenceTypes.js";
import { sourceUsageModes } from "../Globals/Enumerations/SourceUsageModes.js";

/**
 * SourceLicenceDeclarationForm — asks for the basis on which a third-party
 * document may be used, and returns the declaration.
 *
 * Shared by every surface that attaches a document to sellable content: the
 * content-refinement reference attachment, and the paid-deck verification
 * sources dialog. It exists as one class because the RULES are the thing worth
 * sharing — which choices are offered, which of them need a note, which need
 * attribution. Two copies would drift, and the copy that drifted would be the
 * one recording a weaker declaration than the server will accept, producing a
 * form that says yes and a save that says no.
 *
 * THE DECLARATION IS A CLAIM BY THE PERSON MAKING IT, not a verification. The
 * wording says so throughout, because a form implying the platform had checked
 * would be worse than one that makes the responsibility explicit.
 *
 * These rules MIRROR VerificationSourceLicenceGate on the server; they do not
 * replace it. The server refuses the same cases independently, so a request
 * that never went through this form is refused too — a control that exists only
 * in the browser is not a control.
 */
class SourceLicenceDeclarationForm
{
    /**
     * Licence choices, ordered by how often they will honestly apply.
     *
     * "Not specified" is deliberately absent. An attached document with no
     * stated basis is the exact case this component exists to prevent, and
     * offering it as an option invites it.
     */
    static LICENCE_CHOICES =
    [
        { value: sourceLicenceTypes.CC0, label: "CC0 / no rights reserved" },
        { value: sourceLicenceTypes.PUBLIC_DOMAIN, label: "Public domain" },
        { value: sourceLicenceTypes.CC_BY, label: "Creative Commons BY" },
        { value: sourceLicenceTypes.OWN_WORK, label: "My own work" },
        { value: sourceLicenceTypes.LICENSED_PERMISSION, label: "Licensed, or I hold written permission" },
        { value: sourceLicenceTypes.OTHER, label: "Other — described in the note" },
    ];

    /**
     * Choices whose meaning lives entirely in the note beside them. Neither
     * names a licence on its own — one says "something else", the other says
     * "we have permission" — so without the note they record that someone
     * opened a dropdown, not what the basis is.
     */
    static NOTE_REQUIRED_LICENCE_TYPES = [sourceLicenceTypes.OTHER, sourceLicenceTypes.LICENSED_PERMISSION];

    /**
     * Choices that impose an attribution condition. Attribution cannot be given
     * if the record does not say what to attribute, so either a URL or a note
     * naming the author satisfies it.
     */
    static ATTRIBUTION_REQUIRED_LICENCE_TYPES = [sourceLicenceTypes.CC_BY];

    /**
     * Choices under which a source may also be used to WRITE deck content, not
     * only to check it. Mirrors SourceUsageGate.DERIVATIVE_PERMITTING_LICENCE_TYPES.
     *
     * OTHER is absent on purpose. It makes a complete declaration — the note
     * says what the basis is — and it is fine for checking a deck against. It is
     * not enough to generate sellable material from, because nothing in "other,
     * see note" commits to the derivative right having been granted.
     */
    static DERIVATIVE_PERMITTING_LICENCE_TYPES = [
        sourceLicenceTypes.CC0,
        sourceLicenceTypes.PUBLIC_DOMAIN,
        sourceLicenceTypes.CC_BY,
        sourceLicenceTypes.OWN_WORK,
        sourceLicenceTypes.LICENSED_PERMISSION,
    ];

    /**
     * What a source may be used for, in the order the choices are offered.
     *
     * Declared once here and rendered by all three surfaces — the generation
     * page's per-source rows, the admin attach dialog and the admin edit dialog
     * — so the wording cannot differ between the place a mode is chosen and the
     * place it is changed. `bRequiresDerivativeLicence` is what each surface
     * asks when deciding which options to disable, rather than each testing the
     * modes it happens to remember.
     *
     * `compactLabel` exists because one of those surfaces is a three-column grid
     * row carrying a file name and a note beside the select, where the full
     * sentence would widen the select and squeeze both. It is a shorter way of
     * saying the same thing, not a different choice — which is exactly why it
     * belongs in this table rather than being written out again at that surface.
     */
    static USAGE_MODE_CHOICES =
    [
        {
            value: sourceUsageModes.VERIFICATION_ONLY,
            label: "Check the deck against it only",
            compactLabel: "Check against only",
            bRequiresDerivativeLicence: false,
        },
        {
            value: sourceUsageModes.CONTENT_AND_VERIFICATION,
            label: "Write the deck's content from it, and check against it",
            compactLabel: "Write from it, and check",
            bRequiresDerivativeLicence: true,
        },
        {
            value: sourceUsageModes.CONTENT_ONLY,
            label: "Write the deck's content from it — do not check against it",
            compactLabel: "Write from it only",
            bRequiresDerivativeLicence: true,
        },
    ];

    /**
     * The modes under which the deck is WRITTEN from the source. Mirrors
     * SourceUsageGate.CONTENT_BEARING_USAGE_MODES.
     */
    static CONTENT_BEARING_USAGE_MODES = [
        sourceUsageModes.CONTENT_AND_VERIFICATION,
        sourceUsageModes.CONTENT_ONLY,
    ];

    /**
     * True when the mode means the deck is written from the source.
     */
    static isContentUsage(usageMode)
    {
        return SourceLicenceDeclarationForm.CONTENT_BEARING_USAGE_MODES.includes(Number(usageMode));
    }

    /**
     * A stored usage mode as a value this form can render, or VERIFICATION_ONLY.
     *
     * Needed because a select seeded with a two-way ternary silently rewrites
     * any mode it does not recognise — which would mean opening the edit dialog
     * on a source and being offered, by default, a downgrade nobody asked for.
     * Mirrors SourceUsageGate.normaliseUsageMode, which is authoritative; this
     * one only decides what to show.
     */
    static normaliseUsageMode(usageMode)
    {
        const numericUsageMode = Number(usageMode);

        return SourceLicenceDeclarationForm.USAGE_MODE_CHOICES
            .some(choice => choice.value === numericUsageMode)
                ? numericUsageMode
                : sourceUsageModes.VERIFICATION_ONLY;
    }

    /**
     * The short label for a stored mode, for a badge rather than a dropdown.
     */
    static describeUsage(usageMode)
    {
        switch (SourceLicenceDeclarationForm.normaliseUsageMode(usageMode))
        {
            case sourceUsageModes.CONTENT_AND_VERIFICATION:
                return "Writing content, and checking";

            case sourceUsageModes.CONTENT_ONLY:
                return "Writing content only";

            default:
                return "Checking only";
        }
    }

    /**
     * The markup for the usage-mode options, disabled where the licence cannot
     * carry them.
     *
     * Shared by all three surfaces so a mode can never be offered by one and
     * withheld by another. The suffix explains the disabling in place, because a
     * greyed option with no reason beside it reads as a bug.
     */
    static buildUsageModeOptionsMarkup(selectedUsageMode, bPermitsContent, options = {})
    {
        const bCompact = options.bCompact === true;
        const unavailableSuffix = bCompact ? " — licence does not allow" : " — not available under this basis";
        const normalisedUsageMode = SourceLicenceDeclarationForm.normaliseUsageMode(selectedUsageMode);

        return SourceLicenceDeclarationForm.USAGE_MODE_CHOICES.map(choice =>
        {
            const bDisabled = choice.bRequiresDerivativeLicence && !bPermitsContent;
            const baseLabel = bCompact ? choice.compactLabel : choice.label;
            const label = bDisabled ? `${baseLabel}${unavailableSuffix}` : baseLabel;
            const bSelected = choice.value === normalisedUsageMode && !bDisabled;

            return `<option value="${choice.value}"${bDisabled ? " disabled" : ""}${bSelected ? " selected" : ""}>`
                + `${label}</option>`;
        }).join("");
    }

    /**
     * Whether the chosen licence permits writing new material from the source.
     * Used to enable or disable the content-usage option while the user is
     * choosing, so they are told the rule rather than refused after saving.
     */
    static permitsContentUsage(licenceType)
    {
        return SourceLicenceDeclarationForm.DERIVATIVE_PERMITTING_LICENCE_TYPES.includes(Number(licenceType));
    }

    /**
     * Checks a declaration and returns the reason it is incomplete, or null.
     *
     * Static and side-effect free so callers that render the fields inline —
     * rather than through the dialog below — validate by the same rules.
     */
    static findProblem(declaration)
    {
        const licenceType = Number(declaration ? declaration.licenceType : NaN);
        const licenceNote = String((declaration && declaration.licenceNote) || "").trim();
        const sourceUrl = String((declaration && declaration.sourceUrl) || "").trim();

        if (!Number.isInteger(licenceType) || licenceType === sourceLicenceTypes.UNSPECIFIED)
        {
            return "Choose the basis on which this source may be used.";
        }

        if (SourceLicenceDeclarationForm.isContentUsage(declaration ? declaration.usageMode : 0)
            && !SourceLicenceDeclarationForm.permitsContentUsage(licenceType))
        {
            return "This basis does not record a right to create new material from the source, so it can only be "
                + "used to check the deck. To write content from it, choose the licence you hold, or "
                + "\"Licensed, or I hold written permission\" with a note naming who granted it.";
        }

        if (SourceLicenceDeclarationForm.NOTE_REQUIRED_LICENCE_TYPES.includes(licenceType) && licenceNote.length === 0)
        {
            return "Describe the basis in the note — this choice does not name a licence on its own.";
        }

        if (SourceLicenceDeclarationForm.ATTRIBUTION_REQUIRED_LICENCE_TYPES.includes(licenceType)
            && licenceNote.length === 0
            && sourceUrl.length === 0)
        {
            return "This licence requires attribution. Give the source URL, or name the author in the note.";
        }

        return null;
    }

    /**
     * The markup for the three fields, for a caller embedding them in its own
     * dialog rather than opening the one below.
     *
     * @param {{bShowUrlField: boolean, urlLabel: string, bShowUsageFields: boolean}} options
     */
    static buildFieldsMarkup(options = {})
    {
        const bShowUrlField = options.bShowUrlField !== false;
        const bShowUsageFields = options.bShowUsageFields === true;
        const urlLabel = options.urlLabel || "Source URL (where this came from)";

        // Offered only where a source can actually feed generation — the
        // paid-deck surfaces. The refinement flow attaches a document to justify
        // one correction and has no generation to feed, so showing it there
        // would be a question with no consequence.
        const usageFieldsMarkup = bShowUsageFields
            ? `
                <label class="source-licence-field">
                    <span>How this source is used</span>
                    <select data-role="source-usage-mode">
                        ${SourceLicenceDeclarationForm.buildUsageModeOptionsMarkup(
                            sourceUsageModes.VERIFICATION_ONLY, true)}
                    </select>
                </label>
                <label class="source-licence-field">
                    <span>Note (anything worth recording about this source — kept in the audit report)</span>
                    <textarea data-role="source-note" maxlength="2048" rows="2"
                        placeholder="e.g. purchased under order #1234, licence PDF filed with legal"></textarea>
                </label>
            `
            : "";

        const urlFieldMarkup = bShowUrlField
            ? `
                <label class="source-licence-field">
                    <span>${urlLabel}</span>
                    <input type="url" data-role="licence-source-url" maxlength="2048" placeholder="https://…">
                </label>
            `
            : "";

        return `
            <div class="source-licence-fields">
                <label class="source-licence-field">
                    <span>Basis</span>
                    <select data-role="licence-type">
                        ${SourceLicenceDeclarationForm.LICENCE_CHOICES.map(choice =>
                            `<option value="${choice.value}">${choice.label}</option>`).join("")}
                    </select>
                </label>
                <label class="source-licence-field">
                    <span>Note (where it came from, licence reference, who granted permission)</span>
                    <input type="text" data-role="licence-note" maxlength="1024"
                        placeholder="e.g. NIST SP 800-145, US Government publication">
                </label>
                ${urlFieldMarkup}
                ${usageFieldsMarkup}
                <div class="source-licence-error" data-role="licence-error" hidden></div>
            </div>
        `;
    }

    /**
     * Reads the declaration out of a container the caller rendered.
     *
     * usageMode defaults to VERIFICATION_ONLY when the field is absent, which is
     * both what a caller that did not render it means and the safe direction to
     * default in: a missing field can never turn into permission to generate.
     */
    static readFields(containerElement)
    {
        const urlInput = containerElement.querySelector('[data-role="licence-source-url"]');
        const usageModeSelect = containerElement.querySelector('[data-role="source-usage-mode"]');
        const sourceNoteInput = containerElement.querySelector('[data-role="source-note"]');

        return {
            licenceType: Number(containerElement.querySelector('[data-role="licence-type"]').value),
            licenceNote: containerElement.querySelector('[data-role="licence-note"]').value.trim(),
            sourceUrl: urlInput ? urlInput.value.trim() : "",
            usageMode: usageModeSelect ? Number(usageModeSelect.value) : sourceUsageModes.VERIFICATION_ONLY,
            sourceNote: sourceNoteInput ? sourceNoteInput.value.trim() : "",
        };
    }

    /**
     * Keeps the content-usage options in step with the chosen licence, disabling
     * them (and falling back to verification-only) when the licence does not
     * record a derivative right.
     *
     * Bound by any caller that renders the usage fields. This is a courtesy, not
     * a control — SourceUsageGate refuses the same combination server-side — so
     * it is safe for it to be bypassed.
     *
     * Every content-bearing option is walked, not a remembered one. Holding a
     * single option here was what made adding a third mode a correctness change
     * rather than a markup change: the mode nobody updated this function for
     * would have stayed selectable under a licence that cannot carry it.
     */
    static bindUsageModeToLicence(containerElement)
    {
        const licenceTypeSelect = containerElement.querySelector('[data-role="licence-type"]');
        const usageModeSelect = containerElement.querySelector('[data-role="source-usage-mode"]');

        if (!licenceTypeSelect || !usageModeSelect)
        {
            return;
        }

        const applyLicenceRule = () =>
        {
            const bPermitted = SourceLicenceDeclarationForm.permitsContentUsage(licenceTypeSelect.value);

            for (const choice of SourceLicenceDeclarationForm.USAGE_MODE_CHOICES)
            {
                if (!choice.bRequiresDerivativeLicence)
                {
                    continue;
                }

                const optionElement = usageModeSelect.querySelector(`option[value="${choice.value}"]`);

                if (optionElement === null)
                {
                    continue;
                }

                optionElement.disabled = !bPermitted;
                optionElement.textContent = bPermitted
                    ? choice.label
                    : `${choice.label} — not available under this basis`;
            }

            if (!bPermitted && SourceLicenceDeclarationForm.isContentUsage(usageModeSelect.value))
            {
                usageModeSelect.value = String(sourceUsageModes.VERIFICATION_ONLY);
            }
        };

        licenceTypeSelect.addEventListener("change", applyLicenceRule);
        applyLicenceRule();
    }

    /**
     * Shows the declaration on its own, and resolves with it or with null when
     * the user backs out.
     *
     * @param {{title: string, message: string, bShowUrlField: boolean, urlLabel: string}} options
     * @return {Promise<{licenceType: number, licenceNote: string, sourceUrl: string}|null>}
     */
    static prompt(options = {})
    {
        const title = options.title || "On what basis may this document be used?";
        const message = options.message
            || "This will be used against content that is sold. Declare the basis on which the material may be used — "
             + "you are stating this, and the document is retained alongside your declaration so it can be produced later.";

        return new Promise((resolve) =>
        {
            const dialog = DialogBox.modal(`
                <div class="source-licence-dialog">
                    <div class="title-section">${title}</div>
                    <div class="message-section">${message}</div>
                    ${SourceLicenceDeclarationForm.buildFieldsMarkup(options)}
                    <div class="button-section">
                        <button type="button" class="cancel-button">Cancel</button>
                        <button type="button" class="ok-button">Continue</button>
                    </div>
                </div>
            `);

            SourceLicenceDeclarationForm.bindUsageModeToLicence(dialog);

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
            {
                const declaration = SourceLicenceDeclarationForm.readFields(dialog);
                const problem = SourceLicenceDeclarationForm.findProblem(declaration);
                const errorElement = dialog.querySelector('[data-role="licence-error"]');

                if (problem !== null)
                {
                    errorElement.textContent = problem;
                    errorElement.hidden = false;
                    return;
                }

                finalize(declaration);
            });

            dialog.querySelector(".cancel-button").addEventListener("click", () => finalize(null));

            const closeButton = dialog.querySelector(".close-button");
            if (closeButton)
            {
                closeButton.addEventListener("click", () => finalize(null));
            }
        });
    }

    /**
     * The human label for a stored licence value.
     */
    static describeLicence(licenceType, licenceNote)
    {
        const choice = SourceLicenceDeclarationForm.LICENCE_CHOICES
            .find(candidate => candidate.value === Number(licenceType));

        const label = choice ? choice.label : "Not specified";
        const note = String(licenceNote || "").trim();

        return note.length > 0 ? `${label} — ${note}` : label;
    }
}

export default SourceLicenceDeclarationForm;
