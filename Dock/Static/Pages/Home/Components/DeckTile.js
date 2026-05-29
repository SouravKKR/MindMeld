import DeckOptionsContextMenu from "./DeckOptionsContextMenu.js";
import DeckEvents from "../../../Globals/Events/DeckEvents.js";
import Deck from "../../../Globals/Model/Deck.js";
import PageNavigator from "../../../Globals/Classes/PageNavigator.js";
import SpacedRepetitonSession from "../../Study/Classes/SpacedRepetitionSession.js";
import HomePageContextMenu from "./HomePageContextMenu.js";
import DialogBox from "../../../CommonComponents/DialogBox.js";
import ReviseSession from "../../Study/Classes/ReviseSession.js";
import ContentStudySession from "../../Study/Classes/ContentStudySession.js";
import MockTestPickerModal from "../../Study/Components/MockTestPickerModal.js";
import DetailLevelPickerDialog from "../../../CommonComponents/DetailLevelPickerDialog.js";
import DeckMergeFlow from "./DeckMergeFlow.js";
import FullscreenImageViewer from "../../../CommonComponents/FullscreenImageViewer.js";

class DeckTile extends HTMLElement
{
    static #LONG_PRESS_DURATION_MILLISECONDS = 450;
    static #DRAG_CANCEL_PIXEL_THRESHOLD = 6;
    static #DRAG_GHOST_CLASS = "deck-tile-drag-ghost";
    static #DRAGGED_TILE_CLASS = "deck-tile-being-dragged";
    static #DROP_CANDIDATE_CLASS = "deck-tile-drop-candidate";

    #deck = null;
    #isDragging = false;

    /**
     * Creates a new DeckTile element and sets its associated deck.
     * @param {Deck} deck - The deck to associate with the new DeckTile.
     */
    static create(deck)
    {
        const deckTileElement = document.createElement('deck-tile');
        deckTileElement.initialize(deck);
        return deckTileElement;
    }

    /**
     * Initializes a DeckTile element with the given deck.
     * @param {Deck} deck - The deck to associate with the DeckTile.
     */
    initialize(deck)
    {
        this.#deck = deck;
    }

    /**
     * Returns the deck associated with this DeckTile element.
     * @returns {Deck} The deck associated with this DeckTile element.
     */
    getDeck()
    {
        return this.#deck;
    }

