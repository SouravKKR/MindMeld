const imageResizeHandlePositions = Object.freeze(
{
    NORTH_WEST : "nw",
    NORTH      : "n",
    NORTH_EAST : "ne",
    EAST       : "e",
    SOUTH_EAST : "se",
    SOUTH      : "s",
    SOUTH_WEST : "sw",
    WEST       : "w",
});

const imageResizeLimits = Object.freeze(
{
    minimumWidth  : 20,
    minimumHeight : 20,
});

let currentlyActiveOverlay = null;

export function applyImageResizeDecorator(editableElement)
{
    const overlay = document.createElement("div");
    overlay.className = "image-resize-overlay";
    document.body.appendChild(overlay);

    for (const position of Object.values(imageResizeHandlePositions))
    {
        const handle = document.createElement("div");
        handle.className              = `image-resize-handle image-resize-handle-${position}`;
        handle.dataset.handlePosition = position;
        overlay.appendChild(handle);
    }

    let targetImage          = null;
    let activeHandlePosition = null;
    let dragStartX           = 0;
    let dragStartY           = 0;
    let originalWidth        = 0;
    let originalHeight       = 0;
    let aspectRatio          = 1;

    function repositionOverlay()
    {
        if (!targetImage) return;

        const rect = targetImage.getBoundingClientRect();
        overlay.style.left   = `${rect.left}px`;
        overlay.style.top    = `${rect.top}px`;
        overlay.style.width  = `${rect.width}px`;
        overlay.style.height = `${rect.height}px`;
    }

    function showOverlay(image)
    {
        if (currentlyActiveOverlay && currentlyActiveOverlay !== overlay)
        {
            currentlyActiveOverlay.classList.remove("visible");
        }

        targetImage            = image;
        currentlyActiveOverlay = overlay;
        overlay.classList.add("visible");
        repositionOverlay();
    }

    function hideOverlay()
    {
        targetImage = null;
        overlay.classList.remove("visible");

        if (currentlyActiveOverlay === overlay)
        {
            currentlyActiveOverlay = null;
        }
    }

    editableElement.addEventListener("click", (event) =>
    {
        if (event.target instanceof HTMLImageElement)
        {
            showOverlay(event.target);
        }
        else if (!overlay.contains(event.target))
        {
            hideOverlay();
        }
    });

    for (const handle of overlay.querySelectorAll(".image-resize-handle"))
    {
        handle.addEventListener("pointerdown", (event) =>
        {
            if (!targetImage) return;

            event.preventDefault();

            activeHandlePosition = handle.dataset.handlePosition;
            dragStartX           = event.clientX;
            dragStartY           = event.clientY;
            originalWidth        = targetImage.offsetWidth  || targetImage.naturalWidth;
            originalHeight       = targetImage.offsetHeight || targetImage.naturalHeight;
            aspectRatio          = originalHeight > 0 ? originalWidth / originalHeight : 1;

            handle.setPointerCapture(event.pointerId);

            document.body.style.cursor     = getComputedStyle(handle).cursor;
            document.body.style.userSelect = "none";
        });

        handle.addEventListener("pointermove", (event) =>
        {
            if (!activeHandlePosition || !targetImage) return;

            const deltaX = event.clientX - dragStartX;
            const deltaY = event.clientY - dragStartY;

            let newWidth  = originalWidth;
            let newHeight = originalHeight;

            switch (activeHandlePosition)
            {
                case imageResizeHandlePositions.EAST:
                    newWidth = originalWidth + deltaX;
                    break;

                case imageResizeHandlePositions.WEST:
                    newWidth = originalWidth - deltaX;
                    break;

                case imageResizeHandlePositions.SOUTH:
                    newHeight = originalHeight + deltaY;
                    break;

                case imageResizeHandlePositions.NORTH:
                    newHeight = originalHeight - deltaY;
                    break;

                case imageResizeHandlePositions.SOUTH_EAST:
                    newWidth  = originalWidth + deltaX;
                    newHeight = newWidth / aspectRatio;
                    break;

                case imageResizeHandlePositions.SOUTH_WEST:
                    newWidth  = originalWidth - deltaX;
                    newHeight = newWidth / aspectRatio;
                    break;

                case imageResizeHandlePositions.NORTH_EAST:
                    newWidth  = originalWidth + deltaX;
                    newHeight = newWidth / aspectRatio;
                    break;

                case imageResizeHandlePositions.NORTH_WEST:
                    newWidth  = originalWidth - deltaX;
                    newHeight = newWidth / aspectRatio;
                    break;
            }

            newWidth  = Math.max(imageResizeLimits.minimumWidth,  newWidth);
            newHeight = Math.max(imageResizeLimits.minimumHeight, newHeight);

            targetImage.style.width    = `${Math.round(newWidth)}px`;
            targetImage.style.height   = `${Math.round(newHeight)}px`;
            targetImage.style.maxWidth = "none";

            repositionOverlay();
        });

        handle.addEventListener("pointerup", () =>
        {
            activeHandlePosition           = null;
            document.body.style.cursor     = "";
            document.body.style.userSelect = "";
        });
    }

    window.addEventListener("scroll", repositionOverlay, true);
    window.addEventListener("resize", repositionOverlay);
    editableElement.addEventListener("scroll", repositionOverlay);

    const visibilityObserver = new IntersectionObserver((entries) =>
    {
        for (const entry of entries)
        {
            if (!entry.isIntersecting)
            {
                hideOverlay();
            }
        }
    });

    visibilityObserver.observe(editableElement);
}
