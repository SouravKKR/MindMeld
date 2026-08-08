import DialogBox from "../../../CommonComponents/DialogBox.js";
import OrganizationErrorMessages from "../../../Globals/Classes/Organization/OrganizationErrorMessages.js";
import { memberAttributeValueTypes } from "../../../Globals/Enumerations/MemberAttributeValueTypes.js";

/**
 * OrganizationColumnsDialog
 *
 * What this institute keeps about its members, and what each column is called.
 *
 * Every column except the email address belongs to the institute. A school that
 * uploads "joinYear" and a coaching centre that uploads "batch" and "centre" do
 * not share a schema, and the teachers on a roster may carry none of the columns
 * the students do — so the columns are discovered from what is uploaded and then
 * shaped from here.
 *
 * Three things can be changed, and they are not the same kind of change:
 *
 *   The LABEL and the ORDER are presentation. They are saved together with the
 *   rest of the form and nothing else moves.
 *
 *   HOW THE VALUES READ decides whether a column is filtered as a number, a date
 *   or text. It is offered because the alternative is inference from a sample,
 *   and one "N/A" in a column of admission years is enough to make a year range
 *   behave alphabetically for the entire roster.
 *
 *   The NAME ITSELF is a migration: it rewrites the stored key on every member
 *   and repoints every rule that targeted it. It is therefore a separate,
 *   confirmed action rather than another box on the form — and the old name is
 *   kept, so the spreadsheet the office already has keeps importing correctly.
 *
 * Deleting takes the values with it, which the confirmation says plainly. It has
 * to: the column list is rebuilt from the values members actually carry, so
 * removing the description alone would recreate the column on the next read.
 */
class OrganizationColumnsDialog
{
    static #LIST_ENDPOINT = "/Organization/Members/Columns/List";
    static #SET_ENDPOINT = "/Organization/Members/Columns/Set";
    static #RENAME_ENDPOINT = "/Organization/Members/Columns/Rename";
    static #DELETE_ENDPOINT = "/Organization/Members/Columns/Delete";

    /**
     * @param {{organizationId: string, bMayEdit: boolean}} context
     * @returns {Promise<boolean>} whether anything changed
     */
    static async show({ organizationId, bMayEdit })
    {
        const dialog = DialogBox.modal(`
            <div class="organization-columns-dialog">
                <h2 class="admin-panel-add-title">Member columns</h2>
                <p class="admin-panel-add-subtitle">Loading…</p>
            </div>
        `);

        let bChangedAnything = false;

        return new Promise((resolve) =>
        {
            let bResolved = false;
            const finalize = () =>
            {
                if (bResolved)
                {
                    return;
                }
                bResolved = true;
                dialog.close();
                resolve(bChangedAnything);
            };

            const closeButton = dialog.querySelector(".close-button");
            if (closeButton)
            {
                closeButton.addEventListener("click", finalize);
            }

            const renderColumns = async () =>
            {
                const hostElement = dialog.querySelector(".organization-columns-dialog");

                let columns = [];
                try
                {
                    const response = await fetch(`${OrganizationColumnsDialog.#LIST_ENDPOINT}?organizationId=${encodeURIComponent(organizationId)}`);
                    const responseJson = await response.json().catch(() => ({}));

                    if (!response.ok || responseJson.success === false)
                    {
                        hostElement.innerHTML = `<h2 class="admin-panel-add-title">Member columns</h2><div class="admin-panel-add-error"></div>`;
                        hostElement.querySelector(".admin-panel-add-error").textContent = OrganizationErrorMessages.describe(responseJson.error, response.status);
                        return;
                    }

                    columns = Array.isArray(responseJson.columns) ? responseJson.columns : [];
                }
                catch (loadError)
                {
                    hostElement.innerHTML = `<h2 class="admin-panel-add-title">Member columns</h2><div class="admin-panel-add-error"></div>`;
                    hostElement.querySelector(".admin-panel-add-error").textContent = loadError.message || "Could not load the columns.";
                    return;
                }

                hostElement.innerHTML = OrganizationColumnsDialog.#buildMarkup(columns, bMayEdit);
                OrganizationColumnsDialog.#bindRowActions(hostElement, organizationId, columns, bMayEdit, async () =>
                {
                    bChangedAnything = true;
                    await renderColumns();
                });

                const doneButton = hostElement.querySelector('[data-role="done"]');
                if (doneButton)
                {
                    doneButton.addEventListener("click", finalize);
                }

                const saveButton = hostElement.querySelector('[data-role="save"]');
                if (saveButton)
                {
                    saveButton.addEventListener("click", async () =>
                    {
                        const errorElement = hostElement.querySelector(".admin-panel-add-error");
                        errorElement.hidden = true;

                        const columnInputs = Array.from(hostElement.querySelectorAll(".organization-column-row")).map((rowElement, rowIndex) => (
                        {
                            key: rowElement.dataset.columnKey,
                            label: rowElement.querySelector('[data-role="label"]').value.trim(),
                            valueType: Number(rowElement.querySelector('[data-role="value-type"]').value),
                            displayOrder: rowIndex
                        }));

                        if (columnInputs.some(columnInput => columnInput.label.length === 0))
                        {
                            errorElement.hidden = false;
                            errorElement.textContent = "Every column needs a name.";
                            return;
                        }

                        saveButton.disabled = true;
                        saveButton.textContent = "Saving…";

                        try
                        {
                            const response = await fetch(OrganizationColumnsDialog.#SET_ENDPOINT,
                            {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ organizationId: organizationId, columns: columnInputs })
                            });

                            const responseJson = await response.json().catch(() => ({}));

                            if (!response.ok || responseJson.success === false)
                            {
                                errorElement.hidden = false;
                                errorElement.textContent = OrganizationErrorMessages.describe(responseJson.error, response.status);
                                return;
                            }

                            bChangedAnything = true;
                            await renderColumns();
                        }
                        catch (saveError)
                        {
                            errorElement.hidden = false;
                            errorElement.textContent = saveError.message || "Could not save the columns.";
                        }
                        finally
                        {
                            if (saveButton.isConnected)
                            {
                                saveButton.disabled = false;
                                saveButton.textContent = "Save columns";
                            }
                        }
                    });
                }
            };

