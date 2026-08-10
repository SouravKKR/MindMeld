/**
 * EmbeddedFigureStripper
 *
 * Removes the `<figure>` elements a given uploaded document contributed to a
 * piece of generated HTML, identified by the `data-source-hash` attribute the
 * Agent stamps on them (HtmlInjector.build_source_hash_attribute).
 *
 * Why this exists. A PDF-extracted figure is embedded as a base64 data URL
 * directly inside study material content and card fields, so it is a full copy
 * of the source artwork living inside a different entity. Deleting the
 * information-source row, the stored blob and the `figures` cache leaves every
 * one of those embedded copies untouched — on the server document AND on every
 * device that already synced it. Until this class existed a takedown reported
 * success while the picture it was supposed to remove was still being served.
 *
 * Why a scanner rather than a regular expression. `<figure ...>.*?</figure>` is
 * wrong on nesting and catastrophic on backtracking against a multi-megabyte
 * base64 payload, and the payload is exactly what sits between the two tags
 * here. This walks the string once, matches opening tags to closing tags with a
 * depth counter, and never backtracks.
 *
 * Why not an HTML parser. Dock has no DOM dependency, and adding one to delete a
 * known element emitted by our own generator would be a large surface for a
 * small job. The markup being matched is machine-written by a single function,
 * so its shape is a contract rather than a guess — but the scanner is still
 * written defensively, because the content is round-tripped through client
 * editors before it comes back here.
 *
 * Unbalanced markup is left ALONE rather than truncated. A figure whose closing
 * tag is missing means the assumption behind the scan is broken for that
 * document, and removing "everything to the end" would destroy a user's study
 * material to honour a notice. The caller is told the document could not be
 * cleaned so it can be reported as unremoved rather than silently mangled.
 */
class EmbeddedFigureStripper
{
    static #FIGURE_OPENING_TAG_PATTERN = /<figure\b[^>]*>/gi;
    static #FIGURE_CLOSING_TAG = "</figure>";
    static #FIGURE_OPENING_TAG_PREFIX = "<figure";

    /**
     * Strips every figure attributed to one source document.
     *
     * @param {string} htmlContent - The stored HTML. Returned unchanged when it holds no matching figure.
     * @param {string} contentHash - The sha512 content hash of the document being taken down.
     * @return {{html: string, removedCount: number, bUnbalancedMarkup: boolean}}
     *   html              -> the content with matching figures removed.
     *   removedCount      -> how many figure elements were removed.
     *   bUnbalancedMarkup -> true when a matching figure had no closing tag and was therefore left in place.
     */
    static strip(htmlContent, contentHash)
    {
        if (typeof htmlContent !== "string" || htmlContent.length === 0)
        {
            return { html: htmlContent, removedCount: 0, bUnbalancedMarkup: false };
        }

        if (typeof contentHash !== "string" || contentHash.length === 0)
        {
            return { html: htmlContent, removedCount: 0, bUnbalancedMarkup: false };
        }

        // Cheap rejection before any scanning. The overwhelming majority of
        // documents a takedown sweeps past contain no figure from the noticed
        // source, and this keeps those to a single substring search.
        if (!EmbeddedFigureStripper.containsSourceHash(htmlContent, contentHash))
        {
            return { html: htmlContent, removedCount: 0, bUnbalancedMarkup: false };
        }

        const attributeNeedle = EmbeddedFigureStripper.#buildAttributeNeedle(contentHash);

        let workingHtml = htmlContent;
        let removedCount = 0;
        let bUnbalancedMarkup = false;
        let searchFromIndex = 0;

        while (true)
        {
            const openingTagBounds = EmbeddedFigureStripper.#findOpeningTagCarrying(workingHtml, attributeNeedle, searchFromIndex);
            if (openingTagBounds === null)
            {
                break;
            }

            const closingTagEndIndex = EmbeddedFigureStripper.#findMatchingClosingTagEnd(workingHtml, openingTagBounds.endIndex);
            if (closingTagEndIndex === null)
            {
                // Cannot bound this element, so it stays. Advance past its
                // opening tag rather than retrying it, or the loop never ends.
                bUnbalancedMarkup = true;
                searchFromIndex = openingTagBounds.endIndex;
                continue;
            }

            workingHtml = workingHtml.slice(0, openingTagBounds.startIndex) + workingHtml.slice(closingTagEndIndex);
            removedCount++;

            // Resume from where the removed element began: what follows has
            // shifted into that position and has not been examined yet.
            searchFromIndex = openingTagBounds.startIndex;
        }

        return {
            html: EmbeddedFigureStripper.#collapseBlankLines(workingHtml),
            removedCount: removedCount,
            bUnbalancedMarkup: bUnbalancedMarkup
        };
    }

