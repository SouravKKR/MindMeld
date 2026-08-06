import HeaderComponent from "../../CommonComponents/HeaderComponent.js";
import DialogBox from "../../CommonComponents/DialogBox.js";
import SyncManager from "../../Globals/Classes/SyncManager.js";
import UserIdentityManager from "../../Globals/Classes/UserIdentityManager.js";
import OrganizationErrorMessages from "../../Globals/Classes/Organization/OrganizationErrorMessages.js";

/**
 * OrganizationShelfPage
 *
 * What a member's institute is providing them, and the two things they can do
 * about it: take a copy, or give one back.
 *
 * The shelf shows the decks aimed at this member's own tags first, because a
 * first-year opening a list of four hundred decks meant for six different
 * cohorts has not been helped. But everything the organisation published is one
 * toggle away and can be added from there — the targeting is a default view over
 * a shelf everyone can reach, not a fence around parts of it. That is stated on
 * screen rather than left to be discovered.
 *
 * A deck added here lands in the ORGANISATION's library, not the member's own,
 * whichever view they happened to be in. Said plainly after adding, because the
 * deck appearing in a library they are not currently looking at would otherwise
 * read as nothing having happened.
 */
class OrganizationShelfPage extends HTMLElement
{
    #organizationId = "";
    #organizationName = "";
    #decks = [];
    #memberTags = [];
    #bShowingAll = false;
    #totalPublishedCount = 0;

    initialize(organizationId)
    {
        this.#organizationId = typeof organizationId === "string" ? organizationId : UserIdentityManager.getOrganizationContextId();
    }

    async connectedCallback()
    {
        this.setAttribute("page", "");
        this.innerHTML = `
            <header-component title="Organisation decks"></header-component>
            <div class="organization-shelf-body">
                <p class="organization-shelf-status">Loading…</p>
            </div>
        `;

        await this.#loadAndRender();
    }

    async onPageResumed()
    {
        await this.#loadAndRender();
    }

