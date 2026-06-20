import DialogBox from "../../../CommonComponents/DialogBox.js";
import EmailSheetParser from "../../../Globals/Classes/EmailSheetParser.js";
import PeriodicAssignmentReportPdfRenderer from "../../../Globals/Classes/PeriodicAssignmentReportPdfRenderer.js";
import "./DealPaymentEditor.js";
import { periodicScopeTypes } from "../../../Globals/Enumerations/PeriodicScopeTypes.js";
import { periodicScheduleTypes } from "../../../Globals/Enumerations/PeriodicScheduleTypes.js";
import { periodicOnJoinModes } from "../../../Globals/Enumerations/PeriodicOnJoinModes.js";
import { periodicAssignmentStatuses } from "../../../Globals/Enumerations/PeriodicAssignmentStatuses.js";
import { creditGrantAmountModes } from "../../../Globals/Enumerations/CreditGrantAmountModes.js";
import { creditDealTargetTypes } from "../../../Globals/Enumerations/CreditDealTargetTypes.js";

/**
 * PeriodicAssignmentsPanel  (<periodic-assignments-panel>)
 *
 * Admin surface for recurring credit assignments. The creation form supports
 * ORGANIZATION (dynamic membership) and PEOPLE_SET (fixed email list, importable
 * from paste / .csv / .xlsx) scopes, the three schedule types, the org-only
 * on-join modes (including skip-first), an optional end date, and an optional
 * payment + invoice record (via <deal-payment-editor>). The management list
 * shows every assignment with Terminate and Print-report actions.
 *
 * Assignments are ACTIVE immediately — there is no scheduler; the server's lazy
 * reconciler materialises installments when each recipient next acts.
 */
class PeriodicAssignmentsPanel extends HTMLElement
{
    static #WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

    #organizations = null;

    connectedCallback()
    {
        this.#render();
        this.#bindEvents();
        this.#reloadList();
    }

