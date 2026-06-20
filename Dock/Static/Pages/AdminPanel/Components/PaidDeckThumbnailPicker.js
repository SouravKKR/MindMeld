import DialogBox from "../../../CommonComponents/DialogBox.js";
import PaidDeckThumbnails from "../../../Globals/Classes/PaidDeckThumbnails.js";

/**
 * PaidDeckThumbnailPicker
 *
 * The admin-facing thumbnail authoring tool, in two parts:
 *
 *   1. A MODAL (#show) where the admin either picks one of the built-in
 *      SVG thumbnails (previewed in a grid) or uploads their own image.
 *      Uploaded raster images are downscaled + re-encoded (WebP, JPEG
 *      fallback) so the stored data URL stays small; SVG uploads are kept
 *      verbatim since they're already compact vectors. The modal resolves
 *      to a `{ thumbnailUrl, thumbnailImage }` selection (exactly one set,
 *      or both empty for "use the generic default"), or null on cancel.
 *
 *   2. An inline FIELD (#renderField / #wireField) — a live preview plus a
 *      "Choose thumbnail" button — that the upload and edit dialogs embed.
 *      The live selection is stashed on the field element as
 *      `.thumbnailSelection` so those dialogs can read it back on submit.
 *
 * Selection shape, everywhere:
 *   { thumbnailUrl: string, thumbnailImage: string }
 *     - thumbnailImage set  => an uploaded data URL (wins on render)
 *     - thumbnailUrl set    => a built-in (or external) image URL
 *     - both empty          => fall back to the generic default artwork
 */
class PaidDeckThumbnailPicker
{
    static #MAX_DIMENSION_PIXELS = 512;
    // Rough ceiling on the stored data URL (in characters ≈ 0.75 bytes each).
    // Storefront search returns additionalData inline, so thumbnails must
    // stay light.
    static #MAX_IMAGE_CHARACTERS = 220 * 1024;
    static #COMPRESSION_QUALITY_STEPS = [0.82, 0.7, 0.6, 0.5, 0.4];

    // ── Modal ───────────────────────────────────────────────────────────

