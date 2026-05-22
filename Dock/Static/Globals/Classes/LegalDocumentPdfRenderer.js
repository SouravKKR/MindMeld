/**
 * LegalDocumentPdfRenderer
 *
 * Converts a legal-document HTML payload (as served by /LegalDocuments)
 * into a paginated jsPDF document that preserves the structural
 * formatting — headings, paragraphs, bullet lists, bold / italic runs —
 * so the offline copy reads as cleanly as the in-app modal. Text stays
 * selectable and searchable in the resulting PDF; we deliberately do
 * NOT rasterise via html2canvas because that produces a heavier and
 * less accessible file.
 *
 * The legal-document HTML uses a small vocabulary (h3, h4, p, ul, li,
 * strong, em, br). Anything unrecognised is rendered as plain text.
 */
class LegalDocumentPdfRenderer
{
    static #PAGE_FORMAT             = "a4";
    static #PAGE_ORIENTATION        = "p";
    static #PAGE_UNIT               = "mm";

    static #PAGE_WIDTH_MM           = 210;
    static #PAGE_HEIGHT_MM          = 297;
    static #PAGE_MARGIN_MM          = 18;
    static #FOOTER_RESERVED_MM      = 14;

    static #FONT_FAMILY             = "helvetica";

    static #TITLE_FONT_SIZE_PT      = 18;
    static #H3_FONT_SIZE_PT         = 14;
    static #H4_FONT_SIZE_PT         = 12;
    static #BODY_FONT_SIZE_PT       = 10.5;
    static #META_FONT_SIZE_PT       = 9;
    static #FOOTER_FONT_SIZE_PT     = 8;

    static #LINE_HEIGHT_FACTOR      = 1.35;
    static #PT_TO_MM                = 0.35278;

    static #BULLET_INDENT_MM        = 6;
    static #BULLET_GLYPH            = "•";

    static #SPACING_AFTER_TITLE_MM  = 6;
    static #SPACING_AFTER_HEADING_MM = 2.5;
    static #SPACING_AFTER_PARAGRAPH_MM = 3;
    static #SPACING_AFTER_LIST_ITEM_MM = 1.5;
    static #SPACING_AFTER_LIST_MM   = 2.5;

    /**
     * Renders the document and returns a PDF Blob.
     * @param {{key:string,title:string,version:number,contentHtml:string}} legalDocument
     * @returns {Blob}
     */
    static renderToBlob(legalDocument)
    {
        const documentInstance = LegalDocumentPdfRenderer.#renderInternal(legalDocument);
        return documentInstance.output("blob");
    }

    static #renderInternal(legalDocument)
    {
        const documentInstance = new window.jspdf.jsPDF({
            orientation: LegalDocumentPdfRenderer.#PAGE_ORIENTATION,
            unit:        LegalDocumentPdfRenderer.#PAGE_UNIT,
            format:      LegalDocumentPdfRenderer.#PAGE_FORMAT,
        });

        const pageState =
        {
            documentInstance: documentInstance,
            cursorYMillimetres: LegalDocumentPdfRenderer.#PAGE_MARGIN_MM,
            pageIndex: 1,
            documentTitle: legalDocument.title || "Legal Document",
            documentVersion: legalDocument.version,
        };

        LegalDocumentPdfRenderer.#renderTitleBlock(pageState);

        const bodyDom = LegalDocumentPdfRenderer.#parseHtmlToDom(legalDocument.contentHtml || "");
        for (const childNode of Array.from(bodyDom.childNodes))
        {
            LegalDocumentPdfRenderer.#renderBlockNode(pageState, childNode);
        }

        LegalDocumentPdfRenderer.#drawFooterOnEveryPage(pageState);

        return documentInstance;
    }