    #render()
    {
        this.innerHTML = `
            <style>
                periodic-assignments-panel { display: block; padding: 2px 0 16px; color: var(--primary-text-color); }

                .periodic-section { margin-bottom: 28px; }
                .periodic-section-title
                {
                    font-size: 12px;
                    font-weight: 700;
                    text-transform: uppercase;
                    letter-spacing: 0.07em;
                    color: var(--secondary-text-color);
                    margin: 0 0 14px;
                    padding-bottom: 8px;
                    border-bottom: 1px solid var(--outline-color-subtle);
                }
                .periodic-card
                {
                    background-color: var(--secondary-background-color);
                    border: 1px solid var(--outline-color-subtle);
                    border-radius: 10px;
                    padding: 16px 18px;
                    margin-bottom: 12px;
                }
                .periodic-grid
                {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                    gap: 14px 18px;
                }
                .periodic-field
                {
                    display: flex;
                    flex-direction: column;
                    gap: 6px;
                    min-width: 0;
                    font-size: 11px;
                    text-transform: uppercase;
                    letter-spacing: 0.04em;
                    color: var(--secondary-text-color);
                }
                .periodic-input, .periodic-select, .periodic-textarea
                {
                    width: 100%;
                    box-sizing: border-box;
                    padding: 8px 10px;
                    border-radius: 6px;
                    border: none;
                    outline: 1px solid var(--outline-color);
                    outline-offset: -1px;
                    background-color: var(--tertiary-background-color);
                    color: var(--primary-text-color);
                    font-family: inherit;
                    font-size: 13px;
                    text-transform: none;
                    letter-spacing: normal;
                }
                .periodic-textarea { min-height: 76px; resize: vertical; }
                .periodic-subsection { margin-top: 16px; }
                .periodic-subsection[hidden] { display: none; }
                .periodic-field[hidden] { display: none; }
                .periodic-inline { display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: center; }
                .periodic-checkbox-row { display: flex; align-items: center; gap: 8px; font-size: 13px; text-transform: none; letter-spacing: normal; color: var(--primary-text-color); }
                .periodic-hint { font-size: 12px; color: var(--secondary-text-color); text-transform: none; letter-spacing: normal; margin-top: 6px; }

                .periodic-button
                {
                    padding: 9px 16px;
                    border-radius: 8px;
                    border: none;
                    cursor: pointer;
                    background: var(--primary-background-gradient);
                    color: var(--primary-text-color);
                    font-weight: 600;
                    font-size: 13px;
                }
                .periodic-button:disabled { opacity: 0.4; cursor: not-allowed; }
                .periodic-button-secondary
                {
                    background: transparent;
                    outline: 1px dashed var(--outline-color-strong);
                    outline-offset: -1px;
                    font-weight: 500;
                    color: var(--primary-text-color);
                }
                .periodic-button-danger { background: var(--danger-background-color); color: var(--danger-text-color); }

                .periodic-actionbar { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; margin-top: 16px; }
                .periodic-status { font-size: 13px; color: var(--secondary-text-color); }
                .periodic-status-error { color: var(--danger-text-color); }

                .periodic-table-wrap { overflow-x: auto; border-radius: 8px; outline: 1px solid var(--outline-color-subtle); outline-offset: -1px; }
                .periodic-table { width: 100%; border-collapse: collapse; font-size: 13px; min-width: 720px; }
                .periodic-table th
                {
                    text-align: left;
                    padding: 9px 12px;
                    font-size: 11px;
                    text-transform: uppercase;
                    letter-spacing: 0.04em;
                    color: var(--secondary-text-color);
                    background-color: var(--tertiary-background-color);
                    white-space: nowrap;
                }
                .periodic-table td { padding: 8px 12px; border-top: 1px solid var(--outline-color-subtle); color: var(--primary-text-color); vertical-align: top; }
                .periodic-row-actions { display: flex; flex-wrap: wrap; gap: 8px; }
                .periodic-pill { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 11px; font-weight: 600; }
                .periodic-pill-active { background: var(--success-background-color, rgba(40,160,90,0.18)); color: var(--success-text-color, #2faa63); }
                .periodic-pill-terminated { background: var(--danger-background-color); color: var(--danger-text-color); }

                @media (max-width: 540px)
                {
                    .periodic-card { padding: 14px; }
                    .periodic-grid { grid-template-columns: 1fr; }
                    .periodic-actionbar { gap: 10px; }
                }
            </style>

            <div class="periodic-section">
                <div class="periodic-section-title">New periodic assignment</div>
                <div class="periodic-card" data-role="form">
                    <div class="periodic-grid">
                        <label class="periodic-field">Name (for tracking)
                            <input class="periodic-input" type="text" maxlength="256" data-field="name" placeholder="e.g. Acme monthly credits">
                        </label>
                        <label class="periodic-field">Scope
                            <select class="periodic-select" data-field="scopeType">
                                <option value="${periodicScopeTypes.ORGANIZATION}" selected>Organization members</option>
                                <option value="${periodicScopeTypes.PEOPLE_SET}">Fixed list of people</option>
                            </select>
                        </label>
                        <label class="periodic-field">Amount (credits)
                            <input class="periodic-input" type="number" step="any" min="0" data-field="amount" placeholder="e.g. 100">
                        </label>
                        <label class="periodic-field" data-role="amount-mode-field">Amount mode
                            <select class="periodic-select" data-field="amountMode">
                                <option value="${creditGrantAmountModes.PER_USER}" selected>Per user — each recipient gets this</option>
                                <option value="${creditGrantAmountModes.TOTAL_SPLIT}">Total — split equally across the list</option>
                            </select>
                        </label>
                    </div>

                    <div class="periodic-subsection" data-role="organization-section">
                        <label class="periodic-field">Organization
                            <select class="periodic-select" data-field="organizationId"><option value="">Loading organizations…</option></select>
                        </label>
                        <div class="periodic-grid" style="margin-top:14px;">
                            <label class="periodic-field">On new join
                                <select class="periodic-select" data-field="onJoinMode">
                                    <option value="${periodicOnJoinModes.PERIODIC_ONLY}" selected>Periodic only</option>
                                    <option value="${periodicOnJoinModes.ON_JOIN_PLUS_PERIODIC}">On join + periodic</option>
                                    <option value="${periodicOnJoinModes.ON_JOIN_PLUS_PERIODIC_SKIP_FIRST}">On join + periodic (skip first installment)</option>
                                </select>
                            </label>
                        </div>
                        <div class="periodic-hint">Leaving the org stops the cycle; rejoining never re-grants the on-join bonus. "Skip first installment" avoids double-crediting at join time.</div>
                    </div>

                    <div class="periodic-subsection" data-role="people-section" hidden>
                        <label class="periodic-field">Recipients — one email per line
                            <textarea class="periodic-textarea" data-field="peopleEmails" placeholder="alice@example.com&#10;bob@example.com"></textarea>
                        </label>
                        <div class="periodic-inline" style="margin-top:10px;">
                            <input type="file" class="periodic-input" style="max-width:280px;" data-field="peopleFile" accept=".csv,.xlsx,.xls">
                            <span class="periodic-hint" data-role="people-count">0 valid emails</span>
                        </div>
                        <div class="periodic-hint">Upload a .csv or .xlsx (any column layout) to append emails, or paste above.</div>
                    </div>

                    <div class="periodic-subsection">
                        <div class="periodic-grid">
                            <label class="periodic-field">Schedule
                                <select class="periodic-select" data-field="scheduleType">
                                    <option value="${periodicScheduleTypes.INTERVAL_DAYS}" selected>Every N days</option>
                                    <option value="${periodicScheduleTypes.DAY_OF_WEEK}">A day of the week</option>
                                    <option value="${periodicScheduleTypes.DAY_OF_MONTH}">A day of the month</option>
                                </select>
                            </label>
                            <label class="periodic-field" data-role="interval-field">Every N days
                                <input class="periodic-input" type="number" min="1" step="1" data-field="intervalDays" value="30">
                            </label>
                            <label class="periodic-field" data-role="weekday-field" hidden>Day of week
                                <select class="periodic-select" data-field="dayOfWeek">
                                    ${PeriodicAssignmentsPanel.#WEEKDAY_NAMES.map((dayName, dayIndex) => `<option value="${dayIndex}"${dayIndex === 1 ? " selected" : ""}>${dayName}</option>`).join("")}
                                </select>
                            </label>
                            <label class="periodic-field" data-role="monthday-field" hidden>Day of month
                                <input class="periodic-input" type="number" min="1" max="31" step="1" data-field="dayOfMonth" value="1">
                            </label>
                        </div>
                    </div>

                    <div class="periodic-subsection">
                        <div class="periodic-checkbox-row">
                            <input type="checkbox" data-field="hasValidUntil" id="periodic-has-valid-until">
                            <label for="periodic-has-valid-until">Set an end date (otherwise it runs until terminated)</label>
                        </div>
                        <label class="periodic-field" data-role="valid-until-field" hidden style="margin-top:10px;max-width:280px;">Valid until
                            <input class="periodic-input" type="date" data-field="validUntil">
                        </label>
                    </div>

                    <div class="periodic-subsection">
                        <div class="periodic-section-title" style="border:none;margin-bottom:8px;">Payment / invoice (optional)</div>
                        <deal-payment-editor data-role="deal-editor"></deal-payment-editor>
                    </div>

                    <div class="periodic-actionbar">
                        <button class="periodic-button" data-action="create">Create assignment</button>
                        <span class="periodic-status" data-role="status"></span>
                    </div>
                </div>
            </div>

            <div class="periodic-section">
                <div class="periodic-section-title">Existing assignments</div>
                <div class="periodic-table-wrap">
                    <table class="periodic-table">
                        <thead>
                            <tr><th>Name</th><th>Scope</th><th>Period</th><th>Amount</th><th>Status</th><th>Created</th><th>Actions</th></tr>
                        </thead>
                        <tbody data-role="list-body">
                            <tr><td colspan="7">Loading…</td></tr>
                        </tbody>
                    </table>
                </div>
            </div>
        `;
    }

