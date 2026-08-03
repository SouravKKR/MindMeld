import HeaderComponent from "../../CommonComponents/HeaderComponent.js";

import HomePage from "../../Pages/Home/HomePage.js";
import DeckEditorPage from "../../Pages/DeckEditor/DeckEditorPage.js";
import CardEditorPage from "../../Pages/CardEditor/CardEditorPage.js";
import StudyMaterialEditorPage from "../../Pages/StudyMaterialEditor/StudyMaterialEditorPage.js";
import StudyPage from "../../Pages/Study/StudyPage.js";
import BrowserPage from "../../Pages/Browser/BrowserPage.js";
import MockTestEditorPage from "../../Pages/MockTestEditor/MockTestEditorPage.js";
import MockTestAnswerKeyPage from "../../Pages/MockTestAnswerKey/MockTestAnswerKeyPage.js";
import MockTestTranscriptionReviewPage from "../../Pages/MockTestTranscriptionReview/MockTestTranscriptionReviewPage.js";
import DeckInsightsPage from "../../Pages/DeckInsights/DeckInsightsPage.js";
import AuthenticationEvents from "../Events/AuthenticationEvents.js";
import AutomaticGenerationPage from "../../Pages/AutomaticGeneration/AutomaticGenerationPage.js";
import CogniumLearnAboutPage from "../../Pages/About/CogniumLearnAboutPage.js";
import ProgressPage from "../../Pages/Progress/ProgressPage.js";
import SettingsPage from "../../Pages/Settings/SettingsPage.js";
import ActiveEntityTracker from "./ActiveEntityTracker.js";
import TutorialsPage from "../../Pages/Tutorials/TutorialsPage.js";
import NavigationEvents from "../Events/NavigationEvents.js";
import LoginPage from "../../Pages/Login/LoginPage.js";
import Platform from "./Platform.js";
import { platforms } from "../Enumerations/Platforms.js";

class PageNavigator
{
    static #PAGE_NAVIGATOR_STATE_MARKER = "pageNavigatorStateMarker";

    static #stack = new Array(100);
    static #stackPointer = -1;

    static #bInitialPageOpened = false;

