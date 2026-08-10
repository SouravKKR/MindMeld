/**
 * HtmlDiffBuilder — marks up what changed between two versions of a passage,
 * IN PLACE, leaving the passage's own markup intact.
 *
 * Diffs the RENDERED TEXT, not the HTML source. Two versions of a lesson that
 * read identically can differ in whitespace, attribute order or tag nesting for
 * reasons no reviewer cares about, and a source-level diff paints most of the
 * page as changed — at which point the reviewer stops reading it and starts
 * clicking Apply, which is exactly the failure this whole flow exists to avoid.
 *
 * But the diff is APPLIED to the document rather than to a flattened string. An
 * earlier version tokenised `body.textContent` and re-emitted escaped words
 * joined by spaces, which was correct as a comparison and useless as a review
 * surface: every heading, list, table and figure was gone, and the reviewer was
 * asked to approve a lesson while looking at a wall of text. Here both sides are
 * parsed, walked, marked and re-serialised, so the panes show the lesson and the
 * changed words are highlighted inside it.
 *
 * Word-level, not character-level. A character differ on prose highlights the
 * two letters inside a changed number and reads as noise; a word differ
 * highlights the number.
 *
 * THREE KINDS OF SUBTREE ARE NEVER MARKED, and the reasons differ:
 *
 *   figures      — a diagram is compared by looking at it, side by side, which
 *                  the dialog does separately. Running its base64 payload or its
 *                  SVG path data through a word differ would produce thousands
 *                  of meaningless marks. Pruned from the walk, so the figure is
 *                  still RENDERED in the pane — it just contributes no words.
 *   mermaid      — GeneratedVisualRenderer replaces the block's innerHTML with
 *                  the rendered diagram a frame later, so any mark inside it is
 *                  destroyed anyway. Marking it buys a flash of confetti.
 *   equations    — KaTeX's auto-render scans ONE TEXT NODE AT A TIME. Splitting
 *                  a text node between `\(` and `\)` does not merely move the
 *                  marks, it stops the equation being typeset at all, silently,
 *                  in both panes. Such a node is treated as ATOMIC: its words
 *                  still enter the comparison, so the alignment is unchanged,
 *                  but every offset spans the whole node and collapses to a
 *                  single mark around it.
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
     * lesson and still fits; beyond that the walk degrades to "too large to
     * compare" rather than allocating a matrix big enough to lock the tab.
     */
    static #MAXIMUM_COMPARISON_CELLS = 4000000;

    /**
     * Subtrees the walk prunes entirely. FILTER_REJECT rather than FILTER_SKIP
     * is the whole mechanism: REJECT drops the element AND its descendants,
     * which is how a figure stays in the rendered output while contributing no
     * words to the comparison. SKIP would still descend into it.
     */
    static #SKIPPED_ELEMENT_SELECTOR = "figure, pre.mermaid, .mermaid, svg, canvas, script, style";

    /**
     * The KaTeX delimiters GeneratedVisualRenderer configures. A text node
     * containing any of them is indivisible — see the class comment.
     */
    static #MATH_DELIMITER_PATTERN = /\\\(|\\\)|\\\[|\\\]/;

    static #WORD_PATTERN = /\S+/g;

    /**
     * Builds both panes at once.
     *
     * @param {string} beforeHtml
     * @param {string} afterHtml
     * @return {{beforeHtml: string, afterHtml: string, changedWordCount: number, bAnyChange: boolean, bComparisonTooLarge: boolean}}
     */
    static build(beforeHtml, afterHtml)
    {
        const beforeSide = HtmlDiffBuilder.#parseAndTokenize(beforeHtml);
        const afterSide = HtmlDiffBuilder.#parseAndTokenize(afterHtml);

        if (HtmlDiffBuilder.#isComparisonTooLarge(beforeSide.words, afterSide.words))
        {
            // Rendered unmarked rather than marked everywhere. Marking every
            // word is zero signal at exactly the size where marking costs the
            // most, and it would bury a real edit among thousands of false ones.
            return {
                beforeHtml: beforeSide.parsedDocument.body.innerHTML,
                afterHtml: afterSide.parsedDocument.body.innerHTML,
                changedWordCount: 0,
                // TRUE, deliberately. Reporting "no change" here would make the
                // dialog tell the reviewer the wording is unchanged, which is
                // not something this method actually established.
                bAnyChange: true,
                bComparisonTooLarge: true,
            };
        }

        const alignment = HtmlDiffBuilder.#alignWords(beforeSide.words, afterSide.words);

        HtmlDiffBuilder.#applyMarks(beforeSide.occurrences, alignment.removedIndices, HtmlDiffBuilder.REMOVED_CLASS_NAME);
        HtmlDiffBuilder.#applyMarks(afterSide.occurrences, alignment.addedIndices, HtmlDiffBuilder.ADDED_CLASS_NAME);

        return {
            beforeHtml: beforeSide.parsedDocument.body.innerHTML,
            afterHtml: afterSide.parsedDocument.body.innerHTML,
            changedWordCount: alignment.removedIndices.size + alignment.addedIndices.size,
            bAnyChange: alignment.removedIndices.size > 0 || alignment.addedIndices.size > 0,
            bComparisonTooLarge: false,
        };
    }

    /**
     * Parses one side and records every word together with the exact position it
     * occupies, so a mark can later be inserted around it without rebuilding the
     * document.
     *
     * The document is INERT (DOMParser), so nothing in the passage loads a
     * resource or runs a handler while it is being walked.
     */
    static #parseAndTokenize(htmlContent)
    {
        const parsedDocument = new DOMParser().parseFromString(
            typeof htmlContent === "string" ? htmlContent : "",
            "text/html",
        );

        const words = [];
        const occurrences = [];

        const treeWalker = parsedDocument.createTreeWalker(
            parsedDocument.body,
            NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
            {
                acceptNode: (visitedNode) =>
                {
                    if (visitedNode.nodeType !== Node.ELEMENT_NODE)
                    {
                        return NodeFilter.FILTER_ACCEPT;
                    }

                    return visitedNode.matches(HtmlDiffBuilder.#SKIPPED_ELEMENT_SELECTOR)
                        ? NodeFilter.FILTER_REJECT
                        : NodeFilter.FILTER_SKIP;
                },
            },
        );

        for (let textNode = treeWalker.nextNode(); textNode !== null; textNode = treeWalker.nextNode())
        {
            const bAtomicTextNode = HtmlDiffBuilder.#MATH_DELIMITER_PATTERN.test(textNode.data);

            // matchAll rather than split: match.index is the only cheap source
            // of the offset, and the offset is the entire point — a split
            // discards the position the mark has to be inserted at.
            for (const wordMatch of textNode.data.matchAll(HtmlDiffBuilder.#WORD_PATTERN))
            {
                occurrences.push({
                    textNode: textNode,
                    startOffset: bAtomicTextNode ? 0 : wordMatch.index,
                    endOffset: bAtomicTextNode ? textNode.data.length : wordMatch.index + wordMatch[0].length,
                    wordIndex: words.length,
                });

                words.push(wordMatch[0]);
            }
        }

        return { parsedDocument: parsedDocument, words: words, occurrences: occurrences };
    }

    static #isComparisonTooLarge(beforeWords, afterWords)
    {
        return beforeWords.length * afterWords.length > HtmlDiffBuilder.#MAXIMUM_COMPARISON_CELLS;
    }

    /**
     * Finds which words are unique to each side.
     *
     * A longest-common-subsequence walk over the two word lists, computed with a
     * rolling row rather than a full table so a long lesson does not allocate a
     * matrix of every word against every word. The size ceiling is checked by
     * the caller, which has a better answer than this method could give.
     */
    static #alignWords(beforeWords, afterWords)
    {
        const removedIndices = new Set();
        const addedIndices = new Set();

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

    /**
     * Wraps every marked word in a <mark>, working directly on the parsed
     * document.
     *
     * splitText is used rather than Range.surroundContents (which throws
     * whenever a range partially selects a non-Text node, so it would need these
     * same splits underneath it anyway) and rather than rebuilding each text
     * node as a DocumentFragment (which means re-emitting text as new nodes, and
     * so re-introduces the manual HTML escaping this rewrite exists to delete).
     * With splitText every character stays inside a Text node from parse to
     * serialisation, so `&`, `<` and `"` in the passage come out correct by
     * construction.
     */
    static #applyMarks(occurrences, markedIndices, markClassName)
    {
        const rangesByTextNode = new Map();

        for (const occurrence of occurrences)
        {
            if (!markedIndices.has(occurrence.wordIndex))
            {
                continue;
            }

            if (!rangesByTextNode.has(occurrence.textNode))
            {
                rangesByTextNode.set(occurrence.textNode, []);
            }

            rangesByTextNode.get(occurrence.textNode).push(occurrence);
        }

        for (const [textNode, wordRanges] of rangesByTextNode)
        {
            const originalText = textNode.data;
            const mergedRanges = HtmlDiffBuilder.#mergeAdjacentRanges(originalText, wordRanges);

            // Descending order is load-bearing. splitText SHORTENS the node it
            // is called on, so an offset measured against the original text
            // stays valid only for the part of the node that has not been split
            // away yet — which, working right to left, is exactly the part every
            // remaining range points into.
            for (let rangeIndex = mergedRanges.length - 1; rangeIndex >= 0; rangeIndex -= 1)
            {
                const range = mergedRanges[rangeIndex];

                if (range.endOffset < textNode.data.length)
                {
                    textNode.splitText(range.endOffset);
                }

                const markedTextNode = range.startOffset > 0
                    ? textNode.splitText(range.startOffset)
                    : textNode;

                const markElement = markedTextNode.ownerDocument.createElement("mark");
                markElement.className = markClassName;

                markedTextNode.parentNode.insertBefore(markElement, markedTextNode);
                markElement.appendChild(markedTextNode);
            }
        }
    }

    /**
     * Collapses a run of consecutive marked words into one range.
     *
     * Eight changed words rendered as eight <mark> elements is confetti: the
     * stylesheet gives each mark a background and horizontal padding, so a
     * rewritten sentence reads as eight separate corrections with gaps between
     * them, and the strike-through on the removed side breaks at every space.
     * One mark over the whole run reads as what it is — one edit.
     *
     * Merging deliberately stops at the text node. A run spanning </li><li>
     * cannot be covered by a single <mark> without producing markup the parser
     * would re-nest, and a mark per item is the correct rendering there anyway.
     */
    static #mergeAdjacentRanges(originalText, wordRanges)
    {
        const sortedRanges = [...wordRanges].sort((firstRange, secondRange) => firstRange.startOffset - secondRange.startOffset);
        const mergedRanges = [];

        for (const range of sortedRanges)
        {
            const previousRange = mergedRanges[mergedRanges.length - 1];
            const bOnlyWhitespaceBetween = previousRange !== undefined
                && originalText.slice(previousRange.endOffset, range.startOffset).trim().length === 0;

            if (bOnlyWhitespaceBetween)
            {
                previousRange.endOffset = Math.max(previousRange.endOffset, range.endOffset);
                continue;
            }

            mergedRanges.push({ startOffset: range.startOffset, endOffset: range.endOffset });
        }

        return mergedRanges;
    }
}

export default HtmlDiffBuilder;
