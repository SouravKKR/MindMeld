/**
 * GeneratedVisualRenderer
 *
 * Draws the symbolic visuals that paid-deck generation embeds in study-material
 * HTML. The Agent side deliberately ships these as MARKUP rather than as a
 * rasterised `<img>` — labels stay real selectable text and geometry stays exact
 * at any zoom — which means the markup is inert until something renders it here.
 *
 * Three kinds arrive, each written by PaidDeckVisualGenerator.__sanitize_markup:
 *
 *   - `<span class="smiles-structure" data-smiles="...">` — a chemical structure
 *     in SMILES notation. Drawn by SmilesDrawer's attribute-driven `SmiDrawer`.
 *   - `<pre class="mermaid">` — a flow / hierarchy diagram in Mermaid source.
 *   - `<span class="katex-expression">` — an equation in KaTeX delimiters.
 *     KaTeX is already loaded eagerly by index.html, so this only needs the
 *     existing auto-render pass run over the container.
 *
 * Inline `<svg>` needs nothing: the browser draws it and HtmlSanitizer already
 * passes it through an allow-list.
 *
 * Two rules this class exists to keep:
 *
 *   1. A missing library must DEGRADE, never throw. Every entry point is
 *      guarded, matching the `typeof renderMathInElement === "undefined"` checks
 *      the KaTeX call sites already use. A study material that cannot draw its
 *      diagram must still show its prose.
 *   2. Rendering is idempotent. `onPageResumed` and re-renders call this again
 *      over the same DOM, so every element rendered is marked and skipped on the
 *      next pass — without the mark, Mermaid throws on its own output and
 *      SmilesDrawer stacks duplicate SVGs.
 *
 * SmilesDrawer (~250 KB) and Mermaid (~2.5 MB) are loaded ON DEMAND rather than
 * from index.html. Most decks contain neither, and Mermaid alone would otherwise
 * be added to every cold start of the application.
 */
class GeneratedVisualRenderer
{
    static #SMILES_DRAWER_SCRIPT_PATH = "./ThirdParty/SmilesDrawer/smiles-drawer.min.js";
    static #MERMAID_SCRIPT_PATH = "./ThirdParty/Mermaid/mermaid.min.js";

    // Marks an element whose visual has already been drawn, so a second pass
    // over the same container is a no-op instead of a duplicate render.
    static #RENDERED_MARKER_ATTRIBUTE = "data-visual-rendered";

    // One in-flight promise per script path. Concurrent callers — two study
    // materials rendering in the same frame — share a single network fetch and
    // a single parse instead of racing to inject the same tag twice.
    static #scriptLoadPromises = new Map();

    static #bMermaidInitialised = false;

