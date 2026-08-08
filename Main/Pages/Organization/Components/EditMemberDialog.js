import DialogBox from "../../../CommonComponents/DialogBox.js";
import OrganizationErrorMessages from "../../../Globals/Classes/Organization/OrganizationErrorMessages.js";

/**
 * EditMemberDialog
 *
 * Corrects one member — every field this institute keeps about them, and their
 * tags.
 *
 * The fields are a TABLE OF INPUTS rather than a fixed form: the name on the
 * left, the value on the right, a row that can be removed, and a button that
 * adds another. Nothing about the set is fixed, which is the whole point of the
 * feature — an institute that has never uploaded a spreadsheet has no columns
 * yet, and a form built only from columns that already exist would offer such an
 * administrator nothing but a tags box. Typing a name here is enough to create
 * the field, and it becomes filterable and rule-targetable like any other.
 *
 * Renaming a field here changes it FOR THIS MEMBER ONLY — the old name is
 * cleared and the value re-filed under the new one. Renaming a column for
 * everybody rewrites every member document and repoints every rule, so it lives
 * behind its own confirmation in the Columns editor rather than happening as a
 * side effect of correcting one person. The screen says so.
 *
 * The email address is shown but not editable: it is the identity a membership
 * is keyed by, and changing it would either orphan the membership from the
 * account it belongs to or silently merge two people.
 *
 * A blank value removes the field from this member rather than storing an empty
 * string, because an absent value is what "this person has no admission year"
 * means everywhere else — a stored blank would place them inside every range
 * filter over a column they never filled in.
 */
class EditMemberDialog
{
    static #UPDATE_ENDPOINT = "/Organization/Members/Update";

    static #ATTRIBUTE_ROW_PREFIX = "attribute_";

    // The chooser entry that swaps in a free-text box. A sentinel rather than an
    // empty value, because "" already means "nothing chosen yet".
    static CUSTOM_FIELD_VALUE = "__custom__";

    // The importer refuses more than this on a single row, so the editor holds
    // the same line rather than letting one screen build a member the next
    // spreadsheet could not describe.
    static MAXIMUM_FIELDS = 32;

