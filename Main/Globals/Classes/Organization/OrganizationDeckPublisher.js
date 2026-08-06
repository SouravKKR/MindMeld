import DialogBox from "../../../CommonComponents/DialogBox.js";
import PaidDeckUploadDialog from "../../../Pages/AdminPanel/Components/PaidDeckUploadDialog.js";

/**
 * OrganizationDeckPublisher
 *
 * Turns "publish this deck to my organisation" into the request the server
 * expects: the deck serialised for upload, plus who it should be shown to.
 *
 * Serialisation goes through PaidDeckUploadDialog.serialiseDeckForUpload rather
 * than a second implementation. The export options it passes are load-bearing —
 * progress is stripped, auto-analysis settings are stripped, the root's parent
 * is cut — and a copy of that logic here would drift the moment either changed,
 * with the symptom being members receiving somebody else's study history inside
 * an institute's deck.
 *
 * Kept out of the section component so the section stays about rendering, and
 * so the publish request has one definition whichever surface later needs it.
 */
class OrganizationDeckPublisher
{
    /**
     * Asks which deck to publish and who should see it.
     *
     * @param {Array<Deck>} candidateDecks the publisher's own top-level decks
     * @param {string[]} availableTags the organisation's member tags
     * @returns {Promise<{ deck: Deck, audienceTags: string[] }|null>} null if cancelled
     */
    static async promptForDeckAndAudience(candidateDecks, availableTags)
    {
        const selectedDeck = await OrganizationDeckPublisher.#promptForDeck(candidateDecks);
        if (!selectedDeck)
        {
            return null;
        }

        const audienceTags = await OrganizationDeckPublisher.promptForAudienceTags(availableTags, []);
        if (audienceTags === null)
        {
            return null;
        }

        return { deck: selectedDeck, audienceTags: audienceTags };
    }

    /**
     * Asks which member tags a deck should be shown to. An empty selection means
     * everyone, which is stated on screen rather than left to be inferred from
     * an empty list.
     *
     * @param {string[]} availableTags
     * @param {string[]} selectedTags
     * @returns {Promise<string[]|null>} null if cancelled
     */
    static async promptForAudienceTags(availableTags, selectedTags)
    {
        if (!Array.isArray(availableTags) || availableTags.length === 0)
        {
            const bConfirmed = await DialogBox.confirm
            (
                "Show to everyone",
                "This organisation has no member tags yet, so this deck will be shown to every member. Import members with a tags column if you want to target it."
            );
            return bConfirmed ? [] : null;
        }

        const dialog = document.createElement("dialog-box");
        const currentlySelected = new Set(Array.isArray(selectedTags) ? selectedTags : []);

        dialog.innerHTML = `
            <div class="title-section">Who should see this deck?</div>
            <div class="message-section">
                <p>Pick the tags this deck is aimed at. Members with any of them see it on their shelf by default.</p>
                <p class="admin-panel-add-subtitle">Leave everything unticked to show it to every member. Targeting is a default filter, not a restriction — a member who chooses to see everything can still add it.</p>
                <div class="organization-permission-rule-tags" data-role="tags"></div>
            </div>
            <div class="button-section">
                <button class="ok-button">Ok</button>
                <button class="cancel-button">Cancel</button>
            </div>
        `;

        const tagsHost = dialog.querySelector('[data-role="tags"]');
        for (const tag of availableTags)
        {
            const tagLabel = document.createElement("label");
            tagLabel.className = "organization-permission-tag";

            const tagCheckbox = document.createElement("input");
            tagCheckbox.type = "checkbox";
            tagCheckbox.checked = currentlySelected.has(tag);
            tagCheckbox.addEventListener("change", () =>
            {
                if (tagCheckbox.checked)
                {
                    currentlySelected.add(tag);
                }
                else
                {
                    currentlySelected.delete(tag);
                }
            });

            const tagText = document.createElement("span");
            tagText.textContent = tag;

            tagLabel.appendChild(tagCheckbox);
            tagLabel.appendChild(tagText);
            tagsHost.appendChild(tagLabel);
        }

        return new Promise((resolve) =>
        {
            dialog.querySelector(".ok-button").addEventListener("click", () =>
            {
                dialog.close();
                resolve(Array.from(currentlySelected));
            });
            dialog.querySelector(".cancel-button").addEventListener("click", () =>
            {
                dialog.close();
                resolve(null);
            });
            document.body.appendChild(dialog);
        });
    }

    /**
     * Serialises and uploads. Returns a plain result rather than throwing, so
     * the caller can render the server's own error code through the shared
     * message table instead of inventing wording for it.
     *
     * @param {string} organizationId
     * @param {{ deck: Deck, audienceTags: string[] }} selection
     * @returns {Promise<{ success: boolean, deckId?: string, error?: string, statusCode?: number }>}
     */
    static async publish(organizationId, selection)
    {
        const deckPayload = PaidDeckUploadDialog.serialiseDeckForUpload(selection.deck);
        if (!deckPayload)
        {
            return { success: false, error: "MISSING_METADATA_OR_PAYLOAD", statusCode: 400 };
        }

        try
        {
            const response = await fetch("/Organization/PaidDecks/Upload",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify
                ({
                    organizationId: organizationId,
                    audienceTags: selection.audienceTags,
                    metadata:
                    {
                        title: selection.deck.getName(),
                        description: "",
                        tags: [],
                        isPublished: true
                        // No price, no currency, no duration and no regional
                        // overrides: an organisation's decks are provided, and
                        // the server forces all of that to free regardless of
                        // what is sent.
                    },
                    deckPayload: deckPayload
                })
            });

            const responseJson = await response.json().catch(() => ({}));

            if (!response.ok || responseJson.success === false)
            {
                return { success: false, error: responseJson.error, statusCode: response.status };
            }

            return { success: true, deckId: responseJson.deckId };
        }
        catch (publishError)
        {
            return { success: false, error: publishError.message };
        }
    }

    static async #promptForDeck(candidateDecks)
    {
        const dialog = document.createElement("dialog-box");

        dialog.innerHTML = `
            <div class="title-section">Which deck?</div>
            <div class="message-section">
                <p>Pick the deck to provide to your members. Its sub-decks, cards, study material and mock tests are all included.</p>
                <select class="admin-panel-add-field" data-role="deck"></select>
            </div>
            <div class="button-section">
                <button class="ok-button">Ok</button>
                <button class="cancel-button">Cancel</button>
            </div>
        `;

        const deckSelect = dialog.querySelector('[data-role="deck"]');
        for (const candidateDeck of candidateDecks)
        {
            const deckOption = document.createElement("option");
            deckOption.value = candidateDeck.getId();
            deckOption.textContent = candidateDeck.getName();
            deckSelect.appendChild(deckOption);
        }

        return new Promise((resolve) =>
        {
            dialog.querySelector(".ok-button").addEventListener("click", () =>
            {
                const selectedId = deckSelect.value;
                dialog.close();
                resolve(candidateDecks.find(candidateDeck => candidateDeck.getId() === selectedId) || null);
            });
            dialog.querySelector(".cancel-button").addEventListener("click", () =>
            {
                dialog.close();
                resolve(null);
            });
            document.body.appendChild(dialog);
        });
    }
}

export default OrganizationDeckPublisher;
