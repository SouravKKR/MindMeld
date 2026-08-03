import DialogBox from "../../../CommonComponents/DialogBox.js";
import { supportTicketStatus } from "../../../Globals/Enumerations/SupportTicketStatus.js";
import { supportTicketTypes } from "../../../Globals/Enumerations/SupportTicketTypes.js";
import { enumerationToTitleCase } from "../../../Globals/UtilityFunctions/EnumerationToTitleCase.js";

/**
 * SupportTicketDetailsDialog
 *
 * Everything behind one row of the admin Support list: the deduplicated ticket,
 * the detail each merged report contributed, every individual report with its
 * attachments and log export, and the resolve / decline actions.
 *
 * The reporter count is the centrepiece rather than a detail — it is what turns
 * "someone complained" into "this is hurting N people", and it is the number the
 * credit incentive is sized against. The dialog shows the total alongside how many
 * of those people actually asked to be notified, because those are different
 * populations: everyone gets credits, only the opt-ins get written to.
 *
 * Resolves true when the ticket was closed, so the list refreshes.
 */
class SupportTicketDetailsDialog
{
    static MAXIMUM_RESOLUTION_MESSAGE_LENGTH = 4000;
    static MAXIMUM_CREDITS_PER_REPORTER = 1000;

    /**
     * @param {{ticketId: string}} options
     * @returns {Promise<boolean>}
     */
    static async show({ ticketId })
    {
        let ticketPayload = null;

        try
        {
            const response = await fetch(`/Admin/Support/Ticket?ticketId=${encodeURIComponent(ticketId)}`);
            ticketPayload = await response.json();

            if (!response.ok || ticketPayload?.success === false)
            {
                await DialogBox.alert("Couldn't open the ticket", ticketPayload?.error || `HTTP ${response.status}`);
                return false;
            }
        }
        catch (loadError)
        {
            await DialogBox.alert("Couldn't open the ticket", "The server could not be reached.");
            return false;
        }

        return new Promise((resolve) =>
        {
            const ticket = ticketPayload.ticket;
            const reports = Array.isArray(ticketPayload.reports) ? ticketPayload.reports : [];
            const reporterCount = Number(ticketPayload.reporterCount) || 0;
            const notifyOptInCount = Number(ticketPayload.notifyOptInCount) || 0;
            const bActive = ticket.status === supportTicketStatus.ACTIVE;

            let bChanged = false;

            const dialog = DialogBox.modal(SupportTicketDetailsDialog.#buildMarkup(ticket, reports, reporterCount, notifyOptInCount, bActive));

            const errorElement = dialog.querySelector('[data-role="error"]');

            function showError(message)
            {
                errorElement.textContent = message;
                errorElement.hidden = String(message ?? "").length === 0;
            }

            if (bActive)
            {
                SupportTicketDetailsDialog.#bindActions(dialog, ticket, reporterCount, showError, () =>
                {
                    bChanged = true;
                    dialog.close();
                });
            }

            const removalObserver = new MutationObserver(() =>
            {
                if (!document.body.contains(dialog))
                {
                    removalObserver.disconnect();
                    resolve(bChanged);
                }
            });
            removalObserver.observe(document.body, { childList: true });
        });
    }

