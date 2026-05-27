import DialogBox from "../../../CommonComponents/DialogBox.js";
import Deck from "../../../Globals/Model/Deck.js";
import Card from "../../../Globals/Model/Card.js";
import StudyMaterial from "../../../Globals/Model/StudyMaterial.js";


/**
 * AskAiPopupLink
 *
 * Wires up document-level click delegation for the in-line popup
 * markers inserted by AskAiActionDispatcher's "Insert" / "Insert
 * selected" actions. Each marker is a regular HTML button so the
 * markup round-trips cleanly through raw-HTML editors and any
 * sanitiser layer the user's editor pipeline applies:
 *
 *   <button class="ask-ai-popup-link"
 *           data-popup-id="<random uuid>"
 *           data-deck-id="<owning deck id>">
 *     <span class="ask-ai-popup-link-label">View Example</span>
 *     <span class="ask-ai-popup-link-delete" role="button"
 *           aria-label="Remove saved AI response">×</span>
 *   </button>
 *
 * Click delegation differentiates the two inner hotspots: clicks on
 * the delete span open a confirm dialog and (on confirm) detach the
 * marker from the entity HTML AND drop the matching record from the
 * deck's additionalData. Clicks anywhere else on the button open the
 * saved response.
 *
 * The popup body itself is NOT embedded in the marker — it lives
 * under the owning Deck's `additionalData.askAiPopupLinks` map keyed
 * by the random popup id (see writeRecord / lookupRecord). Two
 * reasons:
 *
 *   1. Cross-device propagation. Decks already sync; piggy-backing on
 *      additionalData means inserts on the desktop client appear on
 *      mobile without a separate transport.
 *   2. Edit-safety. Card.answer / StudyMaterial.content can be edited
 *      by hand. Storing the long HTML inline would invite an editor
 *      to corrupt it; the minimal marker has nothing to corrupt.
 *
 * Importing this module is a side-effecting boot step — the static
 * initialiser block binds one capture-phase document click listener
 * exactly once.
 */
class AskAiPopupLink
{
    static MARKER_CLASS = "ask-ai-popup-link";
    static LABEL_CLASS = "ask-ai-popup-link-label";
    static DELETE_CLASS = "ask-ai-popup-link-delete";
    static POPUP_ID_ATTRIBUTE = "data-popup-id";
    static DECK_ID_ATTRIBUTE = "data-deck-id";
    static DECK_ADDITIONAL_DATA_KEY = "askAiPopupLinks";

    static #bClickHandlerBound = false;

    static
    {
        AskAiPopupLink.#ensureClickHandlerBound();
    }

