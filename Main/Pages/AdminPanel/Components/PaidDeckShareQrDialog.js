import DialogBox from "../../../CommonComponents/DialogBox.js";
import PaidDeckShareQrPanel from "../../PaidDeckDetails/Components/PaidDeckShareQrPanel.js";

/**
 * PaidDeckShareQrDialog
 *
 * Shows a paid deck's share QR code and link from the admin deck list, so a
 * seller can grab the code for a poster or a message without walking the
 * storefront to find their own deck.
 *
 * The panel is the same element the buyer-facing details page renders. It is
 * offered on unpublished decks too — the panel then says the link will not open
 * yet, which is the useful answer for someone about to print it.
 */
class PaidDeckShareQrDialog
{
    static show(deck)
    {
        return new Promise((resolve) =>
        {
            if (!deck || typeof deck.id !== "string" || deck.id.length === 0)
            {
                DialogBox.alert("No shareable link", "This deck has no ID to build a share link from.").then(() => resolve());
                return;
            }

            const dialog = DialogBox.modal(`
                <div class="paid-deck-share-qr-dialog">
                    <div class="title-section">Share ${PaidDeckShareQrDialog.#escape(deck.title || "deck")}</div>
                    <paid-deck-share-qr-panel data-role="share-qr-panel"></paid-deck-share-qr-panel>
                </div>
            `);

            const sharePanelElement = dialog.querySelector('[data-role="share-qr-panel"]');
            if (sharePanelElement)
            {
                sharePanelElement.initialize(deck.id, deck.title || "", Boolean(deck.isPublished));
                if (sharePanelElement.isConnected)
                {
                    // initialize() ran after connectedCallback already fired —
                    // re-trigger its render, same as the details page does.
                    sharePanelElement.connectedCallback();
                }
            }

            const closeButton = dialog.querySelector(".close-button");
            if (closeButton)
            {
                closeButton.addEventListener("click", () => resolve());
            }
        });
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

export default PaidDeckShareQrDialog;
