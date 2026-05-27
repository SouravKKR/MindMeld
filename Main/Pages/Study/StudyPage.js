import ContentStudySession from "./Classes/ContentStudySession.js";
import CuratedStudySession from "./Classes/CuratedStudySession.js";
import MockTestSession from "./Classes/MockTestSession.js";
import ReviseSession from "./Classes/ReviseSession.js";
import SpacedRepetitonSession from "./Classes/SpacedRepetitionSession.js";
import StudySession from "./Classes/StudySession.js";
import DialogBox from "../../CommonComponents/DialogBox.js";
import PageNavigator from "../../Globals/Classes/PageNavigator.js";
import StudySessionBottomPanel from "./Components/StudySessionBottomPanel.js";
import StudyZoomControls from "./Components/StudyZoomControls.js";
import TextSelectionContextMenu from "./Components/TextSelectionContextMenu.js";
import StudyContextMenu from "./Components/StudyContextMenu.js";

class StudyPage extends HTMLElement
{
    static #TEXT_SELECTION_SCOPE_SELECTOR = ".question-section, .answer-section, .study-material-content-section";

    #session = new StudySession();
    #selectionChangeHandler = null;
    #selectionDebounceFrameId = null;
    #pointerDownHandler = null;
    #pointerUpHandler = null;
    #touchEndHandler = null;
    #bPointerSelectionInProgress = false;
    #contextMenuHandler = null;

    // ── Initialisation ─────────────────────────────────────────────────────────

    /**
     * Sets up a study session for the given session class and deck.
     * For MockTestSession, pass a MockTest instance as the second argument
     * (navigation is handled via MockTestPickerModal — not called directly with a Deck).
     * Additional positional args (e.g. `selectedDetailLevels` for ContentStudySession)
     * are forwarded to the session constructor.
     * @param {typeof StudySession} sessionClass
     * @param {Deck | MockTest} deckOrMockTest
     * @param {...any} extraSessionArgs
     */
    initialize(sessionClass, deckOrMockTest = null, ...extraSessionArgs)
    {
        if (sessionClass === MockTestSession)
        {
            // MockTestStartDialog passes a MockTest instance plus a session-options
            // object { mode, durationMinutes } as the third argument. The session-
            // options arg is optional — MockTestSession derives sane defaults when
            // absent (e.g. for static PDF helpers).
            const mockTestSessionOptions = extraSessionArgs.length > 0 ? extraSessionArgs[0] : null;
            this.#session = new MockTestSession(this, deckOrMockTest, mockTestSessionOptions);
            return;
        }

        this.#session = new sessionClass(this, deckOrMockTest, ...extraSessionArgs);
    }

    // ── Resize handle ──────────────────────────────────────────────────────────

    #handleEvents()
    {
        const resizeHandle = this.querySelector(".resize-handle");
        const question     = this.querySelector(".question-section");
        const answer       = this.querySelector(".answer-section");

        if (!resizeHandle || !question || !answer)
        {
            return;
        }

        let isDragging = false;

        resizeHandle.addEventListener("pointerdown", () =>
        {
            isDragging = true;
            document.body.style.cursor     = "ns-resize";
            document.body.style.userSelect = "none";
        });

        window.addEventListener("pointermove", (event) =>
        {
            if (!isDragging)
            {
                return;
            }

            const containerHeight = this.clientHeight;
            const rect            = this.getBoundingClientRect();
            const relativeY       = event.clientY - rect.top;

            const minimumRatio = 0.1;
            const maximumRatio = 0.9;

            let questionRatio = relativeY / containerHeight;
            questionRatio     = Math.max(minimumRatio, Math.min(questionRatio, maximumRatio));

            const answerRatio = 1 - questionRatio;

            question.style.flex = questionRatio.toFixed(3);
            answer.style.flex   = answerRatio.toFixed(3);
        });

        window.addEventListener("pointerup", () =>
        {
            isDragging = false;
            document.body.style.cursor     = "";
            document.body.style.userSelect = "";
        });
    }

    onPageResumed()
    {
        this.#session.onResumed?.();
    }

    renderLatex()
    {
        const container = this.querySelector(".study-material-content-section");

        if (!container || typeof renderMathInElement === "undefined")
        {
            console.warn("Unable to render latex");
            return;
        }
        else
        {
            console.warn("Rendering latex...");
        }

        renderMathInElement(container,
        {
            delimiters:
            [
                { left: "\\(", right: "\\)",  display: false },
                { left: "\\[", right: "\\]",  display: true  }
            ],
            throwOnError: false
        });
    }

