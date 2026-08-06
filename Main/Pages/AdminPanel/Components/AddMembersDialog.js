import DialogBox from "../../../CommonComponents/DialogBox.js";
import OrganizationErrorMessages from "../../../Globals/Classes/Organization/OrganizationErrorMessages.js";
import OrganizationMemberSheetParser from "../../../Globals/Classes/Organization/OrganizationMemberSheetParser.js";
import SpreadsheetWriter from "../../../Globals/Classes/SpreadsheetWriter.js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * AddMembersDialog
 *
 * Every way a roster enters an organization, in one dialog:
 *
 *   Type    — a few addresses by hand, no details
 *   Paste   — a column of addresses, or whole CSV rows pasted from a sheet
 *   Upload  — a .csv / .xlsx roster with names, tags and whatever else the
 *             institute tracks
 *
 * The upload and paste paths keep the other columns rather than scraping the
 * file for anything email-shaped. Those columns are what later make it possible
 * to give credits to "second-year Physics" or remove "roll numbers A0100 to
 * A0450" — a roster of bare addresses can express neither.
 *
 * Re-importing is deliberately a REPLACE: a member already present has their
 * tags and details overwritten by the sheet. Merging would mean a tag applied
 * by mistake could never be corrected by fixing the sheet and uploading again.
 * People missing from the sheet are never touched.
 */
class AddMembersDialog
{
    static #TEMPLATE_FILE_NAME = "CogniumLearn-Members-Template";

