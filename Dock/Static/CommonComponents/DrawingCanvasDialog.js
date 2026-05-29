import DialogBox from "./DialogBox.js";

// Requires: CommonStyles/DrawingCanvasDialog.css

/**
 * Modal canvas the user can draw on with a black pen, then convert into an
 * inline <img> (data URL) for insertion into a contenteditable elsewhere.
 *
 * Why a modal rather than an inline live canvas: once the drawing is
 * committed as an <img>, the existing ApplyImageResizeDecorator gives
 * the user resize handles for free, and copy/paste/Reorder all work
 * out of the box because it is just an image in the document.
 *
 * Returns a Promise that resolves to a PNG data URL on Insert, or to
 * null when the user cancels or closes the dialog.
 */
class DrawingCanvasDialog
{
    static DEFAULT_INITIAL_WIDTH_PX = 600;
    static DEFAULT_INITIAL_HEIGHT_PX = 400;
    static MINIMUM_CANVAS_WIDTH_PX = 120;
    static MINIMUM_CANVAS_HEIGHT_PX = 120;
    static PEN_STROKE_COLOR = "#000000";
    static PEN_STROKE_WIDTH_PX = 2;
    static PEN_BACKGROUND_COLOR = "#ffffff";

    /**
     * Opens the modal and returns a Promise resolving to a PNG data URL
     * on Insert, or null on Cancel / close.
     * @param {{initialWidth?: number, initialHeight?: number}} options
     * @returns {Promise<string|null>}
     */
    static show(options = {})
    {
        const initialWidth = options.initialWidth || DrawingCanvasDialog.DEFAULT_INITIAL_WIDTH_PX;
        const initialHeight = options.initialHeight || DrawingCanvasDialog.DEFAULT_INITIAL_HEIGHT_PX;

        return new Promise((resolve) =>
        {
            const dialog = DialogBox.modal(DrawingCanvasDialog.#buildHtml(initialWidth, initialHeight));

            dialog.style.padding = "0";
            dialog.style.overflow = "hidden";
            dialog.style.maxWidth = "96vw";
            dialog.style.maxHeight = "92vh";

            const canvasElement = dialog.querySelector(".drawing-canvas-surface");
            const clearButton = dialog.querySelector(".drawing-canvas-clear-button");
            const insertButton = dialog.querySelector(".drawing-canvas-insert-button");
            const cancelButton = dialog.querySelector(".drawing-canvas-cancel-button");
            const resizeGrip = dialog.querySelector(".drawing-canvas-resize-grip");
            const closeButton = dialog.querySelector(".close-button");

            DrawingCanvasDialog.#paintWhiteBackground(canvasElement);
            DrawingCanvasDialog.#wireDrawing(canvasElement);
            DrawingCanvasDialog.#wireResize(canvasElement, resizeGrip);

            let bResolved = false;

            const finish = (dataUrlOrNull) =>
            {
                if (bResolved)
                {
                    return;
                }
                bResolved = true;
                dialog.close();
                resolve(dataUrlOrNull);
            };

            clearButton.addEventListener("click", () =>
            {
                DrawingCanvasDialog.#clearCanvas(canvasElement);
            });

            insertButton.addEventListener("click", () =>
            {
                const dataUrl = canvasElement.toDataURL("image/png");
                finish(dataUrl);
            });

            cancelButton.addEventListener("click", () =>
            {
                finish(null);
            });

            // The DialogBox close button is bound by DialogBox.modal()
            // to call dialog.close() — wrap it so the promise resolves.
            if (closeButton)
            {
                closeButton.addEventListener("click", () =>
                {
                    finish(null);
                }, { once: true });
            }
        });
    }

    static #buildHtml(initialWidth, initialHeight)
    {
        return `
            <div class="drawing-canvas-dialog-root">
                <div class="drawing-canvas-dialog-toolbar">
                    <div class="drawing-canvas-dialog-title">Draw</div>
                    <div class="drawing-canvas-dialog-toolbar-actions">
                        <button class="drawing-canvas-clear-button" type="button">Clear</button>
                        <button class="drawing-canvas-cancel-button" type="button">Cancel</button>
                        <button class="drawing-canvas-insert-button" type="button">Insert</button>
                    </div>
                </div>
                <div class="drawing-canvas-stage">
                    <canvas
                        class="drawing-canvas-surface"
                        width="${initialWidth}"
                        height="${initialHeight}"
                    ></canvas>
                    <div class="drawing-canvas-resize-grip" title="Drag to resize"></div>
                </div>
                <div class="drawing-canvas-dialog-hint">
                    Drag inside the canvas to draw. Drag the bottom-right corner to resize.
                </div>
            </div>
        `;
    }

    static #paintWhiteBackground(canvasElement)
    {
        const drawingContext = canvasElement.getContext("2d");
        drawingContext.fillStyle = DrawingCanvasDialog.PEN_BACKGROUND_COLOR;
        drawingContext.fillRect(0, 0, canvasElement.width, canvasElement.height);
    }

    static #clearCanvas(canvasElement)
    {
        const drawingContext = canvasElement.getContext("2d");
        drawingContext.fillStyle = DrawingCanvasDialog.PEN_BACKGROUND_COLOR;
        drawingContext.fillRect(0, 0, canvasElement.width, canvasElement.height);
    }

    static #wireDrawing(canvasElement)
    {
        const drawingContext = canvasElement.getContext("2d");
        drawingContext.strokeStyle = DrawingCanvasDialog.PEN_STROKE_COLOR;
        drawingContext.lineWidth = DrawingCanvasDialog.PEN_STROKE_WIDTH_PX;
        drawingContext.lineCap = "round";
        drawingContext.lineJoin = "round";

        let bIsDrawing = false;
        let lastPointerX = 0;
        let lastPointerY = 0;

        // The canvas may be displayed at a CSS size that differs from
        // its intrinsic resolution — translate pointer coordinates
        // into canvas pixel coordinates so strokes land where the
        // user expects them.
        const toCanvasCoordinates = (pointerEvent) =>
        {
            const rect = canvasElement.getBoundingClientRect();
            const scaleX = canvasElement.width / rect.width;
            const scaleY = canvasElement.height / rect.height;
            return {
                x: (pointerEvent.clientX - rect.left) * scaleX,
                y: (pointerEvent.clientY - rect.top) * scaleY
            };
        };

        canvasElement.addEventListener("pointerdown", (pointerEvent) =>
        {
            pointerEvent.stopPropagation();
            pointerEvent.preventDefault();

            const point = toCanvasCoordinates(pointerEvent);
            bIsDrawing = true;
            lastPointerX = point.x;
            lastPointerY = point.y;
            canvasElement.setPointerCapture(pointerEvent.pointerId);

            // Dot for tap-without-drag.
            drawingContext.beginPath();
            drawingContext.arc(point.x, point.y, DrawingCanvasDialog.PEN_STROKE_WIDTH_PX / 2, 0, Math.PI * 2);
            drawingContext.fillStyle = DrawingCanvasDialog.PEN_STROKE_COLOR;
            drawingContext.fill();
        });

        canvasElement.addEventListener("pointermove", (pointerEvent) =>
        {
            if (!bIsDrawing)
            {
                return;
            }
            pointerEvent.stopPropagation();

            const point = toCanvasCoordinates(pointerEvent);

            drawingContext.beginPath();
            drawingContext.moveTo(lastPointerX, lastPointerY);
            drawingContext.lineTo(point.x, point.y);
            drawingContext.stroke();

            lastPointerX = point.x;
            lastPointerY = point.y;
        });

        const endStroke = (pointerEvent) =>
        {
            if (!bIsDrawing)
            {
                return;
            }
            pointerEvent.stopPropagation();
            bIsDrawing = false;
            try { canvasElement.releasePointerCapture(pointerEvent.pointerId); } catch (releaseError) { /* already released */ }
        };

        canvasElement.addEventListener("pointerup", endStroke);
        canvasElement.addEventListener("pointercancel", endStroke);
        canvasElement.addEventListener("pointerleave", endStroke);
    }

    static #wireResize(canvasElement, resizeGripElement)
    {
        let bIsResizing = false;
        let resizeStartClientX = 0;
        let resizeStartClientY = 0;
        let resizeStartWidth = 0;
        let resizeStartHeight = 0;

        resizeGripElement.addEventListener("pointerdown", (pointerEvent) =>
        {
            pointerEvent.stopPropagation();
            pointerEvent.preventDefault();

            bIsResizing = true;
            resizeStartClientX = pointerEvent.clientX;
            resizeStartClientY = pointerEvent.clientY;
            resizeStartWidth = canvasElement.width;
            resizeStartHeight = canvasElement.height;

            resizeGripElement.setPointerCapture(pointerEvent.pointerId);
        });

        resizeGripElement.addEventListener("pointermove", (pointerEvent) =>
        {
            if (!bIsResizing)
            {
                return;
            }
            pointerEvent.stopPropagation();

            const deltaX = pointerEvent.clientX - resizeStartClientX;
            const deltaY = pointerEvent.clientY - resizeStartClientY;

            const newWidth = Math.max(DrawingCanvasDialog.MINIMUM_CANVAS_WIDTH_PX, Math.round(resizeStartWidth + deltaX));
            const newHeight = Math.max(DrawingCanvasDialog.MINIMUM_CANVAS_HEIGHT_PX, Math.round(resizeStartHeight + deltaY));

            // Preserve existing strokes: snapshot current bitmap, resize,
            // repaint white background, then blit the snapshot back.
            const drawingContext = canvasElement.getContext("2d");
            const previousBitmap = drawingContext.getImageData(0, 0, canvasElement.width, canvasElement.height);

            canvasElement.width = newWidth;
            canvasElement.height = newHeight;

            drawingContext.fillStyle = DrawingCanvasDialog.PEN_BACKGROUND_COLOR;
            drawingContext.fillRect(0, 0, newWidth, newHeight);
            drawingContext.putImageData(previousBitmap, 0, 0);

            // Resizing resets the context's stroke style — restore it.
            drawingContext.strokeStyle = DrawingCanvasDialog.PEN_STROKE_COLOR;
            drawingContext.lineWidth = DrawingCanvasDialog.PEN_STROKE_WIDTH_PX;
            drawingContext.lineCap = "round";
            drawingContext.lineJoin = "round";
        });

        const endResize = (pointerEvent) =>
        {
            if (!bIsResizing)
            {
                return;
            }
            bIsResizing = false;
            try { resizeGripElement.releasePointerCapture(pointerEvent.pointerId); } catch (releaseError) { /* already released */ }
        };

        resizeGripElement.addEventListener("pointerup", endResize);
        resizeGripElement.addEventListener("pointercancel", endResize);
    }
}

export default DrawingCanvasDialog;