    static #ensureClickHandlerBound()
    {
        if (AskAiPopupLink.#bClickHandlerBound)
        {
            return;
        }
        AskAiPopupLink.#bClickHandlerBound = true;

        // Capture phase so the click is intercepted before any host
        // surface (study session, card flipper) interprets it as
        // "advance" or "flip the card". preventDefault + stopPropagation
        // inside the handler keep that interception consistent.
        document.addEventListener("click", AskAiPopupLink.#handleDocumentClick, true);
    }

    static #handleDocumentClick(clickEvent)
    {
        // Order matters — the delete hotspot is INSIDE the marker
        // button, so a click on it would also satisfy the outer
        // marker selector. Check the inner hotspot first.
        const deleteHotspot = clickEvent.target.closest("." + AskAiPopupLink.DELETE_CLASS);
        if (deleteHotspot)
        {
            const markerElement = deleteHotspot.closest("." + AskAiPopupLink.MARKER_CLASS);
            if (markerElement)
            {
                clickEvent.preventDefault();
                clickEvent.stopPropagation();
                const popupId = markerElement.getAttribute(AskAiPopupLink.POPUP_ID_ATTRIBUTE) || "";
                const deckId  = markerElement.getAttribute(AskAiPopupLink.DECK_ID_ATTRIBUTE) || "";
                AskAiPopupLink.#handleDeleteRequest(deckId, popupId, markerElement);
                return;
            }
        }

        const markerElement = clickEvent.target.closest("." + AskAiPopupLink.MARKER_CLASS);
        if (!markerElement)
        {
            return;
        }

        clickEvent.preventDefault();
        clickEvent.stopPropagation();

        const popupId = markerElement.getAttribute(AskAiPopupLink.POPUP_ID_ATTRIBUTE) || "";
        const deckId  = markerElement.getAttribute(AskAiPopupLink.DECK_ID_ATTRIBUTE) || "";
        AskAiPopupLink.#openSavedResponse(deckId, popupId);
    }

    static #openSavedResponse(deckId, popupId)
    {
        const popupRecord = AskAiPopupLink.lookupRecord(deckId, popupId);
        if (!popupRecord)
        {
            DialogBox.alert(
                "AI response not available",
                "This saved AI response could not be retrieved on this device. Its owning deck may not have synced yet, or the entry has been removed."
            );
            return;
        }

        const titleText = AskAiPopupLink.#escapeHtml(popupRecord.title || "Saved AI response");
        const bodyContent = popupRecord.content || "";

        DialogBox.modal(`
            <div class="ask-ai-dialog">
                <h2 class="ask-ai-dialog-title">${titleText}</h2>
                <div class="ask-ai-streaming-body generated-content">${bodyContent}</div>
            </div>
        `);
    }

    static async #handleDeleteRequest(deckId, popupId, markerElement)
    {
        const userConfirmed = await DialogBox.confirm(
            "Delete saved AI response?",
            "The button will be removed from this entity and the saved response will be deleted from the deck. This can't be undone."
        );
        if (!userConfirmed)
        {
            return;
        }

        // Detach the marker from the live DOM right away so the user
        // sees the deletion land. The persistence path below makes the
        // change permanent — if it fails we leave the visible UI in
        // sync with the on-disk state by re-attaching the marker.
        const markerParent     = markerElement.parentNode;
        const markerNextSibling = markerElement.nextSibling;
        markerElement.remove();

        try
        {
            const bRemovedFromPersistence = await AskAiPopupLink.#removeRecordAndMarker(deckId, popupId);
            if (!bRemovedFromPersistence)
            {
                // Nothing to roll back from a deck point of view —
                // record didn't exist or deck wasn't loaded. Leave
                // the live DOM as-is (the user got what they wanted),
                // but warn so a downstream sync mismatch is noticed.
                console.warn(`[AskAiPopupLink] Persistence removal skipped for popupId=${popupId} deckId=${deckId}.`);
            }
        }
        catch (deletionError)
        {
            // Re-attach so the visible state matches the on-disk one.
            if (markerParent)
            {
                markerParent.insertBefore(markerElement, markerNextSibling);
            }
            console.warn("[AskAiPopupLink] Failed to delete saved response:", deletionError);
            DialogBox.alert(
                "Could not delete",
                "Something went wrong removing the saved AI response. The button has been kept so nothing is lost."
            );
        }
    }

    /**
     * Removes the popup record from `deck.additionalData.askAiPopupLinks`
     * AND strips the matching marker element from whichever Card.answer
     * or StudyMaterial.content currently embeds it. Both the deck and
     * the owning entity are saved (the entity's save() routes through
     * deck.save(), so this commits atomically to disk).
     *
     * Returns `true` when at least one of the two halves was actually
     * removed; `false` when both halves were already missing (record
     * never existed, marker not found in any entity).
     */
    static async #removeRecordAndMarker(deckId, popupId)
    {
        if (!deckId || !popupId)
        {
            return false;
        }
        const owningDeck = Deck.getById(deckId);
        if (!owningDeck)
        {
            return false;
        }

        const additionalData = owningDeck.getAdditionalData?.() || {};
        const currentMap = additionalData[AskAiPopupLink.DECK_ADDITIONAL_DATA_KEY] || {};
        const bRecordExists = Object.prototype.hasOwnProperty.call(currentMap, popupId);

        if (bRecordExists)
        {
            const updatedMap = { ...currentMap };
            delete updatedMap[popupId];
            owningDeck.setAdditionalDataField(AskAiPopupLink.DECK_ADDITIONAL_DATA_KEY, updatedMap);
        }

        const owningEntity = AskAiPopupLink.#findEntityContainingPopupMarker(owningDeck, popupId);
        if (owningEntity)
        {
            AskAiPopupLink.#stripMarkerFromEntity(owningEntity, popupId);
            await owningEntity.save();
            // owningEntity.save() routes through deck.save(false), so
            // the deck additionalData change above is committed in the
            // same pass — no need to call deck.save() separately.
            return true;
        }

        if (bRecordExists)
        {
            // Record was there but the marker isn't currently in any
            // card / material on this device (perhaps the entity that
            // owned the marker was deleted). Still useful to drop the
            // orphaned record so it doesn't accumulate.
            await owningDeck.save(false);
            return true;
        }

        return false;
    }

    /**
     * Walks the deck's own cards + study materials (non-recursive —
     * the marker's data-deck-id always identifies the exact owning
     * deck, not an ancestor) looking for one whose HTML embeds the
     * given popup-id. Returns the matching entity, or null.
     */
    static #findEntityContainingPopupMarker(owningDeck, popupId)
    {
        const matchToken = `${AskAiPopupLink.POPUP_ID_ATTRIBUTE}="${popupId}"`;

        const ownDeckCards = owningDeck.getCards(false) || [];
        for (const candidateCard of ownDeckCards)
        {
            if ((candidateCard.getAnswer?.() || "").includes(matchToken))
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

    static #stripMarkerFromEntity(entity, popupId)
    {
        const currentHtml = AskAiPopupLink.#getEntityHtml(entity);
        const newHtml = AskAiPopupLink.#removeMarkerFromHtml(currentHtml, popupId);

        if (entity instanceof Card)
        {
            entity.setAnswer(newHtml);
        }
        else if (entity instanceof StudyMaterial)
        {
            entity.setContent(newHtml);
        }
    }

    static #removeMarkerFromHtml(rawHtml, popupId)
    {
        if (!rawHtml || !popupId) return rawHtml || "";

        const documentParser = new DOMParser();
        const parsedDocument = documentParser.parseFromString("<!doctype html><body>" + rawHtml + "</body>", "text/html");
        const matchingMarkers = parsedDocument.body.querySelectorAll(`.${AskAiPopupLink.MARKER_CLASS}[${AskAiPopupLink.POPUP_ID_ATTRIBUTE}="${CSS.escape(popupId)}"]`);
        for (const matchingMarker of matchingMarkers)
        {
            matchingMarker.remove();
        }
        return parsedDocument.body.innerHTML;
    }

    static #getEntityHtml(entity)
    {
        if (entity instanceof Card)          return entity.getAnswer() || "";
        if (entity instanceof StudyMaterial) return entity.getContent() || "";
        return "";
    }

    // ── Public storage API used by AskAiActionDispatcher ─────────

    static lookupRecord(deckId, popupId)
    {
        if (!deckId || !popupId)
        {
            return null;
        }
        const owningDeck = Deck.getById(deckId);
        if (!owningDeck)
        {
            return null;
        }
        const additionalData = owningDeck.getAdditionalData?.() || {};
        const popupMap = additionalData[AskAiPopupLink.DECK_ADDITIONAL_DATA_KEY] || {};
        return popupMap[popupId] || null;
    }

    static writeRecord(owningDeck, popupId, popupRecord)
    {
        if (!owningDeck || !popupId)
        {
            return;
        }
        const additionalData = owningDeck.getAdditionalData?.() || {};
        const currentMap = additionalData[AskAiPopupLink.DECK_ADDITIONAL_DATA_KEY] || {};
        const updatedMap = { ...currentMap, [popupId]: popupRecord };
        owningDeck.setAdditionalDataField(AskAiPopupLink.DECK_ADDITIONAL_DATA_KEY, updatedMap);
    }

    /**
     * Build the marker HTML the dispatcher splices into entity HTML.
     * Two hotspots inside the button — a label span and a delete
     * span. CSS hides the delete span unless the button is hovered
     * (or the device has no hover, e.g. touchscreens, in which case
     * it stays visible). Click delegation uses the inner-span class
     * names to decide which action to run.
     */
    static buildMarkerHtml({ popupId, deckId, title })
    {
        const safePopupId = AskAiPopupLink.#escapeAttribute(popupId);
        const safeDeckId  = AskAiPopupLink.#escapeAttribute(deckId);
        const safeTitle   = AskAiPopupLink.#escapeHtml(title);
        return (
            `<button type="button" class="${AskAiPopupLink.MARKER_CLASS}" ${AskAiPopupLink.POPUP_ID_ATTRIBUTE}="${safePopupId}" ${AskAiPopupLink.DECK_ID_ATTRIBUTE}="${safeDeckId}">` +
                `<span class="${AskAiPopupLink.LABEL_CLASS}">${safeTitle}</span>` +
                `<span class="${AskAiPopupLink.DELETE_CLASS}" role="button" aria-label="Remove saved AI response">×</span>` +
            `</button>`
        );
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

    static #escapeAttribute(rawString)
    {
        return AskAiPopupLink.#escapeHtml(rawString);
    }
}

export default AskAiPopupLink;
