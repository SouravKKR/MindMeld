import PaidDeckShareConstants from "../Constants/PaidDeckShareConstants.js";

/**
 * QrCodeRenderer
 *
 * Turns a string into a QR code, either as inline SVG markup (what the share
 * panel displays) or as PNG bytes (what "Download QR" hands to the user).
 *
 * The encoder itself is the vendored qrcode-generator library, loaded ON DEMAND
 * rather than from index.html — it is ~57 KB and only two screens in the whole
 * application ever draw a QR code, so putting it on every cold start would be
 * paying for it in every session that never shares anything. This mirrors how
 * GeneratedVisualRenderer loads Mermaid and SmilesDrawer.
 *
 * Colours are hardcoded black-on-white in both output paths. That is not a
 * styling decision the theme is allowed to override: a scanner needs the
 * contrast, and AppearanceManager lets a user pick any palette they like.
 */
class QrCodeRenderer
{
    // The version lives in the FILENAME, not a query string, because that is
    // what opts the file into immutable HTTP caching — see
    // Dock/Endpoints/Plugins/StaticCachePolicy.js. Root-relative, NOT
    // "./ThirdParty/...": a deep-link cold load has the document at /PaidDeck,
    // where a relative source would resolve against the wrong base.
    static #QR_CODE_GENERATOR_SCRIPT_PATH = "/ThirdParty/QrCode/qrcode-generator-1.4.4.js";

    // 0 = let the library pick the smallest symbol version the payload fits in.
    static #AUTOMATIC_TYPE_NUMBER = 0;

    // Medium (~15% recovery). A share URL is ~60-80 characters, which lands at
    // roughly 37 modules — small enough that each module stays chunky and
    // scannable off a photographed poster. Higher levels only add modules, and
    // shrinking them is what actually breaks a real-world scan.
    static #ERROR_CORRECTION_LEVEL = "M";

    // One in-flight promise per script path, so two panels rendering in the
    // same frame share a single network fetch and a single parse.
    static #scriptLoadPromises = new Map();

