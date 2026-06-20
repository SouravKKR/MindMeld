import DialogBox from "../../../CommonComponents/DialogBox.js";
import { htmlToSearchableText } from "../../../Globals/UtilityFunctions/HtmlToSearchableText.js";

/**
 * PaidDeckAiFieldGenerator
 *
 * Shared client-side wiring for the "✨ AI generate" buttons on the paid
 * deck upload and edit dialogs. A button, when clicked, asks the caller
 * to assemble the generation context (study-material titles, deck
 * hierarchy and the metadata already typed), POSTs it to the admin
 * endpoint that runs Gemini 3.1 flash-lite, and drops the returned text
 * into the target field.
 *
 * Both dialogs share this one implementation so the button behaviour —
 * spinner, error surfacing, dirty-event dispatch — stays identical.
 */
class PaidDeckAiFieldGenerator
{
    static ENDPOINT = "/Admin/PaidDecks/GenerateField";
    static STUDY_MATERIAL_TITLE_MAX_CHARS = 120;

    /**
     * Derives a short title for one study material. Study materials carry
     * no explicit title — they are HTML lessons — so we use the first
     * heading element when present and otherwise the leading preview text,
     * matching how the app itself previews them in the browser.
     */
    static #extractStudyMaterialTitle(material)
    {
        const content = (material && typeof material.getContent === "function") ? (material.getContent() || "") : "";
        if (typeof content !== "string" || content.length === 0)
        {
            return "";
        }

        const headingMatch = content.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i);
        const titleSource = headingMatch ? headingMatch[1] : content;

        return htmlToSearchableText(titleSource).trim().substring(0, PaidDeckAiFieldGenerator.STUDY_MATERIAL_TITLE_MAX_CHARS).trim();
    }

    /**
     * Collects the (recursive) study-material titles of a local Deck
     * instance. Returns an empty array when the deck has none, so the
     * caller / worker can fall back to the deck hierarchy.
     */
    static collectStudyMaterialTitles(deckInstance)
    {
        if (!deckInstance || typeof deckInstance.getStudyMaterials !== "function")
        {
            return [];
        }

        const materials = deckInstance.getStudyMaterials(true, true) || [];
        const titles = [];
        for (const material of materials)
        {
            const title = PaidDeckAiFieldGenerator.#extractStudyMaterialTitle(material);
            if (title.length > 0)
            {
                titles.push(title);
            }
        }
        return titles;
    }

    /**
     * Builds the deck-name chain (broad → specific, root excluded) for a
     * local Deck instance — used as fallback context for cards-only decks.
     */
    static collectDeckChain(deckInstance)
    {
        if (!deckInstance || typeof deckInstance.getNameWithAncestors !== "function")
        {
            return [];
        }

        const joinedChain = deckInstance.getNameWithAncestors(false, false) || "";
        return joinedChain.split("->").map((name) => name.trim()).filter((name) => name.length > 0);
    }

    /**
     * Wires a single "AI generate" button. `gatherContext` is supplied by
     * the dialog and returns { studyMaterialTitles, deckChain,
     * existingMetadata } — it is invoked fresh on every click so the
     * latest typed values are sent.
     */
    static wireField(buttonElement, targetInputElement, field, gatherContext)
    {
        if (!buttonElement || !targetInputElement)
        {
            return;
        }

        buttonElement.addEventListener("click", async (clickEvent) =>
        {
            clickEvent.preventDefault();

            if (buttonElement.disabled)
            {
                return;
            }

            const originalLabel = buttonElement.textContent;
            buttonElement.disabled = true;
            buttonElement.classList.add("is-loading");
            buttonElement.textContent = "Generating…";

            try
            {
                const context = await gatherContext();

                const response = await fetch(PaidDeckAiFieldGenerator.ENDPOINT,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify
                    ({
                        field: field,
                        studyMaterialTitles: context.studyMaterialTitles || [],
                        deckChain: context.deckChain || [],
                        existingMetadata: context.existingMetadata || {}
                    })
                });

                if (!response.ok)
                {
                    const errorJson = await response.json().catch(() => ({}));
                    await DialogBox.alert("Generation failed", errorJson.error || `Request failed (HTTP ${response.status}).`);
                    return;
                }

                const resultJson = await response.json();
                const generatedText = typeof resultJson.text === "string" ? resultJson.text.trim() : "";

                if (generatedText.length === 0)
                {
                    await DialogBox.alert("Generation failed", "The AI did not return any text. Please try again.");
                    return;
                }

                targetInputElement.value = generatedText;
                // Notify the dialog's input listeners (dirty tracking,
                // character counters) that the value changed programmatically.
                targetInputElement.dispatchEvent(new Event("input", { bubbles: true }));
            }
            catch (generationError)
            {
                await DialogBox.alert("Generation failed", generationError.message);
            }
            finally
            {
                buttonElement.disabled = false;
                buttonElement.classList.remove("is-loading");
                buttonElement.textContent = originalLabel;
            }
        });
    }
}

export default PaidDeckAiFieldGenerator;