    static #renderTitleBlock(pageState)
    {
        const { documentInstance } = pageState;

        documentInstance.setFont(LegalDocumentPdfRenderer.#FONT_FAMILY, "bold");
        documentInstance.setFontSize(LegalDocumentPdfRenderer.#TITLE_FONT_SIZE_PT);
        documentInstance.setTextColor(0, 0, 0);

        const contentWidth = LegalDocumentPdfRenderer.#contentWidthMillimetres();
        const titleLines = documentInstance.splitTextToSize(pageState.documentTitle, contentWidth);
        documentInstance.text(titleLines, LegalDocumentPdfRenderer.#PAGE_MARGIN_MM, pageState.cursorYMillimetres + LegalDocumentPdfRenderer.#lineHeightMillimetres(LegalDocumentPdfRenderer.#TITLE_FONT_SIZE_PT) - 1);
        pageState.cursorYMillimetres += titleLines.length * LegalDocumentPdfRenderer.#lineHeightMillimetres(LegalDocumentPdfRenderer.#TITLE_FONT_SIZE_PT);

        if (typeof pageState.documentVersion === "number" || (typeof pageState.documentVersion === "string" && pageState.documentVersion.length > 0))
        {
            documentInstance.setFont(LegalDocumentPdfRenderer.#FONT_FAMILY, "normal");
            documentInstance.setFontSize(LegalDocumentPdfRenderer.#META_FONT_SIZE_PT);
            documentInstance.setTextColor(120, 120, 120);
            documentInstance.text(`Version ${pageState.documentVersion}`, LegalDocumentPdfRenderer.#PAGE_MARGIN_MM, pageState.cursorYMillimetres + LegalDocumentPdfRenderer.#lineHeightMillimetres(LegalDocumentPdfRenderer.#META_FONT_SIZE_PT) - 1);
            pageState.cursorYMillimetres += LegalDocumentPdfRenderer.#lineHeightMillimetres(LegalDocumentPdfRenderer.#META_FONT_SIZE_PT);
            documentInstance.setTextColor(0, 0, 0);
        }

        pageState.cursorYMillimetres += LegalDocumentPdfRenderer.#SPACING_AFTER_TITLE_MM;
    }

    static #renderBlockNode(pageState, blockNode)
    {
        if (blockNode.nodeType === Node.TEXT_NODE)
        {
            const trimmed = (blockNode.textContent || "").trim();
            if (trimmed.length > 0)
            {
                LegalDocumentPdfRenderer.#renderParagraphRuns(pageState, [{ text: trimmed, bold: false, italic: false }], LegalDocumentPdfRenderer.#PAGE_MARGIN_MM, LegalDocumentPdfRenderer.#contentWidthMillimetres(), LegalDocumentPdfRenderer.#BODY_FONT_SIZE_PT);
                pageState.cursorYMillimetres += LegalDocumentPdfRenderer.#SPACING_AFTER_PARAGRAPH_MM;
            }
            return;
        }

        if (blockNode.nodeType !== Node.ELEMENT_NODE)
        {
            return;
        }

        const tagName = blockNode.tagName.toLowerCase();

        switch (tagName)
        {
            case "h1":
            case "h2":
            case "h3":
                LegalDocumentPdfRenderer.#renderHeading(pageState, blockNode, LegalDocumentPdfRenderer.#H3_FONT_SIZE_PT);
                break;

            case "h4":
            case "h5":
            case "h6":
                LegalDocumentPdfRenderer.#renderHeading(pageState, blockNode, LegalDocumentPdfRenderer.#H4_FONT_SIZE_PT);
                break;

            case "p":
                LegalDocumentPdfRenderer.#renderParagraph(pageState, blockNode);
                break;

            case "ul":
            case "ol":
                LegalDocumentPdfRenderer.#renderList(pageState, blockNode);
                break;

            case "br":
                pageState.cursorYMillimetres += LegalDocumentPdfRenderer.#lineHeightMillimetres(LegalDocumentPdfRenderer.#BODY_FONT_SIZE_PT) * 0.5;
                break;

            default:
                // Unknown block — fall through to a paragraph render so nothing is silently dropped.
                LegalDocumentPdfRenderer.#renderParagraph(pageState, blockNode);
                break;
        }
    }

    static #renderHeading(pageState, headingElement, fontSizePt)
    {
        pageState.cursorYMillimetres += LegalDocumentPdfRenderer.#SPACING_AFTER_HEADING_MM;
        const runs = LegalDocumentPdfRenderer.#flattenToRuns(headingElement, { bold: true, italic: false });
        LegalDocumentPdfRenderer.#renderParagraphRuns(pageState, runs, LegalDocumentPdfRenderer.#PAGE_MARGIN_MM, LegalDocumentPdfRenderer.#contentWidthMillimetres(), fontSizePt);
        pageState.cursorYMillimetres += LegalDocumentPdfRenderer.#SPACING_AFTER_HEADING_MM;
    }

    static #renderParagraph(pageState, paragraphElement)
    {
        const runs = LegalDocumentPdfRenderer.#flattenToRuns(paragraphElement, { bold: false, italic: false });
        if (runs.length === 0)
        {
            return;
        }
        LegalDocumentPdfRenderer.#renderParagraphRuns(pageState, runs, LegalDocumentPdfRenderer.#PAGE_MARGIN_MM, LegalDocumentPdfRenderer.#contentWidthMillimetres(), LegalDocumentPdfRenderer.#BODY_FONT_SIZE_PT);
        pageState.cursorYMillimetres += LegalDocumentPdfRenderer.#SPACING_AFTER_PARAGRAPH_MM;
    }

    static #renderList(pageState, listElement)
    {
        const listItems = Array.from(listElement.children).filter(child => child.tagName && child.tagName.toLowerCase() === "li");
        if (listItems.length === 0)
        {
            return;
        }

        const bulletColumnXMillimetres = LegalDocumentPdfRenderer.#PAGE_MARGIN_MM;
        const textColumnXMillimetres   = LegalDocumentPdfRenderer.#PAGE_MARGIN_MM + LegalDocumentPdfRenderer.#BULLET_INDENT_MM;
        const textColumnWidthMillimetres = LegalDocumentPdfRenderer.#contentWidthMillimetres() - LegalDocumentPdfRenderer.#BULLET_INDENT_MM;

        for (const listItem of listItems)
        {
            const itemRuns = LegalDocumentPdfRenderer.#flattenToRuns(listItem, { bold: false, italic: false });
            if (itemRuns.length === 0)
            {
                continue;
            }

            LegalDocumentPdfRenderer.#ensureRoom(pageState, LegalDocumentPdfRenderer.#lineHeightMillimetres(LegalDocumentPdfRenderer.#BODY_FONT_SIZE_PT));

            // Bullet is drawn once, then the wrapped item text flows in the indented column.
            pageState.documentInstance.setFont(LegalDocumentPdfRenderer.#FONT_FAMILY, "normal");
            pageState.documentInstance.setFontSize(LegalDocumentPdfRenderer.#BODY_FONT_SIZE_PT);
            pageState.documentInstance.setTextColor(0, 0, 0);
            const bulletBaselineYMillimetres = pageState.cursorYMillimetres + LegalDocumentPdfRenderer.#lineHeightMillimetres(LegalDocumentPdfRenderer.#BODY_FONT_SIZE_PT) - 1.2;
            pageState.documentInstance.text(LegalDocumentPdfRenderer.#BULLET_GLYPH, bulletColumnXMillimetres + 1, bulletBaselineYMillimetres);

            LegalDocumentPdfRenderer.#renderParagraphRuns(pageState, itemRuns, textColumnXMillimetres, textColumnWidthMillimetres, LegalDocumentPdfRenderer.#BODY_FONT_SIZE_PT);
            pageState.cursorYMillimetres += LegalDocumentPdfRenderer.#SPACING_AFTER_LIST_ITEM_MM;
        }

        pageState.cursorYMillimetres += LegalDocumentPdfRenderer.#SPACING_AFTER_LIST_MM;
    }

    /**
     * Renders an array of {text, bold, italic} runs as a wrapped paragraph
     * starting at (xMillimetres, pageState.cursorYMillimetres) within the
     * given column width. Words are split between runs at whitespace
     * boundaries so a run-boundary in the middle of a word does not produce
     * a forced line break.
     */
    static #renderParagraphRuns(pageState, runs, xMillimetres, columnWidthMillimetres, fontSizePt)
    {
        const lineHeightMillimetres = LegalDocumentPdfRenderer.#lineHeightMillimetres(fontSizePt);

        const tokens = LegalDocumentPdfRenderer.#splitRunsToTokens(runs);
        if (tokens.length === 0)
        {
            return;
        }

        let currentLineTokens = [];
        let currentLineWidthMillimetres = 0;

        const flushCurrentLine = () =>
        {
            if (currentLineTokens.length === 0)
            {
                return;
            }

            LegalDocumentPdfRenderer.#ensureRoom(pageState, lineHeightMillimetres);

            let drawXMillimetres = xMillimetres;
            const baselineYMillimetres = pageState.cursorYMillimetres + lineHeightMillimetres - 1.2;

            for (let tokenIndex = 0; tokenIndex < currentLineTokens.length; tokenIndex++)
            {
                const lineToken = currentLineTokens[tokenIndex];
                const isLastTokenOnLine = (tokenIndex === currentLineTokens.length - 1);
                const visibleText = (isLastTokenOnLine && lineToken.text.endsWith(" "))
                    ? lineToken.text.replace(/\s+$/, "")
                    : lineToken.text;

                if (visibleText.length === 0)
                {
                    continue;
                }

                const fontStyle = LegalDocumentPdfRenderer.#fontStyleFor(lineToken.bold, lineToken.italic);
                pageState.documentInstance.setFont(LegalDocumentPdfRenderer.#FONT_FAMILY, fontStyle);
                pageState.documentInstance.setFontSize(fontSizePt);
                pageState.documentInstance.setTextColor(0, 0, 0);
                pageState.documentInstance.text(visibleText, drawXMillimetres, baselineYMillimetres);

                drawXMillimetres += LegalDocumentPdfRenderer.#measureTokenWidthMillimetres(pageState.documentInstance, visibleText, fontStyle, fontSizePt);
            }

            pageState.cursorYMillimetres += lineHeightMillimetres;
            currentLineTokens = [];
            currentLineWidthMillimetres = 0;
        };

        for (const token of tokens)
        {
            const fontStyle = LegalDocumentPdfRenderer.#fontStyleFor(token.bold, token.italic);
            const tokenWidthMillimetres = LegalDocumentPdfRenderer.#measureTokenWidthMillimetres(pageState.documentInstance, token.text, fontStyle, fontSizePt);

            if (currentLineTokens.length > 0 && currentLineWidthMillimetres + tokenWidthMillimetres > columnWidthMillimetres)
            {
                flushCurrentLine();
            }

            currentLineTokens.push(token);
            currentLineWidthMillimetres += tokenWidthMillimetres;
        }

        flushCurrentLine();
    }

    /**
     * Walks an element and produces a flat run list — each run is a
     * contiguous span of text with the same (bold, italic) flags. Inline
     * <strong>, <em>, <i>, <b>, and <br> are recognised; unknown inline
     * elements inherit the surrounding style.
     */
    static #flattenToRuns(rootElement, inheritedStyle)
    {
        const runs = [];

        const visit = (node, style) =>
        {
            if (node.nodeType === Node.TEXT_NODE)
            {
                const text = (node.textContent || "").replace(/\s+/g, " ");
                if (text.length > 0)
                {
                    runs.push({ text: text, bold: style.bold, italic: style.italic });
                }
                return;
            }

            if (node.nodeType !== Node.ELEMENT_NODE)
            {
                return;
            }

            const tag = node.tagName.toLowerCase();
            if (tag === "br")
            {
                runs.push({ text: "\n", bold: style.bold, italic: style.italic });
                return;
            }

            const nextStyle =
            {
                bold:   style.bold   || tag === "strong" || tag === "b",
                italic: style.italic || tag === "em"     || tag === "i",
            };

            for (const childNode of Array.from(node.childNodes))
            {
                visit(childNode, nextStyle);
            }
        };

        for (const childNode of Array.from(rootElement.childNodes))
        {
            visit(childNode, inheritedStyle);
        }

        return LegalDocumentPdfRenderer.#mergeAdjacentRuns(runs);
    }

    static #mergeAdjacentRuns(runs)
    {
        const merged = [];
        for (const run of runs)
        {
            const previous = merged[merged.length - 1];
            if (previous && previous.bold === run.bold && previous.italic === run.italic)
            {
                previous.text += run.text;
            }
            else
            {
                merged.push({ text: run.text, bold: run.bold, italic: run.italic });
            }
        }
        return merged.filter(run => run.text.length > 0);
    }

    /**
     * Splits runs into whitespace-bounded tokens that the line wrapper
     * can lay out independently. A space at the end of a token marks
     * "wrap is allowed after me"; explicit "\n" tokens force a line break.
     */
    static #splitRunsToTokens(runs)
    {
        const tokens = [];
        for (const run of runs)
        {
            if (run.text === "\n")
            {
                tokens.push({ text: "\n", bold: run.bold, italic: run.italic });
                continue;
            }

            const parts = run.text.split(/(\s+)/);
            let buffer = "";
            for (const part of parts)
            {
                if (part.length === 0)
                {
                    continue;
                }
                if (/^\s+$/.test(part))
                {
                    if (buffer.length > 0)
                    {
                        tokens.push({ text: buffer + " ", bold: run.bold, italic: run.italic });
                        buffer = "";
                    }
                }
                else
                {
                    buffer += part;
                }
            }
            if (buffer.length > 0)
            {
                tokens.push({ text: buffer + " ", bold: run.bold, italic: run.italic });
            }
        }
        return tokens;
    }

    static #measureTokenWidthMillimetres(documentInstance, text, fontStyle, fontSizePt)
    {
        documentInstance.setFont(LegalDocumentPdfRenderer.#FONT_FAMILY, fontStyle);
        documentInstance.setFontSize(fontSizePt);
        return documentInstance.getTextWidth(text);
    }

    static #fontStyleFor(bold, italic)
    {
        if (bold && italic) return "bolditalic";
        if (bold)           return "bold";
        if (italic)         return "italic";
        return "normal";
    }

    static #ensureRoom(pageState, requiredMillimetres)
    {
        const usableHeightMillimetres = LegalDocumentPdfRenderer.#PAGE_HEIGHT_MM
            - LegalDocumentPdfRenderer.#PAGE_MARGIN_MM
            - LegalDocumentPdfRenderer.#FOOTER_RESERVED_MM;

        if (pageState.cursorYMillimetres + requiredMillimetres > usableHeightMillimetres)
        {
            pageState.documentInstance.addPage();
            pageState.pageIndex++;
            pageState.cursorYMillimetres = LegalDocumentPdfRenderer.#PAGE_MARGIN_MM;
        }
    }

    static #drawFooterOnEveryPage(pageState)
    {
        const totalPageCount = pageState.documentInstance.internal.getNumberOfPages();
        for (let pageNumber = 1; pageNumber <= totalPageCount; pageNumber++)
        {
            pageState.documentInstance.setPage(pageNumber);
            pageState.documentInstance.setFont(LegalDocumentPdfRenderer.#FONT_FAMILY, "normal");
            pageState.documentInstance.setFontSize(LegalDocumentPdfRenderer.#FOOTER_FONT_SIZE_PT);
            pageState.documentInstance.setTextColor(140, 140, 140);
            const footerText = `${pageState.documentTitle}  ·  Page ${pageNumber} of ${totalPageCount}`;
            pageState.documentInstance.text(
                footerText,
                LegalDocumentPdfRenderer.#PAGE_WIDTH_MM / 2,
                LegalDocumentPdfRenderer.#PAGE_HEIGHT_MM - 9,
                { align: "center" }
            );
            pageState.documentInstance.setTextColor(0, 0, 0);
        }
    }

    static #parseHtmlToDom(rawHtml)
    {
        const parser = new DOMParser();
        const parsed = parser.parseFromString(`<!doctype html><html><body>${rawHtml}</body></html>`, "text/html");
        return parsed.body;
    }

    static #contentWidthMillimetres()
    {
        return LegalDocumentPdfRenderer.#PAGE_WIDTH_MM - 2 * LegalDocumentPdfRenderer.#PAGE_MARGIN_MM;
    }

    static #lineHeightMillimetres(fontSizePt)
    {
        return fontSizePt * LegalDocumentPdfRenderer.#PT_TO_MM * LegalDocumentPdfRenderer.#LINE_HEIGHT_FACTOR;
    }
}

export default LegalDocumentPdfRenderer;
