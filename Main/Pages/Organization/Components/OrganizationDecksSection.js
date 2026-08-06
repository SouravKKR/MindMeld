import DialogBox from "../../../CommonComponents/DialogBox.js";
import Deck from "../../../Globals/Model/Deck.js";
import OrganizationErrorMessages from "../../../Globals/Classes/Organization/OrganizationErrorMessages.js";
import OrganizationDeckPublisher from "../../../Globals/Classes/Organization/OrganizationDeckPublisher.js";
import { organizationDelegatePowers } from "../../../Globals/Enumerations/OrganizationDelegatePowers.js";

/**
 * OrganizationDecksSection
 *
 * The decks an organization provides to its own members: what is published,
 * who holds a copy, and the two acts that change that — publishing one of the
 * publisher's own decks, and withdrawing one that is already out.
 *
 * A published deck gets the full paid-deck treatment minus the price and the
 * password: encrypted at rest and on the sync wire, immutable on the member's
 * device, export-blocked. Members are never charged and never prompted for a
 * passphrase, because the institute is providing the material rather than
 * selling it.
 *
 * Withdrawal is the destructive act on this screen, so it is the one that names
 * its consequence before it happens: the deck leaves every member's library on
 * their next sync, and their progress on it goes with it, because the entities
 * that progress was recorded against stop existing.
 */
class OrganizationDecksSection extends HTMLElement
{
    #organizationId = "";
    #organization = null;
    #authority = null;
    #onChanged = null;

    #decks = [];
    #availableTags = [];
    #publishedCount = 0;
    #maximumPublishedDecks = 0;

    initialize(context)
    {
        this.#organizationId = context.organizationId;
        this.#organization = context.organization;
        this.#authority = context.authority;
        this.#onChanged = typeof context.onChanged === "function" ? context.onChanged : () => {};
    }

    async connectedCallback()
    {
        this.innerHTML = `<p class="admin-panel-add-subtitle">Loading decks…</p>`;
        await this.#loadAndRender();
    }