    /**
     * @returns {string}
     */
    static #buildMarkup(ticket, reports, reporterCount, notifyOptInCount, bActive)
    {
        const escape = SupportTicketDetailsDialog.#escapeHtml;
        const statusLabel = SupportTicketDetailsDialog.#statusLabel(ticket.status);

        const saturationWarning = ticket.bAspectSaturated
            ? `<div class="support-ticket-warning">
                    This ticket has absorbed the maximum number of distinct details. That usually means the grouping has
                    become too broad — consider resolving it and letting the next reports open a sharper ticket.
               </div>`
            : "";

        const aspectsMarkup = Array.isArray(ticket.aspects) && ticket.aspects.length > 0
            ? `<div class="support-ticket-section">
                    <h3>Details added by later reports</h3>
                    <ul class="support-ticket-aspects">
                        ${ticket.aspects.map(aspect => `<li>${escape(aspect.text)}</li>`).join("")}
                    </ul>
               </div>`
            : "";

        const closedMarkup = !bActive
            ? `<div class="support-ticket-section">
                    <h3>${ticket.status === supportTicketStatus.RESOLVED ? "Resolution" : "Decline note"}</h3>
                    <blockquote class="support-ticket-message">${escape(ticket.status === supportTicketStatus.RESOLVED ? ticket.resolutionMessage : (ticket.declineMessage || "(no message — reporters received the generic note)"))}</blockquote>
                    ${ticket.creditsPerReporter > 0 ? `<p class="support-ticket-note">${ticket.creditsPerReporter} credits granted to each reporter.</p>` : ""}
                    ${SupportTicketDetailsDialog.#renderDispatchState(ticket)}
               </div>`
            : "";

        const actionsMarkup = bActive
            ? `<div class="support-ticket-section">
                    <h3>Resolve this ticket</h3>
                    <label class="support-ticket-field">
                        <span>What was fixed? (sent to the ${notifyOptInCount} reporter${notifyOptInCount === 1 ? "" : "s"} who asked to hear back)</span>
                        <textarea data-role="resolution-message" rows="5" maxlength="${SupportTicketDetailsDialog.MAXIMUM_RESOLUTION_MESSAGE_LENGTH}"
                            placeholder="Thanks for reporting this — the issue where … has been fixed and is live now."></textarea>
                    </label>
                    <label class="support-ticket-field support-ticket-credit-field">
                        <span>Credits per reporter</span>
                        <input type="number" data-role="credits" value="0" min="0" max="${SupportTicketDetailsDialog.MAXIMUM_CREDITS_PER_REPORTER}" step="1">
                        <span class="support-ticket-credit-total" data-role="credit-total">${reporterCount} reporters × 0 credits = 0 total</span>
                    </label>
                    <div class="support-ticket-actions">
                        <button type="button" class="ok-button support-ticket-resolve" data-role="resolve">Resolve &amp; notify</button>
                    </div>

                    <h3>Or decline it</h3>
                    <label class="support-ticket-field">
                        <span>Why not? <em>(optional — leave blank to send the generic note)</em></span>
                        <textarea data-role="decline-message" rows="3" maxlength="${SupportTicketDetailsDialog.MAXIMUM_RESOLUTION_MESSAGE_LENGTH}"
                            placeholder="Working as intended — the behaviour described is …"></textarea>
                    </label>
                    <div class="support-ticket-actions">
                        <button type="button" class="cancel-button support-ticket-decline" data-role="decline">Decline ticket</button>
                    </div>
               </div>`
            : "";

        return `
            <div class="support-ticket-dialog">
                <header class="support-ticket-header">
                    <h2 class="support-ticket-title">${escape(ticket.title || "(untitled)")}</h2>
                    <span class="support-ticket-status support-ticket-status-${statusLabel.variant}">${escape(statusLabel.label)}</span>
                </header>

                <div class="support-ticket-counts">
                    <div class="support-ticket-count">
                        <strong>${reporterCount}</strong>
                        <span>reporter${reporterCount === 1 ? "" : "s"}</span>
                    </div>
                    <div class="support-ticket-count">
                        <strong>${notifyOptInCount}</strong>
                        <span>asked to be notified</span>
                    </div>
                    <div class="support-ticket-count">
                        <strong>${escape(enumerationToTitleCase(SupportTicketDetailsDialog.#issueTypeName(ticket.issueType)))}</strong>
                        <span>issue type</span>
                    </div>
                </div>

                ${saturationWarning}

                <div class="support-ticket-section">
                    <h3>Summary</h3>
                    <p class="support-ticket-description">${escape(ticket.description)}</p>
                </div>

                ${aspectsMarkup}

                <div class="support-ticket-section">
                    <h3>Reports (${reports.length})</h3>
                    <div class="support-ticket-report-tools">
                        <a class="support-ticket-link" href="/Admin/Support/Report/Logs?ticketId=${encodeURIComponent(ticket.id)}&format=log" download>Download logs for every reporter (.zip)</a>
                    </div>
                    <div class="support-ticket-reports">
                        ${reports.map(report => SupportTicketDetailsDialog.#renderReport(report)).join("")}
                    </div>
                </div>

                ${closedMarkup}
                ${actionsMarkup}

                <div class="support-ticket-error" data-role="error" hidden></div>
            </div>
        `;
    }

