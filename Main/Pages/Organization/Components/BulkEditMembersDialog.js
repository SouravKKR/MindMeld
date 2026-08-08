import DialogBox from "../../../CommonComponents/DialogBox.js";
import OrganizationErrorMessages from "../../../Globals/Classes/Organization/OrganizationErrorMessages.js";

/**
 * BulkEditMembersDialog
 *
 * Applies one change to many members at once — the checked selection, or
 * everyone the current filter matches.
 *
 * Two things about its shape are deliberate.
 *
 * Fields are OPT-IN: only a ticked row is sent, and its inputs stay disabled
 * until it is ticked. A bulk edit that submitted every box on the form would
 * blank the columns the administrator never looked at, and a stale value typed
 * before an untick would go along with it.
 *
 * Tags are ADDED and REMOVED rather than replaced. A selection is a set of
 * people who differ from one another; replacing the tag list across forty
 * members would strip whatever each of them carried that the others did not.
 * Replacing is still offered, but only as a choice made on purpose.
 *
 * The filter-scoped mode asks the server how many people match BEFORE applying
 * anything, and puts that number in the confirmation. The whole risk of editing
 * by filter is that a filter reaches further than the person writing it expects,
 * and the only honest guard is to say the real number out loud first.
 */
class BulkEditMembersDialog
{
    static #BULK_UPDATE_ENDPOINT = "/Organization/Members/BulkUpdate";
    static #UPDATE_BY_FILTER_ENDPOINT = "/Organization/Members/UpdateByFilter";