    static show(currentSelection = {})
    {
        return new Promise((resolve) =>
        {
            const selection =
            {
                thumbnailUrl: typeof currentSelection.thumbnailUrl === "string" ? currentSelection.thumbnailUrl : "",
                thumbnailImage: typeof currentSelection.thumbnailImage === "string" ? currentSelection.thumbnailImage : ""
            };

            const dialog = DialogBox.modal(PaidDeckThumbnailPicker.#getModalMarkup());

            const previewImage = dialog.querySelector('[data-role="picker-preview"]');
            const previewCaption = dialog.querySelector('[data-role="picker-caption"]');
            const gridElement = dialog.querySelector('[data-role="picker-grid"]');
            const fileInput = dialog.querySelector('[data-role="picker-upload"]');
            const statusElement = dialog.querySelector('[data-role="picker-status"]');
            const clearButton = dialog.querySelector('[data-role="picker-clear"]');
            const confirmButton = dialog.querySelector('[data-role="picker-confirm"]');
            const cancelButton = dialog.querySelector('[data-role="picker-cancel"]');
            const closeButton = dialog.querySelector(".close-button");

            const refreshPreview = () =>
            {
                if (selection.thumbnailImage)
                {
                    previewImage.src = selection.thumbnailImage;
                    previewCaption.textContent = "Uploaded image";
                }
                else if (selection.thumbnailUrl)
                {
                    previewImage.src = selection.thumbnailUrl;
                    previewCaption.textContent = "Built-in thumbnail";
                }
                else
                {
                    previewImage.src = PaidDeckThumbnails.getDefaultThumbnailUrl();
                    previewCaption.textContent = "Default artwork";
                }

                // Reflect the active built-in tile.
                for (const tile of gridElement.querySelectorAll(".paid-deck-thumbnail-picker-tile"))
                {
                    const isActive = !selection.thumbnailImage && tile.dataset.url === selection.thumbnailUrl;
                    tile.classList.toggle("paid-deck-thumbnail-picker-tile-selected", isActive);
                }
            };

            gridElement.innerHTML = PaidDeckThumbnails.getAllThumbnails().map((thumbnail) =>
            {
                return `
                    <button type="button" class="paid-deck-thumbnail-picker-tile" data-url="${PaidDeckThumbnailPicker.#escape(thumbnail.url)}" title="${PaidDeckThumbnailPicker.#escape(thumbnail.label)}">
                        <img class="paid-deck-thumbnail-picker-tile-image" src="${PaidDeckThumbnailPicker.#escape(thumbnail.url)}" alt="${PaidDeckThumbnailPicker.#escape(thumbnail.label)}">
                        <span class="paid-deck-thumbnail-picker-tile-label">${PaidDeckThumbnailPicker.#escape(thumbnail.label)}</span>
                    </button>
                `;
            }).join("");

            gridElement.addEventListener("click", (clickEvent) =>
            {
                const tile = clickEvent.target.closest(".paid-deck-thumbnail-picker-tile");
                if (!tile) return;
                selection.thumbnailUrl = tile.dataset.url || "";
                selection.thumbnailImage = "";
                statusElement.textContent = "";
                refreshPreview();
            });

            fileInput.addEventListener("change", async () =>
            {
                const file = fileInput.files && fileInput.files[0];
                if (!file) return;

                statusElement.textContent = "Processing image…";
                try
                {
                    const dataUrl = await PaidDeckThumbnailPicker.#compressImageFile(file);
                    if (dataUrl.length > PaidDeckThumbnailPicker.#MAX_IMAGE_CHARACTERS)
                    {
                        statusElement.textContent = "That image is too large even after compression — try a smaller one.";
                        return;
                    }
                    selection.thumbnailImage = dataUrl;
                    selection.thumbnailUrl = "";
                    statusElement.textContent = "Image ready.";
                    refreshPreview();
                }
                catch (compressionError)
                {
                    statusElement.textContent = `Could not process that image: ${compressionError.message}`;
                }
                finally
                {
                    // Reset so re-picking the same file fires change again.
                    fileInput.value = "";
                }
            });

            clearButton.addEventListener("click", () =>
            {
                selection.thumbnailUrl = "";
                selection.thumbnailImage = "";
                statusElement.textContent = "";
                refreshPreview();
            });

            const finish = (result) =>
            {
                dialog.close();
                resolve(result);
            };

            confirmButton.addEventListener("click", () => finish({ ...selection }));
            cancelButton.addEventListener("click", () => finish(null));
            if (closeButton)
            {
                closeButton.addEventListener("click", () => finish(null));
            }

            refreshPreview();
        });
    }

    static #getModalMarkup()
    {
        return `
            <form class="paid-deck-thumbnail-picker" onsubmit="return false;">
                <h2 class="paid-deck-thumbnail-picker-title">Choose a thumbnail</h2>
                <p class="paid-deck-thumbnail-picker-subtitle">Pick one of the built-in icons or upload your own image. Leave it on the default to use the generic artwork.</p>

                <div class="paid-deck-thumbnail-picker-preview-row">
                    <img class="paid-deck-thumbnail-picker-preview" data-role="picker-preview" alt="">
                    <div class="paid-deck-thumbnail-picker-preview-side">
                        <span class="paid-deck-thumbnail-picker-caption" data-role="picker-caption"></span>
                        <label class="paid-deck-thumbnail-picker-upload-button">
                            Upload an image…
                            <input type="file" accept="image/*" data-role="picker-upload" hidden>
                        </label>
                        <button type="button" class="paid-deck-thumbnail-picker-clear" data-role="picker-clear">Use default artwork</button>
                        <span class="paid-deck-thumbnail-picker-status" data-role="picker-status"></span>
                    </div>
                </div>

                <div class="paid-deck-thumbnail-picker-grid" data-role="picker-grid"></div>

                <div class="paid-deck-thumbnail-picker-actions">
                    <button type="button" class="paid-deck-thumbnail-picker-cancel" data-role="picker-cancel">Cancel</button>
                    <button type="button" class="paid-deck-thumbnail-picker-confirm" data-role="picker-confirm">Use this thumbnail</button>
                </div>
            </form>
        `;
    }

    // ── Image compression ───────────────────────────────────────────────

    static #readFileAsDataUrl(file)
    {
        return new Promise((resolve, reject) =>
        {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error || new Error("Failed to read the file."));
            reader.readAsDataURL(file);
        });
    }

    static #loadImage(dataUrl)
    {
        return new Promise((resolve, reject) =>
        {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error("the file is not a readable image."));
            image.src = dataUrl;
        });
    }