    /**
     * @param {object} report
     * @returns {string}
     */
    static #renderReport(report)
    {
        const escape = SupportTicketDetailsDialog.#escapeHtml;
        const submittedAt = new Date(report.createdAt).toLocaleString();

        const attachmentsMarkup = Array.isArray(report.attachments) && report.attachments.length > 0
            ? `<div class="support-ticket-report-attachments">
                    ${report.attachments.map(attachment =>
                        `<a class="support-ticket-link" target="_blank" rel="noopener"
                            href="/Admin/Support/Report/Attachment?reportId=${encodeURIComponent(report.id)}&fileName=${encodeURIComponent(attachment.fileName)}">
                            ${escape(attachment.fileName)}
                        </a>`).join("")}
               </div>`
            : "";

        return `
            <article class="support-ticket-report">
                <header class="support-ticket-report-header">
                    <span class="support-ticket-report-email">${escape(report.userEmail || report.userId)}</span>
                    <span class="support-ticket-report-date">${escape(submittedAt)}</span>
                </header>
                <p class="support-ticket-report-description">${escape(report.description)}</p>
                ${attachmentsMarkup}
                <footer class="support-ticket-report-footer">
                    ${report.bNotifyOnResolution ? `<span class="support-ticket-badge">wants notifying</span>` : ""}
                    <!-- The 24 hours ENDING at the report's timestamp: the evidence for
                         something already broken is behind the report, not ahead of it. -->
                    <a class="support-ticket-link" download
                       href="/Admin/Support/Report/Logs?reportId=${encodeURIComponent(report.id)}&format=log">Logs (24h before report)</a>
                    <a class="support-ticket-link" download
                       href="/Admin/Support/Report/Logs?reportId=${encodeURIComponent(report.id)}&format=html">Logs (.html)</a>
                </footer>
            </article>
        `;
    }

    /**
     * @param {object} ticket
     * @returns {string}
     */
    static #renderDispatchState(ticket)
    {
        const dispatchState = ticket.dispatchState;

        if (!dispatchState)
        {
            return "";
        }

        // Counts REPORTS, not reporters — the two differ when someone reported the
        // same problem twice, and the progress counter tracks rows.
        if (dispatchState.completedAt)
        {
            return `<p class="support-ticket-note">Processed all ${dispatchState.totalCount} report${dispatchState.totalCount === 1 ? "" : "s"}.</p>`;
        }

        // Surfaced rather than hidden: an in-flight or stalled fan-out is
        // information the admin needs, and the reconciler sweep will finish it.
        return `<p class="support-ticket-note support-ticket-note-pending">Notifying reporters… ${dispatchState.processedCount} of ${dispatchState.totalCount} reports done.</p>`;
    }

