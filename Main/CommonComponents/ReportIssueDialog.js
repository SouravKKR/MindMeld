import DialogBox from "./DialogBox.js";
import { supportTicketTypes } from "../Globals/Enumerations/SupportTicketTypes.js";
import { supportTicketStatus } from "../Globals/Enumerations/SupportTicketStatus.js";
import { supportTicketReportStatus } from "../Globals/Enumerations/SupportTicketReportStatus.js";
import { enumerationToTitleCase } from "../Globals/UtilityFunctions/EnumerationToTitleCase.js";

/**
 * ReportIssueDialog
 *
 * The in-app replacement for the old support mailto: link. Two views behind one
 * dialog:
 *
 *   "Report an issue" — type, description, attachments, and a notify-me checkbox.
 *   "Your reports"    — every issue this user has raised and where it stands.
 *
 * The second view is not a nicety. Someone who leaves the notify box unchecked has
 * declined an email, not declined the right to know whether their problem was
 * fixed — so the status is always available here regardless of that choice.
 *
 * Reports are deduplicated server-side (several people hitting one bug collapse
 * onto a single ticket), but that is invisible from here: a reporter sees their own
 * submission and the outcome of the ticket it was folded into.
 */
class ReportIssueDialog
{
    // Mirrors Dock/Globals/Classes/Support/SupportTicketLimits.js and
    // SupportAttachmentPolicy.js. Enforced here only to give immediate feedback —
    // the server re-checks every one of these against the bytes that arrive, so a
    // bypassed client-side guard changes nothing.
    static MINIMUM_DESCRIPTION_LENGTH = 20;
    static MAXIMUM_DESCRIPTION_LENGTH = 4000;
    static MAXIMUM_ATTACHMENT_COUNT = 5;
    static MAXIMUM_FILE_BYTES = 10 * 1024 * 1024;
    static ACCEPTED_MIME_TYPES = "image/png,image/jpeg,image/webp,image/gif,application/pdf";

    static ALLOWED_MIME_TYPE_SET = new Set
    ([
        "image/png",
        "image/jpeg",
        "image/jpg",
        "image/webp",
        "image/gif",
        "application/pdf"
    ]);

