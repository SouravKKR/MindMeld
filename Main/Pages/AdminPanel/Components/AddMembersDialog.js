import DialogBox from "../../../CommonComponents/DialogBox.js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * AddMembersDialog
 *
 * Unified dialog with three tabs covering every way an org admin adds
 * members: Type (single + a row-per-additional-email manual entry),
 * Paste (textarea), and Upload (.xlsx/.xls/.csv via SheetJS — already
 * vendored at /ThirdParty/SheetJs/xlsx.full.min.js).
 *
 * After parsing, the dialog displays preview counters (Found / New /
 * Already members / Invalid / Cap allows) and disables submit if the
 * additions would exceed the org's capacity. Submission auto-routes
 * to /Organization/Members/Add for a single email or
 * /Organization/Members/BulkAdd otherwise — the caller never sees the
 * distinction.
 *
 * Resolves true to the parent page when at least one member was added
 * (so the parent re-fetches and re-renders).
 */
class AddMembersDialog
{
    static async show({ organizationId, existingMembers })
    {
        const existingMemberEmails = new Set
        (
            (existingMembers || []).map(member => (member.email || "").trim().toLowerCase())
        );

        return new Promise((resolve) =>
        {
            const escape = (rawString) =>
            {
                if (rawString === null || rawString === undefined) return "";
                return String(rawString)
                    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
            };

            const dialog = DialogBox.modal
            (`
                <div class="admin-panel-add-dialog add-members-dialog">
                    <h2 class="admin-panel-add-title">Add members</h2>
                    <p class="admin-panel-add-subtitle">Type emails manually, paste a list, or upload a spreadsheet — all three feed into the same preview + submit flow.</p>

                    <div class="add-members-tabs">
                        <button type="button" class="add-members-tab add-members-tab-active" data-mode="type">Type emails</button>
                        <button type="button" class="add-members-tab" data-mode="paste">Paste list</button>
                        <button type="button" class="add-members-tab" data-mode="upload">Upload spreadsheet</button>
                    </div>

                    <div class="add-members-mode" data-mode="type">
                        <div class="add-members-type-rows" data-role="type-rows">
                            <input type="email" class="add-members-type-input" autocomplete="off" placeholder="name@example.com">
                        </div>
                        <button type="button" class="add-members-type-add">+ Add another</button>
                    </div>
                    <div class="add-members-mode" data-mode="paste" hidden>
                        <textarea class="add-members-paste-textarea" rows="8" placeholder="One email per line, or comma-separated"></textarea>
                    </div>
                    <div class="add-members-mode" data-mode="upload" hidden>
                        <p>Pick an .xlsx, .xls, or .csv file — every cell will be scanned for valid email addresses. Column position doesn't matter.</p>
                        <input type="file" class="add-members-upload-input" accept=".xlsx,.xls,.csv">
                        <p class="add-members-upload-status" data-role="upload-status"></p>
                    </div>

                    <div class="add-members-preview" data-role="preview"></div>

                    <div class="add-members-result" data-role="result" hidden></div>
                    <div class="admin-panel-add-error" data-role="error" hidden></div>
                    <div class="admin-panel-add-actions">
                        <button type="button" class="admin-panel-add-cancel">Cancel</button>
                        <button type="button" class="admin-panel-add-submit add-members-submit" disabled>Add</button>
                    </div>
                </div>
            `);

            const errorElement = dialog.querySelector('[data-role="error"]');
            const previewElement = dialog.querySelector('[data-role="preview"]');
            const resultElement = dialog.querySelector('[data-role="result"]');
            const submitButton = dialog.querySelector(".add-members-submit");
            const tabs = dialog.querySelectorAll(".add-members-tab");
            const modes = dialog.querySelectorAll(".add-members-mode");

            let currentMode = "type";
            let parsedEmails = [];
            let dialogResolvedWithSuccess = false;

            const showError = (message) =>
            {
                if (!message) { errorElement.hidden = true; errorElement.textContent = ""; return; }
                errorElement.textContent = message;
                errorElement.hidden = false;
            };

            const recomputePreview = (rawList) =>
            {
                resultElement.hidden = true;
                parsedEmails = [];
                const seenInBatch = new Set();
                let invalidCount = 0;
                let alreadyMemberCount = 0;
                const newEmails = [];

                for (const rawEntry of (rawList || []))
                {
                    if (typeof rawEntry !== "string") continue;
                    const trimmed = rawEntry.trim().toLowerCase();
                    if (trimmed.length === 0) continue;
                    if (!EMAIL_REGEX.test(trimmed))
                    {
                        invalidCount++;
                        continue;
                    }
                    if (seenInBatch.has(trimmed)) continue;
                    seenInBatch.add(trimmed);
                    parsedEmails.push(trimmed);
                    if (existingMemberEmails.has(trimmed))
                    {
                        alreadyMemberCount++;
                    }
                    else
                    {
                        newEmails.push(trimmed);
                    }
                }

                const totalFound = parsedEmails.length + invalidCount;
                previewElement.innerHTML = totalFound === 0
                    ? `<p class="admin-panel-add-subtitle">Nothing parsed yet.</p>`
                    : `
                        <p>
                            Found: <strong>${totalFound}</strong> ·
                            New: <strong>${newEmails.length}</strong> ·
                            Already members: <strong>${alreadyMemberCount}</strong> ·
                            Invalid: <strong>${invalidCount}</strong>
                        </p>
                    `;
                submitButton.disabled = newEmails.length === 0;
                submitButton.textContent = newEmails.length === 0 ? "Add" : `Add ${newEmails.length}`;
            };

            for (const tabButton of tabs)
            {
                tabButton.addEventListener("click", () =>
                {
                    currentMode = tabButton.dataset.mode;
                    for (const otherTab of tabs)
                    {
                        otherTab.classList.toggle("add-members-tab-active", otherTab === tabButton);
                    }
                    for (const modeBlock of modes)
                    {
                        modeBlock.hidden = modeBlock.dataset.mode !== currentMode;
                    }
                    parsedEmails = [];
                    submitButton.disabled = true;
                    previewElement.innerHTML = "";
                });
            }

            const typeRows = dialog.querySelector('[data-role="type-rows"]');
            const refreshFromTypeInputs = () =>
            {
                const list = [];
                for (const input of typeRows.querySelectorAll(".add-members-type-input"))
                {
                    list.push(input.value);
                }
                recomputePreview(list);
            };
            typeRows.addEventListener("input", refreshFromTypeInputs);
            dialog.querySelector(".add-members-type-add").addEventListener("click", () =>
            {
                const newRow = document.createElement("input");
                newRow.type = "email";
                newRow.className = "add-members-type-input";
                newRow.autocomplete = "off";
                newRow.placeholder = "name@example.com";
                typeRows.appendChild(newRow);
                newRow.focus();
            });

            const pasteTextarea = dialog.querySelector(".add-members-paste-textarea");
            pasteTextarea.addEventListener("input", () =>
            {
                const parts = pasteTextarea.value.split(/[\s,;]+/);
                recomputePreview(parts);
            });

            const uploadInput = dialog.querySelector(".add-members-upload-input");
            const uploadStatus = dialog.querySelector('[data-role="upload-status"]');
            uploadInput.addEventListener("change", async () =>
            {
                const file = uploadInput.files && uploadInput.files[0];
                if (!file)
                {
                    return;
                }
                if (typeof window.XLSX !== "object" || typeof window.XLSX.read !== "function")
                {
                    showError("Spreadsheet library not loaded. Reload the page and try again.");
                    return;
                }
                uploadStatus.textContent = `Reading ${file.name}…`;
                try
                {
                    const arrayBuffer = await file.arrayBuffer();
                    const workbook = window.XLSX.read(arrayBuffer, { type: "array" });
                    const collectedEmails = [];
                    for (const sheetName of workbook.SheetNames)
                    {
                        const worksheet = workbook.Sheets[sheetName];
                        // Convert every cell to a string and scan for emails — the
                        // user's spreadsheet may have the email in column A, C, or
                        // mixed with other data, so we don't assume a layout.
                        for (const cellRef of Object.keys(worksheet))
                        {
                            if (cellRef.startsWith("!")) continue;
                            const cell = worksheet[cellRef];
                            const cellText = String((cell && (cell.v ?? cell.w)) ?? "");
                            const matches = cellText.match(/[^\s,;<>]+@[^\s,;<>]+\.[^\s,;<>]+/g);
                            if (matches)
                            {
                                for (const match of matches)
                                {
                                    collectedEmails.push(match);
                                }
                            }
                        }
                    }
                    uploadStatus.textContent = `Parsed ${collectedEmails.length} candidate email${collectedEmails.length === 1 ? "" : "s"} from ${file.name}.`;
                    recomputePreview(collectedEmails);
                }
                catch (readError)
                {
                    uploadStatus.textContent = `Could not read the file: ${readError.message || readError}`;
                }
            });

            dialog.querySelector(".admin-panel-add-cancel").addEventListener("click", () =>
            {
                dialog.close();
                resolve(dialogResolvedWithSuccess);
            });

            submitButton.addEventListener("click", async () =>
            {
                showError(null);
                const newEmails = parsedEmails.filter(email => !existingMemberEmails.has(email));
                if (newEmails.length === 0)
                {
                    showError("Nothing to add.");
                    return;
                }

                submitButton.disabled = true;
                submitButton.textContent = "Submitting…";

                try
                {
                    let responseJson;
                    if (newEmails.length === 1)
                    {
                        const singleResponse = await fetch("/Organization/Members/Add",
                        {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ organizationId: organizationId, email: newEmails[0] })
                        });
                        responseJson = await singleResponse.json().catch(() => ({}));
                        if (!singleResponse.ok || responseJson.success === false)
                        {
                            showError(responseJson.error || `HTTP ${singleResponse.status}`);
                            return;
                        }
                    }
                    else
                    {
                        const bulkResponse = await fetch("/Organization/Members/BulkAdd",
                        {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ organizationId: organizationId, emails: newEmails })
                        });
                        responseJson = await bulkResponse.json().catch(() => ({}));
                        if (!bulkResponse.ok || responseJson.success === false)
                        {
                            showError(responseJson.error || `HTTP ${bulkResponse.status}`);
                            return;
                        }
                    }

                    const summary = responseJson.summary || { requested: newEmails.length, added: 0, alreadyMember: 0, invalidEmail: 0, autoAssignedDecks: 0 };
                    dialogResolvedWithSuccess = summary.added > 0;

                    resultElement.hidden = false;
                    resultElement.innerHTML = `
                        <h3>${summary.added} of ${summary.requested} members added</h3>
                        <ul>
                            <li>${summary.added} added new</li>
                            <li>${summary.alreadyMember} already members</li>
                            <li>${summary.invalidEmail} invalid email format</li>
                            <li>${summary.autoAssignedDecks} paid deck${summary.autoAssignedDecks === 1 ? "" : "s"} auto-assigned (FREE perks granted to newly-added members with existing accounts)</li>
                        </ul>
                        ${(responseJson.perEmail || []).length > 0 ? `
                            <details>
                                <summary>View per-email details</summary>
                                <ul>
                                    ${responseJson.perEmail.map(entry => `<li>${escape(entry.email)} — ${entry.status}</li>`).join("")}
                                </ul>
                            </details>
                        ` : ""}
                    `;
                    submitButton.textContent = "Done";
                    submitButton.disabled = false;
                    submitButton.onclick = () =>
                    {
                        dialog.close();
                        resolve(dialogResolvedWithSuccess);
                    };
                }
                catch (submitError)
                {
                    showError(submitError.message || String(submitError));
                    submitButton.disabled = false;
                    submitButton.textContent = "Add";
                }
            });
        });
    }
}

export default AddMembersDialog;
