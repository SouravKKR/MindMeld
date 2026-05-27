/**
 * AskAiImageAttachmentManager
 *
 * Owns the image-attach UI for the TextSelectionContextMenu's "Ask"
 * row — the small "+" button beside the contenteditable, the hidden
 * file picker, the thumbnail strip with X-remove handles, and the
 * paste-image interception on the contenteditable.
 *
 * Pulled out of TextSelectionContextMenu to keep that file focused on
 * positioning, dismissal and Explain/Send wiring. Lifetime is tied to
 * the menu — one manager per menu instance, torn down by `detach`
 * when the menu is removed.
 *
 * Images are per-prompt only — NOT persisted to the deck's
 * additionalData (unlike grounding sources). They live in memory until
 * Send/Explain or the menu closes.
 *
 * Caps (client-side; the server enforces matching caps):
 *   - max 4 images per prompt
 *   - max 1600 px longest edge after downsample
 *   - JPEG quality 0.85 for image/jpeg; PNG passthrough otherwise
 */
class AskAiImageAttachmentManager
{
    static #MAX_IMAGES_PER_PROMPT = 4;
    static #MAX_LONGEST_EDGE_PX   = 1600;
    static #JPEG_QUALITY          = 0.85;

    #hostRowElement = null;
    #questionInputElement = null;
    #attachButton = null;
    #fileInputElement = null;
    #thumbnailStripElement = null;
    #attachedImages = [];
    #boundPasteHandler = null;
    #boundChangeHandler = null;
    #boundClickHandler = null;
    #bVisible = true;

    /**
     * @param {HTMLElement} hostRowElement       — the `.text-selection-question-row` div.
     * @param {HTMLElement} questionInputElement — the contenteditable inside it.
     */
    constructor(hostRowElement, questionInputElement)
    {
        this.#hostRowElement = hostRowElement;
        this.#questionInputElement = questionInputElement;
    }