    // ── UI setup ───────────────────────────────────────────────────────────────

    #setupUi()
    {
        const questionSection               = this.querySelector(".question-section");
        const answerSection                 = this.querySelector(".answer-section");
        const studyMaterialContentSection   = this.querySelector(".study-material-content-section");
        const showAnswerButton              = this.querySelector(".show-answer-button");
        const userScoreSection              = this.querySelector(".user-score-section");
        const editCardButton                = this.querySelector(".edit-card-button");
        const assistantToggleButton         = this.querySelector(".assistant-toggle-button");

        if (this.#session instanceof SpacedRepetitonSession || this.#session instanceof ReviseSession)
        {
            studyMaterialContentSection?.remove();
        }
        else if (this.#session instanceof ContentStudySession || this.#session instanceof CuratedStudySession)
        {
            questionSection?.remove();
            answerSection?.remove();
            showAnswerButton?.remove();
            userScoreSection?.remove();
            editCardButton?.remove();
        }

        // CuratedStudySession does not mount a bottom panel — hide the toggle
        // so the user does not see a control with nothing to act on.
        if (this.#session instanceof CuratedStudySession)
        {
            assistantToggleButton?.remove();
        }
        else if (assistantToggleButton)
        {
            assistantToggleButton.addEventListener("click", () =>
            {
                const bottomPanel = this.querySelector("study-session-bottom-panel");
                if (!bottomPanel)
                {
                    return;
                }

                const isCollapsed = bottomPanel.classList.toggle("study-session-bottom-panel--collapsed");
                assistantToggleButton.textContent = isCollapsed ? "Show Assistant" : "Hide Assistant";
            });
        }

        this.renderLatex();
    }

    // ── Custom element lifecycle ───────────────────────────────────────────────

    connectedCallback()
    {
        // ── Mock test: separate layout — timed test TODO ───────────────────────
        if (this.#session instanceof MockTestSession)
        {
            const mockTest  = this.#session.getMockTest();
            const title     = mockTest?.getTitle?.() || "Mock Test";

            this.innerHTML =
            `
                <header-component title="${title}"></header-component>
                <div class="mock-test-page-wrapper">
                    <div class="mock-test-container"></div>
                </div>
            `;

            this.#session.start();
            return;
        }

        // ── Standard card / content study layout ───────────────────────────────
        const studyingDeck = this.#session._deck;
        const headerTitle  = studyingDeck.isRoot()
            ? "Studying"
            : `Studying: ${studyingDeck.getShortName()}`;

        this.innerHTML =
        `
            <header-component title="${headerTitle}"></header-component>
            <div class="study-page-container">
                <div class="question-section"></div>
                <div class="resize-handle"></div>
                <div class="answer-section"></div>

                <div class="study-material-content-section"></div>

                <div class="study-action-row">
                    <button class="show-answer-button">Show Answer</button>
                    <div class="user-score-section">
                        <button class="very-hard-button" score="0">Very Hard</button>
                        <button class="hard-button" score="0.33">Hard</button>
                        <button class="neutral-button" score="0.66">Medium</button>
                        <button class="easy-button" score="1">Easy</button>
                    </div>
                    <div class="previous-next-button-container">
                        <button class="previous-card-button">Previous</button>
                        <div class="card-progression-container">0/0</div>
                        <button class="next-card-button">Next</button>
                    </div>
                    <study-zoom-controls></study-zoom-controls>
                    <button class="edit-card-button">Edit</button>
                    <button class="assistant-toggle-button" type="button" aria-label="Toggle assistant panel">Hide Assistant</button>
                </div>
            </div>
        `;
        
        this.#handleEvents();
        this.#setupUi();

        this.#session.start();

        this.#mountBottomPanel();
        this.#installTextSelectionWatcher();
        this.#installStudyContextMenuWatcher();
    }

    /**
     * Tears down page-scoped global listeners + any visible
     * TextSelectionContextMenu when the user navigates away (browser
     * back, header back button, etc.). Called by PageNavigator.back().
     */
    onPageLeft()
    {
        if (this.#selectionChangeHandler)
        {
            document.removeEventListener("selectionchange", this.#selectionChangeHandler);
            this.#selectionChangeHandler = null;
        }
        if (this.#pointerDownHandler)
        {
            document.removeEventListener("pointerdown", this.#pointerDownHandler, true);
            this.#pointerDownHandler = null;
        }
        if (this.#pointerUpHandler)
        {
            document.removeEventListener("pointerup", this.#pointerUpHandler, true);
            this.#pointerUpHandler = null;
        }
        if (this.#touchEndHandler)
        {
            document.removeEventListener("touchend", this.#touchEndHandler, true);
            this.#touchEndHandler = null;
        }
        if (this.#selectionDebounceFrameId)
        {
            cancelAnimationFrame(this.#selectionDebounceFrameId);
            this.#selectionDebounceFrameId = null;
        }
        this.#bPointerSelectionInProgress = false;
        TextSelectionContextMenu.removeAll();
        if (this.#contextMenuHandler)
        {
            this.removeEventListener("contextmenu", this.#contextMenuHandler);
            this.#contextMenuHandler = null;
        }
        StudyContextMenu.removeAll();
    }

    /**
     * Watches `selectionchange` on the document and shows the
     * TextSelectionContextMenu when the selection lands entirely
     * inside a card or study-material content container. Hides /
     * removes the menu when the selection collapses or leaves scope.
     * Skipped for mock-test sessions — that surface has no content
     * containers and no need for the AI selection actions.
     */
    #installTextSelectionWatcher()
    {
        if (this.#session instanceof MockTestSession)
        {
            return;
        }

        // selectionchange fires on every range update during a pointer drag
        // (multiple times per frame on a fast machine), and even with rAF
        // debouncing the menu was being recreated dozens of times during a
        // single drag — visually flickering and stealing focus from the
        // ongoing selection. So we gate creation behind pointerup: while a
        // drag is in progress the selectionchange handler is a no-op, and
        // when the user releases the pointer we run the evaluator once.
        // selectionchange still runs for keyboard-driven selection (shift+
        // arrow etc) because no pointer flag is set in that path.
        this.#selectionChangeHandler = () =>
        {
            if (this.#bPointerSelectionInProgress)
            {
                return;
            }
            if (this.#selectionDebounceFrameId !== null)
            {
                return;
            }
            this.#selectionDebounceFrameId = requestAnimationFrame(() =>
            {
                this.#selectionDebounceFrameId = null;
                this.#evaluateSelection();
            });
        };

        this.#pointerDownHandler = (pointerEvent) =>
        {
            // Interactions inside the menu itself don't count as starting
            // a new selection. Without this, clicking Send / Explain / the
            // Ask contenteditable would arm the in-progress flag and the
            // menu would be torn down on pointerup.
            if (pointerEvent.target?.closest?.(TextSelectionContextMenu.tagName))
            {
                return;
            }
            this.#bPointerSelectionInProgress = true;
            // Any pointerdown outside the menu means the user is starting a
            // fresh interaction — drop the stale menu immediately so it
            // doesn't sit on screen while they're dragging out a new range.
            TextSelectionContextMenu.removeAll();
        };

        this.#pointerUpHandler = () =>
        {
            if (!this.#bPointerSelectionInProgress)
            {
                return;
            }
            this.#bPointerSelectionInProgress = false;
            // Defer one tick so window.getSelection() reflects the final
            // range after the browser commits it on pointerup.
            setTimeout(() => this.#evaluateSelection(), 0);
        };

        // Touch backstop. On Android (and iOS to a lesser degree) the
        // OS owns the selection-handle drag — pointerdown fires when
        // the user first touches, but no matching pointerup fires when
        // they release a selection handle. The in-progress flag would
        // stay true forever and selectionchange would be permanently
        // gated off, which is the "system copy/paste menu shows but
        // ours never does" symptom on mobile. touchend always fires
        // on release, so we clear the flag here and re-run the
        // evaluator after a short delay (the system commits the
        // selection asynchronously on touch).
        this.#touchEndHandler = () =>
        {
            this.#bPointerSelectionInProgress = false;
            setTimeout(() => this.#evaluateSelection(), 80);
        };

        document.addEventListener("selectionchange", this.#selectionChangeHandler);
        document.addEventListener("pointerdown", this.#pointerDownHandler, true);
        document.addEventListener("pointerup", this.#pointerUpHandler, true);
        document.addEventListener("touchend", this.#touchEndHandler, true);
    }

    /**
     * Hooks the page's `contextmenu` event so a right-click anywhere
     * inside the study surface opens a StudyContextMenu — but only
     * when there is no active text selection (TextSelectionContextMenu
     * owns that flow via the selection watcher above). Editable
     * targets (inputs, textareas, contenteditables — the bottom panel
     * has these for AskAI) keep the native menu so paste / spellcheck
     * remain reachable. Mock-test sessions are skipped because the
     * runner owns its own UX.
     */
    #installStudyContextMenuWatcher()
    {
        if (this.#session instanceof MockTestSession)
        {
            return;
        }

        this.#contextMenuHandler = (contextMenuEvent) =>
        {
            const targetElement = contextMenuEvent.target;
            if (targetElement?.closest?.("input, textarea, [contenteditable=\"true\"]"))
            {
                return;
            }
            // Right-clicks inside an already-open menu shouldn't spawn
            // a second one on top of themselves.
            if (targetElement?.closest?.(`${StudyContextMenu.tagName}, ${TextSelectionContextMenu.tagName}`))
            {
                return;
            }

            contextMenuEvent.preventDefault();

            // If the user has an active text selection, leave it alone —
            // the TextSelectionContextMenu either is already mounted or
            // will mount via the selection watcher.
            const selection = window.getSelection();
            if (selection && selection.rangeCount > 0 && !selection.isCollapsed
                && selection.toString().trim().length > 0)
            {
                return;
            }

            const activeEntity = this.#session?._current ?? null;
            StudyContextMenu.create(
                { x: contextMenuEvent.clientX, y: contextMenuEvent.clientY },
                activeEntity
            );
        };

        this.addEventListener("contextmenu", this.#contextMenuHandler);
    }

    #evaluateSelection()
    {
        // Typing inside the menu's own contenteditable mutates the
        // selection — ignore those changes so the menu doesn't
        // tear itself down mid-edit.
        const activeElement = document.activeElement;
        if (activeElement && activeElement.closest(TextSelectionContextMenu.tagName))
        {
            return;
        }

        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed)
        {
            TextSelectionContextMenu.removeAll();
            return;
        }

        const selectedText = selection.toString().trim();
        if (selectedText.length === 0)
        {
            TextSelectionContextMenu.removeAll();
            return;
        }

        const range = selection.getRangeAt(0);
        const containerNode = range.commonAncestorContainer;
        const containerElement = containerNode.nodeType === Node.ELEMENT_NODE
            ? containerNode
            : containerNode.parentElement;

        if (!containerElement)
        {
            TextSelectionContextMenu.removeAll();
            return;
        }

        const scopeElement = containerElement.closest(StudyPage.#TEXT_SELECTION_SCOPE_SELECTOR);
        if (!scopeElement || !this.contains(scopeElement))
        {
            TextSelectionContextMenu.removeAll();
            return;
        }

        // No-op if the existing menu is already showing the same text —
        // selectionchange fires multiple times during a drag and the
        // contenteditable inside the menu would lose focus on every
        // recreate.
        const existingMenu = document.querySelector(TextSelectionContextMenu.tagName);
        if (existingMenu && existingMenu.getSelectedText?.() === selectedText)
        {
            return;
        }

        const rangeRect = range.getBoundingClientRect();
        if (rangeRect.width === 0 && rangeRect.height === 0)
        {
            return;
        }

        // Hand the menu the full selection rect — it now picks its own
        // side (below / above / right / left) based on whichever has
        // room, instead of being pinned to a single point on top of
        // the selection.
        TextSelectionContextMenu.create(rangeRect, selectedText);
    }

    /**
     * Mounts the StudySessionBottomPanel after the session has rendered
     * its initial entity. Skipped for mock tests (separate layout) and
     * for the not-yet-implemented CuratedStudySession (no content
     * containers to attach to). Both card sessions and content-study
     * sessions get the panel appended to .study-page-container so the
     * vertical stack is identical between modes.
     */
    #mountBottomPanel()
    {
        if (this.#session instanceof MockTestSession)
        {
            return;
        }
        if (this.#session instanceof CuratedStudySession)
        {
            return;
        }

        const studyPageContainer = this.querySelector(".study-page-container");
        if (!studyPageContainer)
        {
            return;
        }

        if (this.#session instanceof ContentStudySession)
        {
            const initialStudyMaterial = this.#session._current || null;
            const panel = StudySessionBottomPanel.create(
                StudySessionBottomPanel.MODE_STUDY_MATERIAL,
                initialStudyMaterial
            );
            studyPageContainer.appendChild(panel);
            return;
        }

        // Spaced repetition / revise — card mode.
        const initialCard = this.#session._current || null;
        const panel = StudySessionBottomPanel.create(
            StudySessionBottomPanel.MODE_CARD,
            initialCard
        );
        studyPageContainer.appendChild(panel);
    }
}

customElements.define("study-page", StudyPage);
export default StudyPage;