    #handleEvents()
    {
        const studyButton   = this.querySelector(".study-button");
        const optionsButton = this.querySelector(".deck-options-button");

        this.addEventListener("contextmenu", (event) =>
        {
            event.stopPropagation();
            event.preventDefault();

            HomePageContextMenu.removeAll();
            DeckOptionsContextMenu.create({ x: event.clientX, y: event.clientY }, this.#deck);
        });

        this.addEventListener("click", (event) =>
        {
            // A long-press drag that just ended fires a synthetic click on
            // pointerup — swallow it so the user doesn't accidentally
            // navigate into the deck after dragging it.
            if (this.#isDragging || this.classList.contains(DeckTile.#DRAGGED_TILE_CLASS))
            {
                event.stopPropagation();
                event.preventDefault();
                return;
            }
            event.stopPropagation();

            // Push a browser history entry inside the user's click activation
            // — the most reliable timing for pushState. The browser back
            // button now has a dedicated entry per drill-down click to
            // consume, so each press climbs exactly one tier no matter how
            // PageNavigator's popstate sentinel re-push behaves.
            if (typeof window !== "undefined" && window.history && typeof window.history.pushState === "function")
            {
                window.history.pushState({deckTileDrillSentinel: this.#deck.getId()}, "");
            }

            window.dispatchEvent(new CustomEvent(DeckEvents.EXPAND, { detail: { deck: this.#deck } }));
        });

        this.#enableLongPressDrag();

        // Three-dot button opens the same context menu as right-click /
        // long-press, anchored just below the button so the menu has a
        // predictable origin on touch devices.
        optionsButton.addEventListener("click", (event) =>
        {
            event.stopPropagation();
            event.preventDefault();

            const buttonRect = optionsButton.getBoundingClientRect();

            HomePageContextMenu.removeAll();
            DeckOptionsContextMenu.removeAll();
            DeckOptionsContextMenu.create({ x: buttonRect.right, y: buttonRect.bottom }, this.#deck);
        });

        optionsButton.addEventListener("contextmenu", (event) =>
        {
            // Long-press on mobile fires contextmenu on the button itself —
            // suppress it so we don't open two menus stacked on top of each other.
            event.stopPropagation();
            event.preventDefault();
        });

        studyButton.addEventListener("click", (event) =>
        {
            event.stopPropagation();

            const studyModeSelectionPopup = DialogBox.modal
            (`
                <h2 align="center">Select Study Mode</h2>

                <div class="study-mode-selection-container">
                    <button class="content-study-button">Content Study</button>
                    <button class="spaced-repetition-button">Spaced Repetition</button>
                    <button class="revise-button">Revise</button>
                    <button class="curated-study-button">Curated Study</button>
                    <button class="mock-test-button">Mock Test</button>
                </div>

                <button class="learn-more-button">Learn More About Study Modes</button>
            `);

            const learnMoreButton        = studyModeSelectionPopup.querySelector(".learn-more-button");
            const contentStudyButton     = studyModeSelectionPopup.querySelector(".content-study-button");
            const spacedRepetitionButton = studyModeSelectionPopup.querySelector(".spaced-repetition-button");
            const reviseButton           = studyModeSelectionPopup.querySelector(".revise-button");
            const mockTestButton         = studyModeSelectionPopup.querySelector(".mock-test-button");

            spacedRepetitionButton.addEventListener("click", () =>
            {
                studyModeSelectionPopup.close();
                PageNavigator.open("study-page", SpacedRepetitonSession, this.#deck);
            });

            contentStudyButton.addEventListener("click", async () =>
            {
                studyModeSelectionPopup.close();

                // Skip the detail-level picker entirely when the deck only
                // has one (or zero) tier — the user has no meaningful
                // choice to make.
                const availableLevels = this.#deck.getAvailableStudyMaterialDetailLevels(true);
                if (availableLevels.length <= 1)
                {
                    PageNavigator.open("study-page", ContentStudySession, this.#deck);
                    return;
                }

                const selectedLevels = await DetailLevelPickerDialog.show(availableLevels);
                if (selectedLevels === null)
                {
                    return;
                }

                PageNavigator.open("study-page", ContentStudySession, this.#deck, selectedLevels);
            });

            reviseButton.addEventListener("click", () =>
            {
                studyModeSelectionPopup.close();
                PageNavigator.open("study-page", ReviseSession, this.#deck);
            });

            mockTestButton.addEventListener("click", () =>
            {
                studyModeSelectionPopup.close();
                MockTestPickerModal.show(this.#deck);
            });

            // TODO: Create a full page with more info, for now just show the diagram.
            learnMoreButton.addEventListener("click", () =>
            {
                FullscreenImageViewer.open
                (
                    "./Globals/Assets/Images/Diagrams/MindMeldKnowledgeConsolidationLifecycle.png",
                    "Knowledge consolidation lifecycle"
                );
            });

            DeckOptionsContextMenu.removeAll();
        });
    }

    /**
     * Enables long-press drag detection so the user can pick this tile up
     * after a held-down pointer and drop it onto another tile to trigger a
     * merge. Uses pointer events so the same code path handles touch and
     * mouse uniformly.
     *
     * Cancels the press early if the pointer moves more than a few pixels
     * before the long-press timer fires (treated as a scroll, not a drag).
     */
    #enableLongPressDrag()
    {
        let pressStartClientX = 0;
        let pressStartClientY = 0;
        let longPressTimer = null;
        let activePointerId = null;
        let dragGhostElement = null;
        let lastHoveredTargetTile = null;

        const cancelPressTimer = () =>
        {
            if (longPressTimer !== null)
            {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
        };

        const resetDragState = () =>
        {
            cancelPressTimer();
            if (dragGhostElement)
            {
                dragGhostElement.remove();
                dragGhostElement = null;
            }
            this.classList.remove(DeckTile.#DRAGGED_TILE_CLASS);
            DeckTile.#clearAllDropHighlights();
            lastHoveredTargetTile = null;
            activePointerId = null;
            this.#isDragging = false;
        };

        this.addEventListener("pointerdown", (pointerDownEvent) =>
        {
            // Only react to the primary mouse button or any touch/pen press.
            if (pointerDownEvent.pointerType === "mouse" && pointerDownEvent.button !== 0)
            {
                return;
            }
            // Ignore presses that started on the options/study buttons —
            // those have their own click handlers and shouldn't initiate a
            // drag.
            const pressTarget = pointerDownEvent.target;
            if (pressTarget && pressTarget.closest(".deck-options-button, .study-button"))
            {
                return;
            }

            pressStartClientX = pointerDownEvent.clientX;
            pressStartClientY = pointerDownEvent.clientY;
            activePointerId = pointerDownEvent.pointerId;

            longPressTimer = setTimeout(() =>
            {
                this.#isDragging = true;
                this.classList.add(DeckTile.#DRAGGED_TILE_CLASS);
                dragGhostElement = DeckTile.#buildDragGhostFromTile(this);
                document.body.appendChild(dragGhostElement);
                DeckTile.#positionGhostAt(dragGhostElement, pressStartClientX, pressStartClientY);
            }, DeckTile.#LONG_PRESS_DURATION_MILLISECONDS);
        });

        this.addEventListener("pointermove", (pointerMoveEvent) =>
        {
            if (pointerMoveEvent.pointerId !== activePointerId)
            {
                return;
            }
            const deltaX = pointerMoveEvent.clientX - pressStartClientX;
            const deltaY = pointerMoveEvent.clientY - pressStartClientY;

            if (!this.#isDragging)
            {
                // Movement before the long-press timer fires — user is
                // scrolling, abort the press so we don't pop a ghost
                // mid-scroll.
                if (Math.hypot(deltaX, deltaY) > DeckTile.#DRAG_CANCEL_PIXEL_THRESHOLD)
                {
                    cancelPressTimer();
                    activePointerId = null;
                }
                return;
            }

            DeckTile.#positionGhostAt(dragGhostElement, pointerMoveEvent.clientX, pointerMoveEvent.clientY);

            const candidateTile = DeckTile.#findDropTargetUnderPointer(pointerMoveEvent.clientX, pointerMoveEvent.clientY, this);
            if (candidateTile !== lastHoveredTargetTile)
            {
                DeckTile.#clearAllDropHighlights();
                if (candidateTile)
                {
                    candidateTile.classList.add(DeckTile.#DROP_CANDIDATE_CLASS);
                }
                lastHoveredTargetTile = candidateTile;
            }
        });

        const finishDrag = async (pointerUpEvent) =>
        {
            if (pointerUpEvent.pointerId !== activePointerId)
            {
                return;
            }

            const wasDragging = this.#isDragging;
            const dropTargetTile = wasDragging
                ? DeckTile.#findDropTargetUnderPointer(pointerUpEvent.clientX, pointerUpEvent.clientY, this)
                : null;

            resetDragState();

            if (wasDragging && dropTargetTile)
            {
                const targetDeck = dropTargetTile.getDeck();
                await DeckMergeFlow.runMergeFlow(this.#deck, targetDeck);
            }
        };

        this.addEventListener("pointerup", finishDrag);
        this.addEventListener("pointercancel", (pointerCancelEvent) =>
        {
            if (pointerCancelEvent.pointerId === activePointerId)
            {
                resetDragState();
            }
        });
    }

    static #buildDragGhostFromTile(originTile)
    {
        const ghostElement = originTile.cloneNode(true);
        ghostElement.classList.add(DeckTile.#DRAG_GHOST_CLASS);
        ghostElement.removeAttribute("data-deck-id");
        const ghostRect = originTile.getBoundingClientRect();
        ghostElement.style.width = `${ghostRect.width}px`;
        ghostElement.style.height = `${ghostRect.height}px`;
        return ghostElement;
    }

    static #positionGhostAt(ghostElement, clientX, clientY)
    {
        if (!ghostElement)
        {
            return;
        }
        ghostElement.style.left = `${clientX}px`;
        ghostElement.style.top = `${clientY}px`;
    }

    static #findDropTargetUnderPointer(clientX, clientY, originTile)
    {
        // Temporarily hide the dragged tile + its ghost so elementsFromPoint
        // returns the tile *under* them. Pointer-events: none on the ghost
        // would normally cover this, but the dragged tile itself still
        // intercepts hit-testing without this guard on touch devices.
        const elementsUnderPointer = document.elementsFromPoint(clientX, clientY);
        for (const candidate of elementsUnderPointer)
        {
            if (candidate.tagName === "DECK-TILE" && candidate !== originTile)
            {
                return candidate;
            }
        }
        return null;
    }

    static #clearAllDropHighlights()
    {
        for (const highlightedTile of document.querySelectorAll(`.${DeckTile.#DROP_CANDIDATE_CLASS}`))
        {
            highlightedTile.classList.remove(DeckTile.#DROP_CANDIDATE_CLASS);
        }
    }

    connectedCallback()
    {
        // Stable identifier so HomePage can locate and surgically replace a
        // single tile when its deck fires DeckEvents.UPDATE, instead of
        // wiping and rebuilding the entire grid.
        this.setAttribute("data-deck-id", this.#deck.getId());

        // Tutorial-targetable marker — TutorialSampleDeckBuilder tags its
        // sample deck with CREATED_DURING_TUTORIAL_KEY, and the How-to-Study
        // tutorial wants to highlight that specific tile (its uuid is
        // unknown at registry-definition time). Selector:
        //   deck-tile[data-is-tutorial-sample="true"]
        const additionalData = this.#deck.getAdditionalData?.() || {};
        if (additionalData["bCreatedDuringTutorial"] === true)
        {
            this.setAttribute("data-is-tutorial-sample", "true");
        }

        this.innerHTML =
        `
            <button class="deck-options-button" aria-label="Deck options" title="Deck options">&#x22EE;</button>
            <div class="deck-name-container">${this.#deck.getShortName()}</div>
            <button class="study-button">Study</button>
        `;

        this.#renderPaidDeckOverlay();
        this.#handleEvents();
    }

    #renderPaidDeckOverlay()
    {
        // Best-effort import — keep the watermark optional so a legacy build
        // without PaidDeckRegistry still renders a deck tile.
        import("../../../Globals/Classes/PaidDeckRegistry.js").then((module) =>
        {
            const PaidDeckRegistry = module.default;
            if (!PaidDeckRegistry.isLicensed(this.#deck.getId()))
            {
                return;
            }

            const buyerProfilePictureUrl = window["user"]?.getProfilePictureUrl?.()
                || window["user"]?.getAdditionalData?.()?.displayPicture
                || "";

            if (!buyerProfilePictureUrl)
            {
                return;
            }

            const watermarkElement = document.createElement("img");
            watermarkElement.className = "paid-deck-owner-watermark";
            watermarkElement.src = buyerProfilePictureUrl;
            watermarkElement.draggable = false;
            watermarkElement.alt = "";
            this.appendChild(watermarkElement);

            // Provision for seller-side branding. Today the buyer overlay
            // is the only enabled signal; the seller hook is reserved for
            // a future creator-marketplace pass.
            //
            // if (deck.sellerProfilePictureUrl)
            // {
            //     const sellerOverlay = document.createElement("img");
            //     sellerOverlay.className = "paid-deck-seller-watermark";
            //     sellerOverlay.src = deck.sellerProfilePictureUrl;
            //     this.appendChild(sellerOverlay);
            // }
        }).catch(() => {});
    }
}

customElements.define('deck-tile', DeckTile);
export default DeckTile;