    static
    {
        // Push a sentinel state so the first popstate has something to
        // consume. Subsequent open() calls each push their own state,
        // giving every PageNavigator level a matching browser-history
        // entry so the hardware back button can drive PageNavigator.back().
        if (typeof window !== "undefined" && window.history && typeof window.history.pushState === "function")
        {
            window.history.pushState({[PageNavigator.#PAGE_NAVIGATOR_STATE_MARKER]: true, sentinel: true}, "");
            window.addEventListener("popstate", PageNavigator.#handlePopState);
        }

        // Auth-gated startup. AuthenticationEvents.#bootstrap fires
        // exactly one of ON_USER_LOGGED_IN / ON_USER_LOGGED_OUT after
        // its /GetUser probe resolves. We defer opening any page until
        // then so unauthenticated users land on the login gate and
        // authenticated users land on home. Subsequent fires after
        // boot (e.g. logout-without-reload paths added later) replace
        // the entire page stack so an unauthenticated user can never
        // see authenticated content.
        window.addEventListener(AuthenticationEvents.ON_USER_LOGGED_IN, () =>
        {
            PageNavigator.#openInitialOrReplace("home-page");
        });

        window.addEventListener(AuthenticationEvents.ON_USER_LOGGED_OUT, () =>
        {
            // On the web, the Dock server gates `/` by session cookie and
            // serves the lightweight login shell to unauthenticated
            // visitors. Reloading hands control to that gate so we don't
            // sit on a fully-downloaded SPA in an unauthenticated state.
            // Tauri loads files directly from disk and has no server
            // gate, so it falls back to the in-SPA login page.
            if (Platform.get() === platforms.WEB)
            {
                window.location.href = "/";
                return;
            }

            PageNavigator.#openInitialOrReplace("login-page");
        });
    }

    static #openInitialOrReplace(pageTagName)
    {
        if (!PageNavigator.#bInitialPageOpened)
        {
            PageNavigator.#bInitialPageOpened = true;
            PageNavigator.open(pageTagName);
        }
        else
        {
            PageNavigator.clearAndOpen(pageTagName);
        }
    }


    static open(page, ...args)
    {
        const pageElement = document.createElement(page);

        if(PageNavigator.#stackPointer >= 0)
        {
            PageNavigator.#stack[PageNavigator.#stackPointer].style.display = "none";
        }

        // Reset before the new page mounts so its connectedCallback /
        // initialize can re-assert the active entity if applicable.
        ActiveEntityTracker.clear();

        PageNavigator.#stackPointer++;
        PageNavigator.#stack[PageNavigator.#stackPointer] = pageElement;

        if(pageElement.initialize)
        {
            pageElement.initialize(...args);
        }

        // Bind a history entry to this page-stack level so a single
        // browser-back press unwinds exactly one PageNavigator level.
        if (typeof window !== "undefined" && window.history && typeof window.history.pushState === "function")
        {
            window.history.pushState(
                {[PageNavigator.#PAGE_NAVIGATOR_STATE_MARKER]: true, pageNavigatorIndex: PageNavigator.#stackPointer},
                ""
            );
        }

        document.body.appendChild(pageElement);

        PageNavigator.#dispatchPageOpenedEvent(page);
    }

    static back()
    {
        if(PageNavigator.#stackPointer > 0)
        {
            const leavingPage = PageNavigator.#stack[PageNavigator.#stackPointer];
            leavingPage.style.display = "none";

            // Give the leaving page a chance to clean up any transient
            // state it holds. The hook intentionally fires for every
            // back() path (in-page back buttons, hardware back, the
            // header-component back arrow) so pages don't need to
            // duplicate cleanup logic per trigger.
            leavingPage.onPageLeft?.();

            // Detach the popped page. Hiding it alone left every page the
            // user had ever visited parked in document.body for the rest of
            // the session — a steady DOM leak, and worse, a correctness
            // hazard: any global document.querySelector(".some-button") then
            // resolves to a stale hidden copy from an earlier page instead of
            // the live one. Its stack slot is already being dropped, so the
            // element has no way back; removing it also lets each page's
            // disconnectedCallback unbind listeners at the right moment.
            leavingPage.remove();
            PageNavigator.#stack[PageNavigator.#stackPointer] = undefined;

            PageNavigator.#stackPointer--;

            // Reset before the resumed page re-asserts via onPageResumed.
            ActiveEntityTracker.clear();

            const resumedPage = PageNavigator.#stack[PageNavigator.#stackPointer];
            resumedPage.style.display = "flex";
            resumedPage.onPageResumed?.();

            PageNavigator.#dispatchPageOpenedEvent(resumedPage.tagName.toLowerCase());
        }
    }

    static #dispatchPageOpenedEvent(pageTagName)
    {
        if (typeof window === "undefined")
        {
            return;
        }

        window.dispatchEvent(new CustomEvent(NavigationEvents.PAGE_OPENED, {detail: {pageTagName: pageTagName}}));
    }

    /**
     * Handles browser/Android/Tauri back-button presses. If the in-app page
     * stack can pop, we do so (and re-push a sentinel state so the next
     * back press is captured the same way). Otherwise we let the page at
     * the bottom of the stack decide what "back" means in its context via
     * the HARDWARE_BACK_AT_ROOT event — HomePage uses this to climb the
     * deck hierarchy.
     */
    static #handlePopState(event)
    {
        if (PageNavigator.canGoBack())
        {
            PageNavigator.back();
        }
        else
        {
            window.dispatchEvent(new CustomEvent(NavigationEvents.HARDWARE_BACK_AT_ROOT));
        }

        // Re-push a sentinel so the user can press back again without
        // exiting the app. Browsers consume one history entry per popstate;
        // without this, the next back press would walk past the SPA.
        if (window.history && typeof window.history.pushState === "function")
        {
            window.history.pushState(
                {[PageNavigator.#PAGE_NAVIGATOR_STATE_MARKER]: true, sentinel: true},
                ""
            );
        }
    }

    static forward()
    {
        if(PageNavigator.#stack[PageNavigator.#stackPointer + 1])
        {
            
        }        
    }

    static refresh()
    {

    }

    static clear()
    {
        for (let stackIndex = 0; stackIndex <= PageNavigator.#stackPointer; stackIndex++)
        {
            const pageElement = PageNavigator.#stack[stackIndex];

            if (pageElement && pageElement.parentNode)
            {
                pageElement.parentNode.removeChild(pageElement);
            }

            PageNavigator.#stack[stackIndex] = undefined;
        }

        PageNavigator.#stackPointer = -1;
        ActiveEntityTracker.clear();
    }

    static clearAndOpen(page, ...args)
    {
        PageNavigator.clear();
        PageNavigator.open(page, ...args);
    }

    static getCurrentPage()
    {
        return PageNavigator.#stack[PageNavigator.#stackPointer];
    }

    static canGoBack()
    {
        return PageNavigator.#stackPointer > 0;
    }
    
}

export default PageNavigator;