    /**
     * @param {{organizationId: string, columns: Array<object>, memberIds?: string[],
     *          filterScope?: {search: string, filters: object}, scopeDescription: string}} context
     * @returns {Promise<boolean>} whether anything was applied
     */
    static show({ organizationId, columns, memberIds, filterScope, scopeDescription })
    {
        return new Promise((resolve) =>
        {
            const safeColumns = Array.isArray(columns) ? columns : [];
            const bFilterScoped = !Array.isArray(memberIds);

            const dialog = DialogBox.modal(BulkEditMembersDialog.#buildMarkup(safeColumns, scopeDescription, bFilterScoped));

            const formElement = dialog.querySelector(".organization-bulk-edit-form");
            const errorElement = dialog.querySelector(".admin-panel-add-error");
            const submitButton = dialog.querySelector(".admin-panel-add-submit");
            const cancelButton = dialog.querySelector(".organization-bulk-edit-cancel");
            const closeButton = dialog.querySelector(".close-button");
            const statusElement = dialog.querySelector(".organization-bulk-edit-status");

            let bResolved = false;
            const finalize = (bApplied) =>
            {
                if (bResolved)
                {
                    return;
                }
                bResolved = true;
                dialog.close();
                resolve(bApplied);
            };

            cancelButton.addEventListener("click", () => finalize(false));
            if (closeButton)
            {
                closeButton.addEventListener("click", () => finalize(false));
            }

            // A value input stays disabled until its row is ticked, so a value
            // typed and then unticked can never be submitted by accident.
            const bindFieldRows = () =>
            {
                for (const fieldRow of formElement.querySelectorAll(".organization-bulk-edit-field"))
                {
                    if (fieldRow.dataset.bound === "true")
                    {
                        continue;
                    }
                    fieldRow.dataset.bound = "true";

                    const toggleCheckbox = fieldRow.querySelector(".organization-bulk-edit-toggle");
                    const valueInputs = fieldRow.querySelectorAll(".organization-bulk-edit-input, .organization-bulk-edit-name");

                    const synchroniseEnabledState = () =>
                    {
                        for (const valueInput of valueInputs)
                        {
                            valueInput.disabled = !toggleCheckbox.checked;
                        }
                    };

                    toggleCheckbox.addEventListener("change", synchroniseEnabledState);
                    synchroniseEnabledState();
                }
            };

            bindFieldRows();

            // An institute whose roster arrived as bare email addresses has no
            // columns at all, and one that is inventing a field mid-term has no
            // column for it yet. Offering only what already exists would make
            // this screen useless in exactly those cases.
            formElement.querySelector('[data-role="add-field"]').addEventListener("click", () =>
            {
                const fieldsHost = formElement.querySelector(".organization-bulk-edit-fields");
                fieldsHost.insertAdjacentHTML("beforeend", `
                    <label class="organization-bulk-edit-field">
                        <input type="checkbox" class="organization-bulk-edit-toggle" data-field="newAttribute" checked>
                        <input type="text" class="organization-bulk-edit-name" data-role="new-field-name" maxlength="128" placeholder="Field name">
                        <input type="text" class="organization-bulk-edit-input" maxlength="256" placeholder="Value for everyone selected">
                    </label>
                `);

                bindFieldRows();
                fieldsHost.lastElementChild.querySelector('[data-role="new-field-name"]').focus();
            });

            submitButton.addEventListener("click", async () =>
            {
                errorElement.hidden = true;
                statusElement.textContent = "";

                const mutation = BulkEditMembersDialog.#collectMutation(formElement);
                if (mutation === null)
                {
                    errorElement.hidden = false;
                    errorElement.textContent = "Tick at least one thing to change.";
                    return;
                }

                submitButton.disabled = true;
                const originalLabel = submitButton.textContent;

                try
                {
                    if (bFilterScoped)
                    {
                        submitButton.textContent = "Checking…";
                        const bConfirmed = await BulkEditMembersDialog.#confirmFilterScope(organizationId, filterScope, mutation, errorElement);
                        if (!bConfirmed)
                        {
                            return;
                        }
                    }

                    submitButton.textContent = "Applying…";

                    const endpoint = bFilterScoped ? BulkEditMembersDialog.#UPDATE_BY_FILTER_ENDPOINT : BulkEditMembersDialog.#BULK_UPDATE_ENDPOINT;
                    const payload = bFilterScoped
                        ? { organizationId: organizationId, search: filterScope.search, filters: filterScope.filters, ...mutation }
                        : { organizationId: organizationId, memberIds: memberIds, ...mutation };

                    const response = await fetch(endpoint,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(payload)
                    });

                    const responseJson = await response.json().catch(() => ({}));

                    if (!response.ok || responseJson.success === false)
                    {
                        errorElement.hidden = false;
                        errorElement.textContent = OrganizationErrorMessages.describe(responseJson.error, response.status);
                        return;
                    }

                    const updatedCount = bFilterScoped ? responseJson.updated : responseJson.summary?.updated;
                    const truncationNote = responseJson.truncated
                        ? " Some members beyond the limit for one request were left unchanged — run it again to finish them."
                        : "";

                    await DialogBox.alert("Applied", `${updatedCount} member${updatedCount === 1 ? "" : "s"} updated.${truncationNote}`);
                    finalize(true);
                }
                catch (applyError)
                {
                    errorElement.hidden = false;
                    errorElement.textContent = applyError.message || "Could not apply the change.";
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
     * Asks the server how many members the filter reaches and makes the
     * administrator confirm that real number.
     */
    static async #confirmFilterScope(organizationId, filterScope, mutation, errorElement)
    {
        const response = await fetch(BulkEditMembersDialog.#UPDATE_BY_FILTER_ENDPOINT,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify
            ({
                organizationId: organizationId,
                search: filterScope.search,
                filters: filterScope.filters,
                dryRun: true,
                ...mutation
            })
        });

        const responseJson = await response.json().catch(() => ({}));

        if (!response.ok || responseJson.success === false)
        {
            errorElement.hidden = false;
            errorElement.textContent = OrganizationErrorMessages.describe(responseJson.error, response.status);
            return false;
        }

        if (responseJson.matchedCount === 0)
        {
            errorElement.hidden = false;
            errorElement.textContent = "No members match the current filter, so there is nothing to change.";
            return false;
        }

        const sampleEmails = Array.isArray(responseJson.sample) ? responseJson.sample.map(entry => entry.email) : [];
        const sampleText = sampleEmails.length > 0 ? `\n\nFor example: ${sampleEmails.slice(0, 5).join(", ")}` : "";

        return await DialogBox.confirm
        (
            "Apply to everyone filtered?",
            `${responseJson.matchedCount} member${responseJson.matchedCount === 1 ? "" : "s"} match the current filter and will be changed.${sampleText}`
        );
    }

    static #collectMutation(formElement)
    {
        const mutation = {};
        const setAttributes = {};
        const clearAttributeKeys = [];

        for (const fieldRow of formElement.querySelectorAll(".organization-bulk-edit-field"))
        {
            const toggleCheckbox = fieldRow.querySelector(".organization-bulk-edit-toggle");
            if (!toggleCheckbox.checked)
            {
                continue;
            }

            const fieldName = toggleCheckbox.dataset.field;
            const valueInput = fieldRow.querySelector(".organization-bulk-edit-input");
            const rawValue = valueInput ? valueInput.value : "";

            if (fieldName === "addTags" || fieldName === "removeTags" || fieldName === "replaceTags")
            {
                mutation[fieldName] = rawValue
                    .split(",")
                    .map(tagText => tagText.trim())
                    .filter(tagText => tagText.length > 0);
                continue;
            }

            if (fieldName === "attribute")
            {
                const attributeKey = valueInput.dataset.attributeKey;
                const attributeValue = rawValue.trim();

                if (attributeValue.length === 0)
                {
                    clearAttributeKeys.push(attributeKey);
                }
                else
                {
                    setAttributes[attributeKey] = attributeValue;
                }
                continue;
            }

            if (fieldName === "newAttribute")
            {
                // A field being invented here has its NAME typed alongside its
                // value. The server derives the stored key from that name the
                // same way it does from a spreadsheet header, so "Join Year"
                // typed here and uploaded later land on one field, not two.
                const newFieldName = fieldRow.querySelector('[data-role="new-field-name"]').value.trim();
                const newFieldValue = rawValue.trim();

                if (newFieldName.length > 0 && newFieldValue.length > 0)
                {
                    setAttributes[newFieldName] = newFieldValue;
                }
            }
        }

        if (Object.keys(setAttributes).length > 0)
        {
            mutation.setAttributes = setAttributes;
        }
        if (clearAttributeKeys.length > 0)
        {
            mutation.clearAttributeKeys = clearAttributeKeys;
        }

        // Replacing and adjusting the tag set are contradictory instructions, so
        // the server refuses both together; caught here to say so in plainer
        // words than an error code.
        if (Array.isArray(mutation.replaceTags) && (Array.isArray(mutation.addTags) || Array.isArray(mutation.removeTags)))
        {
            return null;
        }

        return Object.keys(mutation).length > 0 ? mutation : null;
    }

    static #buildMarkup(columns, scopeDescription, bFilterScoped)
    {
        const columnFields = columns.map(column => `
            <label class="organization-bulk-edit-field">
                <input type="checkbox" class="organization-bulk-edit-toggle" data-field="attribute">
                <span class="organization-bulk-edit-label">${BulkEditMembersDialog.#escape(column.label)}</span>
                <input type="text" class="organization-bulk-edit-input" data-attribute-key="${BulkEditMembersDialog.#escape(column.key)}" maxlength="256" placeholder="Leave blank to clear">
            </label>
        `).join("");

        return `
            <form class="organization-bulk-edit-form" onsubmit="return false;">
                <h2 class="admin-panel-add-title">Edit members</h2>
                <p class="admin-panel-add-subtitle">${BulkEditMembersDialog.#escape(scopeDescription)}</p>
                <p class="admin-panel-add-subtitle">Tick only what you want to change. Anything left unticked is not touched.</p>

                <div class="organization-bulk-edit-fields">
                    <label class="organization-bulk-edit-field">
                        <input type="checkbox" class="organization-bulk-edit-toggle" data-field="addTags">
                        <span class="organization-bulk-edit-label">Add tags</span>
                        <input type="text" class="organization-bulk-edit-input" placeholder="scholarship, merit">
                    </label>

                    <label class="organization-bulk-edit-field">
                        <input type="checkbox" class="organization-bulk-edit-toggle" data-field="removeTags">
                        <span class="organization-bulk-edit-label">Remove tags</span>
                        <input type="text" class="organization-bulk-edit-input" placeholder="first-year">
                    </label>

                    <label class="organization-bulk-edit-field">
                        <input type="checkbox" class="organization-bulk-edit-toggle" data-field="replaceTags">
                        <span class="organization-bulk-edit-label">Replace every tag with</span>
                        <input type="text" class="organization-bulk-edit-input" placeholder="final-year">
                    </label>

                    ${columnFields}
                </div>

                <div class="organization-field-table-actions">
                    <button type="button" class="organization-secondary-button" data-role="add-field">Set a field that does not exist yet</button>
                </div>

                <p class="organization-bulk-edit-status"></p>
                <div class="admin-panel-add-error" hidden></div>
                <div class="admin-panel-add-actions">
                    <button type="button" class="organization-secondary-button organization-bulk-edit-cancel">Cancel</button>
                    <button type="button" class="admin-panel-add-submit">${bFilterScoped ? "Check and apply" : "Apply"}</button>
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

export default BulkEditMembersDialog;
