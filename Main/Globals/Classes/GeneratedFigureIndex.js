/**
 * GeneratedFigureIndex — enumerates the figures inside a passage so a reviewer
 * can act on exactly one of them.
 *
 * Addressing is layered, because the content predates the address. Figures
 * generated from now on carry a data-visual-id (the injector stamps the
 * perceptual hash the pipeline already computes), which is an exact,
 * position-independent handle. Everything generated before that carries no id,
 * so those are addressed by ordinal position — correct at the moment the
 * reviewer looked, and wrong the instant anything above them changes.
 *
 * So an address built here carries BOTH: the id when there is one, and
 * otherwise the ordinal plus the caption text as a confirmation. The server
 * refuses an ordinal whose caption no longer matches rather than redrawing
 * whichever figure happens to sit at that index now. Redrawing the wrong diagram
 * is not something a reviewer reliably catches in a before/after of a long
 * lesson, which is why the guard is worth the extra field.
 *
 * Parsing uses DOMParser rather than a regular expression. The passage contains
 * inline SVG whose own markup includes angle brackets and quoted attributes, and
 * a regex over that is a bug waiting for the first diagram with a <title> in it.
 */
class GeneratedFigureIndex
{
    /**
     * Both figure families are indexed. A reviewer looking at a lesson sees
     * "the third diagram" — whether it was drawn by the pipeline or extracted
     * from a PDF is not a distinction they should have to make before they can
     * ask for it to be removed.
     */
    static FIGURE_SELECTOR = "figure.generated-figure, figure.extracted-figure";

    /**
     * Renders a passage and returns one entry per figure, in document order.
     *
     * @param {string} htmlContent
     * @return {object[]} {ordinal, visualId, className, captionText, method, markup, bIsComposite, panelCount}
     */
    static listFigures(htmlContent)
    {
        if (typeof htmlContent !== "string" || htmlContent.length === 0)
        {
            return [];
        }

        const parsedDocument = new DOMParser().parseFromString(htmlContent, "text/html");
        const figureElements = parsedDocument.querySelectorAll(GeneratedFigureIndex.FIGURE_SELECTOR);

        const figures = [];

        figureElements.forEach((figureElement, ordinal) =>
        {
            const bIsComposite = figureElement.classList.contains("composite-figure");

            figures.push
            ({
                ordinal: ordinal,
                visualId: figureElement.getAttribute("data-visual-id") || "",
                className: figureElement.getAttribute("class") || "",
                captionText: GeneratedFigureIndex.#readOwnCaption(figureElement),
                method: GeneratedFigureIndex.#detectMethod(figureElement),
                markup: figureElement.outerHTML,
                bIsComposite: bIsComposite,
                panelCount: bIsComposite ? figureElement.querySelectorAll(".composite-panel").length : 1,
            });
        });

        return figures;
    }

    /**
     * The address to send to the server for one figure.
     */
    static buildAddress(figure)
    {
        return {
            visualId: figure.visualId || "",
            figureOrdinal: figure.ordinal,
            expectedCaptionText: figure.captionText || "",
        };
    }

    /**
     * The figure's own caption, not a panel's.
     *
     * A composite plate carries a caption per panel inside its grid as well as
     * its own trailing figcaption, so the last one is taken — the same rule the
     * server-side locator uses, deliberately, because the two have to agree
     * about what a figure is called or the confirmation check fails on a
     * correctly-addressed figure.
     */
    static #readOwnCaption(figureElement)
    {
        const captionElements = figureElement.querySelectorAll("figcaption");

        if (captionElements.length === 0)
        {
            return "";
        }

        return (captionElements[captionElements.length - 1].textContent || "").replace(/\s+/g, " ").trim();
    }

    /**
     * How this figure is drawn, inferred from the markup the injector emitted.
     *
     * Used to preselect the visual kind when a reviewer asks for a redraw, so
     * they are not made to re-choose "this is a Mermaid flowchart" about a
     * flowchart already on their screen. Best-effort: an unrecognised shape
     * returns empty and the reviewer picks.
     */
    static #detectMethod(figureElement)
    {
        if (figureElement.querySelector("span.smiles-structure"))
        {
            return "SMILES";
        }

        if (figureElement.querySelector("pre.mermaid"))
        {
            return "MERMAID";
        }

        if (figureElement.querySelector("span.katex-expression"))
        {
            return "KATEX";
        }

        if (figureElement.querySelector("svg"))
        {
            return "INLINE_SVG";
        }

        if (figureElement.querySelector("img"))
        {
            return "RASTER_IMAGE";
        }

        return "";
    }
}

export default GeneratedFigureIndex;