    /**
     * Mount the attach button, hidden file input, and (sibling) thumbnail
     * strip. Idempotent — calling twice is harmless.
     */
    mount()
    {
        if (this.#attachButton)
        {
            return;
        }

        this.#attachButton = document.createElement("button");
        this.#attachButton.type = "button";
        this.#attachButton.className = "ask-ai-image-attach-button";
        this.#attachButton.setAttribute("aria-label", "Attach image");
        this.#attachButton.textContent = "+";

        this.#fileInputElement = document.createElement("input");
        this.#fileInputElement.type = "file";
        this.#fileInputElement.accept = "image/*";
        this.#fileInputElement.multiple = true;
        this.#fileInputElement.style.display = "none";

        // Insert the button at the start of the row so the visual order
        // is [+]  [editor]  [Send]. The file input lives in the row but
        // never renders.
        this.#hostRowElement.insertBefore(this.#attachButton, this.#hostRowElement.firstChild);
        this.#hostRowElement.appendChild(this.#fileInputElement);

        // Thumbnail strip sits AFTER the row (separate row) so the
        // editor doesn't reflow as thumbnails grow.
        this.#thumbnailStripElement = document.createElement("div");
        this.#thumbnailStripElement.className = "ask-ai-image-thumbnail-strip";
        this.#thumbnailStripElement.hidden = true;
        this.#hostRowElement.insertAdjacentElement("afterend", this.#thumbnailStripElement);

        this.#boundClickHandler = () => this.#fileInputElement.click();
        this.#attachButton.addEventListener("click", this.#boundClickHandler);

        this.#boundChangeHandler = (changeEvent) => this.#onFilesPicked(changeEvent);
        this.#fileInputElement.addEventListener("change", this.#boundChangeHandler);

        this.#boundPasteHandler = (pasteEvent) => this.#onPaste(pasteEvent);
        this.#questionInputElement.addEventListener("paste", this.#boundPasteHandler);
    }

    /**
     * Hide / show the entire attach surface. Used by the menu to keep
     * it off the Free-tier flow (Free has no image input).
     */
    setVisible(bVisible)
    {
        this.#bVisible = bVisible;
        if (this.#attachButton) this.#attachButton.hidden = !bVisible;
        if (this.#thumbnailStripElement) this.#thumbnailStripElement.hidden = !bVisible || this.#attachedImages.length === 0;
    }

    /**
     * The session reads this just before fetch — returns a shallow copy
     * of the structured payload (mimeType + base64 data, no DOM refs)
     * so the caller can ship it across the wire without aliasing.
     */
    getAttachedImages()
    {
        return this.#attachedImages.map((attachment) =>
        ({
            mimeType:   attachment.mimeType,
            base64Data: attachment.base64Data,
        }));
    }

    /**
     * Detach all listeners and remove the injected DOM. Called by the
     * menu's disconnectedCallback so we don't leak listeners on rapid
     * selection churn.
     */
    detach()
    {
        if (this.#attachButton)
        {
            this.#attachButton.removeEventListener("click", this.#boundClickHandler);
            this.#attachButton.remove();
            this.#attachButton = null;
        }
        if (this.#fileInputElement)
        {
            this.#fileInputElement.removeEventListener("change", this.#boundChangeHandler);
            this.#fileInputElement.remove();
            this.#fileInputElement = null;
        }
        if (this.#thumbnailStripElement)
        {
            this.#thumbnailStripElement.remove();
            this.#thumbnailStripElement = null;
        }
        if (this.#questionInputElement && this.#boundPasteHandler)
        {
            this.#questionInputElement.removeEventListener("paste", this.#boundPasteHandler);
        }
        this.#boundClickHandler = null;
        this.#boundChangeHandler = null;
        this.#boundPasteHandler = null;
        for (const attachedImage of this.#attachedImages)
        {
            if (attachedImage.thumbnailUrl) URL.revokeObjectURL(attachedImage.thumbnailUrl);
        }
        this.#attachedImages = [];
    }

    async #onFilesPicked(changeEvent)
    {
        const pickedFiles = Array.from(changeEvent.target.files || []);
        // Reset the input so picking the same file twice in a row still
        // fires `change` the second time.
        this.#fileInputElement.value = "";
        for (const pickedFile of pickedFiles)
        {
            if (!pickedFile.type.startsWith("image/")) continue;
            await this.#addImageFile(pickedFile);
        }
    }

    async #onPaste(pasteEvent)
    {
        const clipboardItems = Array.from(pasteEvent.clipboardData?.items || []);
        const imageItems = clipboardItems.filter((clipboardItem) =>
            clipboardItem.kind === "file" && clipboardItem.type.startsWith("image/")
        );
        if (imageItems.length === 0)
        {
            // Not an image paste — let the browser handle plain text /
            // rich text normally.
            return;
        }

        // Image-bearing paste: prevent the contenteditable from
        // swallowing the image into its innerHTML, then route through
        // the same downsample pipeline as the file picker.
        pasteEvent.preventDefault();
        for (const imageItem of imageItems)
        {
            const pastedFile = imageItem.getAsFile();
            if (pastedFile)
            {
                await this.#addImageFile(pastedFile);
            }
        }
    }

    async #addImageFile(imageFile)
    {
        if (this.#attachedImages.length >= AskAiImageAttachmentManager.#MAX_IMAGES_PER_PROMPT)
        {
            console.warn(`[AskAiImageAttachmentManager] Hit ${AskAiImageAttachmentManager.#MAX_IMAGES_PER_PROMPT}-image cap; ignoring extra paste.`);
            return;
        }

        try
        {
            const downsampledResult = await AskAiImageAttachmentManager.#downsampleImageFile(imageFile);
            const attachmentEntry =
            {
                mimeType:     downsampledResult.mimeType,
                base64Data:   downsampledResult.base64Data,
                thumbnailUrl: downsampledResult.thumbnailUrl,
            };
            this.#attachedImages.push(attachmentEntry);
            this.#renderThumbnails();
        }
        catch (downsampleError)
        {
            console.warn(`[AskAiImageAttachmentManager] Failed to attach image: ${downsampleError?.message || downsampleError}`);
        }
    }

    #renderThumbnails()
    {
        if (!this.#thumbnailStripElement) return;
        this.#thumbnailStripElement.innerHTML = "";

        for (let attachedImageIndex = 0; attachedImageIndex < this.#attachedImages.length; attachedImageIndex++)
        {
            const attachedImage = this.#attachedImages[attachedImageIndex];

            const thumbnailWrapper = document.createElement("div");
            thumbnailWrapper.className = "ask-ai-image-thumbnail";

            const imageElement = document.createElement("img");
            imageElement.src = attachedImage.thumbnailUrl;
            imageElement.alt = "Attached image";
            thumbnailWrapper.appendChild(imageElement);

            const removeButton = document.createElement("button");
            removeButton.type = "button";
            removeButton.className = "ask-ai-image-thumbnail-remove";
            removeButton.setAttribute("aria-label", "Remove image");
            removeButton.textContent = "×";
            removeButton.addEventListener("click", () =>
            {
                const removalIndex = this.#attachedImages.indexOf(attachedImage);
                if (removalIndex !== -1)
                {
                    if (attachedImage.thumbnailUrl) URL.revokeObjectURL(attachedImage.thumbnailUrl);
                    this.#attachedImages.splice(removalIndex, 1);
                    this.#renderThumbnails();
                }
            });
            thumbnailWrapper.appendChild(removeButton);

            this.#thumbnailStripElement.appendChild(thumbnailWrapper);
        }

        this.#thumbnailStripElement.hidden = !this.#bVisible || this.#attachedImages.length === 0;
    }

    /**
     * Decode → downsample → re-encode pipeline. Returns:
     *   mimeType:     "image/jpeg" or "image/png"
     *   base64Data:   the re-encoded bytes (no data: prefix)
     *   thumbnailUrl: a blob: URL for in-DOM rendering (caller revokes)
     */
    static async #downsampleImageFile(imageFile)
    {
        const objectUrl = URL.createObjectURL(imageFile);
        try
        {
            const decodedImage = await AskAiImageAttachmentManager.#decodeImage(objectUrl);
            const longestEdge = Math.max(decodedImage.naturalWidth, decodedImage.naturalHeight);
            const scaleFactor = longestEdge > AskAiImageAttachmentManager.#MAX_LONGEST_EDGE_PX
                ? AskAiImageAttachmentManager.#MAX_LONGEST_EDGE_PX / longestEdge
                : 1.0;

            const targetWidth  = Math.max(1, Math.round(decodedImage.naturalWidth  * scaleFactor));
            const targetHeight = Math.max(1, Math.round(decodedImage.naturalHeight * scaleFactor));

            const drawingCanvas = document.createElement("canvas");
            drawingCanvas.width  = targetWidth;
            drawingCanvas.height = targetHeight;
            const drawingContext = drawingCanvas.getContext("2d");
            drawingContext.drawImage(decodedImage, 0, 0, targetWidth, targetHeight);

            const outputMimeType = imageFile.type === "image/png" ? "image/png" : "image/jpeg";
            const outputBlob = await new Promise((resolve) =>
            {
                drawingCanvas.toBlob(
                    (blob) => resolve(blob),
                    outputMimeType,
                    outputMimeType === "image/jpeg" ? AskAiImageAttachmentManager.#JPEG_QUALITY : undefined
                );
            });

            if (!outputBlob)
            {
                throw new Error("toBlob returned null — canvas tainted or browser quirk.");
            }

            const base64Data = await AskAiImageAttachmentManager.#blobToBase64(outputBlob);
            const thumbnailUrl = URL.createObjectURL(outputBlob);

            return { mimeType: outputMimeType, base64Data, thumbnailUrl };
        }
        finally
        {
            URL.revokeObjectURL(objectUrl);
        }
    }

    static #decodeImage(objectUrl)
    {
        return new Promise((resolve, reject) =>
        {
            const imageElement = new Image();
            imageElement.onload  = () => resolve(imageElement);
            imageElement.onerror = (loadError) => reject(loadError);
            imageElement.src = objectUrl;
        });
    }

    static #blobToBase64(blob)
    {
        return new Promise((resolve, reject) =>
        {
            const fileReader = new FileReader();
            fileReader.onloadend = () =>
            {
                const dataUrlString = fileReader.result || "";
                const commaIndex = String(dataUrlString).indexOf(",");
                resolve(commaIndex >= 0 ? String(dataUrlString).slice(commaIndex + 1) : "");
            };
            fileReader.onerror = (readError) => reject(readError);
            fileReader.readAsDataURL(blob);
        });
    }
}

export default AskAiImageAttachmentManager;
