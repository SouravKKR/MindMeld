import DialogBox from "../../../CommonComponents/DialogBox.js";
import { deckPurchaseGranularity } from "../../../Globals/Enumerations/DeckPurchaseGranularity.js";

/**
 * PaidDeckEditDialog
 *
 * Edit form for a single existing PaidDeck. Pre-populates the same
 * fields PaidDeckUploadDialog collects; only sends fields the server's
 * /Admin/PaidDecks/Update accepts.
 */
class PaidDeckEditDialog
{
    static #UPDATE_ENDPOINT = "/Admin/PaidDecks/Update";

    static show(deck)
    {
        return new Promise((resolve) =>
        {
            const dialog = DialogBox.modal(PaidDeckEditDialog.#getFormMarkup(deck));

            const formElement = dialog.querySelector(".paid-deck-edit-form");
            const cancelButton = dialog.querySelector(".paid-deck-edit-cancel");
            const submitButton = dialog.querySelector(".paid-deck-edit-submit");
            const errorElement = dialog.querySelector(".paid-deck-edit-error");

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

            submitButton.addEventListener("click", async () =>
            {
                errorElement.textContent = "";
                errorElement.hidden = true;

                const updates = PaidDeckEditDialog.#collectFormUpdates(formElement, deck);

                submitButton.disabled = true;
                submitButton.textContent = "Saving…";

                try
                {
                    const response = await fetch(PaidDeckEditDialog.#UPDATE_ENDPOINT,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ id: deck.id, updates: updates })
                    });

                    if (response.ok)
                    {
                        finalize(true);
                        return;
                    }

                    const errorJson = await response.json().catch(() => ({}));
                    errorElement.textContent = errorJson.error || `Save failed (HTTP ${response.status}).`;
                    errorElement.hidden = false;
                }
                catch (saveError)
                {
                    errorElement.textContent = saveError.message;
                    errorElement.hidden = false;
                }
                finally
                {
                    submitButton.disabled = false;
                    submitButton.textContent = "Save";
                }
            });
        });
    }

