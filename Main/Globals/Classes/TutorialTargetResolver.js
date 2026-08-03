/**
 * TutorialTargetResolver
 *
 * Resolves a tutorial step's CSS selector to the element the user can
 * actually see and click.
 *
 * A plain `document.querySelector` is wrong for tutorial targets:
 *
 *   - Several pages are mounted at once. PageNavigator keeps the whole
 *     stack in the DOM and hides all but the top one, so
 *     `header-component .back-button` matches the Home page's header —
 *     whose back arrow is hidden at the root of the stack — long before
 *     it reaches the header of the page the user is looking at.
 *   - A step's target can have a collapsed twin. The study Assistant
 *     panel mounts collapsed (zero height, pointer-events off), and a
 *     spotlight on that box points at nothing.
 *
 * So the resolution order is: a visible match inside the page the user
 * is on, then a visible match anywhere (dialogs, context menus and
 * pickers are appended to <body>, outside the page element), then the
 * first match at all — so a target that genuinely has no box yet
 * (mid-transition) still spotlights instead of dropping the step to a
 * floating tooltip.
 */
class TutorialTargetResolver
{
    /**
     * @param {string} selector
     * @returns {Element|null}
     */
    static resolve(selector)
    {
        if (!selector)
        {
            return null;
        }

        const currentPageElement = TutorialTargetResolver.#getCurrentPageElement();

        if (currentPageElement)
        {
            const pageScopedMatches = Array.from(currentPageElement.querySelectorAll(selector));
            const visiblePageMatch = pageScopedMatches.find(TutorialTargetResolver.#bIsVisible);

            if (visiblePageMatch)
            {
                return visiblePageMatch;
            }
        }

        const documentMatches = Array.from(document.querySelectorAll(selector));

        return documentMatches.find(TutorialTargetResolver.#bIsVisible) || documentMatches[0] || null;
    }

    /**
     * The topmost mounted page element, identified by the `page` attribute
     * every page component sets on itself. Read from the DOM rather than
     * from PageNavigator so this class takes no import-time dependency on
     * the navigator, which pulls in every page module.
     *
     * @returns {Element|null}
     */
    static #getCurrentPageElement()
    {
        const visiblePages = Array.from(document.querySelectorAll("[page]"))
            .filter(TutorialTargetResolver.#bIsVisible);

        return visiblePages.length > 0 ? visiblePages[visiblePages.length - 1] : null;
    }

    /**
     * An element with no client rectangles is display:none, detached, or
     * inside a collapsed container — in every case invisible to the user.
     *
     * @param {Element} element
     * @returns {boolean}
     */
    static #bIsVisible(element)
    {
        return element.getClientRects().length > 0;
    }
}

export default TutorialTargetResolver;
