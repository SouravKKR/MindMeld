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
        this.innerHTML = 
        `
            <header-component title="${this.#deck.getName()} Insights"></header-component>
            
            <deck-insights deck-id="${this.#deck.getId()}"></deck-insights>
            
        `; 
    }
}

customElements.define('deck-insights-page', DeckInsightsPage);
export default DeckInsightsPage;