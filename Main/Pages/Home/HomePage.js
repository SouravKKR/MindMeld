import DeckOptionsContextMenu from "./Components/DeckOptionsContextMenu.js";
import DialogBox from "../../CommonComponents/DialogBox.js";
import DeckEvents from "../../Globals/Events/DeckEvents.js";
import Deck from "../../Globals/Model/Deck.js";
import DeckTile from "./Components/DeckTile.js";
import NewDeckTile from "./Components/NewDeckTile.js";
import HomePageContextMenu from "./Components/HomePageContextMenu.js";
import HeaderComponent from "../../CommonComponents/HeaderComponent.js";
import PausedTaskBanner from "../../CommonComponents/PausedTaskBanner.js";
import MaintenanceBanner from "../../CommonComponents/MaintenanceBanner.js";
import ProfileComponent from "./Components/ProfileComponent.js";
import SyncManager from "../../Globals/Classes/SyncManager.js";
import SyncStatusComponent from "./Components/SyncStatusComponent.js";
import SignInLegalNoticeComponent from "./Components/SignInLegalNoticeComponent.js";
import NavigationEvents from "../../Globals/Events/NavigationEvents.js";
// Side-effect import: registers the observer that injects the latest streak
// badge into the profile dropdown wherever it opens (no dropdown edits).
import "../../Globals/Classes/Streak/ProfileBadgeInjector.js";
// Side-effect import: starts the metric tracker's flush timer + tab-hide flush
// and ships any buffer left from a previous session.
import "../../Globals/Classes/Metrics/MetricTracker.js";
// Side-effect import: eagerly prefetches the deck-chat embedding table at boot
// and binds the edit-listener that keeps deck vectors warm (EmbeddingPrewarmer.init()).
import "../../Globals/Classes/Embeddings/EmbeddingPrewarmer.js";

class HomePage extends HTMLElement
{
    // Bind window-level listeners exactly once at class-load. Earlier this
    // method ran on every connectedCallback, so a clearAndOpen("home-page")
    // sequence stacked duplicate handlers on window and left closures
    // pointing at detached DOM. Static binding + lazy DOM lookup avoids both.
    static #pendingExpandRequest = null;
    static #pendingFrameToken    = null;

    // Explicit drill stack for the subdeck navigation that HomePage owns
    // outside the PageNavigator stack. Each entry is an ancestor deck ID
    // between root (implicit floor, never pushed) and the current deck.
    // HARDWARE_BACK_AT_ROOT pops from here so back/Escape are deterministic
    // regardless of how currentDeck was set (drill-down, return from
    // CardEditor, UPDATE event hitting a sibling subtree).
    static #deckDrillStack = [];

    static
    {
        window.addEventListener(DeckEvents.EXPAND, (event) =>
        {
            const deckToOpen = event.detail.deck || Deck.getRoot();
            HomePage.#syncDrillStack(deckToOpen);
            HomePage.#scheduleExpand(deckToOpen);
        });

        window.addEventListener(DeckEvents.CREATE, (event) =>
        {
            const deck = event.detail.deck;
            window.dispatchEvent(new CustomEvent(DeckEvents.EXPAND, {detail: {deck: deck.getParent()}}));
        });

        // Surgical update: when a deck's metadata changes (e.g. rename),
        // replace just its tile in place — no full grid rebuild. Falls
        // back to a normal EXPAND when the tile cannot be located (the
        // deck has moved between parents, or the current view is
        // elsewhere).
        window.addEventListener(DeckEvents.UPDATE, (event) =>
        {
            const deck = event.detail.deck;

            if (!deck)
            {
                return;
            }

            const parent = deck.getParent();
            const currentDeck = Deck.getCurrentDeck();
            const decksContainer = HomePage.#getDecksContainer();

            if (decksContainer && parent && currentDeck && parent.getId() === currentDeck.getId())
            {
                const existingTile = decksContainer.querySelector(`[data-deck-id="${deck.getId()}"]`);
                if (existingTile)
                {
                    const replacementTile = DeckTile.create(deck);
                    existingTile.replaceWith(replacementTile);
                    return;
                }
            }

            window.dispatchEvent(new CustomEvent(DeckEvents.EXPAND, {detail: {deck: parent}}));
        });

        window.addEventListener(DeckEvents.DELETE, (event) =>
        {
            const parent = event.detail.parent;
            window.dispatchEvent(new CustomEvent(DeckEvents.EXPAND, {detail: {deck: parent}}));
        });

        // Hardware back at the bottom of the page-stack: pop one level
        // off the drill stack and expand to the deck we came from. The
        // explicit stack survives sibling-subtree navigation (UPDATE
        // events, DeckTile clicks across the hierarchy) — `getParent()`
        // alone can't, because currentDeck may have been reset by a
        // sibling EXPAND without back-pressure on the drill chain.
        window.addEventListener(NavigationEvents.HARDWARE_BACK_AT_ROOT, () =>
        {
            HomePage.#handleBackAtRoot();
        });
    }