    /**
     * Opens the dialog. Resolves once it closes; the value is true when a report
     * was successfully submitted, so a caller can react if it wants to.
     *
     * @returns {Promise<boolean>}
     */
    static async show()
    {
        const currentUser = window["user"];

        if (!currentUser || typeof currentUser.getId !== "function" || !currentUser.getId())
        {
            ReportIssueDialog.#showSignInPrompt();
            return false;
        }

        return new Promise((resolve) =>
        {
            const dialog = DialogBox.modal(ReportIssueDialog.#buildMarkup());

            const selectedFiles = [];
            let bSubmitted = false;

            const errorElement = dialog.querySelector('[data-role="error"]');
            const descriptionInput = dialog.querySelector('[data-role="description"]');
            const counterElement = dialog.querySelector('[data-role="description-counter"]');
            const fileInput = dialog.querySelector('[data-role="file-input"]');
            const dropZone = dialog.querySelector('[data-role="drop-zone"]');
            const attachmentListElement = dialog.querySelector('[data-role="attachment-list"]');
            const submitButton = dialog.querySelector('[data-role="submit"]');
            const progressElement = dialog.querySelector('[data-role="progress"]');

            function showError(message)
            {
                errorElement.textContent = message;
                errorElement.hidden = String(message ?? "").length === 0;
            }

            ReportIssueDialog.#populateIssueTypes(dialog.querySelector('[data-role="issue-type"]'));
            ReportIssueDialog.#bindTabs(dialog);

            descriptionInput.addEventListener("input", () =>
            {
                counterElement.textContent = `${descriptionInput.value.length} / ${ReportIssueDialog.MAXIMUM_DESCRIPTION_LENGTH}`;
                showError("");
            });

            function renderAttachments()
            {
                attachmentListElement.innerHTML = selectedFiles
                    .map((file, fileIndex) =>
                        `<li class="report-issue-attachment">
                            <span class="report-issue-attachment-name">${ReportIssueDialog.#escapeHtml(file.name)}</span>
                            <span class="report-issue-attachment-size">${ReportIssueDialog.#formatBytes(file.size)}</span>
                            <button type="button" class="report-issue-attachment-remove" data-index="${fileIndex}" aria-label="Remove attachment">×</button>
                        </li>`)
                    .join("");

                dropZone.classList.toggle("report-issue-drop-zone-full", selectedFiles.length >= ReportIssueDialog.MAXIMUM_ATTACHMENT_COUNT);
            }

            function addFiles(fileList)
            {
                for (const file of Array.from(fileList || []))
                {
                    if (selectedFiles.length >= ReportIssueDialog.MAXIMUM_ATTACHMENT_COUNT)
                    {
                        showError(`You can attach up to ${ReportIssueDialog.MAXIMUM_ATTACHMENT_COUNT} files.`);
                        break;
                    }

                    if (!ReportIssueDialog.ALLOWED_MIME_TYPE_SET.has(String(file.type || "").toLowerCase()))
                    {
                        showError(`"${file.name}" isn't a supported file type. Attach images or PDFs.`);
                        continue;
                    }

                    if (file.size > ReportIssueDialog.MAXIMUM_FILE_BYTES)
                    {
                        showError(`"${file.name}" is larger than ${ReportIssueDialog.#formatBytes(ReportIssueDialog.MAXIMUM_FILE_BYTES)}.`);
                        continue;
                    }

                    selectedFiles.push(file);
                }

                renderAttachments();
            }

            dropZone.addEventListener("click", () => fileInput.click());
            fileInput.addEventListener("change", () =>
            {
                addFiles(fileInput.files);
                // Cleared so re-picking the same file still fires a change event.
                fileInput.value = "";
            });

            dropZone.addEventListener("dragover", (dragEvent) =>
            {
                dragEvent.preventDefault();
                dropZone.classList.add("report-issue-drop-zone-active");
            });
            dropZone.addEventListener("dragleave", () => dropZone.classList.remove("report-issue-drop-zone-active"));
            dropZone.addEventListener("drop", (dropEvent) =>
            {
                dropEvent.preventDefault();
                dropZone.classList.remove("report-issue-drop-zone-active");
                addFiles(dropEvent.dataTransfer?.files);
            });

            attachmentListElement.addEventListener("click", (clickEvent) =>
            {
                const removeButton = clickEvent.target.closest(".report-issue-attachment-remove");

                if (!removeButton)
                {
                    return;
                }

                selectedFiles.splice(Number(removeButton.dataset.index), 1);
                renderAttachments();
                showError("");
            });

            dialog.querySelector('[data-role="cancel"]').addEventListener("click", () => dialog.close());

            submitButton.addEventListener("click", () =>
            {
                const description = descriptionInput.value.trim();

                if (description.length < ReportIssueDialog.MINIMUM_DESCRIPTION_LENGTH)
                {
                    showError(`Please describe the issue in at least ${ReportIssueDialog.MINIMUM_DESCRIPTION_LENGTH} characters so we can act on it.`);
                    return;
                }

                if (description.length > ReportIssueDialog.MAXIMUM_DESCRIPTION_LENGTH)
                {
                    showError(`Please shorten the description to ${ReportIssueDialog.MAXIMUM_DESCRIPTION_LENGTH} characters or fewer.`);
                    return;
                }

                showError("");
                submitButton.disabled = true;

                const issueTypeName = dialog.querySelector('[data-role="issue-type"]').value;
                const formData = new FormData();
                formData.append("issueType", String(supportTicketTypes[issueTypeName] ?? supportTicketTypes.OTHER));
                formData.append("description", description);
                formData.append("bNotifyOnResolution", dialog.querySelector('[data-role="notify"]').checked ? "true" : "false");

                // One repeated field name; the server reads each file's name and
                // type from its own multipart part headers and re-validates both.
                for (const file of selectedFiles)
                {
                    formData.append("attachments", file);
                }

                // XMLHttpRequest rather than fetch specifically for upload
                // progress — a 10 MB screenshot on a slow connection otherwise
                // looks like a frozen dialog.
                const request = new XMLHttpRequest();
                request.open("POST", "/Support/Report/Submit");

                request.upload.onprogress = (progressEvent) =>
                {
                    if (!progressEvent.lengthComputable || selectedFiles.length === 0)
                    {
                        return;
                    }

                    progressElement.hidden = false;
                    progressElement.textContent = `Uploading… ${Math.round((progressEvent.loaded / progressEvent.total) * 100)}%`;
                };

                request.onload = () =>
                {
                    progressElement.hidden = true;

                    let responseJson = {};
                    try
                    {
                        responseJson = JSON.parse(request.responseText || "{}");
                    }
                    catch (parseError)
                    {
                        responseJson = {};
                    }

                    if (request.status >= 200 && request.status < 300 && responseJson.success !== false)
                    {
                        bSubmitted = true;
                        ReportIssueDialog.#showSubmittedState(dialog, responseJson);
                        return;
                    }

                    submitButton.disabled = false;
                    showError(ReportIssueDialog.#describeError(responseJson, request.status));
                };

                request.onerror = () =>
                {
                    progressElement.hidden = true;
                    submitButton.disabled = false;
                    showError("Couldn't reach the server. Check your connection and try again.");
                };

                request.send(formData);
            });

            dialog.setDismissHandler(() => dialog.close());

            // DialogBox emits no close event, so resolution is tied to removal from
            // the DOM instead — which covers the close button, Escape, and the
            // programmatic close above uniformly.
            const removalObserver = new MutationObserver(() =>
            {
                if (!document.body.contains(dialog))
                {
                    removalObserver.disconnect();
                    resolve(bSubmitted);
                }
            });
            removalObserver.observe(document.body, { childList: true });

            ReportIssueDialog.#loadMyReports(dialog);
        });
    }

    /**
     * @returns {string}
     */
    static #buildMarkup()
    {
        return `
            <div class="report-issue-dialog">
                <h2 class="report-issue-title">Report an issue</h2>
                <p class="report-issue-subtitle">Tell us what went wrong and we'll look into it. You can check back here for the outcome.</p>

                <div class="report-issue-tabs">
                    <button type="button" class="report-issue-tab report-issue-tab-active" data-tab="report">Report an issue</button>
                    <button type="button" class="report-issue-tab" data-tab="mine">Your reports</button>
                </div>

                <div class="report-issue-panel" data-panel="report">
                    <label class="report-issue-field">
                        <span>What kind of issue is it?</span>
                        <select data-role="issue-type"></select>
                    </label>

                    <label class="report-issue-field">
                        <span>What happened?</span>
                        <textarea data-role="description" rows="6" maxlength="${ReportIssueDialog.MAXIMUM_DESCRIPTION_LENGTH}"
                            placeholder="Describe what you were doing, what you expected, and what happened instead."></textarea>
                        <span class="report-issue-counter" data-role="description-counter">0 / ${ReportIssueDialog.MAXIMUM_DESCRIPTION_LENGTH}</span>
                    </label>

                    <div class="report-issue-field">
                        <span>Attachments <em>(optional — up to ${ReportIssueDialog.MAXIMUM_ATTACHMENT_COUNT} images or PDFs, ${ReportIssueDialog.#formatBytes(ReportIssueDialog.MAXIMUM_FILE_BYTES)} each)</em></span>
                        <div class="report-issue-drop-zone" data-role="drop-zone">
                            <span>Drop screenshots here, or click to choose</span>
                        </div>
                        <input type="file" multiple accept="${ReportIssueDialog.ACCEPTED_MIME_TYPES}" data-role="file-input" hidden>
                        <ul class="report-issue-attachments" data-role="attachment-list"></ul>
                    </div>

                    <label class="report-issue-checkbox">
                        <input type="checkbox" data-role="notify" checked>
                        <span>Email me when this is resolved</span>
                    </label>

                    <div class="report-issue-error" data-role="error" hidden></div>
                    <div class="report-issue-progress" data-role="progress" hidden></div>

                    <div class="report-issue-actions">
                        <button type="button" class="cancel-button report-issue-cancel" data-role="cancel">Cancel</button>
                        <button type="button" class="ok-button report-issue-submit" data-role="submit">Send report</button>
                    </div>
                </div>

                <div class="report-issue-panel" data-panel="mine" hidden>
                    <div class="report-issue-my-reports" data-role="my-reports">Loading your reports…</div>
                </div>
            </div>
        `;
    }

    /**
     * @param {HTMLSelectElement} selectElement
     * @returns {void}
     */
    static #populateIssueTypes(selectElement)
    {
        // UNKNOWN is a storage-level default, never something a person picks.
        // Every other member is title-cased straight from its enum name, which is
        // why those names were chosen to read as labels — it keeps the client and
        // the admin list on one vocabulary with no separate label map to drift.
        const options = Object.keys(supportTicketTypes)
            .filter(typeName => supportTicketTypes[typeName] !== supportTicketTypes.UNKNOWN)
            .map(typeName => `<option value="${typeName}">${ReportIssueDialog.#escapeHtml(enumerationToTitleCase(typeName))}</option>`);

        selectElement.innerHTML = options.join("");
        selectElement.value = "BUG";
    }

    /**
     * @param {HTMLElement} dialog
     * @returns {void}
     */
    static #bindTabs(dialog)
    {
        for (const tabButton of dialog.querySelectorAll(".report-issue-tab"))
        {
            tabButton.addEventListener("click", () =>
            {
                for (const otherTab of dialog.querySelectorAll(".report-issue-tab"))
                {
                    otherTab.classList.toggle("report-issue-tab-active", otherTab === tabButton);
                }

                for (const panel of dialog.querySelectorAll(".report-issue-panel"))
                {
                    panel.hidden = panel.dataset.panel !== tabButton.dataset.tab;
                }
            });
        }
    }

    /**
     * Replaces the form with a confirmation once a report lands, and refreshes the
     * status list so the new entry is visible on the other tab straight away.
     *
     * @param {HTMLElement} dialog
     * @param {object} responseJson
     * @returns {void}
     */
    static #showSubmittedState(dialog, responseJson)
    {
        const remaining = Number(responseJson?.remaining);
        const remainingNote = Number.isFinite(remaining)
            ? `You can send ${remaining} more report${remaining === 1 ? "" : "s"} today.`
            : "";

        dialog.querySelector('[data-panel="report"]').innerHTML = `
            <div class="report-issue-submitted">
                <h3>Thanks — we've got it.</h3>
                <p>We group reports about the same problem together, so you may see this listed alongside others describing the same thing.</p>
                <p>You can check the status any time under <strong>Your reports</strong>.</p>
                <p class="report-issue-subtitle">${ReportIssueDialog.#escapeHtml(remainingNote)}</p>
                <div class="report-issue-actions">
                    <button type="button" class="ok-button report-issue-submit" data-role="done">Done</button>
                </div>
            </div>
        `;

        dialog.querySelector('[data-role="done"]').addEventListener("click", () => dialog.close());
        ReportIssueDialog.#loadMyReports(dialog);
    }

    /**
     * @param {HTMLElement} dialog
     * @returns {Promise<void>}
     */
    static async #loadMyReports(dialog)
    {
        const container = dialog.querySelector('[data-role="my-reports"]');

        if (!container)
        {
            return;
        }

        let responseJson = null;

        try
        {
            const response = await fetch("/Support/MyReports");
            responseJson = await response.json();
        }
        catch (loadError)
        {
            container.textContent = "Couldn't load your reports right now.";
            return;
        }

        const reports = Array.isArray(responseJson?.reports) ? responseJson.reports : [];

        if (reports.length === 0)
        {
            container.innerHTML = `<p class="report-issue-subtitle">You haven't reported anything yet.</p>`;
            return;
        }

        container.innerHTML = reports.map(report => ReportIssueDialog.#renderReportCard(report)).join("");
    }

    /**
     * @param {object} report
     * @returns {string}
     */
    static #renderReportCard(report)
    {
        const status = ReportIssueDialog.#describeStatus(report);
        const submittedOn = new Date(report.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
        const adminMessage = report.ticketStatus === supportTicketStatus.RESOLVED ? report.resolutionMessage : report.declineMessage;
        const creditNote = Number(report.creditAmount) > 0
            ? `<p class="report-issue-card-credit">+${report.creditAmount} credits added as a thank you.</p>`
            : "";

        return `
            <article class="report-issue-card">
                <header class="report-issue-card-header">
                    <span class="report-issue-card-type">${ReportIssueDialog.#escapeHtml(enumerationToTitleCase(ReportIssueDialog.#issueTypeName(report.issueType)))}</span>
                    <span class="report-issue-card-status report-issue-card-status-${status.variant}">${ReportIssueDialog.#escapeHtml(status.label)}</span>
                </header>
                <p class="report-issue-card-description">${ReportIssueDialog.#escapeHtml(report.description)}</p>
                ${adminMessage ? `<blockquote class="report-issue-card-message">${ReportIssueDialog.#escapeHtml(adminMessage)}</blockquote>` : ""}
                ${creditNote}
                <footer class="report-issue-card-footer">Reported ${ReportIssueDialog.#escapeHtml(submittedOn)}</footer>
            </article>
        `;
    }

    /**
     * @param {object} report
     * @returns {{label: string, variant: string}}
     */
    static #describeStatus(report)
    {
        if (report.groupingStatus === supportTicketReportStatus.GROUPING_FAILED)
        {
            return { label: "Received", variant: "pending" };
        }

        if (report.ticketStatus === supportTicketStatus.RESOLVED)
        {
            return { label: "Resolved", variant: "resolved" };
        }

        if (report.ticketStatus === supportTicketStatus.DECLINED)
        {
            return { label: "Closed", variant: "declined" };
        }

        return { label: "Under review", variant: "pending" };
    }

    /**
     * @param {number} issueTypeValue
     * @returns {string}
     */
    static #issueTypeName(issueTypeValue)
    {
        const matchedName = Object.keys(supportTicketTypes).find(typeName => supportTicketTypes[typeName] === issueTypeValue);
        return matchedName && matchedName !== "UNKNOWN" ? matchedName : "OTHER";
    }

    /**
     * Turns a server error code into something a reporter can act on. The quota
     * case is the one that actually matters — it is the only rejection a
     * well-behaved user will realistically hit.
     *
     * @param {object} responseJson
     * @param {number} statusCode
     * @returns {string}
     */
    static #describeError(responseJson, statusCode)
    {
        const errorCode = String(responseJson?.error ?? "");

        if (errorCode === "SUPPORT_QUOTA_EXCEEDED")
        {
            const hours = Math.max(1, Math.round(Number(responseJson?.retryAfterSeconds || 0) / 3600));
            return `You've reached the limit of ${responseJson?.limit ?? 2} reports a day. You can send another in about ${hours} hour${hours === 1 ? "" : "s"}.`;
        }

        if (errorCode === "SUPPORT_TOO_MANY_ATTACHMENTS")
        {
            return `Please attach no more than ${responseJson?.maximumCount ?? ReportIssueDialog.MAXIMUM_ATTACHMENT_COUNT} files.`;
        }

        if (errorCode === "SUPPORT_ATTACHMENT_TOO_LARGE")
        {
            return `"${responseJson?.reason ?? "That file"}" is too large. Each attachment must be under ${ReportIssueDialog.#formatBytes(ReportIssueDialog.MAXIMUM_FILE_BYTES)}.`;
        }

        if (errorCode === "SUPPORT_INVALID_ATTACHMENT")
        {
            return `"${responseJson?.reason ?? "That file"}" isn't a supported type. Attach images or PDFs.`;
        }

        if (responseJson?.reason === "descriptionTooShort")
        {
            return `Please describe the issue in at least ${responseJson?.minimumLength ?? ReportIssueDialog.MINIMUM_DESCRIPTION_LENGTH} characters.`;
        }

        if (responseJson?.reason === "descriptionTooLong")
        {
            return `Please shorten the description to ${responseJson?.maximumLength ?? ReportIssueDialog.MAXIMUM_DESCRIPTION_LENGTH} characters or fewer.`;
        }

        if (statusCode === 401)
        {
            return "Please sign in again to send a report.";
        }

        return "Something went wrong sending your report. Please try again.";
    }

    /**
     * @returns {void}
     */
    static #showSignInPrompt()
    {
        DialogBox.alert("Sign in to report an issue", "Reporting an issue needs an account so we can follow up with you and let you know when it's fixed.");
    }

    /**
     * @param {number} byteCount
     * @returns {string}
     */
    static #formatBytes(byteCount)
    {
        const megabytes = byteCount / (1024 * 1024);
        return megabytes >= 1 ? `${Math.round(megabytes)} MB` : `${Math.max(1, Math.round(byteCount / 1024))} KB`;
    }

    /**
     * @param {*} rawValue
     * @returns {string}
     */
    static #escapeHtml(rawValue)
    {
        return String(rawValue ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }
}

export default ReportIssueDialog;
