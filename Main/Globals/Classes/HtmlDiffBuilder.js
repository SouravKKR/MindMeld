/**
 * HtmlDiffBuilder — marks up what changed between two versions of a passage.
 *
 * Diffs the RENDERED TEXT, not the HTML source. Two versions of a lesson that
 * read identically can differ in whitespace, attribute order or tag nesting for
 * reasons no reviewer cares about, and a source-level diff paints most of the
 * page as changed — at which point the reviewer stops reading it and starts
 * clicking Apply, which is exactly the failure this whole flow exists to avoid.
 *
 * Figures are excluded from the comparison and reproduced untouched. A diagram
 * is compared by looking at it, side by side, which the dialog does separately;
 * running its base64 payload or its SVG path data through a word differ would
 * produce thousands of meaningless marks.
 *
 * Word-level, not character-level. A character differ on prose highlights the
 * two letters inside a changed number and reads as noise; a word differ
 * highlights the number.
 */
class HtmlDiffBuilder
{
    /**
     * Marks applied to the two panes. Kept as class constants so the stylesheet
     * and the builder cannot drift apart.
     */
    static REMOVED_CLASS_NAME = "refinement-diff-removed";
    static ADDED_CLASS_NAME = "refinement-diff-added";

    /**
     * Ceiling on the comparison table. Two thousand words a side is a very long
     * lesson and still fits; beyond that the walk degrades to "everything
     * changed" rather than allocating a matrix big enough to lock the tab.
     */
    static #MAXIMUM_COMPARISON_CELLS = 4000000;

    /**
     * Builds both panes at once.
     *
     * @param {string} beforeHtml
     * @param {string} afterHtml
     * @return {{beforeHtml: string, afterHtml: string, changedWordCount: number, bAnyChange: boolean}}
     */
    static build(beforeHtml, afterHtml)
    {
        const beforeWords = HtmlDiffBuilder.#splitIntoWords(HtmlDiffBuilder.#extractComparableText(beforeHtml));
        const afterWords = HtmlDiffBuilder.#splitIntoWords(HtmlDiffBuilder.#extractComparableText(afterHtml));

        const alignment = HtmlDiffBuilder.#alignWords(beforeWords, afterWords);

        return {
            beforeHtml: HtmlDiffBuilder.#renderPane(beforeWords, alignment.removedIndices, HtmlDiffBuilder.REMOVED_CLASS_NAME),
            afterHtml: HtmlDiffBuilder.#renderPane(afterWords, alignment.addedIndices, HtmlDiffBuilder.ADDED_CLASS_NAME),
            changedWordCount: alignment.removedIndices.size + alignment.addedIndices.size,
            bAnyChange: alignment.removedIndices.size > 0 || alignment.addedIndices.size > 0,
        };
    }

    /**
     * The text a reader actually sees, with figures dropped.
     */
    static #extractComparableText(htmlContent)
    {
        if (typeof htmlContent !== "string" || htmlContent.length === 0)
        {
            return "";
        }

        const parsedDocument = new DOMParser().parseFromString(htmlContent, "text/html");

        parsedDocument.querySelectorAll("figure").forEach(figureElement => figureElement.remove());

        return (parsedDocument.body.textContent || "").replace(/\s+/g, " ").trim();
    }

    static #splitIntoWords(plainText)
    {
        return plainText.length === 0 ? [] : plainText.split(" ");
    }

    /**
     * Finds which words are unique to each side.
     *
     * A longest-common-subsequence walk over the two word lists, computed with a
     * rolling row rather than a full table so a long lesson does not allocate a
     * matrix of every word against every word. Above the size ceiling the
     * comparison degrades to "everything changed" rather than locking the tab —
     * a reviewer told "this is too large to compare in detail" can still read
     * both panes, which a frozen browser does not allow.
     */
    static #alignWords(beforeWords, afterWords)
    {
        const removedIndices = new Set();
        const addedIndices = new Set();

        if (beforeWords.length * afterWords.length > HtmlDiffBuilder.#MAXIMUM_COMPARISON_CELLS)
        {
            beforeWords.forEach((word, index) => removedIndices.add(index));
            afterWords.forEach((word, index) => addedIndices.add(index));
            return { removedIndices: removedIndices, addedIndices: addedIndices };
        }

        const lengths = [];

        for (let beforeIndex = 0; beforeIndex <= beforeWords.length; beforeIndex += 1)
        {
            lengths.push(new Uint32Array(afterWords.length + 1));
        }

        for (let beforeIndex = beforeWords.length - 1; beforeIndex >= 0; beforeIndex -= 1)
        {
            for (let afterIndex = afterWords.length - 1; afterIndex >= 0; afterIndex -= 1)
            {
                lengths[beforeIndex][afterIndex] = beforeWords[beforeIndex] === afterWords[afterIndex]
                    ? lengths[beforeIndex + 1][afterIndex + 1] + 1
                    : Math.max(lengths[beforeIndex + 1][afterIndex], lengths[beforeIndex][afterIndex + 1]);
            }
        }

        let beforeIndex = 0;
        let afterIndex = 0;

        while (beforeIndex < beforeWords.length && afterIndex < afterWords.length)
        {
            if (beforeWords[beforeIndex] === afterWords[afterIndex])
            {
                beforeIndex += 1;
                afterIndex += 1;
            }
            else if (lengths[beforeIndex + 1][afterIndex] >= lengths[beforeIndex][afterIndex + 1])
            {
                removedIndices.add(beforeIndex);
                beforeIndex += 1;
            }
            else
            {
                addedIndices.add(afterIndex);
                afterIndex += 1;
            }
        }

        while (beforeIndex < beforeWords.length)
        {
            removedIndices.add(beforeIndex);
            beforeIndex += 1;
        }

        while (afterIndex < afterWords.length)
        {
            addedIndices.add(afterIndex);
            afterIndex += 1;
        }

        return { removedIndices: removedIndices, addedIndices: addedIndices };
    }

    static #renderPane(words, markedIndices, markClassName)
    {
        return words
            .map((word, index) =>
            {
                const escapedWord = HtmlDiffBuilder.#escape(word);
                return markedIndices.has(index) ? `<mark class="${markClassName}">${escapedWord}</mark>` : escapedWord;
            })
            .join(" ");
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

export default HtmlDiffBuilder;