    /**
     * Injects a script tag once and resolves when it has executed. Resolves to
     * false rather than rejecting when the script cannot load, so a missing
     * library degrades to "no QR code shown" instead of a thrown error on a
     * page the user came to for something else.
     */
    static #loadScriptOnce(scriptPath)
    {
        if (QrCodeRenderer.#scriptLoadPromises.has(scriptPath))
        {
            return QrCodeRenderer.#scriptLoadPromises.get(scriptPath);
        }

        const loadPromise = new Promise((resolve) =>
        {
            const scriptElement = document.createElement("script");
            scriptElement.src = scriptPath;
            scriptElement.async = true;
            scriptElement.addEventListener("load", () => resolve(true));
            scriptElement.addEventListener("error", () =>
            {
                console.warn(`[QrCodeRenderer] Could not load ${scriptPath} — QR codes stay unrendered.`);
                resolve(false);
            });
            document.head.appendChild(scriptElement);
        });

        QrCodeRenderer.#scriptLoadPromises.set(scriptPath, loadPromise);
        return loadPromise;
    }

    /**
     * Encodes the text and returns the library's module matrix, or null when
     * the library is unavailable or the payload cannot be encoded (which for a
     * QR code means "too long for the largest symbol").
     */
    static async #encode(text)
    {
        const textToEncode = typeof text === "string" ? text : "";
        if (textToEncode.length === 0)
        {
            return null;
        }

        const bScriptLoaded = await QrCodeRenderer.#loadScriptOnce(QrCodeRenderer.#QR_CODE_GENERATOR_SCRIPT_PATH);
        if (!bScriptLoaded || typeof window.qrcode !== "function")
        {
            return null;
        }

        try
        {
            const qrCode = window.qrcode(QrCodeRenderer.#AUTOMATIC_TYPE_NUMBER, QrCodeRenderer.#ERROR_CORRECTION_LEVEL);
            qrCode.addData(textToEncode);
            qrCode.make();
            return qrCode;
        }
        catch (encodeError)
        {
            console.warn(`[QrCodeRenderer] Could not encode the payload. ${encodeError?.message || encodeError}`);
            return null;
        }
    }

    /**
     * Renders the code as scalable inline SVG markup, or "" on failure.
     *
     * The markup carries geometry only — the encoded text is never
     * interpolated into it — so assigning the result with innerHTML introduces
     * no injection surface.
     */
    static async renderSvgMarkup(text)
    {
        const qrCode = await QrCodeRenderer.#encode(text);
        if (!qrCode)
        {
            return "";
        }

        const moduleCount = qrCode.getModuleCount();
        const quietZoneModules = PaidDeckShareConstants.QR_QUIET_ZONE_MODULES;
        const canvasModules = moduleCount + (quietZoneModules * 2);

        const pathSegments = [];
        for (let moduleRowIndex = 0; moduleRowIndex < moduleCount; moduleRowIndex++)
        {
            for (let moduleColumnIndex = 0; moduleColumnIndex < moduleCount; moduleColumnIndex++)
            {
                if (!qrCode.isDark(moduleRowIndex, moduleColumnIndex))
                {
                    continue;
                }

                const originX = moduleColumnIndex + quietZoneModules;
                const originY = moduleRowIndex + quietZoneModules;
                pathSegments.push(`M${originX} ${originY}h1v1h-1z`);
            }
        }

        // The quiet zone is part of the specification, not padding: a scanner
        // needs the clear margin to find the symbol at all.
        return `
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${canvasModules} ${canvasModules}" width="100%" height="100%" shape-rendering="crispEdges" role="img" aria-label="QR code">
                <rect width="${canvasModules}" height="${canvasModules}" fill="#ffffff"></rect>
                <path d="${pathSegments.join("")}" fill="#000000"></path>
            </svg>
        `;
    }

    /**
     * Renders the code as PNG bytes for download, or null on failure.
     *
     * PNG rather than SVG because the real destinations for a share code —
     * messaging apps, slide decks, documents, print shops — variously refuse
     * SVG or rasterise it inconsistently, and a QR code is a grid of squares,
     * so there is no curve for a vector format to preserve.
     *
     * The module size is deliberately an INTEGER number of pixels: fillRect on
     * whole-pixel boundaries produces no antialiasing along module edges, and a
     * softened edge is exactly what makes a printed-then-photographed code fail
     * to scan. The output is therefore close to, not exactly, the requested size.
     */
    static async renderPngBytes(text, targetPixelSize)
    {
        const qrCode = await QrCodeRenderer.#encode(text);
        if (!qrCode)
        {
            return null;
        }

        const moduleCount = qrCode.getModuleCount();
        const quietZoneModules = PaidDeckShareConstants.QR_QUIET_ZONE_MODULES;
        const canvasModules = moduleCount + (quietZoneModules * 2);

        const requestedSize = Number(targetPixelSize) > 0 ? Number(targetPixelSize) : PaidDeckShareConstants.QR_MODULE_TARGET_PIXEL_SIZE;
        const modulePixelSize = Math.max(1, Math.floor(requestedSize / canvasModules));
        const canvasPixelSize = canvasModules * modulePixelSize;

        const canvasElement = document.createElement("canvas");
        canvasElement.width = canvasPixelSize;
        canvasElement.height = canvasPixelSize;

        const drawingContext = canvasElement.getContext("2d");
        if (!drawingContext)
        {
            console.warn("[QrCodeRenderer] No 2D canvas context available — cannot rasterise the QR code.");
            return null;
        }

        drawingContext.fillStyle = "#ffffff";
        drawingContext.fillRect(0, 0, canvasPixelSize, canvasPixelSize);

        drawingContext.fillStyle = "#000000";
        for (let moduleRowIndex = 0; moduleRowIndex < moduleCount; moduleRowIndex++)
        {
            for (let moduleColumnIndex = 0; moduleColumnIndex < moduleCount; moduleColumnIndex++)
            {
                if (!qrCode.isDark(moduleRowIndex, moduleColumnIndex))
                {
                    continue;
                }

                const originX = (moduleColumnIndex + quietZoneModules) * modulePixelSize;
                const originY = (moduleRowIndex + quietZoneModules) * modulePixelSize;
                drawingContext.fillRect(originX, originY, modulePixelSize, modulePixelSize);
            }
        }

        const pngBlob = await new Promise((resolve) => canvasElement.toBlob(resolve, "image/png"));
        if (!pngBlob)
        {
            console.warn("[QrCodeRenderer] canvas.toBlob produced nothing — cannot download the QR code.");
            return null;
        }

        return new Uint8Array(await pngBlob.arrayBuffer());
    }
}

export default QrCodeRenderer;