    /**
     * @returns {void}
     */
    static #bindActions(dialog, ticket, reporterCount, showError, onClosed)
    {
        const creditsInput = dialog.querySelector('[data-role="credits"]');
        const creditTotalElement = dialog.querySelector('[data-role="credit-total"]');
        const resolveButton = dialog.querySelector('[data-role="resolve"]');
        const declineButton = dialog.querySelector('[data-role="decline"]');

        // The running total is the point of this field: "5 credits" reads very
        // differently at 3 reporters than at 300, and the admin should see the
        // real cost before committing.
        creditsInput.addEventListener("input", () =>
        {
            const creditsPerReporter = Number(creditsInput.value) || 0;
            const total = Number((creditsPerReporter * reporterCount).toFixed(4));
            creditTotalElement.textContent = `${reporterCount} reporters × ${creditsPerReporter} credits = ${total} total`;
        });

        resolveButton.addEventListener("click", async () =>
        {
            const resolutionMessage = dialog.querySelector('[data-role="resolution-message"]').value.trim();
            const creditsPerReporter = Number(creditsInput.value) || 0;

            if (resolutionMessage.length === 0)
            {
                showError("Write what was fixed — it goes out to everyone who asked to be notified.");
                return;
            }

            const bConfirmed = await DialogBox.confirm
            (
                "Resolve this ticket?",
                `${reporterCount} reporter${reporterCount === 1 ? "" : "s"} will be credited ${creditsPerReporter} credits each `
                + `(${Number((creditsPerReporter * reporterCount).toFixed(4))} total), and the ones who opted in will be emailed. This cannot be undone.`
            );

            if (!bConfirmed)
            {
                return;
            }

            resolveButton.disabled = true;
            declineButton.disabled = true;

            const bSucceeded = await SupportTicketDetailsDialog.#postAction("/Admin/Support/Ticket/Resolve",
            {
                ticketId: ticket.id,
                resolutionMessage: resolutionMessage,
                creditsPerReporter: creditsPerReporter
            }, showError);

            if (bSucceeded)
            {
                onClosed();
                return;
            }

            resolveButton.disabled = false;
            declineButton.disabled = false;
        });

        declineButton.addEventListener("click", async () =>
        {
            const declineMessage = dialog.querySelector('[data-role="decline-message"]').value.trim();

            const bConfirmed = await DialogBox.confirm
            (
                "Decline this ticket?",
                declineMessage.length > 0
                    ? "Reporters who opted in will receive your note. No credits are granted."
                    : "Reporters who opted in will receive the generic decline note. No credits are granted."
            );

            if (!bConfirmed)
            {
                return;
            }

            resolveButton.disabled = true;
            declineButton.disabled = true;

            const bSucceeded = await SupportTicketDetailsDialog.#postAction("/Admin/Support/Ticket/Decline",
            {
                ticketId: ticket.id,
                declineMessage: declineMessage
            }, showError);

            if (bSucceeded)
            {
                onClosed();
                return;
            }

            resolveButton.disabled = false;
            declineButton.disabled = false;
        });
    }

    /**
     * @returns {Promise<boolean>}
     */
    static async #postAction(routePath, body, showError)
    {
        try
        {
            const response = await fetch(routePath,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body)
            });

            const responseJson = await response.json().catch(() => ({}));

            if (!response.ok || responseJson.success === false)
            {
                // A 409 means someone else closed this ticket first — the atomic
                // claim on the server is what prevented a second round of credits.
                showError(responseJson.error === "SUPPORT_TICKET_NOT_ACTIVE"
                    ? "This ticket was already closed by someone else. Reopen the list to see its current state."
                    : (responseJson.error || `HTTP ${response.status}`));
                return false;
            }

            return true;
        }
        catch (postError)
        {
            showError("The server could not be reached.");
            return false;
        }
    }

    /**
     * @param {number} status
     * @returns {{label: string, variant: string}}
     */
    static #statusLabel(status)
    {
        if (status === supportTicketStatus.RESOLVED)
        {
            return { label: "Resolved", variant: "resolved" };
        }

        if (status === supportTicketStatus.DECLINED)
        {
            return { label: "Declined", variant: "declined" };
        }

        return { label: "Active", variant: "active" };
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

export default SupportTicketDetailsDialog;
