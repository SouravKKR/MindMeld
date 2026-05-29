import DialogBox from "../../../CommonComponents/DialogBox.js";

/**
 * BulkApplyDialog
 *
 * Lets the admin apply a partial field set to many decks at once. Two
 * common scopes:
 *   - "Apply to all subdecks of X" — caller passes deck.bundleChildIds
 *     as the deckIds.
 *   - "Apply to selected decks" — caller passes whatever the admin
 *     checked in the deck list.
 *
 * The dialog itself is scope-agnostic; the title describes the scope
 * so the admin knows what they're committing to.
 *
 * Field policies match the server endpoint:
 *   - assignments: $set field to value (replaces)
 *   - addTags:     $addToSet onto tags (union)
 *   - additionalDataMerge: $set sub-keys under additionalData
 *
 * Fields are opt-in — only fields whose checkbox is checked are sent.
 * That way the admin can apply just "category" to a set without
 * overwriting the other fields.
 */
class BulkApplyDialog
{
    static #BULK_UPDATE_ENDPOINT = "/Admin/PaidDecks/BulkUpdate";

    static show({ title, deckIds })
    {
        return new Promise((resolve) =>
        {
            if (!Array.isArray(deckIds) || deckIds.length === 0)
            {
                DialogBox.alert("Nothing to apply", "There are no decks in this selection.").then(() => resolve(false));
                return;
            }

            const dialog = DialogBox.modal(BulkApplyDialog.#getFormMarkup(title, deckIds));

            const formElement = dialog.querySelector(".bulk-apply-form");
            const cancelButton = dialog.querySelector(".bulk-apply-cancel");
            const submitButton = dialog.querySelector(".bulk-apply-submit");
            const errorElement = dialog.querySelector(".bulk-apply-error");

            let bResolved = false;

            const finalize = (result) =>
            {
                if (bResolved) return;
                bResolved = true;
                dialog.close();
                resolve(result);
            };

            cancelButton.addEventListener("click", () => finalize(false));

            const closeButton = dialog.querySelector(".close-button");
            if (closeButton)
            {
                closeButton.addEventListener("click", () => finalize(false));
            }

            // Enable/disable each value input based on its row checkbox so
            // the admin can't accidentally submit a stale typed value.
            for (const fieldRow of formElement.querySelectorAll(".bulk-apply-field"))
            {
                const checkbox = fieldRow.querySelector(".bulk-apply-field-toggle");
                const inputs = fieldRow.querySelectorAll(".bulk-apply-field-input");

                const sync = () =>
                {
                    for (const input of inputs)
                    {
                        input.disabled = !checkbox.checked;
                    }
                };

                checkbox.addEventListener("change", sync);
                sync();
            }

            submitButton.addEventListener("click", async () =>
            {
                errorElement.textContent = "";
                errorElement.hidden = true;

                const payload = BulkApplyDialog.#collectFormPayload(formElement);
                payload.deckIds = deckIds;

                const hasAssignments = Object.keys(payload.assignments || {}).length > 0;
                const hasTags = Array.isArray(payload.addTags) && payload.addTags.length > 0;
                const hasMerge = Object.keys(payload.additionalDataMerge || {}).length > 0;

                if (!hasAssignments && !hasTags && !hasMerge)
                {
                    errorElement.textContent = "Tick at least one field to apply.";
                    errorElement.hidden = false;
                    return;
                }

                submitButton.disabled = true;
                submitButton.textContent = "Applying…";

                try
                {
                    const response = await fetch(BulkApplyDialog.#BULK_UPDATE_ENDPOINT,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(payload)
                    });

                    if (response.ok)
                    {
                        const responseJson = await response.json();
                        await DialogBox.alert
                        (
                            "Applied",
                            `Updated ${responseJson.modifiedCount}/${responseJson.matchedCount} decks.`
                        );
                        finalize(true);
                        return;
                    }

                    const errorJson = await response.json().catch(() => ({}));
                    errorElement.textContent = errorJson.error || `Bulk update failed (HTTP ${response.status}).`;
                    errorElement.hidden = false;
                }
                catch (applyError)
                {
                    errorElement.textContent = applyError.message;
                    errorElement.hidden = false;
                }
                finally
                {
                    submitButton.disabled = false;
                    submitButton.textContent = "Apply";
                }
            });
        });
    }