    /**
     * Whether a piece of HTML carries at least one figure from this source.
     *
     * Public because the query layer uses the same test to decide which stored
     * documents to rewrite, and the two must agree — a document the query
     * selects but the stripper does not clean would be rewritten with an
     * unchanged body and a bumped timestamp, pushing a pointless update to every
     * device.
     *
     * @param {string} htmlContent
     * @param {string} contentHash
     * @return {boolean}
     */
    static containsSourceHash(htmlContent, contentHash)
    {
        if (typeof htmlContent !== "string" || typeof contentHash !== "string" || contentHash.length === 0)
        {
            return false;
        }

        return htmlContent.includes(EmbeddedFigureStripper.#buildAttributeNeedle(contentHash));
    }

    /**
     * The attribute as the Agent writes it. A content hash is hexadecimal, so it
     * survives HTML attribute escaping unchanged and can be compared literally.
     */
    static #buildAttributeNeedle(contentHash)
    {
        return `data-source-hash="${contentHash}"`;
    }

    /**
     * Finds the next `<figure ...>` opening tag whose own attributes contain the
     * needle.
     *
     * Matching the needle against the opening TAG rather than the document is
     * what stops a figure being removed because some later, unrelated figure
     * from the noticed source appears further down the same document.
     */
    static #findOpeningTagCarrying(htmlContent, attributeNeedle, searchFromIndex)
    {
        EmbeddedFigureStripper.#FIGURE_OPENING_TAG_PATTERN.lastIndex = searchFromIndex;

        let openingTagMatch = EmbeddedFigureStripper.#FIGURE_OPENING_TAG_PATTERN.exec(htmlContent);

        while (openingTagMatch !== null)
        {
            if (openingTagMatch[0].includes(attributeNeedle))
            {
                return { startIndex: openingTagMatch.index, endIndex: openingTagMatch.index + openingTagMatch[0].length };
            }

            openingTagMatch = EmbeddedFigureStripper.#FIGURE_OPENING_TAG_PATTERN.exec(htmlContent);
        }

        return null;
    }

    /**
     * Walks forward from the end of an opening tag to the `</figure>` that
     * closes it, counting nested `<figure` openings so an inner element does not
     * end the outer one early. Returns the index just past the closing tag, or
     * null when the element is never closed.
     */
    static #findMatchingClosingTagEnd(htmlContent, scanFromIndex)
    {
        let depth = 1;
        let cursorIndex = scanFromIndex;

        while (cursorIndex < htmlContent.length)
        {
            const nextClosingIndex = htmlContent.indexOf(EmbeddedFigureStripper.#FIGURE_CLOSING_TAG, cursorIndex);
            if (nextClosingIndex === -1)
            {
                return null;
            }

            const nextOpeningIndex = EmbeddedFigureStripper.#findNextOpeningTagStart(htmlContent, cursorIndex, nextClosingIndex);

            if (nextOpeningIndex !== -1)
            {
                depth++;
                cursorIndex = nextOpeningIndex + EmbeddedFigureStripper.#FIGURE_OPENING_TAG_PREFIX.length;
                continue;
            }

            depth--;
            cursorIndex = nextClosingIndex + EmbeddedFigureStripper.#FIGURE_CLOSING_TAG.length;

            if (depth === 0)
            {
                return cursorIndex;
            }
        }

        return null;
    }

    /**
     * Locates a genuine nested `<figure` opening before the given boundary.
     *
     * The trailing-character check is what keeps `<figcaption>` — which every
     * one of these elements contains — from being counted as a nested figure and
     * running the depth counter away.
     */
    static #findNextOpeningTagStart(htmlContent, searchFromIndex, boundaryIndex)
    {
        let candidateIndex = htmlContent.indexOf(EmbeddedFigureStripper.#FIGURE_OPENING_TAG_PREFIX, searchFromIndex);

        while (candidateIndex !== -1 && candidateIndex < boundaryIndex)
        {
            const characterAfterPrefix = htmlContent.charAt(candidateIndex + EmbeddedFigureStripper.#FIGURE_OPENING_TAG_PREFIX.length);

            if (characterAfterPrefix === ">" || characterAfterPrefix === " " || characterAfterPrefix === "\t" || characterAfterPrefix === "\n" || characterAfterPrefix === "\r")
            {
                return candidateIndex;
            }

            candidateIndex = htmlContent.indexOf(EmbeddedFigureStripper.#FIGURE_OPENING_TAG_PREFIX, candidateIndex + EmbeddedFigureStripper.#FIGURE_OPENING_TAG_PREFIX.length);
        }

        return -1;
    }

    /**
     * Removes the blank line a removed figure leaves behind. The injector writes
     * each figure onto its own line, so stripping one otherwise leaves a widening
     * gap in the prose every time a notice is actioned.
     */
    static #collapseBlankLines(htmlContent)
    {
        return htmlContent.replace(/\n{3,}/g, "\n\n");
    }
}

module.exports = EmbeddedFigureStripper;
