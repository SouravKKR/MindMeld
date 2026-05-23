import DialogBox from "../../../CommonComponents/DialogBox.js";
import PageNavigator from "../../../Globals/Classes/PageNavigator.js";
import MockTestSession from "../Classes/MockTestSession.js";
import MockTestStartDialog from "./MockTestStartDialog.js";

// Requires: Pages/Study/Styles/MockTestPickerModal.css

class MockTestPickerModal
{
    /**
     * Displays the mock test picker modal for a given deck.
     * Shows a card for each available mock test with Take Test, Print, and History actions.
     * @param {Deck} deck - The deck whose mock tests to display.
     */
    static show(deck)
    {
        const mockTests = deck?.getMockTests ? deck.getMockTests(true) : [];

        if (mockTests.length === 0)
        {
            DialogBox.alert(
                "No Mock Tests",
                "No mock tests have been generated for this deck yet.<br>Generate one first from the automatic generation page."
            );
            return;
        }

        const dialog = DialogBox.modal(MockTestPickerModal.#buildPickerModalHtml(mockTests));

        dialog.style.padding       = "0";
        dialog.style.overflow      = "hidden";
        dialog.style.width         = "min(700px, 94vw)";
        dialog.style.maxHeight     = "min(85vh, 720px)";
        dialog.style.display       = "flex";
        dialog.style.flexDirection = "column";
        dialog.style.boxSizing     = "border-box";

        MockTestPickerModal.#bindPickerEvents(dialog, mockTests);
    }

    // ── Picker HTML ────────────────────────────────────────────────────────────

    static #buildPickerModalHtml(mockTests)
    {
        const cardListHtml = mockTests
            .map((mockTest, cardIndex) => MockTestPickerModal.#buildMockTestCardHtml(mockTest, cardIndex))
            .join("");

        return `
            <div class="mock-test-picker-modal-header">
                <div class="mock-test-picker-modal-header-title">Select a Mock Test</div>
                <div class="mock-test-picker-modal-header-subtitle">
                    ${mockTests.length} test${mockTests.length !== 1 ? "s" : ""} available
                </div>
            </div>
            <div class="mock-test-picker-card-list">
                ${cardListHtml}
            </div>
        `;
    }

    static #buildMockTestCardHtml(mockTest, cardIndex)
    {
        const title        = mockTest.getTitle() || "Untitled Mock Test";
        const duration     = mockTest.getDuration ? mockTest.getDuration() : 0;
        const durationText = duration > 0 ? `${duration} min` : "Duration not set";
        const itemCount    = mockTest.getItems ? mockTest.getItems().length : 0;
        const attemptCount = mockTest.getHistory ? mockTest.getHistory().length : 0;

        // Unique gradient ID per card to avoid SVG defs collisions.
        const gradientId = `mockTestPickerGradient${cardIndex}`;

        return `
            <div class="mock-test-picker-card">

                <div class="mock-test-picker-card-header-row">
                    <div class="mock-test-picker-card-icon-wrapper">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <defs>
                                <linearGradient id="${gradientId}" x1="0" y1="0" x2="1" y2="1">
                                    <stop offset="0%" stop-color="#0098C4"/>
                                    <stop offset="100%" stop-color="#B55BD0"/>
                                </linearGradient>
                            </defs>
                            <path d="M14 2H6C5.46957 2 4.96086 2.21071 4.58579 2.58579C4.21071 2.96086 4 3.46957 4 4V20C4 20.5304 4.21071 21.0391 4.58579 21.4142C4.96086 21.7893 5.46957 22 6 22H18C18.5304 22 19.0391 21.7893 19.4142 21.4142C19.7893 21.0391 20 20.5304 20 20V8L14 2Z"
                                stroke="url(#${gradientId})" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                            <path d="M14 2V8H20"
                                stroke="url(#${gradientId})" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                    </div>

                    <div class="mock-test-picker-card-info">
                        <div class="mock-test-picker-card-title">${title}</div>
                        <div class="mock-test-picker-card-meta">
                            <span class="mock-test-picker-card-meta-badge">
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                                </svg>
                                ${durationText}
                            </span>
                            <span class="mock-test-picker-card-meta-badge">
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/>
                                    <line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/>
                                    <line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
                                </svg>
                                ${itemCount} item${itemCount !== 1 ? "s" : ""}
                            </span>
                            <span class="mock-test-picker-card-meta-badge">
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                                </svg>
                                ${attemptCount} attempt${attemptCount !== 1 ? "s" : ""}
                            </span>
                        </div>
                    </div>
                </div>

                <div class="mock-test-picker-card-actions">
                    <button
                        class="mock-test-picker-action-button mock-test-picker-take-test-button"
                        data-action="take-test"
                        data-card-index="${cardIndex}"
                    >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M8 5v14l11-7z"/>
                        </svg>
                        Take Test
                    </button>
                    <button
                        class="mock-test-picker-action-button mock-test-picker-print-button"
                        data-action="print"
                        data-card-index="${cardIndex}"
                    >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="6 9 6 2 18 2 18 9"/>
                            <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
                            <rect x="6" y="14" width="12" height="8"/>
                        </svg>
                        Print
                    </button>
                    <button
                        class="mock-test-picker-action-button mock-test-picker-view-key-button"
                        data-action="view-key"
                        data-card-index="${cardIndex}"
                    >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
                        </svg>
                        View Key
                    </button>
                    <button
                        class="mock-test-picker-action-button mock-test-picker-edit-button"
                        data-action="edit"
                        data-card-index="${cardIndex}"
                    >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                        </svg>
                        Edit
                    </button>
                    <button
                        class="mock-test-picker-action-button mock-test-picker-history-button"
                        data-action="history"
                        data-card-index="${cardIndex}"
                    >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="9"/>
                        </svg>
                        History
                    </button>
                </div>

            </div>
        `;
    }

    // ── Picker events ──────────────────────────────────────────────────────────

    static #bindPickerEvents(dialog, mockTests)
    {
        dialog.addEventListener("click", (event) =>
        {
            const actionButton = event.target.closest("[data-action]");
            if (!actionButton) return;

            const action           = actionButton.dataset.action;
            const cardIndex        = parseInt(actionButton.dataset.cardIndex);
            const selectedMockTest = mockTests[cardIndex];

            if (!selectedMockTest) return;

            if (action === "take-test")
            {
                MockTestStartDialog.show(selectedMockTest, dialog);
            }
            else if (action === "print")
            {
                MockTestPickerModal.#openPrintModal(selectedMockTest);
            }
            else if (action === "view-key")
            {
                dialog.close();
                PageNavigator.open("mock-test-answer-key-page", selectedMockTest);
            }
            else if (action === "edit")
            {
                dialog.close();
                PageNavigator.open("mock-test-editor-page", selectedMockTest, selectedMockTest.getDeck ? selectedMockTest.getDeck() : null);
            }
            else if (action === "history")
            {
                // TODO: Implement attempt history viewer.
                DialogBox.alert("Coming Soon", "Attempt history is not yet implemented.");
            }
        });
    }

    // ── Print modal ────────────────────────────────────────────────────────────

    static #openPrintModal(mockTest)
    {
        const pdfBlob  = MockTestSession.buildPdfBlob(mockTest);
        const blobUrl  = URL.createObjectURL(pdfBlob);
        const title    = mockTest.getTitle() || "Mock Test";
        const duration = mockTest.getDuration ? mockTest.getDuration() : 0;
        const metaText = duration > 0 ? `${duration} min` : "Duration not set";

        const printDialog = DialogBox.modal(MockTestPickerModal.#buildPrintModalHtml(title, metaText, blobUrl));

        printDialog.style.padding       = "0";
        printDialog.style.overflow      = "hidden";
        printDialog.style.width         = "min(920px, 96vw)";
        printDialog.style.height        = "min(90vh, 780px)";
        printDialog.style.display       = "flex";
        printDialog.style.flexDirection = "column";
        printDialog.style.boxSizing     = "border-box";

        // DialogBox.modal() wraps our HTML in a div with padding:20px that has no
        // flex-grow set, so it never stretches to fill the dialog-box height.
        // We can't change DialogBox itself, so we neutralise that wrapper here.
        const dialogBoxInnerWrapper = printDialog.querySelector(":scope > div");
        if (dialogBoxInnerWrapper)
        {
            dialogBoxInnerWrapper.style.flex       = "1";
            dialogBoxInnerWrapper.style.minHeight  = "0";
            dialogBoxInnerWrapper.style.padding    = "0";
            dialogBoxInnerWrapper.style.overflow   = "hidden";
            dialogBoxInnerWrapper.style.display    = "flex";
            dialogBoxInnerWrapper.style.flexDirection = "column";
        }

        printDialog.querySelector(".mock-test-print-download-button").addEventListener("click", () =>
        {
            MockTestSession.downloadPdf(mockTest);
        });

        // Revoke the blob URL when the print dialog is removed from the DOM.
        const domObserver = new MutationObserver(() =>
        {
            if (!document.body.contains(printDialog))
            {
                URL.revokeObjectURL(blobUrl);
                domObserver.disconnect();
            }
        });
        domObserver.observe(document.body, { childList: true, subtree: true });
    }

    static #buildPrintModalHtml(title, metaText, blobUrl)
    {
        return `
            <div class="mock-test-print-modal-toolbar">
                <div class="mock-test-print-modal-toolbar-info">
                    <div class="mock-test-print-modal-toolbar-title">${title}</div>
                    <div class="mock-test-print-modal-toolbar-meta">${metaText}</div>
                </div>
                <button class="mock-test-print-download-button">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 16l-5-5h3V4h4v7h3l-5 5zm-7 2h14v2H5v-2z"/>
                    </svg>
                    Download PDF
                </button>
            </div>
            <iframe
                class="mock-test-print-modal-pdf-frame"
                src="${blobUrl}"
                title="${title}"
            ></iframe>
        `;
    }
}

export default MockTestPickerModal;