    static #escape(rawValue)
    {
        return String(rawValue ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    static #getFormMarkup(deck)
    {
        const tagsJoined = Array.isArray(deck.tags) ? deck.tags.join(", ") : "";
        const bundleChildIdsJoined = Array.isArray(deck.bundleChildIds) ? deck.bundleChildIds.join(", ") : "";
        const parentBundleIdsJoined = Array.isArray(deck.parentBundleIds) ? deck.parentBundleIds.join(", ") : "";

        const existingInstitute = (deck.additionalData && typeof deck.additionalData === "object" && deck.additionalData.institute)
            ? deck.additionalData.institute
            : {};
        const instituteNameValue = typeof existingInstitute.name === "string" ? existingInstitute.name : "";
        const instituteLocationValue = typeof existingInstitute.location === "string" ? existingInstitute.location : "";
        const instituteAlternateNamesValue = Array.isArray(existingInstitute.alternateNames) ? existingInstitute.alternateNames.join(", ") : "";

        return `
            <form class="paid-deck-edit-form" onsubmit="return false;">
                <h2 class="paid-deck-edit-title">Edit ${PaidDeckEditDialog.#escape(deck.title)}</h2>

                <div class="paid-deck-upload-grid">
                    <label class="paid-deck-upload-field">
                        <span>Title</span>
                        <input type="text" name="title" maxlength="256" value="${PaidDeckEditDialog.#escape(deck.title)}">
                    </label>

                    <label class="paid-deck-upload-field">
                        <span>Category</span>
                        <input type="text" name="category" maxlength="128" value="${PaidDeckEditDialog.#escape(deck.category)}">
                    </label>

                    <label class="paid-deck-upload-field paid-deck-upload-field-full">
                        <span>Description</span>
                        <textarea name="description" rows="3" maxlength="4096">${PaidDeckEditDialog.#escape(deck.description)}</textarea>
                    </label>

                    <label class="paid-deck-upload-field">
                        <span>Thumbnail URL</span>
                        <input type="url" name="thumbnailUrl" maxlength="2048" value="${PaidDeckEditDialog.#escape(deck.thumbnailUrl)}">
                    </label>

                    <label class="paid-deck-upload-field">
                        <span>Base price (minor units)</span>
                        <input type="number" name="basePriceMinor" min="0" value="${Number(deck.basePriceMinor) || 0}">
                    </label>

                    <label class="paid-deck-upload-field">
                        <span>Currency</span>
                        <input type="text" name="currency" maxlength="8" value="${PaidDeckEditDialog.#escape(deck.currency || "INR")}">
                    </label>

                    <label class="paid-deck-upload-field">
                        <span>Granularity</span>
                        <select name="granularity">
                            <option value="${deckPurchaseGranularity.INDIVIDUAL}" ${deck.granularity === deckPurchaseGranularity.INDIVIDUAL ? "selected" : ""}>Individually buyable</option>
                            <option value="${deckPurchaseGranularity.BUNDLE_ONLY}" ${deck.granularity === deckPurchaseGranularity.BUNDLE_ONLY ? "selected" : ""}>Bundle only</option>
                        </select>
                    </label>

                    <label class="paid-deck-upload-field">
                        <span>Tags (comma-separated)</span>
                        <input type="text" name="tags" value="${PaidDeckEditDialog.#escape(tagsJoined)}">
                    </label>

                    <label class="paid-deck-upload-field">
                        <span>Bundle child IDs (comma-separated)</span>
                        <input type="text" name="bundleChildIds" value="${PaidDeckEditDialog.#escape(bundleChildIdsJoined)}">
                    </label>

                    <label class="paid-deck-upload-field">
                        <span>Parent bundle IDs (comma-separated)</span>
                        <input type="text" name="parentBundleIds" value="${PaidDeckEditDialog.#escape(parentBundleIdsJoined)}">
                    </label>

                    <label class="paid-deck-upload-field paid-deck-upload-field-checkbox">
                        <input type="checkbox" name="isPublished" ${deck.isPublished ? "checked" : ""}>
                        <span>Published</span>
                    </label>

                    <div class="paid-deck-upload-field paid-deck-upload-field-full paid-deck-upload-section-divider">
                        <span class="paid-deck-upload-section-heading">Institute (optional)</span>
                    </div>

                    <label class="paid-deck-upload-field">
                        <span>Institute name</span>
                        <input type="text" name="instituteName" maxlength="256" value="${PaidDeckEditDialog.#escape(instituteNameValue)}" placeholder="Bangalore Institute of Technology">
                    </label>

                    <label class="paid-deck-upload-field">
                        <span>Institute location</span>
                        <input type="text" name="instituteLocation" maxlength="256" value="${PaidDeckEditDialog.#escape(instituteLocationValue)}" placeholder="Bangalore, Karnataka">
                    </label>

                    <label class="paid-deck-upload-field paid-deck-upload-field-full">
                        <span>Institute alternate names (comma-separated)</span>
                        <input type="text" name="instituteAlternateNames" value="${PaidDeckEditDialog.#escape(instituteAlternateNamesValue)}" placeholder="BIT, BIT Bangalore">
                    </label>
                </div>

                <div class="paid-deck-edit-error" hidden></div>
                <div class="paid-deck-upload-actions">
                    <button type="button" class="paid-deck-edit-cancel">Cancel</button>
                    <button type="button" class="paid-deck-edit-submit">Save</button>
                </div>
            </form>
        `;
    }

    static #parseCsvList(rawValue)
    {
        if (typeof rawValue !== "string" || rawValue.trim().length === 0) return [];
        return rawValue
            .split(",")
            .map(part => part.trim())
            .filter(part => part.length > 0);
    }

    static #collectFormUpdates(formElement, deck)
    {
        const getValue = (name) => formElement.elements[name]?.value ?? "";
        const getChecked = (name) => Boolean(formElement.elements[name]?.checked);

        // Start from the deck's existing additionalData so other keys the
        // admin set out-of-band (sourceFile, internalNotes, etc.) survive
        // an institute edit instead of being silently wiped.
        const mergedAdditionalData = (deck && deck.additionalData && typeof deck.additionalData === "object")
            ? { ...deck.additionalData }
            : {};

        const instituteName = getValue("instituteName").trim();
        if (instituteName.length > 0)
        {
            mergedAdditionalData.institute =
            {
                name: instituteName,
                location: getValue("instituteLocation").trim(),
                alternateNames: PaidDeckEditDialog.#parseCsvList(getValue("instituteAlternateNames"))
            };
        }
        else
        {
            // Clearing the name field intentionally removes the institute
            // entirely — admins shouldn't have to manually scrub it from the
            // additionalData JSON when they want to make a deck universal.
            delete mergedAdditionalData.institute;
        }

        return {
            title: getValue("title").trim(),
            category: getValue("category").trim(),
            description: getValue("description").trim(),
            thumbnailUrl: getValue("thumbnailUrl").trim(),
            basePriceMinor: Number(getValue("basePriceMinor") || 0),
            currency: getValue("currency").trim().toUpperCase() || "INR",
            granularity: Number(getValue("granularity") || 0),
            tags: PaidDeckEditDialog.#parseCsvList(getValue("tags")),
            bundleChildIds: PaidDeckEditDialog.#parseCsvList(getValue("bundleChildIds")),
            parentBundleIds: PaidDeckEditDialog.#parseCsvList(getValue("parentBundleIds")),
            isPublished: getChecked("isPublished"),
            additionalData: mergedAdditionalData
        };
    }
}

export default PaidDeckEditDialog;
