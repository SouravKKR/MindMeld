import CardPreviewSession from "./Classes/CardPreviewSession.js";
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
import StudyActivityReporter from "../../Globals/Classes/Streak/StudyActivityReporter.js";
import MetricTracker from "../../Globals/Classes/Metrics/MetricTracker.js";

class StudyPage extends HTMLElement
{
    static #TEXT_SELECTION_SCOPE_SELECTOR = ".question-section, .answer-section, .study-material-content-section";
    static #SELECTION_SETTLE_MILLISECONDS = 200;

    #session = new StudySession();
    #selectionChangeHandler = null;
    #selectionDebounceTimeoutId = null;
    #pointerDownHandler = null;
    #contextMenuHandler = null;
    #visibilityHandler = null;

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
        // Resume banking activity-gated study time.
        this.#session.startStudyTimer?.();
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

        if (this.#session instanceof SpacedRepetitonSession || this.#session instanceof ReviseSession || this.#session instanceof CardPreviewSession)
        {
            studyMaterialContentSection?.remove();
        }
        else if (this.#session instanceof ContentStudySession)
        {
            questionSection?.remove();
            answerSection?.remove();
            showAnswerButton?.remove();
            userScoreSection?.remove();
            editCardButton?.remove();
        }
        else if (this.#session instanceof CuratedStudySession)
        {
            // CuratedStudySession needs BOTH the material layout and
            // the card layout — material → flashcards → next topic.
            // Keep every section mounted; the session toggles
            // visibility per phase via a study-page--curated-mode class
            // on the page root. Standard FSRS score row and edit button
            // do not apply to curated cards (Easy/Hard only), so those
            // get removed up front.
            this.classList.add("study-page--curated-mode");
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
        // Bank activity-gated study time toward the "hours studied" metric while
        // the page is visible (the ticker itself only counts when the user is
        // active); pause it while the tab is hidden so a backgrounded page accrues
        // nothing. Applies to every session type since they all run in this page.
        this.#session.startStudyTimer?.();
        this.#visibilityHandler = () =>
        {
            if (document.visibilityState === "hidden")
            {
                this.#session.stopStudyTimer?.();
            }
            else
            {
                this.#session.startStudyTimer?.();
            }
        };
        document.addEventListener("visibilitychange", this.#visibilityHandler);

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
                <div class="curated-topic-progress-badge" hidden></div>

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
                    <div class="curated-score-section" hidden>
                        <button class="curated-easy-button">Easy</button>
                        <button class="curated-hard-button">Hard</button>
                    </div>
                    <button class="curated-i-have-read-this-button" hidden>I've read this</button>
                    <div class="previous-next-button-container">
                        <button class="previous-card-button">Previous</button>
                        <div class="card-progression-container">0/0</div>
                        <button class="next-card-button">Next</button>
                    </div>
                    <study-zoom-controls></study-zoom-controls>
                    <button class="edit-card-button">Edit</button>
                    <button class="assistant-toggle-button" type="button" aria-label="Toggle assistant panel">Show Assistant</button>
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
        // Stop the activity-gated study-time ticker.
        this.#session.stopStudyTimer?.();
        if (this.#visibilityHandler)
        {
            document.removeEventListener("visibilitychange", this.#visibilityHandler);
            this.#visibilityHandler = null;
        }

        // Session boundary: ship pending hours/doubts and recompute cards/mock
        // tests server-side (so a crossed badge is awarded AFTER the session).
        MetricTracker.sync({ recompute: true });

        // If the user owes study to recover a broken streak, report today's
        // spaced-repetition count now that this session's attempts are recorded.
        // Fire-and-forget; it self-skips when no recovery is pending.
        StudyActivityReporter.reportIfRecoveryPending();

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
        if (this.#selectionDebounceTimeoutId !== null)
        {
            clearTimeout(this.#selectionDebounceTimeoutId);
            this.#selectionDebounceTimeoutId = null;
        }
        TextSelectionContextMenu.removeAll();
        if (this.#contextMenuHandler)
        {
            this.removeEventListener("contextmenu", this.#contextMenuHandler);
            this.#contextMenuHandler = null;
        }
        StudyContextMenu.removeAll();

        // Tear down a mock-test session if one is in flight. Without this
        // the MockTestRunner stays mounted (PageNavigator.back hides the
        // page via display:none rather than removing it from the DOM),
        // its timer keeps ticking, and on expiry the auto-submit fires
        // its "Time Up — submitting your answers" dialog from a page the
        // user is no longer looking at. Stopping the session discards
        // the in-progress attempt by design — there is no draft autosave
        // on mock tests.
        if (this.#session instanceof MockTestSession && typeof this.#session.stop === "function")
        {
            this.#session.stop();
        }
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

        // selectionchange fires on every range update — many times per
        // frame on a desktop drag, and intermittently while the OS
        // commits a touch selection. We use a time-based debounce that
        // RESETS on every change: the evaluator runs only once the
        // selection has been stable for #SELECTION_SETTLE_MILLISECONDS.
        //
        // This is uniform across input types — desktop mouse drag,
        // mobile OS-driven selection-handle drag, and keyboard
        // (shift+arrow). Pointer-event gating doesn't work on mobile
        // because the OS owns the selection UI: pointerdown fires when
        // the user first touches text, but a matching pointerup often
        // never reaches us when the user releases a selection handle,
        // so any flag set on pointerdown would stay armed forever and
        // selectionchange would be permanently suppressed (the "system
        // copy/paste menu shows but ours never does" symptom).
        //
        // The "same text already shown" check inside #evaluateSelection
        // is what prevents flicker: if the debounce fires and the menu
        // is already displaying the current selection, it stays put.
        this.#selectionChangeHandler = () =>
        {
            if (this.#selectionDebounceTimeoutId !== null)
            {
                clearTimeout(this.#selectionDebounceTimeoutId);
            }
            this.#selectionDebounceTimeoutId = setTimeout(() =>
            {
                this.#selectionDebounceTimeoutId = null;
                this.#evaluateSelection();
            }, StudyPage.#SELECTION_SETTLE_MILLISECONDS);
        };

        this.#pointerDownHandler = (pointerEvent) =>
        {
            // Interactions inside the menu itself must not dismiss it —
            // tapping Send / Explain / the Ask contenteditable would
            // otherwise tear the menu down out from under the user.
            if (pointerEvent.target?.closest?.(TextSelectionContextMenu.tagName))
            {
                return;
            }
            // Any pointerdown outside the menu means the user is
            // starting a fresh interaction — drop the stale menu
            // immediately so it doesn't sit on screen while a new
            // selection is being made. The selectionchange debounce
            // will rebuild it once the new selection settles.
            TextSelectionContextMenu.removeAll();
        };

        document.addEventListener("selectionchange", this.#selectionChangeHandler);
        document.addEventListener("pointerdown", this.#pointerDownHandler, true);
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
            panel.classList.add("study-session-bottom-panel--collapsed");
            studyPageContainer.appendChild(panel);
            return;
        }

        // Spaced repetition / revise — card mode.
        const initialCard = this.#session._current || null;
        const panel = StudySessionBottomPanel.create(
            StudySessionBottomPanel.MODE_CARD,
            initialCard
        );
        panel.classList.add("study-session-bottom-panel--collapsed");
        studyPageContainer.appendChild(panel);
    }
}

customElements.define("study-page", StudyPage);
export default StudyPage;