    static #getFormMarkup(title, deckIds)
    {
        return `
            <form class="bulk-apply-form" onsubmit="return false;">
                <h2 class="bulk-apply-title">${BulkApplyDialog.#escape(title)}</h2>
                <p class="bulk-apply-subtitle">Tick each field you want to change. ${deckIds.length} deck${deckIds.length === 1 ? "" : "s"} will be updated.</p>

                <div class="bulk-apply-fields">
                    <label class="bulk-apply-field">
                        <input type="checkbox" class="bulk-apply-field-toggle" data-field="category">
                        <span class="bulk-apply-field-label">Category</span>
                        <input type="text" class="bulk-apply-field-input" data-field="category">
                    </label>

                    <label class="bulk-apply-field">
                        <input type="checkbox" class="bulk-apply-field-toggle" data-field="currency">
                        <span class="bulk-apply-field-label">Currency</span>
                        <input type="text" class="bulk-apply-field-input" data-field="currency" maxlength="8">
                    </label>

                    <label class="bulk-apply-field">
                        <input type="checkbox" class="bulk-apply-field-toggle" data-field="basePriceMinor">
                        <span class="bulk-apply-field-label">Base price (minor)</span>
                        <input type="number" class="bulk-apply-field-input" data-field="basePriceMinor" min="0">
                    </label>

                    <label class="bulk-apply-field">
                        <input type="checkbox" class="bulk-apply-field-toggle" data-field="sellerId">
                        <span class="bulk-apply-field-label">Seller ID</span>
                        <input type="text" class="bulk-apply-field-input" data-field="sellerId">
                    </label>

                    <label class="bulk-apply-field">
                        <input type="checkbox" class="bulk-apply-field-toggle" data-field="isPublished">
                        <span class="bulk-apply-field-label">Published</span>
                        <select class="bulk-apply-field-input" data-field="isPublished">
                            <option value="true">Yes</option>
                            <option value="false">No</option>
                        </select>
                    </label>

                    <label class="bulk-apply-field">
                        <input type="checkbox" class="bulk-apply-field-toggle" data-field="addTags">
                        <span class="bulk-apply-field-label">Add tags (comma-separated)</span>
                        <input type="text" class="bulk-apply-field-input" data-field="addTags" placeholder="physics, kcet">
                    </label>

                    <label class="bulk-apply-field">
                        <input type="checkbox" class="bulk-apply-field-toggle" data-field="additionalDataMerge">
                        <span class="bulk-apply-field-label">Merge additionalData (JSON)</span>
                        <textarea class="bulk-apply-field-input" data-field="additionalDataMerge" rows="3" placeholder='{"region":"IN"}'></textarea>
                    </label>
                </div>

                <div class="bulk-apply-error" hidden></div>
                <div class="paid-deck-upload-actions">
                    <button type="button" class="bulk-apply-cancel">Cancel</button>
                    <button type="button" class="bulk-apply-submit">Apply</button>
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

    static #collectFormPayload(formElement)
    {
        const assignments = {};
        const additionalDataMerge = {};
        let addTags = null;

        for (const fieldRow of formElement.querySelectorAll(".bulk-apply-field"))
        {
            const checkbox = fieldRow.querySelector(".bulk-apply-field-toggle");
            if (!checkbox.checked) continue;

            const fieldKey = checkbox.dataset.field;
            const input = fieldRow.querySelector(`.bulk-apply-field-input[data-field="${fieldKey}"]`);
            const rawValue = input.value;

            if (fieldKey === "basePriceMinor")
            {
                assignments[fieldKey] = Number(rawValue) || 0;
            }
            else if (fieldKey === "isPublished")
            {
                assignments[fieldKey] = rawValue === "true";
            }
            else if (fieldKey === "addTags")
            {
                addTags = rawValue
                    .split(",")
                    .map(part => part.trim())
                    .filter(part => part.length > 0);
            }
            else if (fieldKey === "additionalDataMerge")
            {
                try
                {
                    const parsed = JSON.parse(rawValue);
                    if (parsed && typeof parsed === "object")
                    {
                        Object.assign(additionalDataMerge, parsed);
                    }
                }
                catch (parseError)
                {
                    // Invalid JSON is silently dropped; the UI error
                    // message below the form would be a separate
                    // improvement. For now the admin sees "no valid
                    // fields" if this was the only ticked field.
                }
            }
            else
            {
                const trimmed = typeof rawValue === "string" ? rawValue.trim() : rawValue;
                assignments[fieldKey] = trimmed;
            }
        }

        const payload = {};

        if (Object.keys(assignments).length > 0)
        {
            payload.assignments = assignments;
        }

        if (Object.keys(additionalDataMerge).length > 0)
        {
            payload.additionalDataMerge = additionalDataMerge;
        }

        if (addTags !== null && addTags.length > 0)
        {
            payload.addTags = addTags;
        }

        return payload;
    }
}

export default BulkApplyDialog;