    #mayPublish()
    {
        const heldPowers = Number.isInteger(this.#authority?.delegatePowers) ? this.#authority.delegatePowers : 0;
        return (heldPowers & organizationDelegatePowers.PUBLISH_DECKS) === organizationDelegatePowers.PUBLISH_DECKS;
    }

    async #loadAndRender()
    {
        let responseJson = null;
        let statusCode = 0;

        try
        {
            const response = await fetch(`/Organization/PaidDecks/List?organizationId=${encodeURIComponent(this.#organizationId)}`);
            statusCode = response.status;
            responseJson = await response.json().catch(() => ({}));

            if (!response.ok || responseJson.success === false)
            {
                this.innerHTML = `<div class="admin-panel-add-error"></div>`;
                this.querySelector(".admin-panel-add-error").textContent = OrganizationErrorMessages.describe(responseJson.error, statusCode);
                return;
            }
        }
        catch (loadError)
        {
            this.innerHTML = `<div class="admin-panel-add-error"></div>`;
            this.querySelector(".admin-panel-add-error").textContent = loadError.message || "Could not load the organisation's decks.";
            return;
        }

        this.#decks = Array.isArray(responseJson.decks) ? responseJson.decks : [];
        this.#availableTags = Array.isArray(responseJson.availableTags) ? responseJson.availableTags : [];
        this.#publishedCount = Number(responseJson.publishedCount) || 0;
        this.#maximumPublishedDecks = Number(responseJson.maxPublishedDecks) || 0;

        this.#render();
    }

    #render()
    {
        const bMayPublish = this.#mayPublish();
        const bAtCapacity = this.#maximumPublishedDecks <= 0 || this.#publishedCount >= this.#maximumPublishedDecks;

        this.innerHTML = `
            <div class="organization-section-header">
                <h2 class="organization-section-title">Decks</h2>
                <p class="admin-panel-add-subtitle">
                    Decks published here appear on your members' shelf inside this organisation's view.
                    They are always free, open without a password, and can't be exported or edited by members.
                </p>
            </div>

            <div class="organization-summary-grid">
                <div class="organization-summary-card">
                    <span class="organization-summary-label">Published</span>
                    <span class="organization-summary-value">${this.#publishedCount} of ${this.#maximumPublishedDecks > 0 ? this.#maximumPublishedDecks : "0"}</span>
                </div>
                <div class="organization-summary-card">
                    <span class="organization-summary-label">Total copies held</span>
                    <span class="organization-summary-value">${this.#decks.reduce((runningTotal, deck) => runningTotal + (Number(deck.holderCount) || 0), 0)}</span>
                </div>
            </div>

            ${bMayPublish ? `
                <div class="organization-section-actions">
                    <button type="button" class="admin-panel-add-submit" data-role="publish" ${bAtCapacity ? "disabled" : ""}>Publish one of my decks</button>
                </div>
                ${bAtCapacity ? `
                    <p class="admin-panel-add-subtitle">
                        ${this.#maximumPublishedDecks > 0
                            ? "This organisation has published as many decks as its agreement allows. Withdraw one to make room, or ask for a higher limit."
                            : "This organisation's agreement does not include publishing decks yet."}
                    </p>
                ` : ""}
            ` : `
                <p class="admin-panel-add-subtitle">You can see these decks but not publish or withdraw them.</p>
            `}

            <div class="organization-table-scroll">
                <table class="admin-panel-table organization-decks-table">
                    <thead>
                        <tr><th>Deck</th><th>Shown to</th><th>Status</th><th>Members holding it</th><th></th></tr>
                    </thead>
                    <tbody data-role="rows"></tbody>
                </table>
            </div>

            <p class="organization-action-status" data-role="status"></p>
        `;

        this.#renderRows();

        const publishButton = this.querySelector('[data-role="publish"]');
        if (publishButton)
        {
            publishButton.addEventListener("click", () => this.#publishFromLibrary(publishButton));
        }
    }

    #renderRows()
    {
        const rowsHost = this.querySelector('[data-role="rows"]');
        rowsHost.innerHTML = "";

        if (this.#decks.length === 0)
        {
            const emptyRow = document.createElement("tr");
            const emptyCell = document.createElement("td");
            emptyCell.colSpan = 5;
            emptyCell.textContent = "Nothing published yet. Members see an empty shelf until you publish a deck.";
            emptyRow.appendChild(emptyCell);
            rowsHost.appendChild(emptyRow);
            return;
        }

        for (const deck of this.#decks)
        {
            const row = document.createElement("tr");

            const titleCell = document.createElement("td");
            titleCell.textContent = deck.title || deck.id;

            const audienceCell = document.createElement("td");
            audienceCell.textContent = Array.isArray(deck.audienceTags) && deck.audienceTags.length > 0
                ? deck.audienceTags.join(", ")
                : "Everyone in the organisation";

            const statusCell = document.createElement("td");
            statusCell.textContent = deck.isPublished ? "Published" : "Withdrawn";

            const holderCell = document.createElement("td");
            holderCell.textContent = String(Number(deck.holderCount) || 0);

            const actionCell = document.createElement("td");
            if (this.#mayPublish())
            {
                const audienceButton = document.createElement("button");
                audienceButton.type = "button";
                audienceButton.className = "organization-secondary-button";
                audienceButton.textContent = "Change who sees it";
                audienceButton.addEventListener("click", () => this.#editAudienceTags(deck));
                actionCell.appendChild(audienceButton);

                if (deck.isPublished)
                {
                    const withdrawButton = document.createElement("button");
                    withdrawButton.type = "button";
                    withdrawButton.className = "organization-secondary-button";
                    withdrawButton.textContent = "Withdraw";
                    withdrawButton.addEventListener("click", () => this.#withdraw(deck));
                    actionCell.appendChild(withdrawButton);
                }
            }

            row.appendChild(titleCell);
            row.appendChild(audienceCell);
            row.appendChild(statusCell);
            row.appendChild(holderCell);
            row.appendChild(actionCell);
            rowsHost.appendChild(row);
        }
    }

    /**
     * Publishes one of the publisher's own decks. The deck is serialised and
     * encrypted exactly as a catalogue upload is — the same service handles
     * both — so what members receive behaves identically to a marketplace deck
     * in every respect except price and password.
     */
    async #publishFromLibrary(publishButton)
    {
        const candidateDecks = Deck.getRoot()?.getSubDecks?.() || [];
        if (candidateDecks.length === 0)
        {
            await DialogBox.alert("Nothing to publish", "You have no decks in this library to publish. Create or open the deck you want to provide, then come back.");
            return;
        }

        const chosen = await OrganizationDeckPublisher.promptForDeckAndAudience(candidateDecks, this.#availableTags);
        if (!chosen)
        {
            return;
        }

        const statusElement = this.querySelector('[data-role="status"]');
        publishButton.disabled = true;
        const originalLabel = publishButton.textContent;
        publishButton.textContent = "Publishing…";
        statusElement.classList.remove("organization-action-status-failure", "organization-action-status-success");
        statusElement.textContent = "Encrypting and uploading…";

        const publishResult = await OrganizationDeckPublisher.publish(this.#organizationId, chosen);

        publishButton.disabled = false;
        publishButton.textContent = originalLabel;

        if (!publishResult.success)
        {
            statusElement.classList.add("organization-action-status-failure");
            statusElement.textContent = OrganizationErrorMessages.describe(publishResult.error, publishResult.statusCode);
            return;
        }

        statusElement.classList.add("organization-action-status-success");
        statusElement.textContent = `Published. Members will see "${chosen.deck.getName()}" on their shelf.`;

        this.#onChanged();
        await this.#loadAndRender();
    }

    async #editAudienceTags(deck)
    {
        const chosenTags = await OrganizationDeckPublisher.promptForAudienceTags(this.#availableTags, deck.audienceTags || []);
        if (chosenTags === null)
        {
            return;
        }

        const statusElement = this.querySelector('[data-role="status"]');
        statusElement.classList.remove("organization-action-status-failure", "organization-action-status-success");

        try
        {
            const response = await fetch("/Organization/PaidDecks/Update",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ organizationId: this.#organizationId, deckId: deck.id, audienceTags: chosenTags })
            });
            const responseJson = await response.json().catch(() => ({}));

            if (!response.ok || responseJson.success === false)
            {
                statusElement.classList.add("organization-action-status-failure");
                statusElement.textContent = OrganizationErrorMessages.describe(responseJson.error, response.status);
                return;
            }

            statusElement.classList.add("organization-action-status-success");
            statusElement.textContent = "Updated who this deck is shown to. Members who already have it keep it.";
            await this.#loadAndRender();
        }
        catch (updateError)
        {
            statusElement.classList.add("organization-action-status-failure");
            statusElement.textContent = updateError.message || "Could not update the deck.";
        }
    }

    async #withdraw(deck)
    {
        const holderCount = Number(deck.holderCount) || 0;

        // Named in full before it happens: this is the only action here that
        // reaches into members' devices and removes something they may be in
        // the middle of studying.
        const bConfirmed = await DialogBox.confirm
        (
            "Withdraw this deck?",
            `
                <p><strong>${OrganizationDecksSection.#escapeHtml(deck.title || deck.id)}</strong> will be taken back from everyone who has it.</p>
                <ul class="organization-view-switch-list">
                    <li>${holderCount} member${holderCount === 1 ? "" : "s"} currently hold a copy. It will disappear from their devices at their next sync.</li>
                    <li>Their study progress on this deck goes with it — the cards it was recorded against stop existing.</li>
                    <li>Nobody new will be able to add it.</li>
                    <li>The deck itself is kept, so you can publish it again later.</li>
                </ul>
            `
        );

        if (!bConfirmed)
        {
            return;
        }

        const statusElement = this.querySelector('[data-role="status"]');
        statusElement.classList.remove("organization-action-status-failure", "organization-action-status-success");
        statusElement.textContent = "Withdrawing…";

        try
        {
            const response = await fetch("/Organization/PaidDecks/Withdraw",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ organizationId: this.#organizationId, deckId: deck.id })
            });
            const responseJson = await response.json().catch(() => ({}));

            if (!response.ok || responseJson.success === false)
            {
                statusElement.classList.add("organization-action-status-failure");
                statusElement.textContent = OrganizationErrorMessages.describe(responseJson.error, response.status);
                return;
            }

            statusElement.classList.add("organization-action-status-success");
            statusElement.textContent = `Withdrawn from ${responseJson.licensesRevoked} member${responseJson.licensesRevoked === 1 ? "" : "s"}.`;

            this.#onChanged();
            await this.#loadAndRender();
        }
        catch (withdrawError)
        {
            statusElement.classList.add("organization-action-status-failure");
            statusElement.textContent = withdrawError.message || "Could not withdraw the deck.";
        }
    }

    static #escapeHtml(rawString)
    {
        const escapeElement = document.createElement("div");
        escapeElement.textContent = rawString === null || rawString === undefined ? "" : String(rawString);
        return escapeElement.innerHTML;
    }
}

customElements.define("organization-decks-section", OrganizationDecksSection);
export default OrganizationDecksSection;