    #bindEvents()
    {
        this.querySelector('[data-field="scopeType"]').addEventListener("change", () => this.#applyScope());
        this.querySelector('[data-field="scheduleType"]').addEventListener("change", () => this.#applySchedule());
        this.querySelector('[data-field="hasValidUntil"]').addEventListener("change", (changeEvent) =>
        {
            this.querySelector('[data-role="valid-until-field"]').hidden = !changeEvent.currentTarget.checked;
        });

        const peopleTextarea = this.querySelector('[data-field="peopleEmails"]');
        peopleTextarea.addEventListener("input", () => this.#updatePeopleCount());

        const peopleFileInput = this.querySelector('[data-field="peopleFile"]');
        peopleFileInput.addEventListener("change", async () =>
        {
            const file = peopleFileInput.files && peopleFileInput.files[0];
            if (!file)
            {
                return;
            }
            try
            {
                const parsed = await EmailSheetParser.parseFile(file);
                const existing = EmailSheetParser.parseText(peopleTextarea.value);
                const merged = [...new Set([...existing, ...parsed])];
                peopleTextarea.value = merged.join("\n");
                this.#updatePeopleCount();
            }
            catch (parseError)
            {
                this.#setStatus(`Could not read the file: ${parseError.message || parseError}`, true);
            }
            peopleFileInput.value = "";
        });

        this.querySelector('[data-action="create"]').addEventListener("click", () => this.#create());

        this.#applyScope();
        this.#applySchedule();
    }

    #applyScope()
    {
        const scopeType = Number(this.querySelector('[data-field="scopeType"]').value);
        const isOrganization = scopeType === periodicScopeTypes.ORGANIZATION;
        this.querySelector('[data-role="organization-section"]').hidden = !isOrganization;
        this.querySelector('[data-role="people-section"]').hidden = isOrganization;

        // TOTAL_SPLIT is undefined against a dynamic org roster — force + lock
        // PER_USER for org scope.
        const amountModeField = this.querySelector('[data-role="amount-mode-field"]');
        const amountModeSelect = this.querySelector('[data-field="amountMode"]');
        if (isOrganization)
        {
            amountModeSelect.value = String(creditGrantAmountModes.PER_USER);
            amountModeField.hidden = true;
            this.#ensureOrganizationsLoaded();
        }
        else
        {
            amountModeField.hidden = false;
        }
    }

    #applySchedule()
    {
        const scheduleType = Number(this.querySelector('[data-field="scheduleType"]').value);
        this.querySelector('[data-role="interval-field"]').hidden = scheduleType !== periodicScheduleTypes.INTERVAL_DAYS;
        this.querySelector('[data-role="weekday-field"]').hidden = scheduleType !== periodicScheduleTypes.DAY_OF_WEEK;
        this.querySelector('[data-role="monthday-field"]').hidden = scheduleType !== periodicScheduleTypes.DAY_OF_MONTH;
    }

    #updatePeopleCount()
    {
        const emails = EmailSheetParser.parseText(this.querySelector('[data-field="peopleEmails"]').value);
        this.querySelector('[data-role="people-count"]').textContent = `${emails.length} valid email${emails.length === 1 ? "" : "s"}`;
        return emails;
    }

    async #ensureOrganizationsLoaded()
    {
        if (this.#organizations !== null)
        {
            return;
        }
        const organizationSelect = this.querySelector('[data-field="organizationId"]');
        try
        {
            const response = await fetch("/Admin/Organizations/List");
            if (!response.ok)
            {
                organizationSelect.innerHTML = `<option value="">Failed to load (HTTP ${response.status})</option>`;
                return;
            }
            const responseJson = await response.json();
            this.#organizations = responseJson.organizations || [];
        }
        catch (loadError)
        {
            organizationSelect.innerHTML = `<option value="">${PeriodicAssignmentsPanel.#escape(loadError.message)}</option>`;
            return;
        }

        organizationSelect.innerHTML = this.#organizations.length === 0
            ? `<option value="">No organizations</option>`
            : `<option value="">Select an organization…</option>` + this.#organizations
                .map(organization => `<option value="${PeriodicAssignmentsPanel.#escape(organization.id)}">${PeriodicAssignmentsPanel.#escape(organization.name)} (${organization.currentMemberCount ?? 0} members)</option>`)
                .join("");
    }

    #buildPayload()
    {
        const name = this.querySelector('[data-field="name"]').value.trim();
        if (name.length === 0)
        {
            return { error: "Enter a name for the assignment." };
        }

        const scopeType = Number(this.querySelector('[data-field="scopeType"]').value);
        const amount = parseFloat(this.querySelector('[data-field="amount"]').value);
        if (!(amount > 0))
        {
            return { error: "Enter a positive credit amount." };
        }

        const scheduleType = Number(this.querySelector('[data-field="scheduleType"]').value);
        const payload =
        {
            name: name,
            scopeType: scopeType,
            amount: amount,
            amountMode: Number(this.querySelector('[data-field="amountMode"]').value),
            scheduleType: scheduleType,
            intervalDays: parseInt(this.querySelector('[data-field="intervalDays"]').value, 10),
            dayOfWeek: parseInt(this.querySelector('[data-field="dayOfWeek"]').value, 10),
            dayOfMonth: parseInt(this.querySelector('[data-field="dayOfMonth"]').value, 10)
        };

        if (scopeType === periodicScopeTypes.ORGANIZATION)
        {
            const organizationId = this.querySelector('[data-field="organizationId"]').value;
            if (!organizationId)
            {
                return { error: "Select an organization." };
            }
            payload.organizationId = organizationId;
            payload.onJoinMode = Number(this.querySelector('[data-field="onJoinMode"]').value);
        }
        else
        {
            const emails = this.#updatePeopleCount();
            if (emails.length === 0)
            {
                return { error: "Add at least one valid recipient email." };
            }
            payload.peopleEmails = emails;
        }

        const hasValidUntil = this.querySelector('[data-field="hasValidUntil"]').checked;
        payload.hasValidUntil = hasValidUntil;
        if (hasValidUntil)
        {
            const validUntilRaw = this.querySelector('[data-field="validUntil"]').value;
            if (!validUntilRaw)
            {
                return { error: "Pick an end date or uncheck 'Set an end date'." };
            }
            // End of the chosen day so the final day is fully included.
            payload.validUntil = new Date(`${validUntilRaw}T23:59:59`).toISOString();
        }

        return { payload: payload };
    }

    async #create()
    {
        const built = this.#buildPayload();
        if (built.error)
        {
            this.#setStatus(built.error, true);
            return;
        }

        const createButton = this.querySelector('[data-action="create"]');
        createButton.disabled = true;
        this.#setStatus("Creating…", false);

        let createJson;
        try
        {
            const response = await fetch("/Admin/Credits/Periodic/Create", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(built.payload)
            });
            createJson = await response.json().catch(() => ({}));
            if (!response.ok)
            {
                createButton.disabled = false;
                this.#setStatus(createJson.error || `Create failed (HTTP ${response.status}).`, true);
                return;
            }
        }
        catch (createError)
        {
            createButton.disabled = false;
            this.#setStatus(createError.message, true);
            return;
        }

        // Attach the optional payment / invoice to the new assignment.
        let dealNote = "";
        try
        {
            const dealEditor = this.querySelector('[data-role="deal-editor"]');
            const dealResult = await dealEditor.submitForTarget(creditDealTargetTypes.PERIODIC_ASSIGNMENT, createJson.assignment.id);
            if (dealResult.error)
            {
                dealNote = ` (payment note: ${dealResult.error})`;
            }
            else if (dealResult.recorded)
            {
                dealNote = dealResult.captured ? " Payment captured." : (dealResult.invoiceUploaded ? " Invoice attached." : " Payment recorded.");
            }
        }
        catch (dealError)
        {
            dealNote = ` (payment note: ${dealError.message})`;
        }

        createButton.disabled = false;
        this.#setStatus(`Created "${createJson.assignment.name}" — seeded ${createJson.seededRecipients} current recipient(s).${dealNote}`, false);
        this.#resetForm();
        this.#reloadList();
    }

    #resetForm()
    {
        this.querySelector('[data-field="name"]').value = "";
        this.querySelector('[data-field="amount"]').value = "";
        this.querySelector('[data-field="peopleEmails"]').value = "";
        this.querySelector('[data-field="hasValidUntil"]').checked = false;
        this.querySelector('[data-role="valid-until-field"]').hidden = true;
        this.#updatePeopleCount();
        const dealEditor = this.querySelector('[data-role="deal-editor"]');
        if (dealEditor && typeof dealEditor.reset === "function")
        {
            dealEditor.reset();
        }
    }

    async #reloadList()
    {
        const listBody = this.querySelector('[data-role="list-body"]');
        let assignments = [];
        try
        {
            const response = await fetch("/Admin/Credits/Periodic/List");
            const responseJson = await response.json().catch(() => ({}));
            if (!response.ok)
            {
                listBody.innerHTML = `<tr><td colspan="7">Failed to load (HTTP ${response.status}).</td></tr>`;
                return;
            }
            assignments = responseJson.assignments || [];
        }
        catch (loadError)
        {
            listBody.innerHTML = `<tr><td colspan="7">${PeriodicAssignmentsPanel.#escape(loadError.message)}</td></tr>`;
            return;
        }

        if (assignments.length === 0)
        {
            listBody.innerHTML = `<tr><td colspan="7">No assignments yet.</td></tr>`;
            return;
        }

        listBody.innerHTML = assignments.map(assignment => this.#renderRow(assignment)).join("");

        for (const terminateButton of this.querySelectorAll('[data-action="terminate"]'))
        {
            terminateButton.addEventListener("click", () => this.#terminate(terminateButton.dataset.id, terminateButton.dataset.name));
        }
        for (const printButton of this.querySelectorAll('[data-action="print"]'))
        {
            printButton.addEventListener("click", () => this.#print(printButton.dataset.id));
        }
    }

    #renderRow(assignment)
    {
        const isActive = assignment.status === periodicAssignmentStatuses.ACTIVE;
        const scopeLabel = assignment.scopeType === periodicScopeTypes.ORGANIZATION
            ? "Organization"
            : `People (${(assignment.peopleEmails || []).length})`;
        const createdLabel = assignment.createdAt ? new Date(assignment.createdAt).toLocaleDateString() : "—";

        return `
            <tr>
                <td>${PeriodicAssignmentsPanel.#escape(assignment.name)}</td>
                <td>${scopeLabel}</td>
                <td>${PeriodicAssignmentsPanel.#escape(PeriodicAssignmentsPanel.#periodLabel(assignment))}</td>
                <td>${PeriodicAssignmentsPanel.#formatCredits(assignment.amount)}</td>
                <td><span class="periodic-pill ${isActive ? "periodic-pill-active" : "periodic-pill-terminated"}">${isActive ? "Active" : "Terminated"}</span></td>
                <td>${createdLabel}</td>
                <td>
                    <div class="periodic-row-actions">
                        <button class="periodic-button periodic-button-secondary" data-action="print" data-id="${PeriodicAssignmentsPanel.#escape(assignment.id)}">Print</button>
                        ${isActive ? `<button class="periodic-button periodic-button-danger" data-action="terminate" data-id="${PeriodicAssignmentsPanel.#escape(assignment.id)}" data-name="${PeriodicAssignmentsPanel.#escape(assignment.name)}">Terminate</button>` : ""}
                    </div>
                </td>
            </tr>
        `;
    }

    async #terminate(assignmentId, assignmentName)
    {
        const confirmed = await DialogBox.confirm("Terminate assignment", `Stop "${assignmentName}"? Future installments stop immediately. Already-granted credits are kept.`);
        if (!confirmed)
        {
            return;
        }
        try
        {
            const response = await fetch("/Admin/Credits/Periodic/Terminate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ assignmentId: assignmentId })
            });
            const responseJson = await response.json().catch(() => ({}));
            if (!response.ok)
            {
                this.#setStatus(responseJson.error || `Terminate failed (HTTP ${response.status}).`, true);
                return;
            }
            this.#setStatus(`Terminated "${assignmentName}".`, false);
            this.#reloadList();
        }
        catch (terminateError)
        {
            this.#setStatus(terminateError.message, true);
        }
    }

    async #print(assignmentId)
    {
        this.#setStatus("Building report…", false);
        try
        {
            const response = await fetch(`/Admin/Credits/Periodic/Report?assignmentId=${encodeURIComponent(assignmentId)}`);
            const report = await response.json().catch(() => ({}));
            if (!response.ok)
            {
                this.#setStatus(report.error || `Report failed (HTTP ${response.status}).`, true);
                return;
            }

            const blob = PeriodicAssignmentReportPdfRenderer.renderToBlob(report);
            const objectUrl = URL.createObjectURL(blob);
            const downloadLink = document.createElement("a");
            downloadLink.href = objectUrl;
            downloadLink.download = `PeriodicAssignment-${(report.assignment?.name || "report").replace(/[^A-Za-z0-9_-]/g, "_")}.pdf`;
            document.body.appendChild(downloadLink);
            downloadLink.click();
            downloadLink.remove();
            setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);
            this.#setStatus("Report downloaded.", false);
        }
        catch (printError)
        {
            this.#setStatus(printError.message, true);
        }
    }

    #setStatus(message, isError)
    {
        const statusLabel = this.querySelector('[data-role="status"]');
        statusLabel.textContent = message;
        statusLabel.classList.toggle("periodic-status-error", isError === true);
    }

    static #periodLabel(assignment)
    {
        if (assignment.scheduleType === periodicScheduleTypes.INTERVAL_DAYS)
        {
            return assignment.intervalDays === 1 ? "Every day" : `Every ${assignment.intervalDays} days`;
        }
        if (assignment.scheduleType === periodicScheduleTypes.DAY_OF_WEEK)
        {
            return `Every ${PeriodicAssignmentsPanel.#WEEKDAY_NAMES[assignment.dayOfWeek] || "week"}`;
        }
        if (assignment.scheduleType === periodicScheduleTypes.DAY_OF_MONTH)
        {
            return `Day ${assignment.dayOfMonth} monthly`;
        }
        return "—";
    }

    static #formatCredits(value)
    {
        const numeric = typeof value === "number" && isFinite(value) ? value : 0;
        return String(Math.round(numeric * 10000) / 10000);
    }

    static #escape(text)
    {
        const div = document.createElement("div");
        div.textContent = String(text ?? "");
        return div.innerHTML;
    }
}

customElements.define("periodic-assignments-panel", PeriodicAssignmentsPanel);
export default PeriodicAssignmentsPanel;
