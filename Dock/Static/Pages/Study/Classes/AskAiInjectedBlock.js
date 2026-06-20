import DialogBox from "../../../CommonComponents/DialogBox.js";
import Deck from "../../../Globals/Model/Deck.js";
import Card from "../../../Globals/Model/Card.js";
import StudyMaterial from "../../../Globals/Model/StudyMaterial.js";


/**
 * AskAiInjectedBlock
 *
 * Wires up document-level click delegation for the inline blocks
 * inserted by AskAiActionDispatcher's "Append" / "Append after
 * relevant section" actions. Each block round-trips through Card.answer
 * or StudyMaterial.content as plain HTML so any raw-HTML editor /
 * sanitiser layer leaves it intact:
 *
 *   <div class="ask-ai-injected"
 *        data-injection-id="<random uuid>"
 *        data-deck-id="<owning deck id>">
 *     <button type="button" class="ask-ai-injected-delete"
 *             aria-label="Remove appended AI response">×</button>
 *     ...full appended HTML...
 *   </div>
 *
 * Visual treatment lives in AskAiDialog.css — the wrapper itself is
 * intentionally neutral (no accent border, no tinted background) so
 * the appended content reads as part of the card / material. The
 * class name is preserved purely so future styling and the delete
 * affordance have something to hang off.
 *
 * Unlike AskAiPopupLink (which stores the popup body on the deck
 * under `additionalData.askAiPopupLinks` and embeds only a marker
 * button), the inline block IS the content — there is no separate
 * deck-side record. Deleting one therefore only has to strip the
 * wrapper element from the owning entity's HTML and save.
 *
 * Importing this module is a side-effecting boot step — the static
 * initialiser binds one capture-phase document click listener exactly
 * once, mirroring the AskAiPopupLink pattern.
 */
class AskAiInjectedBlock
{
    static WRAPPER_CLASS = "ask-ai-injected";
    static DELETE_CLASS = "ask-ai-injected-delete";
    static INJECTION_ID_ATTRIBUTE = "data-injection-id";
    static DECK_ID_ATTRIBUTE = "data-deck-id";

    static #bClickHandlerBound = false;

    static
    {
        AskAiInjectedBlock.#ensureClickHandlerBound();
    }

