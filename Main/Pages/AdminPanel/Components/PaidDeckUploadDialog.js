import DialogBox from "../../../CommonComponents/DialogBox.js";
import { deckPurchaseGranularity } from "../../../Globals/Enumerations/DeckPurchaseGranularity.js";

/**
 * PaidDeckUploadDialog
 *
 * Full-featured admin upload form. Every PaidDeck metadata field is
 * settable here; the encrypted deck payload itself is pasted as JSON
 * (or, in a future pass, picked from a file). The dialog resolves to
 * `true` on a successful upload so the caller can refresh its list.
 */
class PaidDeckUploadDialog
{
    static #UPLOAD_ENDPOINT = "/Admin/PaidDecks/Upload";

    static show()
    {
        return new Promise((resolve) =>
        {
            const dialog = DialogBox.modal(PaidDeckUploadDialog.#getFormMarkup());

            const formElement = dialog.querySelector(".paid-deck-upload-form");
            const cancelButton = dialog.querySelector(".paid-deck-upload-cancel");
            const submitButton = dialog.querySelector(".paid-deck-upload-submit");
            const errorElement = dialog.querySelector(".paid-deck-upload-error");

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

                const payload = PaidDeckUploadDialog.#collectFormPayload(formElement);

                if (!payload.metadata.title)
                {
                    errorElement.textContent = "Title is required.";
                    errorElement.hidden = false;
                    return;
                }

                if (!payload.deckPayload)
                {
                    errorElement.textContent = "Deck payload JSON is required.";
                    errorElement.hidden = false;
                    return;
                }

                submitButton.disabled = true;
                submitButton.textContent = "Uploading…";

                try
                {
                    const response = await fetch(PaidDeckUploadDialog.#UPLOAD_ENDPOINT,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(payload)
                    });

                    if (response.ok)
                    {
                        finalize(true);
                        return;
                    }

                    const errorJson = await response.json().catch(() => ({}));
                    errorElement.textContent = errorJson.error || `Upload failed (HTTP ${response.status}).`;
                    errorElement.hidden = false;
                }
                catch (uploadError)
                {
                    errorElement.textContent = uploadError.message;
                    errorElement.hidden = false;
                }
                finally
                {
                    submitButton.disabled = false;
                    submitButton.textContent = "Upload";
                }
            });
        });
    }

    static #getFormMarkup()
    {
        return `
            <form class="paid-deck-upload-form" onsubmit="return false;">
                <h2 class="paid-deck-upload-title">Upload a paid deck</h2>
                <p class="paid-deck-upload-subtitle">Every field below is editable here. Paste the deck JSON payload at the bottom — the server encrypts it before storage.</p>

                <div class="paid-deck-upload-grid">
                    <label class="paid-deck-upload-field">
                        <span>Title *</span>
                        <input type="text" name="title" required maxlength="256">
                    </label>

                    <label class="paid-deck-upload-field">
                        <span>Category</span>
                        <input type="text" name="category" maxlength="128">
                    </label>

                    <label class="paid-deck-upload-field paid-deck-upload-field-full">
                        <span>Description</span>
                        <textarea name="description" rows="3" maxlength="4096"></textarea>
                    </label>

                    <label class="paid-deck-upload-field">
                        <span>Seller ID</span>
                        <input type="text" name="sellerId">
                    </label>

                    <label class="paid-deck-upload-field">
                        <span>Thumbnail URL</span>
                        <input type="url" name="thumbnailUrl" maxlength="2048">
                    </label>

                    <label class="paid-deck-upload-field">
                        <span>Base price (minor units)</span>
                        <input type="number" name="basePriceMinor" min="0" value="0">
                    </label>

                    <label class="paid-deck-upload-field">
                        <span>Currency</span>
                        <input type="text" name="currency" value="INR" maxlength="8">
                    </label>

                    <label class="paid-deck-upload-field">
                        <span>Granularity</span>
                        <select name="granularity">
                            <option value="${deckPurchaseGranularity.INDIVIDUAL}">Individually buyable</option>
                            <option value="${deckPurchaseGranularity.BUNDLE_ONLY}">Bundle only</option>
                        </select>
                    </label>

                    <label class="paid-deck-upload-field">
                        <span>Tags (comma-separated)</span>
                        <input type="text" name="tags" placeholder="physics, kcet, class-12">
                    </label>

                    <label class="paid-deck-upload-field">
                        <span>Bundle child IDs (comma-separated)</span>
                        <input type="text" name="bundleChildIds">
                    </label>

                    <label class="paid-deck-upload-field">
                        <span>Parent bundle IDs (comma-separated)</span>
                        <input type="text" name="parentBundleIds">
                    </label>

                    <label class="paid-deck-upload-field paid-deck-upload-field-checkbox">
                        <input type="checkbox" name="isPublished">
                        <span>Publish immediately</span>
                    </label>

                    <div class="paid-deck-upload-field paid-deck-upload-field-full paid-deck-upload-section-divider">
                        <span class="paid-deck-upload-section-heading">Institute (optional)</span>
                    </div>

                    <label class="paid-deck-upload-field">
                        <span>Institute name</span>
                        <input type="text" name="instituteName" maxlength="256" placeholder="Bangalore Institute of Technology">
                    </label>

                    <label class="paid-deck-upload-field">
                        <span>Institute location</span>
                        <input type="text" name="instituteLocation" maxlength="256" placeholder="Bangalore, Karnataka">
                    </label>

                    <label class="paid-deck-upload-field paid-deck-upload-field-full">
                        <span>Institute alternate names (comma-separated)</span>
                        <input type="text" name="instituteAlternateNames" placeholder="BIT, BIT Bangalore">
                    </label>

                    <label class="paid-deck-upload-field paid-deck-upload-field-full">
                        <span>Deck payload JSON *</span>
                        <textarea name="deckPayload" rows="8" placeholder='{"cards":[{"q":"...","a":"..."}],...}'></textarea>
                    </label>

                    <label class="paid-deck-upload-field paid-deck-upload-field-full">
                        <span>Additional data (JSON object, optional)</span>
                        <textarea name="additionalData" rows="3" placeholder='{"sourceFile":"kcet.pdf"}'></textarea>
                    </label>
                </div>

                <div class="paid-deck-upload-error" hidden></div>
                <div class="paid-deck-upload-actions">
                    <button type="button" class="paid-deck-upload-cancel">Cancel</button>
                    <button type="button" class="paid-deck-upload-submit">Upload</button>
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

    static #parseJsonOrNull(rawValue)
    {
        if (typeof rawValue !== "string" || rawValue.trim().length === 0) return null;
        try
        {
            return JSON.parse(rawValue);
        }
        catch (parseError)
        {
            return null;
        }
    }

    static #collectFormPayload(formElement)
    {
        const getValue = (name) => formElement.elements[name]?.value ?? "";
        const getChecked = (name) => Boolean(formElement.elements[name]?.checked);

        const additionalDataRaw = getValue("additionalData");
        const additionalData = additionalDataRaw.trim().length > 0
            ? (PaidDeckUploadDialog.#parseJsonOrNull(additionalDataRaw) || {})
            : {};

        // Merge institute fields into additionalData without clobbering
        // anything the admin hand-pasted into the JSON textarea. The whole
        // institute block is omitted when no name was provided so universal
        // (institute-less) decks stay genuinely universal.
        const instituteName = getValue("instituteName").trim();
        if (instituteName.length > 0)
        {
            additionalData.institute =
            {
                name: instituteName,
                location: getValue("instituteLocation").trim(),
                alternateNames: PaidDeckUploadDialog.#parseCsvList(getValue("instituteAlternateNames"))
            };
        }

        const deckPayload = PaidDeckUploadDialog.#parseJsonOrNull(getValue("deckPayload"));

        const metadata =
        {
            title: getValue("title").trim(),
            category: getValue("category").trim(),
            description: getValue("description").trim(),
            sellerId: getValue("sellerId").trim(),
            thumbnailUrl: getValue("thumbnailUrl").trim(),
            basePriceMinor: Number(getValue("basePriceMinor") || 0),
            currency: getValue("currency").trim().toUpperCase() || "INR",
            granularity: Number(getValue("granularity") || 0),
            tags: PaidDeckUploadDialog.#parseCsvList(getValue("tags")),
            bundleChildIds: PaidDeckUploadDialog.#parseCsvList(getValue("bundleChildIds")),
            parentBundleIds: PaidDeckUploadDialog.#parseCsvList(getValue("parentBundleIds")),
            isPublished: getChecked("isPublished"),
            additionalData: additionalData
        };

        return { metadata, deckPayload };
    }
}

export default PaidDeckUploadDialog;