            renderColumns();
        });
    }

    static #bindRowActions(hostElement, organizationId, columns, bMayEdit, onChanged)
    {
        if (!bMayEdit)
        {
            return;
        }

        // Up/down buttons rather than dragging. Reordering by drag is not
        // reliably usable on a touch screen, and this list is edited as often
        // from a phone as from a desk.
        for (const moveButton of hostElement.querySelectorAll('[data-role="move-up"], [data-role="move-down"]'))
        {
            moveButton.addEventListener("click", () =>
            {
                const rowElement = moveButton.closest(".organization-column-row");
                const listElement = rowElement.parentElement;
                const bMoveUp = moveButton.dataset.role === "move-up";
                const siblingElement = bMoveUp ? rowElement.previousElementSibling : rowElement.nextElementSibling;

                if (!siblingElement || !siblingElement.classList.contains("organization-column-row"))
                {
                    return;
                }

                if (bMoveUp)
                {
                    listElement.insertBefore(rowElement, siblingElement);
                }
                else
                {
                    listElement.insertBefore(siblingElement, rowElement);
                }
            });
        }

        for (const renameButton of hostElement.querySelectorAll('[data-role="rename"]'))
        {
            renameButton.addEventListener("click", async () =>
            {
                const rowElement = renameButton.closest(".organization-column-row");
                const currentKey = rowElement.dataset.columnKey;
                const currentLabel = rowElement.querySelector('[data-role="label"]').value.trim();

                const newName = await DialogBox.prompt
                (
                    "Rename this column",
                    `"${currentLabel}" is stored as "${currentKey}". Renaming rewrites it on every member and repoints every rule that uses it. The old name keeps working for imports, so the spreadsheets you already send will still load correctly.`,
                    currentLabel
                );

                if (newName === null || String(newName).trim().length === 0)
                {
                    return;
                }

                const response = await fetch(OrganizationColumnsDialog.#RENAME_ENDPOINT,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify
                    ({
                        organizationId: organizationId,
                        key: currentKey,
                        newKey: String(newName).trim(),
                        newLabel: String(newName).trim()
                    })
                });

                const responseJson = await response.json().catch(() => ({}));

                if (!response.ok || responseJson.success === false)
                {
                    await DialogBox.alert("Could not rename", OrganizationErrorMessages.describe(responseJson.error, response.status));
                    return;
                }

                await onChanged();
            });
        }

        for (const deleteButton of hostElement.querySelectorAll('[data-role="delete"]'))
        {
            deleteButton.addEventListener("click", async () =>
            {
                const rowElement = deleteButton.closest(".organization-column-row");
                const currentKey = rowElement.dataset.columnKey;
                const currentLabel = rowElement.querySelector('[data-role="label"]').value.trim();

                const bConfirmed = await DialogBox.confirm
                (
                    "Delete this column?",
                    `"${currentLabel}" will be removed from every member, along with the values it holds. Any rule that filters on it will stop matching anybody. This cannot be undone.`
                );

                if (!bConfirmed)
                {
                    return;
                }

                const response = await fetch(OrganizationColumnsDialog.#DELETE_ENDPOINT,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ organizationId: organizationId, key: currentKey })
                });

                const responseJson = await response.json().catch(() => ({}));

                if (!response.ok || responseJson.success === false)
                {
                    await DialogBox.alert("Could not delete", OrganizationErrorMessages.describe(responseJson.error, response.status));
                    return;
                }

                await onChanged();
            });
        }
    }

    static #buildMarkup(columns, bMayEdit)
    {
        if (columns.length === 0)
        {
            return `
                <h2 class="admin-panel-add-title">Member columns</h2>
                <p class="admin-panel-add-subtitle">This organization has no member columns yet. Import a roster with columns such as a name, a joining year or a role, and they will appear here ready to be renamed and filtered on.</p>
                <div class="admin-panel-add-actions">
                    <button type="button" class="organization-secondary-button" data-role="done">Close</button>
                </div>
            `;
        }

        const typeOptions = (selectedValue) => `
            <option value="${memberAttributeValueTypes.STRING}" ${selectedValue === memberAttributeValueTypes.STRING ? "selected" : ""}>Text</option>
            <option value="${memberAttributeValueTypes.NUMBER}" ${selectedValue === memberAttributeValueTypes.NUMBER ? "selected" : ""}>Number</option>
            <option value="${memberAttributeValueTypes.DATE}" ${selectedValue === memberAttributeValueTypes.DATE ? "selected" : ""}>Date</option>
        `;

        const columnRows = columns.map(column => `
            <div class="organization-column-row" data-column-key="${OrganizationColumnsDialog.#escape(column.key)}">
                <label class="admin-panel-add-field organization-column-name">
                    <span>Name</span>
                    <input type="text" data-role="label" maxlength="128" value="${OrganizationColumnsDialog.#escape(column.label)}" ${bMayEdit ? "" : "disabled"}>
                    <small class="organization-permission-rule-hint">Stored as <code>${OrganizationColumnsDialog.#escape(column.key)}</code></small>
                </label>

                <label class="admin-panel-add-field organization-column-type">
                    <span>Values read as</span>
                    <select data-role="value-type" ${bMayEdit ? "" : "disabled"}>${typeOptions(Number(column.valueType))}</select>
                </label>

                ${bMayEdit ? `
                    <div class="organization-column-actions">
                        <button type="button" class="organization-secondary-button" data-role="move-up" title="Move up" aria-label="Move up">↑</button>
                        <button type="button" class="organization-secondary-button" data-role="move-down" title="Move down" aria-label="Move down">↓</button>
                        <button type="button" class="organization-secondary-button" data-role="rename">Rename</button>
                        <button type="button" class="organization-secondary-button" data-role="delete">Delete</button>
                    </div>
                ` : ""}
            </div>
        `).join("");

        return `
            <h2 class="admin-panel-add-title">Member columns</h2>
            <p class="admin-panel-add-subtitle">
                These are the details this organization keeps about its members. Renaming one rewrites it
                everywhere and keeps the old name working for imports. The email address is fixed and is
                not listed here.
            </p>

            <div class="organization-column-list">${columnRows}</div>

            <div class="admin-panel-add-error" hidden></div>
            <div class="admin-panel-add-actions">
                <button type="button" class="organization-secondary-button" data-role="done">Close</button>
                ${bMayEdit ? `<button type="button" class="admin-panel-add-submit" data-role="save">Save columns</button>` : ""}
            </div>
        `;
    }

    static #escape(rawValue)
    {
        return String(rawValue ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }
}

export default OrganizationColumnsDialog;