    /**
     * Injects a script tag once and resolves when it has executed. Resolves to
     * false rather than rejecting when the script cannot load, so callers can
     * treat "library unavailable" as an ordinary skip.
     */
    static #loadScriptOnce(scriptPath)
    {
        if (GeneratedVisualRenderer.#scriptLoadPromises.has(scriptPath))
        {
            return GeneratedVisualRenderer.#scriptLoadPromises.get(scriptPath);
        }

        const loadPromise = new Promise((resolve) =>
        {
            const scriptElement = document.createElement("script");
            scriptElement.src = scriptPath;
            scriptElement.async = true;
            scriptElement.addEventListener("load", () => resolve(true));
            scriptElement.addEventListener("error", () =>
            {
                console.warn(`[GeneratedVisualRenderer] Could not load ${scriptPath} — visuals of that kind stay unrendered.`);
                resolve(false);
            });
            document.head.appendChild(scriptElement);
        });

        GeneratedVisualRenderer.#scriptLoadPromises.set(scriptPath, loadPromise);
        return loadPromise;
    }

    // Success and failure are marked distinctly. Both stop the element being
    // retried on the next pass, but only "true" is allowed to become visible —
    // GeneratedContent.css keeps a failed Mermaid block hidden so a student
    // never sees raw diagram syntax where a diagram should be.
    static #RENDER_SUCCEEDED = "true";
    static #RENDER_FAILED = "failed";

    static #markRendered(element, outcome)
    {
        element.setAttribute(GeneratedVisualRenderer.#RENDERED_MARKER_ATTRIBUTE, outcome);
    }

    static #collectUnrendered(containerElement, selector)
    {
        return Array.from(containerElement.querySelectorAll(selector)).filter(
            (element) => !element.hasAttribute(GeneratedVisualRenderer.#RENDERED_MARKER_ATTRIBUTE)
        );
    }

    /**
     * Picks the SmilesDrawer / Mermaid palette that will actually be legible.
     *
     * The application themes itself by writing CSS variables onto
     * documentElement (AppearanceManager) and users can set arbitrary colours,
     * so there is no "is dark mode" flag to read.
     *
     * This reads the TEXT colour rather than the background. Backgrounds cannot
     * be measured reliably: the app paints its dark surface with a
     * `linear-gradient`, which is a background-IMAGE, so `backgroundColor`
     * computes to `rgba(0, 0, 0, 0)` on the figure and on every ancestor up to
     * <body>. A probe that walked that chain found nothing to measure, fell back
     * to "light", and drew near-black structures onto a #1a1a1a page — present
     * in the DOM, occupying layout, completely invisible.
     *
     * Text colour has no such hole. It is inherited, always resolved, and never
     * transparent, because a UI that did not set a readable text colour would be
     * unreadable. Light text means a dark surface behind it.
     */
    static #resolveDrawingTheme(element)
    {
        const textColorChannels = getComputedStyle(element).color.match(/[\d.]+/g);

        if (!textColorChannels || textColorChannels.length < 3)
        {
            return "light";
        }

        const perceivedTextLuminance =
            (0.299 * parseFloat(textColorChannels[0])
            + 0.587 * parseFloat(textColorChannels[1])
            + 0.114 * parseFloat(textColorChannels[2])) / 255;

        return perceivedTextLuminance > 0.5 ? "dark" : "light";
    }

    /**
     * Draws every chemical structure in the container.
     *
     * The target is the literal string "svg", NOT an element. This looks odd and
     * is load-bearing. SmilesDrawer's element branch draws into an SVG you own
     * but never writes width/height onto it, so the result has no intrinsic
     * size, collapses under `height: auto`, and renders as a blank gap —
     * present in the DOM, correct in every attribute, invisible on the page.
     * The "svg" branch is the only one that measures the drawing
     * (`getDimensions`) and stamps the dimensions on before handing it back
     * through the success callback, so that element is what gets inserted.
     *
     * Errors arrive through SmilesDrawer's own errorCallback: parsing happens
     * inside the library, so a try/catch around the call does not see them.
     */
    static async #renderChemicalStructures(containerElement)
    {
        const structureElements = GeneratedVisualRenderer.#collectUnrendered(containerElement, "span.smiles-structure[data-smiles]");

        if (structureElements.length === 0)
        {
            return;
        }

        const bLoaded = await GeneratedVisualRenderer.#loadScriptOnce(GeneratedVisualRenderer.#SMILES_DRAWER_SCRIPT_PATH);

        if (!bLoaded || typeof SmiDrawer === "undefined")
        {
            return;
        }

        const structureDrawer = new SmiDrawer();
        const drawingTheme = GeneratedVisualRenderer.#resolveDrawingTheme(containerElement);

        for (const structureElement of structureElements)
        {
            structureDrawer.draw(
                structureElement.getAttribute("data-smiles"),
                "svg",
                drawingTheme,
                (drawnSvgElement) =>
                {
                    structureElement.replaceChildren(drawnSvgElement);
                    GeneratedVisualRenderer.#markRendered(structureElement, GeneratedVisualRenderer.#RENDER_SUCCEEDED);
                },
                (drawError) =>
                {
                    console.warn("[GeneratedVisualRenderer] A chemical structure could not be drawn:", drawError);
                    structureElement.replaceChildren();
                    GeneratedVisualRenderer.#markRendered(structureElement, GeneratedVisualRenderer.#RENDER_FAILED);
                }
            );
        }
    }

    /**
     * Draws every Mermaid block in the container, replacing the source text with
     * the rendered SVG. A block whose source does not parse keeps its original
     * text rather than collapsing to an empty box.
     */
    static async #renderFlowDiagrams(containerElement)
    {
        const diagramElements = GeneratedVisualRenderer.#collectUnrendered(containerElement, "pre.mermaid");

        if (diagramElements.length === 0)
        {
            return;
        }

        const bLoaded = await GeneratedVisualRenderer.#loadScriptOnce(GeneratedVisualRenderer.#MERMAID_SCRIPT_PATH);

        if (!bLoaded || typeof mermaid === "undefined")
        {
            return;
        }

        if (!GeneratedVisualRenderer.#bMermaidInitialised)
        {
            // startOnLoad false: this class decides when to draw, so Mermaid must
            // not also sweep the document on its own and race these passes.
            // securityLevel strict: diagram source is model-authored, so its
            // labels are sanitised and click-handlers are refused.
            mermaid.initialize({
                startOnLoad: false,
                securityLevel: "strict",
                theme: GeneratedVisualRenderer.#resolveDrawingTheme(containerElement) === "dark" ? "dark" : "default",
            });
            GeneratedVisualRenderer.#bMermaidInitialised = true;
        }

        for (let diagramIndex = 0; diagramIndex < diagramElements.length; diagramIndex++)
        {
            const diagramElement = diagramElements[diagramIndex];
            const diagramSource = diagramElement.textContent || "";

            try
            {
                const renderIdentifier = `generated-mermaid-${Date.now()}-${diagramIndex}`;
                const renderResult = await mermaid.render(renderIdentifier, diagramSource);
                diagramElement.innerHTML = renderResult.svg;
                GeneratedVisualRenderer.#markRendered(diagramElement, GeneratedVisualRenderer.#RENDER_SUCCEEDED);
            }
            catch (renderError)
            {
                console.warn("[GeneratedVisualRenderer] A flow diagram could not be drawn:", renderError);
                GeneratedVisualRenderer.#markRendered(diagramElement, GeneratedVisualRenderer.#RENDER_FAILED);
            }
        }
    }

    /**
     * Runs the already-loaded KaTeX auto-render pass over the container so
     * generated equations typeset alongside the other visual kinds.
     */
    static #renderEquations(containerElement)
    {
        if (typeof renderMathInElement === "undefined")
        {
            return;
        }

        try
        {
            renderMathInElement(containerElement,
            {
                delimiters: [
                    { left: "\\(", right: "\\)", display: false },
                    { left: "\\[", right: "\\]", display: true },
                ],
                throwOnError: false,
            });
        }
        catch (renderError)
        {
            console.warn("[GeneratedVisualRenderer] Equation rendering failed:", renderError);
        }
    }

    /**
     * Renders every generated visual inside containerElement.
     *
     * Call immediately after assigning sanitised study-material HTML to
     * `innerHTML`. Safe to call on any container: one that holds no generated
     * visual does no work and loads no library.
     *
     * Deliberately not awaited by callers — a diagram appearing a frame after
     * the prose is the correct trade against blocking the lesson on a 2.5 MB
     * download.
     */
    static async render(containerElement)
    {
        if (!containerElement)
        {
            return;
        }

        GeneratedVisualRenderer.#renderEquations(containerElement);

        await Promise.all([
            GeneratedVisualRenderer.#renderChemicalStructures(containerElement),
            GeneratedVisualRenderer.#renderFlowDiagrams(containerElement),
        ]);
    }
}

export default GeneratedVisualRenderer;