    static #handleBackAtRoot()
    {
        const rootDeck = Deck.getRoot();
        if (!rootDeck)
        {
            return;
        }

        const previousDeckId = HomePage.#deckDrillStack.pop();
        const deckToReturnTo = previousDeckId ? Deck.getById(previousDeckId) : null;

        if (deckToReturnTo)
        {
            window.dispatchEvent(new CustomEvent(DeckEvents.EXPAND, {detail: {deck: deckToReturnTo}}));
            return;
        }

        const currentDeck = Deck.getCurrentDeck();
        if (currentDeck && currentDeck.getId() !== rootDeck.getId())
        {
            window.dispatchEvent(new CustomEvent(DeckEvents.EXPAND, {detail: {deck: rootDeck}}));
        }
    }

    // Reconciles the drill stack with whichever deck is about to become
    // the current one. Computes the deterministic root-to-target ancestor
    // chain (excluding root and target themselves) and uses that as the
    // new stack. Idempotent: receiving the same target back-to-back is a
    // no-op visually and shrinks/extends the stack correctly when the
    // user jumps around (DeckTile from a sibling, UPDATE coming from a
    // different subtree). The matching browser-history entry is pushed
    // by DeckTile's click handler — inside the user activation context,
    // which is the most reliable place for pushState to actually create
    // a new history entry.
    static #syncDrillStack(targetDeck)
    {
        const rootDeck = Deck.getRoot();
        if (!rootDeck || !targetDeck)
        {
            return;
        }

        const rootId = rootDeck.getId();
        const targetId = targetDeck.getId();

        if (targetId === rootId)
        {
            HomePage.#deckDrillStack = [];
            return;
        }

        const ancestorChain = [];
        let ancestorWalker = targetDeck.getParent();

        while (ancestorWalker && ancestorWalker.getId() !== rootId)
        {
            ancestorChain.unshift(ancestorWalker.getId());
            ancestorWalker = ancestorWalker.getParent();
        }

        HomePage.#deckDrillStack = ancestorChain;
    }

    static #getActiveHomePage()
    {
        return document.querySelector("home-page");
    }

    static #getDecksContainer()
    {
        const activeHomePage = HomePage.#getActiveHomePage();
        return activeHomePage ? activeHomePage.querySelector(".decks-container") : null;
    }

    // Coalesce repeat EXPAND events fired within the same animation frame
    // (e.g. a batch save firing multiple UPDATE events) so the grid only
    // rebuilds once per frame instead of once per event.
    static #scheduleExpand(deckToOpen)
    {
        HomePage.#pendingExpandRequest = deckToOpen;

        if (HomePage.#pendingFrameToken !== null)
        {
            return;
        }

        HomePage.#pendingFrameToken = requestAnimationFrame(() =>
        {
            const target = HomePage.#pendingExpandRequest;
            HomePage.#pendingExpandRequest = null;
            HomePage.#pendingFrameToken    = null;
            HomePage.#rebuildGrid(target);
        });
    }