    static #ensureClickHandlerBound()
    {
        if (AskAiInjectedBlock.#bClickHandlerBound)
        {
            return;
        }
        AskAiInjectedBlock.#bClickHandlerBound = true;

        // Capture phase so the click is intercepted before any host
        // surface (study session, card flipper) interprets it as
        // "advance" or "flip the card". The handler only consumes the
        // event when it actually lands on a delete affordance; other
        // clicks inside the wrapper are left alone so links and other
        // interactive content keep working.
        document.addEventListener("click", AskAiInjectedBlock.#handleDocumentClick, true);
    }

    static #handleDocumentClick(clickEvent)
    {
        const deleteHotspot = clickEvent.target.closest("." + AskAiInjectedBlock.DELETE_CLASS);
        if (!deleteHotspot)
        {
            return;
        }
        const wrapperElement = deleteHotspot.closest("." + AskAiInjectedBlock.WRAPPER_CLASS);
        if (!wrapperElement)
        {
            return;
        }

        clickEvent.preventDefault();
        clickEvent.stopPropagation();

        const injectionId = wrapperElement.getAttribute(AskAiInjectedBlock.INJECTION_ID_ATTRIBUTE) || "";
        const deckId      = wrapperElement.getAttribute(AskAiInjectedBlock.DECK_ID_ATTRIBUTE) || "";
        AskAiInjectedBlock.#handleDeleteRequest(deckId, injectionId, wrapperElement);
    }

    static async #handleDeleteRequest(deckId, injectionId, wrapperElement)
    {
        const userConfirmed = await DialogBox.confirm(
            "Delete this appended AI response?",
            "The appended block will be removed from this card / study material. This can't be undone."
        );
        if (!userConfirmed)
        {
            return;
        }

        // Detach from the live DOM right away so the user sees the
        // deletion land. The persistence path below makes the change
        // permanent — if it fails we re-attach so the visible UI stays
        // in sync with the on-disk state.
        const wrapperParent      = wrapperElement.parentNode;
        const wrapperNextSibling = wrapperElement.nextSibling;
        wrapperElement.remove();

        try
        {
            const bRemovedFromPersistence = await AskAiInjectedBlock.#removeWrapperFromOwningEntity(deckId, injectionId);
            if (!bRemovedFromPersistence)
            {
                console.warn(`[AskAiInjectedBlock] Persistence removal skipped for injectionId=${injectionId} deckId=${deckId}.`);
            }
        }
        catch (deletionError)
        {
            if (wrapperParent)
            {
                wrapperParent.insertBefore(wrapperElement, wrapperNextSibling);
            }
            console.warn("[AskAiInjectedBlock] Failed to delete injected block:", deletionError);
            DialogBox.alert(
                "Could not delete",
                "Something went wrong removing the appended block. It has been kept so nothing is lost."
            );
        }
    }

    /**
     * Finds the owning entity (card or study material) whose HTML
     * embeds the wrapper with the given injection id, strips the
     * wrapper out, and saves. Returns true when a save was committed,
     * false when no owning entity could be located.
     */
    static async #removeWrapperFromOwningEntity(deckId, injectionId)
    {
        if (!deckId || !injectionId)
        {
            return false;
        }
        const owningDeck = Deck.getById(deckId);
        if (!owningDeck)
        {
            return false;
        }

        const owningEntity = AskAiInjectedBlock.#findEntityContainingInjection(owningDeck, injectionId);
        if (!owningEntity)
        {
            return false;
        }

        AskAiInjectedBlock.#stripWrapperFromEntity(owningEntity, injectionId);
        await owningEntity.save();
        return true;
    }

    /**
     * Walks the deck's own cards + study materials looking for one
     * whose HTML embeds the given injection-id. Non-recursive — the
     * wrapper's data-deck-id always identifies the exact owning deck.
     */
    static #findEntityContainingInjection(owningDeck, injectionId)
    {
        const matchToken = `${AskAiInjectedBlock.INJECTION_ID_ATTRIBUTE}="${injectionId}"`;

        const ownDeckCards = owningDeck.getCards(false) || [];
        for (const candidateCard of ownDeckCards)
        {
            if ((candidateCard.getAnswer?.() || "").includes(matchToken))
            {
                return candidateCard;
            }
            if ((candidateCard.getQuestion?.() || "").includes(matchToken))
            {
                return candidateCard;
            }
        }

        const ownDeckMaterials = owningDeck.getStudyMaterials(false) || [];
        for (const candidateMaterial of ownDeckMaterials)
        {
            if ((candidateMaterial.getContent?.() || "").includes(matchToken))
            {
                return candidateMaterial;
            }
        }

        return null;
    }

    static #stripWrapperFromEntity(entity, injectionId)
    {
        if (entity instanceof Card)
        {
            const updatedAnswer = AskAiInjectedBlock.#removeWrapperFromHtml(entity.getAnswer() || "", injectionId);
            entity.setAnswer(updatedAnswer);
            // Question can also legitimately host an appended block —
            // strip from there too so we don't leave orphaned markup.
            const updatedQuestion = AskAiInjectedBlock.#removeWrapperFromHtml(entity.getQuestion() || "", injectionId);
            entity.setQuestion(updatedQuestion);
            return;
        }
        if (entity instanceof StudyMaterial)
        {
            const updatedContent = AskAiInjectedBlock.#removeWrapperFromHtml(entity.getContent() || "", injectionId);
            entity.setContent(updatedContent);
        }
    }

    static #removeWrapperFromHtml(rawHtml, injectionId)
    {
        if (!rawHtml || !injectionId) return rawHtml || "";

        const documentParser = new DOMParser();
        const parsedDocument = documentParser.parseFromString("<!doctype html><body>" + rawHtml + "</body>", "text/html");
        const matchingWrappers = parsedDocument.body.querySelectorAll(
            `.${AskAiInjectedBlock.WRAPPER_CLASS}[${AskAiInjectedBlock.INJECTION_ID_ATTRIBUTE}="${CSS.escape(injectionId)}"]`
        );
        for (const matchingWrapper of matchingWrappers)
        {
            matchingWrapper.remove();
        }
        return parsedDocument.body.innerHTML;
    }

    /**
     * Build the wrapper HTML the dispatcher splices into entity HTML.
     * The delete button is part of the saved markup so the affordance
     * persists across reloads and devices — there's no separate JS
     * post-processing step needed when the entity is next rendered.
     */
    static buildWrapperHtml({ injectionId, deckId, innerHtml })
    {
        const safeInjectionId = AskAiInjectedBlock.#escapeAttribute(injectionId);
        const safeDeckId      = AskAiInjectedBlock.#escapeAttribute(deckId);
        const safeInnerHtml   = innerHtml || "";
        return (
            `<div class="${AskAiInjectedBlock.WRAPPER_CLASS}" ${AskAiInjectedBlock.INJECTION_ID_ATTRIBUTE}="${safeInjectionId}" ${AskAiInjectedBlock.DECK_ID_ATTRIBUTE}="${safeDeckId}">` +
                `<button type="button" class="${AskAiInjectedBlock.DELETE_CLASS}" aria-label="Remove appended AI response">×</button>` +
                safeInnerHtml +
            `</div>`
        );
    }

    static #escapeAttribute(rawString)
    {
        if (rawString === null || rawString === undefined) return "";
        return String(rawString)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }
}

export default AskAiInjectedBlock;