    async #loadAndRender()
    {
        const bodyElement = this.querySelector(".organization-shelf-body");

        if (this.#organizationId.length === 0)
        {
            bodyElement.innerHTML = `<p class="organization-shelf-status">No organisation selected.</p>`;
            return;
        }

        let responseJson = null;
        let statusCode = 0;

        try
        {
            const response = await fetch(`/Organization/Decks/Shelf?organizationId=${encodeURIComponent(this.#organizationId)}&includeAll=${this.#bShowingAll ? "true" : "false"}`);
            statusCode = response.status;
            responseJson = await response.json().catch(() => ({}));

            if (!response.ok || responseJson.success === false)
            {
                bodyElement.innerHTML = `<p class="organization-shelf-status organization-shelf-status-error"></p>`;
                bodyElement.querySelector(".organization-shelf-status").textContent = OrganizationErrorMessages.describe(responseJson.error, statusCode);
                return;
            }
        }
        catch (loadError)
        {
            bodyElement.innerHTML = `<p class="organization-shelf-status organization-shelf-status-error"></p>`;
            bodyElement.querySelector(".organization-shelf-status").textContent = loadError.message || "Could not load the shelf.";
            return;
        }

        this.#organizationName = responseJson.organizationName || "";
        this.#decks = Array.isArray(responseJson.decks) ? responseJson.decks : [];
        this.#memberTags = Array.isArray(responseJson.memberTags) ? responseJson.memberTags : [];
        this.#totalPublishedCount = Number(responseJson.totalPublishedCount) || 0;

        this.querySelector("header-component").setAttribute("title", this.#organizationName || "Organisation decks");
        this.#render();
    }

    #render()
    {
        const bodyElement = this.querySelector(".organization-shelf-body");
        const hiddenCount = Math.max(0, this.#totalPublishedCount - this.#decks.length);

        bodyElement.innerHTML = `
            <p class="organization-shelf-intro">
                These decks are provided by ${OrganizationShelfPage.#escapeHtml(this.#organizationName)}. They're free,
                they open without a password, and they live in this organisation's library rather than your own.
            </p>

            ${this.#memberTags.length > 0 && !this.#bShowingAll ? `
                <p class="organization-shelf-filter-note">
                    Showing what's aimed at ${OrganizationShelfPage.#escapeHtml(this.#memberTags.join(", "))}.
                    ${hiddenCount > 0 ? `${hiddenCount} more ${hiddenCount === 1 ? "deck is" : "decks are"} available.` : ""}
                </p>
            ` : ""}

            <div class="organization-shelf-actions">
                <button type="button" class="organization-secondary-button" data-role="toggle">
                    ${this.#bShowingAll ? "Show only what's for me" : "Show everything published"}
                </button>
            </div>

            <div class="organization-shelf-grid" data-role="grid"></div>
            <p class="organization-action-status" data-role="status"></p>
        `;

        this.#renderGrid();

        bodyElement.querySelector('[data-role="toggle"]').addEventListener("click", async () =>
        {
            this.#bShowingAll = !this.#bShowingAll;
            await this.#loadAndRender();
        });
    }

    #renderGrid()
    {
        const gridHost = this.querySelector('[data-role="grid"]');
        gridHost.innerHTML = "";

        if (this.#decks.length === 0)
        {
            const emptyElement = document.createElement("p");
            emptyElement.className = "organization-shelf-status";
            emptyElement.textContent = this.#bShowingAll
                ? "This organisation hasn't published any decks yet."
                : "Nothing is aimed at your tags right now. Try showing everything published.";
            gridHost.appendChild(emptyElement);
            return;
        }

        for (const deck of this.#decks)
        {
            gridHost.appendChild(this.#buildDeckCard(deck));
        }
    }

    #buildDeckCard(deck)
    {
        const cardElement = document.createElement("div");
        cardElement.className = "organization-shelf-card";

        const titleElement = document.createElement("h3");
        titleElement.className = "organization-shelf-card-title";
        titleElement.textContent = deck.title || deck.id;

        const descriptionElement = document.createElement("p");
        descriptionElement.className = "organization-shelf-card-description";
        descriptionElement.textContent = deck.description || "";

        const summaryElement = document.createElement("p");
        summaryElement.className = "organization-shelf-card-summary";
        const cardCount = Number(deck.contentSummary?.cardCount) || 0;
        summaryElement.textContent = cardCount > 0 ? `${cardCount} card${cardCount === 1 ? "" : "s"}` : "";

        const actionButton = document.createElement("button");
        actionButton.type = "button";
        actionButton.className = deck.held ? "organization-secondary-button" : "admin-panel-add-submit";
        actionButton.textContent = deck.held ? "Remove from my library" : "Add to my library";
        actionButton.addEventListener("click", () =>
        {
            if (deck.held)
            {
                this.#removeDeck(deck, actionButton);
            }
            else
            {
                this.#addDeck(deck, actionButton);
            }
        });

        cardElement.appendChild(titleElement);
        if (descriptionElement.textContent.length > 0)
        {
            cardElement.appendChild(descriptionElement);
        }
        if (summaryElement.textContent.length > 0)
        {
            cardElement.appendChild(summaryElement);
        }
        cardElement.appendChild(actionButton);

        return cardElement;
    }

    async #addDeck(deck, actionButton)
    {
        const statusElement = this.querySelector('[data-role="status"]');
        statusElement.classList.remove("organization-action-status-failure", "organization-action-status-success");
        actionButton.disabled = true;
        actionButton.textContent = "Adding…";

        try
        {
            const response = await fetch("/Organization/Decks/Add",
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
            statusElement.textContent = UserIdentityManager.isOrganizationContext()
                ? "Added. It'll appear on your home page after the next sync."
                : `Added to ${this.#organizationName}'s library. Switch to viewing as ${this.#organizationName} from the profile menu to study it.`;

            // The copy is seeded server-side, so it only becomes visible once
            // this device pulls it. Forced rather than waited for, so the deck
            // the member just added is there when they go looking.
            await SyncManager.sync({ bForce: true }).catch(() => {});
            await this.#loadAndRender();
        }
        catch (addError)
        {
            statusElement.classList.add("organization-action-status-failure");
            statusElement.textContent = addError.message || "Could not add the deck.";
        }
        finally
        {
            if (actionButton.isConnected)
            {
                actionButton.disabled = false;
            }
        }
    }

    async #removeDeck(deck, actionButton)
    {
        const bConfirmed = await DialogBox.confirm
        (
            "Remove this deck?",
            `
                <p><strong>${OrganizationShelfPage.#escapeHtml(deck.title || deck.id)}</strong> will be removed from your library on every device.</p>
                <ul class="organization-view-switch-list">
                    <li>Your study progress on it goes with it — the cards it was recorded against stop existing.</li>
                    <li>You can add it again from this shelf whenever you like, but it starts fresh.</li>
                </ul>
            `
        );

        if (!bConfirmed)
        {
            return;
        }

        const statusElement = this.querySelector('[data-role="status"]');
        statusElement.classList.remove("organization-action-status-failure", "organization-action-status-success");
        actionButton.disabled = true;
        actionButton.textContent = "Removing…";

        try
        {
            const response = await fetch("/Organization/Decks/Remove",
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
            statusElement.textContent = "Removed.";

            await SyncManager.sync({ bForce: true }).catch(() => {});
            await this.#loadAndRender();
        }
        catch (removeError)
        {
            statusElement.classList.add("organization-action-status-failure");
            statusElement.textContent = removeError.message || "Could not remove the deck.";
        }
        finally
        {
            if (actionButton.isConnected)
            {
                actionButton.disabled = false;
            }
        }
    }

    static #escapeHtml(rawString)
    {
        const escapeElement = document.createElement("div");
        escapeElement.textContent = rawString === null || rawString === undefined ? "" : String(rawString);
        return escapeElement.innerHTML;
    }
}

customElements.define("organization-shelf-page", OrganizationShelfPage);
export default OrganizationShelfPage;
