import DialogBox from "../../CommonComponents/DialogBox.js";
import InitializationEvents from "../Events/InitializationEvents.js";
import PageNavigator from "./PageNavigator.js";
import PaidDeckShareConstants from "../Constants/PaidDeckShareConstants.js";

/**
 * PaidDeckDeepLinkBootstrap
 *
 * Turns a scanned paid-deck share link into an in-app navigation.
 *
 * The application has no URL router — PageNavigator is an in-memory stack of
 * custom elements and never reads window.location. This class is the one place
 * an external URL is allowed to influence which page opens: the deep-link route
 * serves the ordinary SPA shell, and the deck ID rides along in the query
 * string until the app has booted far enough to act on it.
 *
 * The listing is fetched from the public single-listing endpoint rather than
 * carried in memory, because a cold load has no storefront data at all.
 *
 * A signed-out visitor never reaches this code: the server hands them the login
 * shell and remembers the deck in the deep-link cookie, redirecting back to the
 * same URL once they are authenticated.
 */
class PaidDeckDeepLinkBootstrap
{
    static #FETCH_TIMEOUT_MILLISECONDS = 12000;
    static #DETAILS_PAGE_TAG = "paid-deck-details-page";
    static #HOME_PAGE_TAG = "home-page";

    // Outcomes of the listing fetch. Private to this class and never crossing a
    // file boundary, so they are static class constants rather than a
    // codegen-mirrored enumeration in Common/.
    static #OUTCOME_FOUND = "FOUND";
    static #OUTCOME_NOT_AVAILABLE = "NOT_AVAILABLE";
    static #OUTCOME_UNREACHABLE = "UNREACHABLE";

    static #bConsumed = false;

    // Latched from module load, not from the await below. The deck tree can
    // finish loading before the listing request resolves, and a listener
    // registered after the fact would wait forever for an event that already
    // fired — the same reasoning as TutorialBootstrap's EXPAND latch.
    static #bInitializationComplete = false;

    static
    {
        window.addEventListener(InitializationEvents.COMPLETE, () =>
        {
            PaidDeckDeepLinkBootstrap.#bInitializationComplete = true;
        }, { once: true });

        PaidDeckDeepLinkBootstrap.#run();
    }

    static async #run()
    {
        let requestedDeckId = "";
        try
        {
            const searchParameters = new URLSearchParams(window.location.search);
            requestedDeckId = searchParameters.get(PaidDeckShareConstants.DEEP_LINK_DECK_ID_QUERY_PARAMETER) || "";
        }
        catch (queryParseError)
        {
            console.warn("[PaidDeckDeepLinkBootstrap] Could not read the deep-link query string:", queryParseError);
            return;
        }

        if (requestedDeckId.length === 0 || PaidDeckDeepLinkBootstrap.#bConsumed)
        {
            return;
        }

        PaidDeckDeepLinkBootstrap.#bConsumed = true;

        // Start the fetch immediately, in parallel with the rest of the boot.
        // The endpoint is public and needs no session, so the listing is
        // normally already in hand by the time the deck tree finishes loading.
        const listingRequestPromise = PaidDeckDeepLinkBootstrap.#fetchListing(requestedDeckId);

        PaidDeckDeepLinkBootstrap.#cleanAddressBar();

        await PaidDeckDeepLinkBootstrap.#waitForInitialization();

        const listingResult = await listingRequestPromise;

        if (listingResult.outcome === PaidDeckDeepLinkBootstrap.#OUTCOME_NOT_AVAILABLE)
        {
            // The visitor deliberately followed a link; saying nothing would
            // read as the app being broken.
            await DialogBox.alert("That deck isn't available", "The link you followed points to a deck that is no longer on the store.");
            return;
        }

        if (listingResult.outcome === PaidDeckDeepLinkBootstrap.#OUTCOME_UNREACHABLE)
        {
            // Almost always an offline or flaky-network boot, where everything
            // else in the app still works. A blocking error dialog at startup
            // would be worse than quietly landing on Home.
            console.warn("[PaidDeckDeepLinkBootstrap] Could not load the shared deck listing; staying on the home page.");
            return;
        }

        PaidDeckDeepLinkBootstrap.#openDetailsPage(listingResult);
    }

    /**
     * Strips the deck ID out of the address bar as soon as it has been read, so
     * a refresh or a back press cannot re-trigger the navigation.
     *
     * The CURRENT history state is passed straight back through. PageNavigator's
     * static block has just pushed a sentinel state that its popstate handler
     * relies on to translate a back press at the root of the stack; replacing it
     * with null here would silently break the hardware back button.
     */
    static #cleanAddressBar()
    {
        if (!window.history || typeof window.history.replaceState !== "function")
        {
            return;
        }

        try
        {
            window.history.replaceState(window.history.state, "", "/");
        }
        catch (addressBarError)
        {
            console.warn("[PaidDeckDeepLinkBootstrap] Could not clean the address bar:", addressBarError);
        }
    }

    static #waitForInitialization()
    {
        if (PaidDeckDeepLinkBootstrap.#bInitializationComplete)
        {
            return Promise.resolve();
        }

        return new Promise((resolve) =>
        {
            window.addEventListener(InitializationEvents.COMPLETE, () => resolve(), { once: true });
        });
    }

    static async #fetchListing(deckId)
    {
        const abortController = new AbortController();
        const timeoutId = setTimeout(() => abortController.abort(), PaidDeckDeepLinkBootstrap.#FETCH_TIMEOUT_MILLISECONDS);

        try
        {
            const requestUrl = `${PaidDeckShareConstants.DETAILS_ENDPOINT_PATH}?deckId=${encodeURIComponent(deckId)}`;
            const response = await fetch(requestUrl, { signal: abortController.signal });

            if (!response.ok)
            {
                // 400 (malformed ID) and 404 (unknown, or still a draft) both
                // mean the same thing to the visitor: there is nothing to show.
                return { outcome: PaidDeckDeepLinkBootstrap.#OUTCOME_NOT_AVAILABLE, deck: null, region: "" };
            }

            const payload = await response.json();
            if (!payload || !payload.deck)
            {
                return { outcome: PaidDeckDeepLinkBootstrap.#OUTCOME_NOT_AVAILABLE, deck: null, region: "" };
            }

            return { outcome: PaidDeckDeepLinkBootstrap.#OUTCOME_FOUND, deck: payload.deck, region: payload.region || "" };
        }
        catch (fetchError)
        {
            console.warn(`[PaidDeckDeepLinkBootstrap] Listing request failed. ${fetchError?.message || fetchError}`);
            return { outcome: PaidDeckDeepLinkBootstrap.#OUTCOME_UNREACHABLE, deck: null, region: "" };
        }
        finally
        {
            clearTimeout(timeoutId);
        }
    }

    static #openDetailsPage(listingResult)
    {
        const currentPage = PageNavigator.getCurrentPage();
        const currentPageTag = currentPage ? currentPage.tagName.toLowerCase() : "";

        // The boot-to-listing window is usually well under a second, but if the
        // user has already gone somewhere in it, honouring a stale intent by
        // yanking them out of what they started is worse than dropping it.
        if (currentPageTag !== PaidDeckDeepLinkBootstrap.#HOME_PAGE_TAG)
        {
            return;
        }

        // open(), never clearAndOpen(): Home stays underneath, so back and
        // hardware-back behave exactly as they do when the same page is reached
        // by tapping a card in the paid deck library.
        PageNavigator.open(PaidDeckDeepLinkBootstrap.#DETAILS_PAGE_TAG, listingResult.deck, listingResult.region);
    }
}

export default PaidDeckDeepLinkBootstrap;
