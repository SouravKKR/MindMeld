import DialogBox from "../../../CommonComponents/DialogBox.js";
import { askAiPromptModes } from "../../../Globals/Enumerations/AskAiPromptModes.js";


/**
 * EnhanceFlow
 *
 * Shared "pick an enhancement tool + optional instructions" modal used
 * by both surfaces that drive the AskAi enhancement actions:
 *
 *   - StudySessionBottomPanel's Enhance button (whole-entity mode —
 *     no highlighted fragment; the prompt builder routes to the
 *     *_WHOLE_USER template).
 *   - TextSelectionContextMenu's Enhance button (selection-aware mode
 *     — the menu hands its selected fragment to its existing dispatch
 *     helper, which forwards selectedText to AskAiSession; the prompt
 *     builder then picks the SELECTION-variant template).
 *
 * The flow itself owns ONLY the picker UI — it returns the user's
 * choice and the caller wires its existing AskAiSession dispatch path
 * (which already knows about tier validation, grounding sources,
 * attached images, etc.). Keeping it minimal avoids duplicating the
 * per-surface state plumbing — the bottom panel and the selection
 * menu both have their own readAskAiPreferences / liveSources /
 * imageAttachmentManager wiring; pushing that into EnhanceFlow would
 * force one surface to mirror the other's persistence machinery.
 */
class EnhanceFlow
{
    // The order here is the order rendered in the dialog. The same
    // list backed the inline implementation that used to live inside
    // StudySessionBottomPanel — kept verbatim so existing prompt
    // settings (selected-tool key in localStorage, etc.) keep working.
    static ENHANCEMENT_TOOLS =
    [
        { key: "format",        label: "Format",        promptModeKey: "FORMAT" },
        { key: "make-mnemonic", label: "Make mnemonic", promptModeKey: "MAKE_MNEMONIC" },
        { key: "give-examples", label: "Give examples", promptModeKey: "GIVE_EXAMPLES" },
        { key: "glossary",      label: "Glossary",      promptModeKey: "GLOSSARY" }
    ];

    static #SELECTION_PREVIEW_MAX_CHARS = 48;

    /**
     * Opens the Enhance modal and resolves to the user's selection.
     *
     * @param {object} options
     * @param {string} [options.selectedText] — non-empty when invoked
     *        from the text-selection menu; used purely to switch the
     *        dialog's heading + helper text to "Enhance: <preview>"
     *        so the learner sees what fragment will be acted on. The
     *        actual selectedText forwarding happens in the caller's
     *        dispatch helper.
     *
     * @returns {Promise<{ promptModeValue: number, instructions: string } | null>}
     *          `null` if the user cancelled or picked an unknown tool.
     */
    static async open({ selectedText = "" } = {})
    {
        return new Promise((resolve) =>
        {
            const bHasSelection      = typeof selectedText === "string" && selectedText.trim().length > 0;
            const selectionPreview   = bHasSelection
                ? EnhanceFlow.#buildSelectionPreview(selectedText)
                : null;

            const toolOptionsMarkup = EnhanceFlow.ENHANCEMENT_TOOLS
                .map((tool, toolIndex) => `
                    <label class="bottom-panel-enhance-option">
                        <input
                            type="radio"
                            name="enhance-flow-tool"
                            value="${tool.key}"
                            ${toolIndex === 0 ? "checked" : ""}
                        >
                        <span>${tool.label}</span>
                    </label>
                `).join("");

            const headingMarkup = bHasSelection
                ? `<h2>Enhance: <em>${EnhanceFlow.#escapeHtml(selectionPreview)}</em></h2>
                   <p>Pick an enhancement to apply to the highlighted fragment, optionally with additional instructions.</p>`
                : `<h2>Enhance</h2>
                   <p>Pick an enhancement to apply, optionally with additional instructions.</p>`;

            const dialog = DialogBox.modal
            (`
                <div class="bottom-panel-enhance-dialog">
                    ${headingMarkup}
                    <div class="bottom-panel-enhance-options">${toolOptionsMarkup}</div>
                    <label class="bottom-panel-enhance-instructions-label">
                        Additional instructions (optional)
                        <textarea
                            class="bottom-panel-enhance-instructions"
                            rows="3"
                            placeholder="Optional — refine the focus, output style, or constraints."
                        ></textarea>
                    </label>
                    <div class="bottom-panel-enhance-actions">
                        <button type="button" class="bottom-panel-enhance-cancel">Cancel</button>
                        <button type="button" class="bottom-panel-enhance-apply">Apply</button>
                    </div>
                </div>
            `);

            dialog.querySelector(".bottom-panel-enhance-cancel").addEventListener("click", () =>
            {
                dialog.close();
                resolve(null);
            });

            dialog.querySelector(".bottom-panel-enhance-apply").addEventListener("click", () =>
            {
                const selectedRadio = dialog.querySelector("input[name=\"enhance-flow-tool\"]:checked");
                const selectedKey   = selectedRadio?.value || EnhanceFlow.ENHANCEMENT_TOOLS[0].key;
                const selectedTool  = EnhanceFlow.ENHANCEMENT_TOOLS.find((tool) => tool.key === selectedKey)
                    || EnhanceFlow.ENHANCEMENT_TOOLS[0];
                const instructions  = (dialog.querySelector(".bottom-panel-enhance-instructions")?.value || "").trim();

                dialog.close();

                // The promptModeKey is a string ("FORMAT" / "MAKE_MNEMONIC" / …)
                // resolved here to the numeric askAiPromptModes value so the
                // wire-format stays enum-typed end-to-end.
                const promptModeValue = askAiPromptModes[selectedTool.promptModeKey];
                if (typeof promptModeValue !== "number")
                {
                    console.warn(`[EnhanceFlow] Unknown Enhance tool '${selectedKey}'`);
                    resolve(null);
                    return;
                }

                resolve({ promptModeValue, instructions });
            });
        });
    }

    /**
     * Trim the selected text into a short, single-line preview suitable
     * for the dialog heading. Collapses whitespace so a multi-line
     * selection doesn't blow out the heading height.
     */
    static #buildSelectionPreview(rawSelection)
    {
        const collapsed = String(rawSelection).replace(/\s+/g, " ").trim();
        if (collapsed.length <= EnhanceFlow.#SELECTION_PREVIEW_MAX_CHARS)
        {
            return collapsed;
        }
        return collapsed.slice(0, EnhanceFlow.#SELECTION_PREVIEW_MAX_CHARS - 1).trimEnd() + "…";
    }

    static #escapeHtml(rawString)
    {
        if (rawString === null || rawString === undefined) return "";
        return String(rawString)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }
}

export default EnhanceFlow;
