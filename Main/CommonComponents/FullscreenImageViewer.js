/**
 * FullscreenImageViewer
 *
 * Shared lightbox for displaying a single image at full viewport size with
 * a comfortably-sized close affordance. Used by both the tutorial lifecycle
 * diagram zoom and the study modal's "Learn More" knowledge-consolidation
 * diagram so behaviour stays identical.
 *
 * Stacking: sits at z-index 2147483600, above the tutorial overlay mask
 * (2147483500) so the lightbox always wins.
 *
 * Dismissal: ESC key, backdrop click, or close button. Image clicks are
 * absorbed so pinch / long-press interactions don't accidentally dismiss.
 */
import PopupStack from "../Globals/Classes/PopupStack.js";

class FullscreenImageViewer
{
    static OVERLAY_CLASS_NAME = "fullscreen-image-viewer";
    static CLOSE_BUTTON_CLASS_NAME = "fullscreen-image-viewer-close";

    static open(imageSourceUrl, imageAltText = "")
    {
        const overlayElement = document.createElement("div");
        overlayElement.className = FullscreenImageViewer.OVERLAY_CLASS_NAME;
        overlayElement.innerHTML =
        `
            <img src="${imageSourceUrl}" alt="${imageAltText}">
            <button type="button" class="${FullscreenImageViewer.CLOSE_BUTTON_CLASS_NAME}" aria-label="Close fullscreen">&times;</button>
        `;

        // Escape dismissal routes through the PopupStack so the global Escape
        // handler closes the lightbox instead of navigating the page away.
        let popupStackHandle = null;

        const dismiss = () =>
        {
            overlayElement.remove();
            PopupStack.unregister(popupStackHandle);
            popupStackHandle = null;
        };

        popupStackHandle = PopupStack.register({ dismiss });

        overlayElement.addEventListener("click", dismiss);

        const closeButton = overlayElement.querySelector("." + FullscreenImageViewer.CLOSE_BUTTON_CLASS_NAME);
        closeButton.addEventListener("click", (closeClickEvent) =>
        {
            closeClickEvent.stopPropagation();
            dismiss();
        });

        const imageElement = overlayElement.querySelector("img");
        if(imageElement)
        {
            imageElement.addEventListener("click", (imageClickEvent) =>
            {
                imageClickEvent.stopPropagation();
            });
        }

        document.body.appendChild(overlayElement);

        return { close: dismiss };
    }
}

export default FullscreenImageViewer;
window.FullscreenImageViewer = FullscreenImageViewer;
