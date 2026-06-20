import DeckInsights from "./Components/DeckInsights.js";

class DeckInsightsPage extends HTMLElement
{
    #deck = null;
    initialize(deck)
    {
        this.#deck = deck;
    }

    connectedCallback()
    {
        // Guard against a missing deck (e.g. navigated here without initialize,
        // or a deck that left the id map) so connectedCallback never throws.
        if (!this.#deck)
        {
            this.innerHTML = `<header-component title="Deck not found"></header-component>`;
            return;
        }

        this.innerHTML =
        `
            <header-component title="${this.#deck.getName()} Insights"></header-component>

            <deck-insights deck-id="${this.#deck.getId()}"></deck-insights>

        `;
    }
}

customElements.define('deck-insights-page', DeckInsightsPage);
export default DeckInsightsPage;