    static async #compressImageFile(file)
    {
        const originalDataUrl = await PaidDeckThumbnailPicker.#readFileAsDataUrl(file);

        // SVG uploads are already compact vector text and scale perfectly —
        // keep them verbatim rather than rasterising them. (If a pathological
        // SVG is huge, fall through to the raster path which will rasterise
        // and shrink it.)
        if (file.type === "image/svg+xml"
            && originalDataUrl.length <= PaidDeckThumbnailPicker.#MAX_IMAGE_CHARACTERS)
        {
            return originalDataUrl;
        }

        const image = await PaidDeckThumbnailPicker.#loadImage(originalDataUrl);

        const naturalWidth = image.naturalWidth || image.width;
        const naturalHeight = image.naturalHeight || image.height;
        if (!naturalWidth || !naturalHeight)
        {
            throw new Error("the image has no readable dimensions.");
        }

        const scale = Math.min(1, PaidDeckThumbnailPicker.#MAX_DIMENSION_PIXELS / Math.max(naturalWidth, naturalHeight));
        const targetWidth = Math.max(1, Math.round(naturalWidth * scale));
        const targetHeight = Math.max(1, Math.round(naturalHeight * scale));

        const canvas = document.createElement("canvas");
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0, targetWidth, targetHeight);

        // Prefer WebP (much smaller); browsers that can't encode it make
        // toDataURL silently return PNG, in which case fall back to JPEG.
        const supportsWebp = canvas.toDataURL("image/webp").startsWith("data:image/webp");
        const mimeType = supportsWebp ? "image/webp" : "image/jpeg";

        let encoded = canvas.toDataURL(mimeType, PaidDeckThumbnailPicker.#COMPRESSION_QUALITY_STEPS[0]);
        for (const quality of PaidDeckThumbnailPicker.#COMPRESSION_QUALITY_STEPS)
        {
            encoded = canvas.toDataURL(mimeType, quality);
            if (encoded.length <= PaidDeckThumbnailPicker.#MAX_IMAGE_CHARACTERS)
            {
                break;
            }
        }
        return encoded;
    }

    // ── Inline field (embedded by the upload / edit dialogs) ─────────────

    /**
     * Markup for an inline thumbnail field: a live preview + a "Choose
     * thumbnail" button. `roleName` is the data-role the host dialog uses
     * to find this field; it must be unique within the dialog. The preview
     * src is set by #wireField (which runs right after the markup mounts),
     * so it isn't embedded here.
     */
    static renderField(roleName)
    {
        return `
            <div class="paid-deck-thumbnail-field" data-role="${PaidDeckThumbnailPicker.#escape(roleName)}">
                <img class="paid-deck-thumbnail-field-preview" data-role="thumbnail-preview" alt="">
                <div class="paid-deck-thumbnail-field-controls">
                    <button type="button" class="paid-deck-thumbnail-field-button" data-role="thumbnail-pick">Choose thumbnail…</button>
                    <span class="paid-deck-thumbnail-field-hint" data-role="thumbnail-hint"></span>
                </div>
            </div>
        `;
    }

    /**
     * Wires a field rendered by #renderField. Stashes the live selection on
     * the field element as `.thumbnailSelection` so the host dialog can read
     * it back on submit via #readSelection.
     */
    static wireField(fieldElement, initialSelection = {})
    {
        if (!fieldElement) return;

        const previewImage = fieldElement.querySelector('[data-role="thumbnail-preview"]');
        const pickButton = fieldElement.querySelector('[data-role="thumbnail-pick"]');
        const hintElement = fieldElement.querySelector('[data-role="thumbnail-hint"]');

        const selection =
        {
            thumbnailUrl: typeof initialSelection.thumbnailUrl === "string" ? initialSelection.thumbnailUrl : "",
            thumbnailImage: typeof initialSelection.thumbnailImage === "string" ? initialSelection.thumbnailImage : ""
        };
        fieldElement.thumbnailSelection = selection;

        const refreshPreview = () =>
        {
            if (selection.thumbnailImage)
            {
                previewImage.src = selection.thumbnailImage;
                hintElement.textContent = "Uploaded image";
            }
            else if (selection.thumbnailUrl)
            {
                previewImage.src = selection.thumbnailUrl;
                hintElement.textContent = "Built-in thumbnail";
            }
            else
            {
                previewImage.src = PaidDeckThumbnails.getDefaultThumbnailUrl();
                hintElement.textContent = "Default artwork";
            }
        };
        refreshPreview();

        pickButton.addEventListener("click", async () =>
        {
            const result = await PaidDeckThumbnailPicker.show(selection);
            if (!result) return;
            selection.thumbnailUrl = result.thumbnailUrl || "";
            selection.thumbnailImage = result.thumbnailImage || "";
            refreshPreview();
        });
    }

    /** Reads the live selection off a wired field element. */
    static readSelection(fieldElement)
    {
        const selection = fieldElement && fieldElement.thumbnailSelection;
        return {
            thumbnailUrl: (selection && typeof selection.thumbnailUrl === "string") ? selection.thumbnailUrl : "",
            thumbnailImage: (selection && typeof selection.thumbnailImage === "string") ? selection.thumbnailImage : ""
        };
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

export default PaidDeckThumbnailPicker;
