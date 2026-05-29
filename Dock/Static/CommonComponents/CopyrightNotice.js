/**
 * CopyrightNotice
 *
 * Tiny, low-contrast copyright stamp shown across the app. Two variants:
 *
 *   default (no attribute)           — fixed bottom-left of the viewport,
 *                                       low z-index, pointer-events: none.
 *                                       Naturally sits beneath any opaque
 *                                       footer / panel that overlaps it,
 *                                       so pages with their own bottom-row
 *                                       UI (e.g. HomePage's footer) cover
 *                                       it without any extra wiring.
 *
 *   position="bottom-center"         — absolute bottom-center inside the
 *                                       nearest positioned ancestor. Used
 *                                       inside the initialization overlay
 *                                       so a copyright is visible while
 *                                       the global one is masked by the
 *                                       full-screen loading backdrop.
 *
 *   position="inline"                — a flat, centred block in normal
 *                                       document flow. Used on the home
 *                                       page sandwiched between the deck
 *                                       grid and the footer, where the
 *                                       global fixed copyright would
 *                                       otherwise be hidden behind the
 *                                       footer band.
 *
 * Year is rendered statically — bumping it is a one-line edit on this
 * component rather than something that silently advances mid-session.
 */
class CopyrightNotice extends HTMLElement
{
    static #STYLE_ID = "copyright-notice-style";
    static #COPYRIGHT_TEXT = "© 2025-26 MindMeld. All rights reserved.";

    connectedCallback()
    {
        CopyrightNotice.#ensureStylesInjected();

        this.textContent = CopyrightNotice.#COPYRIGHT_TEXT;
    }

    static #ensureStylesInjected()
    {
        if (document.getElementById(CopyrightNotice.#STYLE_ID))
        {
            return;
        }

        const styleElement = document.createElement("style");
        styleElement.id = CopyrightNotice.#STYLE_ID;
        styleElement.textContent =
        `
            copyright-notice
            {
                position: fixed;
                left: 10px;
                bottom: 4px;
                z-index: 1;
                pointer-events: none;
                user-select: none;
                font-size: 10.5px;
                letter-spacing: 0.02em;
                color: rgba(184, 184, 196, 0.45);
                white-space: nowrap;
            }

            copyright-notice[position="bottom-center"]
            {
                position: absolute;
                left: 50%;
                right: auto;
                bottom: 14px;
                transform: translateX(-50%);
                z-index: auto;
                font-size: 11px;
                color: rgba(184, 184, 196, 0.5);
            }

            copyright-notice[position="inline"]
            {
                position: static;
                display: block;
                text-align: center;
                padding: 4px 12px 6px 12px;
                font-size: 10.5px;
                color: rgba(184, 184, 196, 0.45);
                pointer-events: none;
                user-select: none;
                flex-shrink: 0;
            }
        `;

        document.head.appendChild(styleElement);
    }
}

customElements.define("copyright-notice", CopyrightNotice);
export default CopyrightNotice;
