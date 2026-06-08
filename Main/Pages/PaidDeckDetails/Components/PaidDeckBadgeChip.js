import PaidDeckBadgeRegistry from "../../../Globals/Classes/PaidDeckBadgeRegistry.js";

/**
 * PaidDeckBadgeChip
 *
 * Renders a single feature badge as an icon-with-label chip. The badge
 * value comes either via `initialize(badgeValue)` (when constructed by
 * the details page) or via the `data-badge-value` attribute (when
 * declared in markup). Falls back silently if the value is unknown so
 * a stale enum value from an older client doesn't break the page.
 */
class PaidDeckBadgeChip extends HTMLElement
{
    #badgeValue = null;

    initialize(badgeValue)
    {
        this.#badgeValue = Number(badgeValue);
    }

    connectedCallback()
    {
        if (this.#badgeValue === null && this.dataset.badgeValue !== undefined)
        {
            this.#badgeValue = Number(this.dataset.badgeValue);
        }

        const metadata = PaidDeckBadgeRegistry.getMetadata(this.#badgeValue);
        if (!metadata)
        {
            this.style.display = "none";
            return;
        }

        this.title = metadata.description;
        this.innerHTML = `
            <img class="paid-deck-badge-chip-icon" src="${metadata.iconPath}" alt="">
            <span class="paid-deck-badge-chip-label">${PaidDeckBadgeChip.#escape(metadata.label)}</span>
        `;
    }

    static #escape(rawValue)
    {
        return String(rawValue ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    }
}

customElements.define("paid-deck-badge-chip", PaidDeckBadgeChip);
export default PaidDeckBadgeChip;
