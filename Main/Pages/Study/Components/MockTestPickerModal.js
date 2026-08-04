import DialogBox from "../../../CommonComponents/DialogBox.js";
import PageNavigator from "../../../Globals/Classes/PageNavigator.js";
import { mockTestEvaluationStatuses } from "../../../Globals/Enumerations/MockTestEvaluationStatuses.js";
import MockTestSession from "../Classes/MockTestSession.js";
import MockTestStartDialog from "./MockTestStartDialog.js";
import PaidDeckStudyGate from "../../../Globals/Classes/PaidDeckStudyGate.js";

// Requires: Pages/Study/Styles/MockTestPickerModal.css

class MockTestPickerModal
{
    // TEMPORARY: the question paper PDF download is hidden while the export is
    // being refined. The print preview itself still works — only the "Download
    // PDF" button is withheld. This will be unhidden later; flip back to false
    // to restore it (nothing else was removed).
    static QUESTION_PAPER_DOWNLOAD_TEMPORARILY_HIDDEN = true;

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
        dialog.addEventListener("click", async (event) =>
        {
            const actionButton = event.target.closest("[data-action]");
            if (!actionButton) return;

            const action           = actionButton.dataset.action;
            const cardIndex        = parseInt(actionButton.dataset.cardIndex);
            const selectedMockTest = mockTests[cardIndex];

            if (!selectedMockTest) return;

            const bIsPaidDeck = !!selectedMockTest.getDeck?.()?.getAdditionalData?.()?.paidDeckId;

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
                // Printing produces a shareable PDF of the questions — an export
                // path. Block it for a paid deck (content stays on-device only).
                if (bIsPaidDeck)
                {
                    DialogBox.alert("Not available", "Mock tests in a paid deck can't be printed or exported.");
                    return;
                }
                // Same queue caveat as take-test: close the picker first so
                // the print modal isn't enqueued behind it.
                dialog.close();
                MockTestPickerModal.#openPrintModal(selectedMockTest);
            }
            else if (action === "view-key")
            {
                dialog.close();
                // Paid deck: unlock once per session before the answer key opens
                // so it never renders [Locked] and is never reachable without the
                // password. No-op for a normal/unlocked deck.
                const bReady = await PaidDeckStudyGate.ensureReadyForStudy(selectedMockTest.getDeck());
                if (!bReady)
                {
                    return;
                }
                PageNavigator.open("mock-test-answer-key-page", selectedMockTest);
            }
            else if (action === "edit")
            {
                dialog.close();
                PageNavigator.open("mock-test-editor-page", selectedMockTest, selectedMockTest.getDeck ? selectedMockTest.getDeck() : null);
            }
            else if (action === "history")
            {
                // Close the picker first — DialogBox is a singleton queue.
                dialog.close();
                MockTestPickerModal.#openHistoryModal(selectedMockTest);
            }
        });
    }

    // ── History modal ──────────────────────────────────────────────────────────

    static #openHistoryModal(mockTest)
    {
        const history = mockTest.getHistory ? mockTest.getHistory() : [];

        if (!Array.isArray(history) || history.length === 0)
        {
            DialogBox.alert(
                "No Attempts",
                "You haven't taken this mock test yet. Take it once and your attempts will show up here."
            );
            return;
        }

        const sortedAttemptsLatestFirst = [...history].sort((firstAttempt, secondAttempt) =>
        {
            const firstTime = firstAttempt.getAttemptDate ? firstAttempt.getAttemptDate().getTime() : 0;
            const secondTime = secondAttempt.getAttemptDate ? secondAttempt.getAttemptDate().getTime() : 0;
            return secondTime - firstTime;
        });

        const dialog = DialogBox.modal(MockTestPickerModal.#buildHistoryModalHtml(mockTest, sortedAttemptsLatestFirst));

        dialog.style.padding       = "0";
        dialog.style.overflow      = "hidden";
        dialog.style.width         = "min(560px, 94vw)";
        dialog.style.maxHeight     = "min(85vh, 720px)";
        dialog.style.display       = "flex";
        dialog.style.flexDirection = "column";
        dialog.style.boxSizing     = "border-box";

        // Same DialogBox wrapper-neutralisation trick as the picker.
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

        dialog.addEventListener("click", async (event) =>
        {
            const row = event.target.closest("[data-attempt-id]");
            if (!row)
            {
                return;
            }
            const attemptId = row.dataset.attemptId;
            const selectedAttempt = sortedAttemptsLatestFirst.find((entry) => entry.getId() === attemptId);
            if (!selectedAttempt)
            {
                return;
            }
            dialog.close();
            // Paid deck: unlock once per session before the answer key opens.
            const bReady = await PaidDeckStudyGate.ensureReadyForStudy(mockTest.getDeck());
            if (!bReady)
            {
                return;
            }
            PageNavigator.open("mock-test-answer-key-page", mockTest, selectedAttempt);
        });
    }

    static #buildHistoryModalHtml(mockTest, sortedAttempts)
    {
        const mockTestTitle = mockTest.getTitle() || "Mock Test";
        const rowsHtml = sortedAttempts
            .map((attempt) => MockTestPickerModal.#buildHistoryRowHtml(attempt))
            .join("");

        return `
            <div class="mock-test-history-modal-header">
                <div class="mock-test-history-modal-header-title">Attempt History</div>
                <div class="mock-test-history-modal-header-subtitle">${MockTestPickerModal.#escapeHtml(mockTestTitle)} — ${sortedAttempts.length} attempt${sortedAttempts.length === 1 ? "" : "s"}</div>
            </div>
            <div class="mock-test-history-modal-list">
                ${rowsHtml}
            </div>
        `;
    }

    static #buildHistoryRowHtml(attempt)
    {
        const attemptId = attempt.getId();
        const attemptDate = attempt.getAttemptDate ? attempt.getAttemptDate() : null;
        const dateLabel = attemptDate ? attemptDate.toLocaleString() : "(unknown date)";
        const status = attempt.getEvaluationStatus ? attempt.getEvaluationStatus() : null;
        const { statusLabel, statusClass } = MockTestPickerModal.#formatAttemptStatus(status);
        const scoreLabel = MockTestPickerModal.#formatAttemptScore(attempt);

        return `
            <button
                type="button"
                class="mock-test-history-modal-row"
                data-attempt-id="${MockTestPickerModal.#escapeHtml(attemptId)}"
            >
                <div class="mock-test-history-modal-row-main">
                    <div class="mock-test-history-modal-row-date">${MockTestPickerModal.#escapeHtml(dateLabel)}</div>
                    <div class="mock-test-history-modal-row-status mock-test-history-modal-row-status-${statusClass}">${statusLabel}</div>
                </div>
                <div class="mock-test-history-modal-row-score">${scoreLabel}</div>
            </button>
        `;
    }

    static #formatAttemptStatus(status)
    {
        if (status === mockTestEvaluationStatuses.COMPLETED)
        {
            return { statusLabel: "Graded", statusClass: "completed" };
        }
        if (status === mockTestEvaluationStatuses.GRADING)
        {
            return { statusLabel: "Grading…", statusClass: "grading" };
        }
        if (status === mockTestEvaluationStatuses.FAILED)
        {
            return { statusLabel: "Failed", statusClass: "failed" };
        }
        return { statusLabel: "Not graded", statusClass: "pending" };
    }

    static #formatAttemptScore(attempt)
    {
        const status = attempt.getEvaluationStatus ? attempt.getEvaluationStatus() : null;
        if (status !== mockTestEvaluationStatuses.COMPLETED)
        {
            return "—";
        }
        let score = 0;
        let maxScore = 0;
        for (const item of attempt.getItems() || [])
        {
            if (typeof item?.getMarks !== "function" || typeof item?.getScore !== "function")
            {
                continue;
            }
            const itemScore = item.getScore();
            const itemMarks = item.getMarks();
            score += Number.isFinite(itemScore) ? itemScore : 0;
            maxScore += Number.isFinite(itemMarks) ? itemMarks : 0;
        }
        if (maxScore === 0)
        {
            // Fall back to the attempt-level totals if per-item sum yields
            // nothing (legacy attempts that never had per-item scoring).
            score = attempt.getScore ? attempt.getScore() : 0;
            maxScore = attempt.getMaxScore ? attempt.getMaxScore() : 0;
        }
        const formattedScore = Number.isInteger(score) ? String(score) : score.toFixed(2);
        const formattedMaxScore = Number.isInteger(maxScore) ? String(maxScore) : maxScore.toFixed(2);
        return `${formattedScore} / ${formattedMaxScore}`;
    }

    static #escapeHtml(value)
    {
        if (value === null || value === undefined)
        {
            return "";
        }
        return String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
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

        // Null while QUESTION_PAPER_DOWNLOAD_TEMPORARILY_HIDDEN is on — the
        // button is not rendered. The handler below is kept intact so the
        // download works again the moment the flag is flipped back.
        const printDownloadButton = printDialog.querySelector(".mock-test-print-download-button");
        if (printDownloadButton)
        {
            printDownloadButton.addEventListener("click", () =>
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
        }

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
                ${MockTestPickerModal.QUESTION_PAPER_DOWNLOAD_TEMPORARILY_HIDDEN ? "" : `<button class="mock-test-print-download-button">
                    <img class="mock-test-print-download-icon" src="./Globals/Assets/Images/Icons/DownloadIcon.svg" alt="">
                    Download PDF
                </button>`}
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