    static #escapeHtml(rawString)
    {
        if (rawString === null || rawString === undefined)
        {
            return "";
        }
        return String(rawString)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    static async show({ organizationId, existingMembers })
    {
        const existingMemberEmails = new Set
        (
            (Array.isArray(existingMembers) ? existingMembers : [])
                .map(member => String(member?.email || "").trim().toLowerCase())
                .filter(email => email.length > 0)
        );

        return new Promise((resolve) =>
        {
            const dialog = DialogBox.modal
            (`
                <div class="admin-panel-add-dialog add-members-dialog">
                    <h2 class="admin-panel-add-title">Add members</h2>
                    <p class="admin-panel-add-subtitle">Members are identified by email. Upload a sheet to bring their details across too — those are what let you target credits, permissions and decks at part of the organization later.</p>

                    <div class="admin-panel-add-error" data-role="error" hidden></div>

                    <div class="add-members-tabs" data-role="tabs">
                        <button type="button" class="add-members-tab add-members-tab-active" data-mode="type">Type</button>
                        <button type="button" class="add-members-tab" data-mode="paste">Paste</button>
                        <button type="button" class="add-members-tab" data-mode="upload">Upload a sheet</button>
                    </div>

                    <div class="add-members-panel" data-panel="type">
                        <div class="add-members-email-rows" data-role="email-rows"></div>
                        <button type="button" class="organization-secondary-button add-members-type-add">+ Add another</button>
                    </div>

                    <div class="add-members-panel" data-panel="paste" hidden>
                        <label class="admin-panel-add-field">
                            <span>One address per line, or rows copied straight out of a spreadsheet</span>
                            <textarea class="add-members-paste-textarea" rows="8" placeholder="arjun.rao@example.edu&#10;meera.iyer@example.edu"></textarea>
                        </label>
                    </div>

                    <div class="add-members-panel" data-panel="upload" hidden>
                        <label class="admin-panel-add-field">
                            <span>Roster file (.csv, .xlsx, .xls)</span>
                            <input type="file" class="add-members-file-input" accept=".csv,.xlsx,.xls">
                        </label>
                        <p class="admin-panel-add-subtitle">
                            Recommended columns: <strong>${AddMembersDialog.#escapeHtml(OrganizationMemberSheetParser.RECOMMENDED_HEADERS.join(", "))}</strong>.
                            Put several tags in one cell separated by semicolons. Any extra column you add becomes a detail you can filter and select ranges over.
                        </p>
                        <p class="admin-panel-add-subtitle">
                            The quickest way to collect this is a Google Form with exactly these fields — one short-answer question per column, with the email question set to collect verified addresses. Download its responses as CSV and upload the file here unchanged.
                        </p>
                        <button type="button" class="organization-secondary-button add-members-download-template">Download the template</button>
                    </div>

                    <div class="add-members-preview" data-role="preview"></div>
                    <div class="add-members-result" data-role="result" hidden></div>

                    <div class="admin-panel-add-actions">
                        <button type="button" class="admin-panel-add-cancel add-members-cancel">Cancel</button>
                        <button type="button" class="admin-panel-add-submit add-members-submit" disabled>Add</button>
                    </div>
                </div>
            `);

            const errorElement = dialog.querySelector('[data-role="error"]');
            const previewElement = dialog.querySelector('[data-role="preview"]');
            const resultElement = dialog.querySelector('[data-role="result"]');
            const emailRowsElement = dialog.querySelector('[data-role="email-rows"]');
            const pasteTextarea = dialog.querySelector(".add-members-paste-textarea");
            const fileInput = dialog.querySelector(".add-members-file-input");
            const submitButton = dialog.querySelector(".add-members-submit");

            let activeMode = "type";
            let parsedMembers = [];
            let invalidRowCount = 0;
            let bSubmissionCompleted = false;
            let bDialogChangedSomething = false;

            const showError = (message) =>
            {
                if (!message)
                {
                    errorElement.hidden = true;
                    errorElement.textContent = "";
                    return;
                }
                errorElement.textContent = message;
                errorElement.hidden = false;
                errorElement.scrollIntoView({ block: "nearest" });
            };

            const renderPreview = () =>
            {
                const newMembers = parsedMembers.filter(member => !existingMemberEmails.has(member.email));
                const updatedMembers = parsedMembers.filter(member => existingMemberEmails.has(member.email));
                const detailCount = parsedMembers.filter(member => Object.keys(member.attributes || {}).length > 0 || (member.tags || []).length > 0).length;

                submitButton.disabled = parsedMembers.length === 0;

                if (parsedMembers.length === 0)
                {
                    previewElement.textContent = invalidRowCount > 0
                        ? `No usable rows — ${invalidRowCount} row${invalidRowCount === 1 ? "" : "s"} had no valid email address.`
                        : "";
                    return;
                }

                previewElement.innerHTML = `
                    <ul class="add-members-preview-list">
                        <li><strong>${newMembers.length}</strong> new member${newMembers.length === 1 ? "" : "s"} to add</li>
                        <li><strong>${updatedMembers.length}</strong> already here — their tags and details will be replaced by this sheet</li>
                        <li><strong>${detailCount}</strong> row${detailCount === 1 ? "" : "s"} carrying tags or details</li>
                        ${invalidRowCount > 0 ? `<li><strong>${invalidRowCount}</strong> row${invalidRowCount === 1 ? "" : "s"} skipped — no valid email</li>` : ""}
                    </ul>
                `;
            };

            const renderEmailRows = () =>
            {
                if (emailRowsElement.children.length === 0)
                {
                    AddMembersDialog.#appendEmailRow(emailRowsElement, collectTypedEmails);
                }
            };

            const collectTypedEmails = () =>
            {
                if (activeMode !== "type")
                {
                    return;
                }
                const typedEmails = Array.from(emailRowsElement.querySelectorAll(".add-members-email-input"))
                    .map(input => input.value.trim().toLowerCase())
                    .filter(email => email.length > 0);

                invalidRowCount = typedEmails.filter(email => !EMAIL_REGEX.test(email)).length;
                const seenEmails = new Set();
                parsedMembers = [];
                for (const email of typedEmails)
                {
                    if (EMAIL_REGEX.test(email) && !seenEmails.has(email))
                    {
                        seenEmails.add(email);
                        parsedMembers.push({ email: email, attributes: {}, tags: [] });
                    }
                }
                renderPreview();
            };

            const parsePasted = () =>
            {
                if (activeMode !== "paste")
                {
                    return;
                }
                const parseResult = OrganizationMemberSheetParser.parseText(pasteTextarea.value);
                parsedMembers = parseResult.members;
                invalidRowCount = parseResult.invalidRows.length;
                renderPreview();
            };

            for (const tabButton of dialog.querySelectorAll(".add-members-tab"))
            {
                tabButton.addEventListener("click", (clickEvent) =>
                {
                    activeMode = clickEvent.currentTarget.dataset.mode;
                    for (const otherTab of dialog.querySelectorAll(".add-members-tab"))
                    {
                        otherTab.classList.toggle("add-members-tab-active", otherTab.dataset.mode === activeMode);
                    }
                    for (const panel of dialog.querySelectorAll(".add-members-panel"))
                    {
                        panel.hidden = panel.dataset.panel !== activeMode;
                    }

                    parsedMembers = [];
                    invalidRowCount = 0;
                    showError(null);

                    if (activeMode === "type")
                    {
                        collectTypedEmails();
                    }
                    else if (activeMode === "paste")
                    {
                        parsePasted();
                    }
                    else
                    {
                        renderPreview();
                    }
                });
            }

            dialog.querySelector(".add-members-type-add").addEventListener("click", () =>
            {
                AddMembersDialog.#appendEmailRow(emailRowsElement, collectTypedEmails);
            });

            pasteTextarea.addEventListener("input", parsePasted);

            fileInput.addEventListener("change", async () =>
            {
                const selectedFile = fileInput.files && fileInput.files[0];
                if (!selectedFile)
                {
                    return;
                }

                showError(null);
                previewElement.textContent = "Reading the file…";

                try
                {
                    const parseResult = await OrganizationMemberSheetParser.parseFile(selectedFile);
                    parsedMembers = parseResult.members;
                    invalidRowCount = parseResult.invalidRows.length;

                    if (!parseResult.bHadHeaderRow && parsedMembers.length > 0)
                    {
                        showError("No header row was found, so every column after the email was read as a tag. Add a header row starting with \"email\" to keep names and other details.");
                    }

                    renderPreview();
                }
                catch (readError)
                {
                    parsedMembers = [];
                    invalidRowCount = 0;
                    renderPreview();
                    showError(readError.message || "That file could not be read.");
                }
            });

            dialog.querySelector(".add-members-download-template").addEventListener("click", () =>
            {
                SpreadsheetWriter.downloadWorkbook
                (
                    OrganizationMemberSheetParser.buildTemplateRows(),
                    AddMembersDialog.#TEMPLATE_FILE_NAME,
                    "Members"
                );
            });

            dialog.querySelector(".add-members-cancel").addEventListener("click", () =>
            {
                dialog.close();
                resolve(bDialogChangedSomething);
            });

            // DialogBox.modal's own X — and Escape, which PopupStack routes to
            // it — closes the element without settling this promise.
            dialog.querySelector(".close-button").addEventListener("click", () =>
            {
                resolve(bDialogChangedSomething);
            });

            submitButton.addEventListener("click", async () =>
            {
                if (bSubmissionCompleted)
                {
                    dialog.close();
                    resolve(bDialogChangedSomething);
                    return;
                }

                if (parsedMembers.length === 0)
                {
                    showError("Nothing to add yet.");
                    return;
                }

                showError(null);
                submitButton.disabled = true;
                submitButton.textContent = "Importing…";

                try
                {
                    const response = await fetch("/Organization/Members/Import",
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ organizationId: organizationId, members: parsedMembers })
                    });
                    const responseJson = await response.json().catch(() => ({}));

                    if (!response.ok || responseJson.success === false)
                    {
                        showError(OrganizationErrorMessages.describe(responseJson.error, response.status));
                        return;
                    }

                    const summary = responseJson.summary || {};
                    bDialogChangedSomething = (summary.added || 0) > 0 || (summary.updated || 0) > 0;

                    resultElement.hidden = false;
                    resultElement.innerHTML = `
                        <h3>${summary.added || 0} added, ${summary.updated || 0} updated</h3>
                        <ul>
                            <li>${summary.added || 0} new member${(summary.added || 0) === 1 ? "" : "s"}</li>
                            <li>${summary.updated || 0} existing member${(summary.updated || 0) === 1 ? "" : "s"} had their tags and details replaced</li>
                            <li>${summary.invalidEmail || 0} row${(summary.invalidEmail || 0) === 1 ? "" : "s"} skipped for an invalid email</li>
                            <li>${summary.autoAssignedDecks || 0} deck licence${(summary.autoAssignedDecks || 0) === 1 ? "" : "s"} auto-assigned from free perks</li>
                        </ul>
                    `;

                    bSubmissionCompleted = true;
                    submitButton.textContent = "Done";
                }
                catch (submitError)
                {
                    showError(submitError.message || String(submitError));
                }
                finally
                {
                    // Restored on every exit path, so a refused import never
                    // leaves the button stuck on "Importing…".
                    submitButton.disabled = false;
                    if (!bSubmissionCompleted)
                    {
                        submitButton.textContent = "Add";
                    }
                }
            });

            renderEmailRows();
            collectTypedEmails();
        });
    }

    static #appendEmailRow(emailRowsElement, onInputCallback)
    {
        const rowElement = document.createElement("label");
        rowElement.className = "admin-panel-add-field";
        rowElement.innerHTML = `
            <span>Email</span>
            <input type="email" class="add-members-email-input" autocomplete="off" placeholder="member@example.edu">
        `;
        emailRowsElement.appendChild(rowElement);
        rowElement.querySelector(".add-members-email-input").addEventListener("input", onInputCallback);
        rowElement.querySelector(".add-members-email-input").focus();
    }
}

export default AddMembersDialog;