    /**
     * @param {{organizationId: string, member: object, columns: Array<object>}} context
     * @returns {Promise<boolean>} whether anything was saved
     */
    static show({ organizationId, member, columns })
    {
        return new Promise((resolve) =>
        {
            const safeColumns = Array.isArray(columns) ? columns : [];
            const initialFields = EditMemberDialog.#buildInitialFields(member, safeColumns);
            // What the member carried when the dialog opened. Saving compares
            // against it to work out which fields were removed or renamed, since
            // the endpoint applies a partial change and would otherwise leave a
            // deleted field exactly where it was.
            const originalAttributeKeys = initialFields.map(field => field.key).filter(key => key.length > 0);

            const dialog = DialogBox.modal(EditMemberDialog.#buildMarkup(member, initialFields, safeColumns));

            const formElement = dialog.querySelector(".organization-edit-member-form");
            const fieldsHost = formElement.querySelector('[data-role="fields"]');
            const errorElement = formElement.querySelector(".admin-panel-add-error");
            const submitButton = formElement.querySelector(".admin-panel-add-submit");
            const cancelButton = formElement.querySelector(".organization-edit-member-cancel");
            const addFieldButton = formElement.querySelector('[data-role="add-field"]');
            const closeButton = dialog.querySelector(".close-button");

            let bResolved = false;
            const finalize = (bSaved) =>
            {
                if (bResolved)
                {
                    return;
                }
                bResolved = true;
                dialog.close();
                resolve(bSaved);
            };

            cancelButton.addEventListener("click", () => finalize(false));
            if (closeButton)
            {
                closeButton.addEventListener("click", () => finalize(false));
            }

            EditMemberDialog.#bindRows(fieldsHost, safeColumns);

            addFieldButton.addEventListener("click", () =>
            {
                if (fieldsHost.querySelectorAll(".organization-field-row").length >= EditMemberDialog.MAXIMUM_FIELDS)
                {
                    errorElement.hidden = false;
                    errorElement.textContent = `A member can carry at most ${EditMemberDialog.MAXIMUM_FIELDS} fields.`;
                    return;
                }

                errorElement.hidden = true;
                fieldsHost.insertAdjacentHTML("beforeend", EditMemberDialog.#buildFieldRowMarkup({ key: "", label: "", value: "" }, safeColumns));
                EditMemberDialog.#bindRows(fieldsHost, safeColumns);

                fieldsHost.lastElementChild.querySelector('[data-role="field-name-select"]').focus();
            });

            submitButton.addEventListener("click", async () =>
            {
                errorElement.hidden = true;

                const collected = EditMemberDialog.#collectFields(fieldsHost, safeColumns);
                if (collected.duplicateName !== null)
                {
                    errorElement.hidden = false;
                    errorElement.textContent = `"${collected.duplicateName}" is listed twice. Two fields cannot share a name — merge them into one row.`;
                    return;
                }

                const tagsInput = formElement.querySelector('[data-role="tags"]');
                const replaceTags = tagsInput.value
                    .split(",")
                    .map(tagText => tagText.trim())
                    .filter(tagText => tagText.length > 0);

                // Anything the member had that is no longer on screen — deleted
                // outright, or renamed so its value now lives under a new key.
                const survivingKeys = new Set(Object.keys(collected.setAttributes));
                const clearAttributeKeys = originalAttributeKeys.filter(originalKey => !survivingKeys.has(originalKey));

                submitButton.disabled = true;
                const originalLabel = submitButton.textContent;
                submitButton.textContent = "Saving…";

                try
                {
                    const response = await fetch(EditMemberDialog.#UPDATE_ENDPOINT,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify
                        ({
                            organizationId: organizationId,
                            memberId: member.id,
                            replaceTags: replaceTags,
                            setAttributes: collected.setAttributes,
                            clearAttributeKeys: clearAttributeKeys
                        })
                    });

                    const responseJson = await response.json().catch(() => ({}));

                    if (!response.ok || responseJson.success === false)
                    {
                        errorElement.hidden = false;
                        errorElement.textContent = OrganizationErrorMessages.describe(responseJson.error, response.status);
                        return;
                    }

                    finalize(true);
                }
                catch (saveError)
                {
                    errorElement.hidden = false;
                    errorElement.textContent = saveError.message || "Could not save this member.";
                }
                finally
                {
                    if (submitButton.isConnected)
                    {
                        submitButton.disabled = false;
                        submitButton.textContent = originalLabel;
                    }
                }
            });
        });
    }

    /**
     * The rows the dialog opens with: every column this organization keeps,
     * plus anything this member carries that has no column row yet.
     *
     * The union matters because the two can genuinely differ — a member imported
     * moments ago carries a value whose column has not been registered, and
     * showing only registered columns would hide a value the administrator can
     * plainly see in the list behind the dialog.
     */
    static #buildInitialFields(member, columns)
    {
        const fields = [];
        const seenKeys = new Set();

        for (const column of (Array.isArray(columns) ? columns : []))
        {
            fields.push
            ({
                key: column.key,
                label: column.label,
                value: member[`${EditMemberDialog.#ATTRIBUTE_ROW_PREFIX}${column.key}`] || ""
            });
            seenKeys.add(column.key);
        }

        for (const rowKey of Object.keys(member || {}))
        {
            if (!rowKey.startsWith(EditMemberDialog.#ATTRIBUTE_ROW_PREFIX))
            {
                continue;
            }

            const attributeKey = rowKey.slice(EditMemberDialog.#ATTRIBUTE_ROW_PREFIX.length);
            if (attributeKey.length === 0 || seenKeys.has(attributeKey))
            {
                continue;
            }

            fields.push({ key: attributeKey, label: EditMemberDialog.#describeKey(attributeKey), value: member[rowKey] || "" });
            seenKeys.add(attributeKey);
        }

        // An organization with nothing recorded yet opens with one blank row
        // rather than an empty table, so the first thing on screen is somewhere
        // to type rather than an explanation of why there is nothing to type in.
        if (fields.length === 0)
        {
            fields.push({ key: "", label: "", value: "" });
        }

        return fields;
    }

    static #bindRows(fieldsHost, columns)
    {
        for (const rowElement of fieldsHost.querySelectorAll(".organization-field-row"))
        {
            if (rowElement.dataset.bound === "true")
            {
                continue;
            }
            rowElement.dataset.bound = "true";

            EditMemberDialog.#bindNameChooser(rowElement, columns);

            rowElement.querySelector('[data-role="remove-field"]').addEventListener("click", () =>
            {
                rowElement.remove();
            });
        }
    }

    /**
     * Reads the table back.
     *
     * A row with no name is ignored entirely, and a row with a name but no value
     * clears that field — both are read as "this member does not have this",
     * which is what an empty box means to the person looking at it.
     */
    /**
     * Reads the table back.
     *
     * A row naming nothing is ignored, and a row naming a field with no value
     * clears it — both read as "this member does not have this", which is what
     * an empty box means to the person looking at it.
     */
    static #collectFields(fieldsHost, columns)
    {
        const setAttributes = {};
        const seenNormalisedNames = new Map();
        let duplicateName = null;

        for (const rowElement of fieldsHost.querySelectorAll(".organization-field-row"))
        {
            const nameSelect = rowElement.querySelector('[data-role="field-name-select"]');
            const customInput = rowElement.querySelector('[data-role="field-name-custom"]');
            const fieldValue = rowElement.querySelector('[data-role="field-value"]').value.trim();

            let attributeKey = "";
            let displayedName = "";

            if (nameSelect.value === EditMemberDialog.CUSTOM_FIELD_VALUE)
            {
                displayedName = customInput.value.trim();
                if (displayedName.length === 0)
                {
                    continue;
                }

                // Typing the name of a field that already exists fills THAT
                // field in rather than creating a second one describing the
                // same thing — which is how a roster ends up with both
                // "Join Year" and "Joining Year".
                const matchedColumn = EditMemberDialog.#findColumnByName(columns, displayedName);
                attributeKey = matchedColumn !== null ? matchedColumn.key : displayedName;
            }
            else
            {
                attributeKey = nameSelect.value;
                displayedName = nameSelect.options[nameSelect.selectedIndex]?.textContent?.trim() || attributeKey;

                if (attributeKey.length === 0)
                {
                    continue;
                }
            }

            const normalisedName = EditMemberDialog.#normaliseName(attributeKey);

            if (seenNormalisedNames.has(normalisedName) && duplicateName === null)
            {
                duplicateName = displayedName;
            }
            seenNormalisedNames.set(normalisedName, displayedName);

            if (fieldValue.length > 0)
            {
                setAttributes[attributeKey] = fieldValue;
            }
        }

        return { setAttributes: setAttributes, duplicateName: duplicateName };
    }

    static #describeKey(attributeKey)
    {
        const spacedText = String(attributeKey).replace(/([a-z0-9])([A-Z])/g, "$1 $2");
        return spacedText.charAt(0).toUpperCase() + spacedText.slice(1);
    }

    /**
     * One row: pick a field this organization already keeps, or name a new one.
     *
     * The chooser lists the columns the whole roster uses — not just the ones
     * this member happens to carry — because the common case is filling in a
     * field their classmates already have, and retyping its name to do that is
     * how "Join Year" and "Joining Year" end up as two columns describing one
     * thing. Naming a new field stays one option away for everything else.
     */
    static #buildFieldRowMarkup(field, columns)
    {
        const bIsCustom = field.key.length === 0;

        const columnOptions = (Array.isArray(columns) ? columns : []).map(column => `
            <option value="${EditMemberDialog.#escape(column.key)}" ${column.key === field.key ? "selected" : ""}>${EditMemberDialog.#escape(column.label)}</option>
        `).join("");

        // A field the member carries that the schema has not registered yet —
        // it still has to be selectable, or opening the dialog would silently
        // reassign it.
        const orphanOption = (!bIsCustom && !(columns || []).some(column => column.key === field.key))
            ? `<option value="${EditMemberDialog.#escape(field.key)}" selected>${EditMemberDialog.#escape(field.label)}</option>`
            : "";

        return `
            <div class="organization-field-row" data-original-key="${EditMemberDialog.#escape(field.key)}">
                <div class="organization-field-name-cell">
                    <span class="organization-field-cell-label">Field</span>
                    <select data-role="field-name-select">
                        <option value="">Choose a field…</option>
                        ${columnOptions}
                        ${orphanOption}
                        <option value="${EditMemberDialog.CUSTOM_FIELD_VALUE}" ${bIsCustom ? "selected" : ""}>Something else…</option>
                    </select>
                    <input type="text" data-role="field-name-custom" maxlength="128" placeholder="Name the new field" ${bIsCustom ? "" : "hidden"}>
                    <small class="organization-field-merge-hint" data-role="merge-hint" hidden></small>
                </div>
                <label class="organization-field-value-cell">
                    <span class="organization-field-cell-label">Value</span>
                    <input type="text" data-role="field-value" maxlength="256" placeholder="Leave blank to remove" value="${EditMemberDialog.#escape(field.value)}">
                </label>
                <button type="button" class="organization-secondary-button organization-field-remove" data-role="remove-field" title="Remove this field" aria-label="Remove this field">Remove</button>
            </div>
        `;
    }

    /**
     * Shows and hides the custom-name box, and says out loud when a typed name
     * is going to land on a field that already exists.
     *
     * That notice is the whole reason merging is safe to be implicit: an
     * administrator typing "join year" next to a "Join Year" column is told it
     * will fill in that column rather than discovering afterwards that it did.
     */
    static #bindNameChooser(rowElement, columns)
    {
        const nameSelect = rowElement.querySelector('[data-role="field-name-select"]');
        const customInput = rowElement.querySelector('[data-role="field-name-custom"]');
        const mergeHint = rowElement.querySelector('[data-role="merge-hint"]');

        const refresh = () =>
        {
            const bIsCustom = nameSelect.value === EditMemberDialog.CUSTOM_FIELD_VALUE;
            customInput.hidden = !bIsCustom;

            if (!bIsCustom || customInput.value.trim().length === 0)
            {
                mergeHint.hidden = true;
                return;
            }

            const matchedColumn = EditMemberDialog.#findColumnByName(columns, customInput.value);
            if (matchedColumn === null)
            {
                mergeHint.hidden = false;
                mergeHint.textContent = "This will be added as a new field.";
                return;
            }

            mergeHint.hidden = false;
            mergeHint.textContent = `Same as the existing field "${matchedColumn.label}" — this will fill that one in.`;
        };

        nameSelect.addEventListener("change", () =>
        {
            refresh();
            if (nameSelect.value === EditMemberDialog.CUSTOM_FIELD_VALUE)
            {
                customInput.focus();
            }
        });
        customInput.addEventListener("input", refresh);

        refresh();
    }

    /**
     * The column a typed name refers to, matched the way the server derives a
     * stored key from a spreadsheet header — so "Join Year", "join year" and
     * "joinYear" all find the same one.
     */
    static #findColumnByName(columns, typedName)
    {
        const normalisedTypedName = EditMemberDialog.#normaliseName(typedName);
        if (normalisedTypedName.length === 0)
        {
            return null;
        }

        for (const column of (Array.isArray(columns) ? columns : []))
        {
            if (EditMemberDialog.#normaliseName(column.key) === normalisedTypedName
                || EditMemberDialog.#normaliseName(column.label) === normalisedTypedName)
            {
                return column;
            }
        }

        return null;
    }

    static #normaliseName(rawName)
    {
        return String(rawName ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
    }

    static #buildMarkup(member, initialFields, columns)
    {
        const currentTags = Array.isArray(member.tags) ? member.tags.join(", ") : "";
        const fieldRows = initialFields.map(field => EditMemberDialog.#buildFieldRowMarkup(field, columns)).join("");

        return `
            <form class="organization-edit-member-form" onsubmit="return false;">
                <h2 class="admin-panel-add-title">Edit member</h2>
                <p class="admin-panel-add-subtitle">${EditMemberDialog.#escape(member.email || "")}</p>

                <div class="organization-field-table">
                    <div class="organization-field-table-head">
                        <span>Field</span>
                        <span>Value</span>
                        <span></span>
                    </div>
                    <div data-role="fields">${fieldRows}</div>
                </div>

                <div class="organization-field-table-actions">
                    <button type="button" class="organization-secondary-button" data-role="add-field">Add a field</button>
                </div>

                <p class="organization-permission-rule-hint">
                    Pick a field this organization already uses, or choose "Something else…" to name a new
                    one. A new name matching an existing field fills that field in rather than creating a
                    second one. A blank value removes the field from this member, and switching a row to a
                    different field moves the value for this member only — to rename a field for everybody,
                    use Columns on the members screen.
                </p>

                <label class="admin-panel-add-field">
                    <span>Tags</span>
                    <input type="text" data-role="tags" value="${EditMemberDialog.#escape(currentTags)}" placeholder="first-year, scholarship">
                    <small class="organization-permission-rule-hint">Separate tags with commas. These are what rules and credit grants target.</small>
                </label>

                <div class="admin-panel-add-error" hidden></div>
                <div class="admin-panel-add-actions">
                    <button type="button" class="organization-secondary-button organization-edit-member-cancel">Cancel</button>
                    <button type="button" class="admin-panel-add-submit">Save member</button>
                </div>
            </form>
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

export default EditMemberDialog;
