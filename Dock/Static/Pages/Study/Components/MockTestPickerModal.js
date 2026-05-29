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

        // DialogBox.modal() wraps our HTML in a div with padding:20px that has no
        // flex-grow set, so the card list inside never gets a bounded height and
        // overflows instead of scrolling. Neutralising the wrapper here lets
        // .mock-test-picker-card-list's overflow-y:auto actually engage — mirrors
        // the print-modal flow further down this file.
        const dialogBoxInnerWrapper = dialog.querySelector(":scope > div");
        if (dialogBoxInnerWrapper)
        {
            dialogBoxInnerWrapper.style.flex          = "1";
            dialogBoxInnerWrapper.style.minHeight     = "0";
            dialogBoxInnerWrapper.style.padding       = "0";
            dialogBoxInnerWrapper.style.overflow      = "hidden";
            dialogBoxInnerWrapper.style.display       = "flex";
            dialogBoxInnerWrapper.style.flexDirection = "column";
        }

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

        return `
            <div class="mock-test-picker-card">

                <div class="mock-test-picker-card-header-row">
                    <div class="mock-test-picker-card-icon-wrapper">
                        <img class="mock-test-picker-card-icon" src="./Globals/Assets/Images/Icons/DocumentIcon.svg" alt="">
                    </div>

                    <div class="mock-test-picker-card-info">
                        <div class="mock-test-picker-card-title">${title}</div>
                        <div class="mock-test-picker-card-meta">
                            <span class="mock-test-picker-card-meta-badge">
                                <img class="mock-test-picker-card-meta-icon" src="./Globals/Assets/Images/Icons/ClockIcon.svg" alt="">
                                ${durationText}
                            </span>
                            <span class="mock-test-picker-card-meta-badge">
                                <img class="mock-test-picker-card-meta-icon" src="./Globals/Assets/Images/Icons/ListIcon.svg" alt="">
                                ${itemCount} item${itemCount !== 1 ? "s" : ""}
                            </span>
                            <span class="mock-test-picker-card-meta-badge">
                                <img class="mock-test-picker-card-meta-icon" src="./Globals/Assets/Images/Icons/LightningIcon.svg" alt="">
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
                        <img class="mock-test-picker-action-icon" src="./Globals/Assets/Images/Icons/PlayIcon.svg" alt="">
                        Take Test
                    </button>
                    <button
                        class="mock-test-picker-action-button mock-test-picker-print-button"
                        data-action="print"
                        data-card-index="${cardIndex}"
                    >
                        <img class="mock-test-picker-action-icon" src="./Globals/Assets/Images/Icons/PrintIcon.svg" alt="">
                        Print
                    </button>
                    <button
                        class="mock-test-picker-action-button mock-test-picker-view-key-button"
                        data-action="view-key"
                        data-card-index="${cardIndex}"
                    >
                        <img class="mock-test-picker-action-icon" src="./Globals/Assets/Images/Icons/KeyIcon.svg" alt="">
                        View Key
                    </button>
                    <button
                        class="mock-test-picker-action-button mock-test-picker-edit-button"
                        data-action="edit"
                        data-card-index="${cardIndex}"
                    >
                        <img class="mock-test-picker-action-icon" src="./Globals/Assets/Images/Icons/EditIcon.svg" alt="">
                        Edit
                    </button>
                    <button
                        class="mock-test-picker-action-button mock-test-picker-history-button"
                        data-action="history"
                        data-card-index="${cardIndex}"
                    >
                        <img class="mock-test-picker-action-icon" src="./Globals/Assets/Images/Icons/HistoryIcon.svg" alt="">
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
                // Close the picker BEFORE showing the start dialog. DialogBox is a
                // singleton queue — if the picker is still active, the start dialog
                // gets enqueued and never renders until the picker closes, making it
                // look like it appeared "behind" the picker.
                dialog.close();
                MockTestStartDialog.show(selectedMockTest);
            }
            else if (action === "print")
            {
                // Same queue caveat as take-test: close the picker first so
                // the print modal isn't enqueued behind it.
                dialog.close();
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

    static async #openPrintModal(mockTest)
    {
        const title    = mockTest.getTitle() || "Mock Test";
        const duration = mockTest.getDuration ? mockTest.getDuration() : 0;
        const metaText = duration > 0 ? `${duration} min` : "Duration not set";

        // The PDF build can take several seconds for long tests, so render the
        // modal with a loading overlay first. We swap in the iframe + download
        // button once the blob is ready.
        const printDialog = DialogBox.modal(MockTestPickerModal.#buildPrintModalHtml(title, metaText));

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

        const loadingOverlay = printDialog.querySelector(".mock-test-print-modal-loading-overlay");
        const progressFill = printDialog.querySelector(".mock-test-print-modal-progress-fill");
        const progressLabel = printDialog.querySelector(".mock-test-print-modal-progress-label");

        const updateProgress = (completedItems, totalItems) =>
        {
            if (!progressFill || !progressLabel) return;
            const safeTotal = totalItems > 0 ? totalItems : 1;
            const percent = Math.min(100, Math.round((completedItems / safeTotal) * 100));
            progressFill.style.width = `${percent}%`;
            progressLabel.textContent = `Generating PDF... ${percent}%`;
        };

        updateProgress(0, 1);

        let pdfBlob;
        try
        {
            pdfBlob = await MockTestSession.buildPdfBlobAsync(mockTest, updateProgress);
        }
        catch (buildError)
        {
            console.error("[MockTestPickerModal] PDF build failed:", buildError);
            if (loadingOverlay)
            {
                loadingOverlay.innerHTML = `<div class="mock-test-print-modal-loading-error">Could not generate the PDF. Please try again.</div>`;
            }
            return;
        }

        // The dialog may have been dismissed while we were building. Bail out
        // and let the blob get garbage-collected naturally.
        if (!document.body.contains(printDialog))
        {
            return;
        }

        const blobUrl = URL.createObjectURL(pdfBlob);

        const iframe = printDialog.querySelector(".mock-test-print-modal-pdf-frame");
        if (iframe)
        {
            iframe.src = blobUrl;
        }
        if (loadingOverlay)
        {
            loadingOverlay.remove();
        }

        printDialog.querySelector(".mock-test-print-download-button").addEventListener("click", () =>
        {
            // Reuse the blob we already built rather than calling
            // MockTestSession.downloadPdf, which would re-run the full PDF
            // generation pipeline a second time.
            const downloadLink = document.createElement("a");
            downloadLink.href = blobUrl;
            downloadLink.download = `${mockTest.getTitle() || "Mock Test"}.pdf`;
            document.body.appendChild(downloadLink);
            downloadLink.click();
            downloadLink.remove();
        });

        // Mobile browsers (iOS Safari, Android Chrome) refuse to render
        // PDF blob: URLs in <iframe>, leaving the preview area blank.
        // The fallback panel below replaces the iframe on narrow screens
        // with an "Open PDF" button that calls window.open() on the
        // blob URL -- the mobile OS then hands the PDF to its native
        // viewer (Files / iBooks / Drive) which can actually render it.
        const openInBrowserButton = printDialog.querySelector(".mock-test-print-modal-fallback-open-button");
        if (openInBrowserButton)
        {
            openInBrowserButton.addEventListener("click", () =>
            {
                window.open(blobUrl, "_blank", "noopener,noreferrer");
            });
        }

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

    static #buildPrintModalHtml(title, metaText)
    {
        return `
            <div class="mock-test-print-modal-toolbar">
                <div class="mock-test-print-modal-toolbar-info">
                    <div class="mock-test-print-modal-toolbar-title">${title}</div>
                    <div class="mock-test-print-modal-toolbar-meta">${metaText}</div>
                </div>
                <button class="mock-test-print-download-button">
                    <img class="mock-test-print-download-icon" src="./Globals/Assets/Images/Icons/DownloadIcon.svg" alt="">
                    Download PDF
                </button>
            </div>
            <div class="mock-test-print-modal-preview-area">
                <iframe
                    class="mock-test-print-modal-pdf-frame"
                    title="${title}"
                ></iframe>
                <div class="mock-test-print-modal-loading-overlay">
                    <div class="mock-test-print-modal-loading-spinner"></div>
                    <div class="mock-test-print-modal-progress-label">Preparing PDF...</div>
                    <div class="mock-test-print-modal-progress-track">
                        <div class="mock-test-print-modal-progress-fill"></div>
                    </div>
                </div>
            </div>
            <div class="mock-test-print-modal-fallback">
                <div class="mock-test-print-modal-fallback-icon">
                    <img class="mock-test-print-modal-fallback-icon-image" src="./Globals/Assets/Images/Icons/FileIcon.svg" alt="">
                </div>
                <div class="mock-test-print-modal-fallback-title">${title}</div>
                <div class="mock-test-print-modal-fallback-body">
                    Mobile browsers can't preview PDFs inline. Tap below to open the test in your phone's PDF viewer, or use the Download button up top to save it.
                </div>
                <button class="mock-test-print-modal-fallback-open-button" type="button">Open PDF</button>
            </div>
        `;
    }
}

export default MockTestPickerModal;