    /**
     * True for a paid-deck copy whose root carries the synced "hidden" flag —
     * the buyer removed it from the home grid (kept for re-adding later). Gated
     * on paidDeckId so the flag only ever suppresses paid copies, never a normal
     * deck.
     */
    static #isHiddenPaidCopy(deck)
    {
        const additionalData = (deck && typeof deck.getAdditionalData === "function") ? (deck.getAdditionalData() || {}) : {};
        return typeof additionalData.paidDeckId === "string"
            && additionalData.paidDeckId.length > 0
            && additionalData.hidden === true;
    }

    static #rebuildGrid(deckToOpen)
    {
        const activeHomePage = HomePage.#getActiveHomePage();
        if (!activeHomePage)
        {
            return;
        }

        const decksContainer = activeHomePage.querySelector(".decks-container");
        const backToParentButton = activeHomePage.querySelector(".back-to-parent-button");
        if (!decksContainer || !backToParentButton)
        {
            return;
        }

        decksContainer.innerHTML = "";

        const deckChildren = deckToOpen.getSubDecks();

        for (let childIndex = 0; childIndex < deckChildren.length; childIndex++)
        {
            const childDeck = deckChildren[childIndex];

            // A paid-deck copy the buyer chose to "Hide from home" stays fully
            // present (synced, studyable, its progress intact) but is omitted
            // from the home grid until they un-hide it. The flag rides as a
            // normal synced field on the copy's root deck.
            if (HomePage.#isHiddenPaidCopy(childDeck))
            {
                continue;
            }

            const deckTile = DeckTile.create(childDeck);
            decksContainer.appendChild(deckTile);
        }

        const newDeckTile = NewDeckTile.create();
        decksContainer.appendChild(newDeckTile);

        DeckOptionsContextMenu.removeAll();
        HomePageContextMenu.removeAll();

        if (deckToOpen.getParent())
        {
            backToParentButton.innerHTML = "Navigate to " + deckToOpen.getParent().getName();
            backToParentButton.style.display = "block";
        }
        else
        {
            backToParentButton.style.display = "none";
        }

        Deck.setCurrentDeck(deckToOpen);

        // Scope this update to home-page's OWN header-component. Going
        // through HeaderComponent.setTitle would route via
        // PageNavigator.getCurrentPage(), and an EXPAND rAF can fire
        // AFTER the user has already opened study-page / deck-editor /
        // etc. — the title would then overwrite the new page's header
        // (e.g. "Studying: <short name>" briefly appears and is then
        // clobbered back to the home title).
        const homeHeaderComponent = activeHomePage.querySelector("header-component");
        if (homeHeaderComponent)
        {
            const newTitle =
                `<span style="vertical-align: middle;">` +
                (deckToOpen.getNameWithAncestors(true, false) || "MindMeld Home") +
                "</span>";
            homeHeaderComponent.setAttribute("title", newTitle);
            homeHeaderComponent.render?.();
        }
    }

    #bindInstanceListeners()
    {
        const backToParentButton = this.querySelector(".back-to-parent-button");

        backToParentButton.addEventListener("click", () =>
        {
            // Route through the browser history so the drill click that
            // brought the user here (which pushed a history entry from
            // DeckTile) gets consumed in lockstep with the visual climb.
            // Same single back code path as browser back + Escape.
            window.history.back();
        });

        this.addEventListener("contextmenu", (event) =>
        {
            event.preventDefault();
            DeckOptionsContextMenu.removeAll();
            HomePageContextMenu.create({x: event.clientX, y: event.clientY});
        });
    }

    connectedCallback()
    {
        this.setAttribute("page", "");

        this.innerHTML =
        `
            <header-component title="MindMeld Home"></header-component>
            <maintenance-banner></maintenance-banner>
            <paused-task-banner></paused-task-banner>
            <button class="back-to-parent-button">Navigate to ${Deck.getCurrentDeck()?.getParent()?.getName() || ""}</button>
            <div class="decks-container"></div>
            <copyright-notice position="inline"></copyright-notice>
            <home-footer-component></home-footer-component>
        `;

        if (Deck.getRoot())
        {
            window.dispatchEvent(new CustomEvent(DeckEvents.EXPAND, {detail: {deck: Deck.getRoot()}}));
        }

        this.#bindInstanceListeners();
    }
}

customElements.define('home-page', HomePage);
export default HomePage;
