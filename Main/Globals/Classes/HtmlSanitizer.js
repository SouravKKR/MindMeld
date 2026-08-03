/**
 * HtmlSanitizer
 *
 * Strict allow-list HTML sanitiser for any markup that did NOT originate
 * from this application's own static templates — card question / answer
 * bodies, study-material lesson HTML, LLM-generated answer-key prose, and
 * remote paid-deck content authored by other parties. None of these are
 * fully trusted: a card answer of `<img src=x onerror=alert(document.cookie)>`
 * would otherwise execute in the victim's session, and the page CSP permits
 * `'unsafe-inline'` so it does not block that sink.
 *
 * Approach (mirrors AskAiStreamRenderer's proven DOMParser walk, widened to
 * the richer tag surface real study content uses — images, tables, coloured
 * text, links):
 *
 *   1. Parse the raw markup into an INERT document via DOMParser. An inert
 *      document never fetches resources, so an `<img onerror>` never fires
 *      during parsing — and we strip the handler before the string is ever
 *      assigned to a live element's innerHTML.
 *   2. Walk the tree depth-first. Tags on the remove-entirely list (script,
 *      style, iframe, svg, math, form controls, …) are dropped WITH their
 *      subtree — these are the script-execution sinks and the classic
 *      mutation-XSS namespace-confusion pivots. Any other tag outside the
 *      allow-list is UNWRAPPED (its children/prose are kept, the wrapper is
 *      dropped) so legitimate text survives.
 *   3. On every kept element: drop every `on*` event handler, drop every
 *      attribute outside the allow-list, neutralise dangerous URL schemes
 *      (javascript:, vbscript:, data:text/html, …) on URL-bearing
 *      attributes, and sanitise inline `style` against CSS-borne vectors.
 *
 * The output is a fragment STRING; callers assign it via `innerHTML`. KaTeX
 * delimiters (`\(…\)`, `\[…\]`) live in text nodes and pass through
 * untouched, so post-render `renderLatex()` still works.
 */
class HtmlSanitizer
{
    // Tags kept in the output. Their attributes are still filtered. Covers
    // the formatting/structure/media/table surface the rich-text card editor,
    // the curated-study LLM, and scraped lessons actually emit.
    static #ALLOWED_TAG_NAMES = new Set([
        "p", "br", "hr", "div", "span", "section", "article", "header", "footer", "main", "aside",
        // <button> is allowed (with on* handlers + formaction stripped, an
        // inert button executes nothing). It is required: the Ask-AI
        // "append block" / "popup link" features round-trip a delete /
        // marker <button> THROUGH card & study-material HTML and rely on the
        // sanitiser leaving it intact — see AskAiInjectedBlock /
        // AskAiPopupLink.
        "button",
        "h1", "h2", "h3", "h4", "h5", "h6",
        "blockquote", "pre", "code", "kbd", "samp", "var",
        "strong", "b", "em", "i", "u", "s", "strike", "del", "ins", "mark", "small", "sub", "sup", "font",
        "ul", "ol", "li", "dl", "dt", "dd",
        "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col",
        "a", "img", "figure", "figcaption",
        "abbr", "cite", "q", "time", "address", "details", "summary", "wbr", "ruby", "rt", "rp",
    ]);

    // Tags dropped together with their entire subtree. These either execute
    // script, embed foreign content, or are the namespace pivots used by
    // mutation-XSS bypasses. Unlike a disallowed-but-harmless tag, we do NOT
    // keep their children.
    static #REMOVE_WITH_SUBTREE_TAG_NAMES = new Set([
        "script", "style", "iframe", "object", "embed", "applet",
        "base", "link", "meta", "form", "input", "textarea",
        "select", "option", "optgroup", "label", "fieldset", "legend",
        "noscript", "template", "math", "frame", "frameset",
        "audio", "video", "source", "track", "picture", "canvas", "map", "area",
        "title", "head", "html", "body",
        // SVG elements that re-enter the HTML namespace, pull in external
        // content, or carry timing/animation behaviour. These are the classic
        // mutation-XSS pivots, so they are dropped WITH their subtree rather
        // than unwrapped — `foreignObject` in particular is the one that turns
        // an SVG into an HTML injection point.
        "foreignobject", "use", "image", "animate", "animatetransform",
        "animatemotion", "set", "mpath", "handler", "listener",
    ]);

    // Inline SVG is permitted, but only this element set, and only with the
    // attributes below.
    //
    // Why it is allowed at all: the paid-deck pipeline generates technical
    // diagrams (ray diagrams, circuits, graphs, free-body diagrams) as SVG
    // precisely because SVG keeps labels as real text and coordinates exact,
    // where an image model garbles both. Dropping `<svg>` with its subtree — the
    // previous behaviour — meant those diagrams silently vanished at render
    // time, leaving blank gaps in a lesson with nothing to debug from.
    //
    // Why it is still restricted: `<svg>` is a foreign-content namespace, and
    // the elements that make it dangerous (script, style, foreignObject, use,
    // animation timing) are exactly the ones NOT in this list — they are on the
    // remove-with-subtree list above. What remains is geometry and text, which
    // carry no execution capability once `on*` handlers and URL-bearing
    // attributes are stripped by the shared attribute pass.
    static #ALLOWED_SVG_TAG_NAMES = new Set([
        "svg", "g", "defs", "symbol", "marker", "clippath", "mask",
        "path", "line", "polyline", "polygon", "rect", "circle", "ellipse",
        "text", "tspan", "textpath",
        "lineargradient", "radialgradient", "stop", "pattern",
    ]);

    // Presentation and geometry attributes only. Note these are matched
    // lowercased, because the HTML parser preserves SVG's camelCase names
    // (`viewBox`) while this sanitiser compares in lower case — hence
    // "viewbox", "gradientunits" and friends appearing in this form.
    static #ALLOWED_SVG_ATTRIBUTE_NAMES = new Set([
        "class", "id", "d", "points", "transform",
        "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry",
        "dx", "dy", "width", "height", "viewbox", "preserveaspectratio",
        "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width",
        "stroke-dasharray", "stroke-dashoffset", "stroke-linecap",
        "stroke-linejoin", "stroke-opacity", "stroke-miterlimit",
        "opacity", "visibility", "display", "clip-path", "mask",
        "font-family", "font-size", "font-style", "font-weight",
        "text-anchor", "dominant-baseline", "alignment-baseline",
        "letter-spacing", "word-spacing", "writing-mode",
        "marker-start", "marker-mid", "marker-end", "orient",
        "refx", "refy", "markerwidth", "markerheight", "markerunits",
        "offset", "stop-color", "stop-opacity",
        "gradientunits", "gradienttransform", "spreadmethod",
        "patternunits", "patterncontentunits", "clippathunits", "maskunits",
        "xmlns", "version", "role", "aria-label",
    ]);

    // Attributes kept on any allowed element. `id` is deliberately excluded
    // (DOM-clobbering surface). `data-*` attributes are allowed via the
    // prefix check in #isAllowedAttributeName — they cannot execute script.
    static #ALLOWED_ATTRIBUTE_NAMES = new Set([
        "class", "title", "dir", "lang", "align", "valign", "role",
        "colspan", "rowspan", "headers", "scope", "span",
        "start", "reversed", "type", "value",
        "alt", "width", "height",
        "href", "target", "rel", "download", "name", "cite", "datetime",
        "color", "face", "size",
        "src", "style",
        // Chemical structure notation carried by generated paid-deck visuals and
        // drawn by GeneratedVisualRenderer. Inert data, not a URL and not a
        // handler: it is read by SmilesDrawer and never interpreted as markup,
        // so it needs no scheme validation. Without it the attribute is stripped
        // and every generated structure renders as an empty span.
        "data-smiles",
    ]);

    // Attributes whose value is a URL — these get scheme-validated so a
    // `javascript:`/`vbscript:`/`data:text/html` payload can't ride in.
    static #URL_ATTRIBUTE_NAMES = new Set([
        "href", "src", "cite",
    ]);

    // URL schemes considered safe for navigation / resource loading.
    static #SAFE_URL_SCHEMES = new Set([
        "http", "https", "mailto", "tel", "ftp",
    ]);

    /**
     * Returns a sanitised HTML fragment string. Pass the result straight to
     * `element.innerHTML`. A null/undefined/empty input yields "".
     */
    static sanitize(rawHtml)
    {
        if (rawHtml === null || rawHtml === undefined || rawHtml === "")
        {
            return "";
        }

        const parsedDocument = new DOMParser().parseFromString(
            "<!doctype html><body>" + String(rawHtml) + "</body>",
            "text/html"
        );
        HtmlSanitizer.#sanitizeSubtree(parsedDocument.body, false);
        return parsedDocument.body.innerHTML;
    }

    /**
     * Convenience sink: sanitise `rawHtml` and assign it to `element`'s
     * innerHTML in one call. No-op when the element is missing.
     */
    static setInnerHtml(element, rawHtml)
    {
        if (!element)
        {
            return;
        }
        element.innerHTML = HtmlSanitizer.sanitize(rawHtml);
    }

    /**
     * Depth-first walk. Snapshot children first because both unwrapping and
     * subtree removal mutate childNodes mid-iteration, which would otherwise
     * skip siblings.
     */
    static #sanitizeSubtree(rootElement, bInsideSvg)
    {
        const childNodeSnapshot = Array.from(rootElement.childNodes);
        for (const childNode of childNodeSnapshot)
        {
            if (childNode.nodeType === Node.COMMENT_NODE)
            {
                childNode.remove();
                continue;
            }

            if (childNode.nodeType !== Node.ELEMENT_NODE)
            {
                // Text and other leaf nodes are kept verbatim.
                continue;
            }

            const tagName = childNode.tagName.toLowerCase();

            if (HtmlSanitizer.#REMOVE_WITH_SUBTREE_TAG_NAMES.has(tagName))
            {
                // Drop the element AND everything under it — do not recurse,
                // do not keep children.
                childNode.remove();
                continue;
            }

            // Once inside an <svg>, stay inside: the SVG allow-lists apply to
            // the whole subtree, not just the root element.
            const bChildIsInsideSvg = bInsideSvg || tagName === "svg";

            // Clean the subtree before acting on the element itself, so an
            // unwrap lifts an already-clean set of children into the parent.
            HtmlSanitizer.#sanitizeSubtree(childNode, bChildIsInsideSvg);

            if (bChildIsInsideSvg)
            {
                if (!HtmlSanitizer.#ALLOWED_SVG_TAG_NAMES.has(tagName))
                {
                    // An unknown element inside SVG is unwrapped rather than
                    // dropped, matching the HTML side: its children have already
                    // been cleaned, so keeping them loses nothing dangerous.
                    HtmlSanitizer.#unwrapElement(childNode);
                    continue;
                }

                HtmlSanitizer.#sanitizeSvgAttributes(childNode);
                continue;
            }

            if (!HtmlSanitizer.#ALLOWED_TAG_NAMES.has(tagName))
            {
                HtmlSanitizer.#unwrapElement(childNode);
                continue;
            }

            HtmlSanitizer.#sanitizeAttributes(childNode, tagName);
        }
    }

    /**
     * Attribute pass for elements inside an `<svg>`. Same two guarantees as the
     * HTML pass — every `on*` handler is dropped and everything outside the
     * allow-list is dropped — but against the SVG attribute surface.
     *
     * Namespaced attributes (`xlink:href`, `xml:*`) are not on the allow-list
     * and are therefore removed; `xlink:href` in particular is how an SVG would
     * otherwise reference external or `javascript:` content.
     */
    static #sanitizeSvgAttributes(elementNode)
    {
        const attributeNames = Array.from(elementNode.attributes).map((attribute) => attribute.name);
        for (const attributeName of attributeNames)
        {
            const lowered = attributeName.toLowerCase();

            if (lowered.startsWith("on"))
            {
                elementNode.removeAttribute(attributeName);
                continue;
            }

            if (lowered.startsWith("data-") || lowered.startsWith("aria-"))
            {
                continue;
            }

            if (!HtmlSanitizer.#ALLOWED_SVG_ATTRIBUTE_NAMES.has(lowered))
            {
                elementNode.removeAttribute(attributeName);
                continue;
            }

            // A handful of allowed SVG attributes take a functional IRI —
            // `fill="url(#gradient)"`, `clip-path="url(#mask)"`. Only same-
            // document fragment references are kept; anything resolving
            // elsewhere (or to a scheme) is dropped.
            const attributeValue = elementNode.getAttribute(attributeName) || "";
            if (attributeValue.includes("url(") && !HtmlSanitizer.#isSafeFunctionalIri(attributeValue))
            {
                elementNode.removeAttribute(attributeName);
            }
        }
    }

    /**
     * True only when every `url(...)` in the value is a local fragment
     * reference such as `url(#arrowhead)`.
     */
    static #isSafeFunctionalIri(attributeValue)
    {
        const urlReferenceMatches = String(attributeValue).match(/url\s*\(([^)]*)\)/gi) || [];
        for (const urlReference of urlReferenceMatches)
        {
            const innerReference = urlReference
                .replace(/^url\s*\(/i, "")
                .replace(/\)$/, "")
                .replace(/['"]/g, "")
                .trim();

            if (!innerReference.startsWith("#"))
            {
                return false;
            }
        }
        return true;
    }

    static #sanitizeAttributes(elementNode, tagName)
    {
        const attributeNames = Array.from(elementNode.attributes).map((attribute) => attribute.name);
        for (const attributeName of attributeNames)
        {
            const lowered = attributeName.toLowerCase();

            // Event handlers are the primary execution sink — drop them all.
            if (lowered.startsWith("on"))
            {
                elementNode.removeAttribute(attributeName);
                continue;
            }

            if (!HtmlSanitizer.#isAllowedAttributeName(lowered))
            {
                elementNode.removeAttribute(attributeName);
                continue;
            }

            if (lowered === "style")
            {
                HtmlSanitizer.#sanitizeStyleAttribute(elementNode);
                continue;
            }

            if (HtmlSanitizer.#URL_ATTRIBUTE_NAMES.has(lowered))
            {
                const urlValue = elementNode.getAttribute(attributeName) || "";
                if (!HtmlSanitizer.#isSafeUrl(urlValue, lowered))
                {
                    elementNode.removeAttribute(attributeName);
                }
            }
        }

        // A link opened in a new tab gets noopener/noreferrer so the opened
        // page can't reach back through window.opener.
        if (tagName === "a" && (elementNode.getAttribute("target") || "").length > 0)
        {
            elementNode.setAttribute("rel", "noopener noreferrer");
        }
    }

    static #isAllowedAttributeName(loweredName)
    {
        // data-* carry no script-execution capability and the rich-text
        // editor / Ask-AI markers use them for book-keeping, so keep them.
        // aria-* are accessibility hints and likewise inert.
        if (loweredName.startsWith("data-") || loweredName.startsWith("aria-"))
        {
            return true;
        }
        return HtmlSanitizer.#ALLOWED_ATTRIBUTE_NAMES.has(loweredName);
    }

    /**
     * Validates a URL-bearing attribute value. Relative URLs and anchors
     * (no scheme) are allowed; `data:` is allowed ONLY for images on `src`;
     * every other scheme must be on the safe list. Control characters and
     * whitespace are stripped first because browsers ignore them when
     * resolving a scheme (`java\tscript:` resolves to javascript:).
     */
    static #isSafeUrl(rawValue, attributeName)
    {
        const normalized = String(rawValue).replace(/[\x00-\x20\x7f]+/g, "").toLowerCase();

        if (normalized === "")
        {
            return true;
        }

        const schemeMatch = normalized.match(/^([a-z][a-z0-9+.\-]*):/);
        if (!schemeMatch)
        {
            // No scheme -> relative path, query, or fragment. Safe.
            return true;
        }

        const scheme = schemeMatch[1];

        if (scheme === "data")
        {
            // Inline data is only ever legitimate as an image source here
            // (the card editor embeds pasted images as data:image/…;base64).
            return attributeName === "src" && normalized.startsWith("data:image/");
        }

        return HtmlSanitizer.#SAFE_URL_SCHEMES.has(scheme);
    }

    /**
     * Inline style is kept (coloured / highlighted text is a first-class
     * editor feature) but scrubbed of the CSS-borne execution vectors:
     * `expression()`, `javascript:` / `vbscript:` URLs, `@import`, IE
     * `behavior`, and any `url(...)` that doesn't resolve to a safe scheme.
     * If anything dangerous is present the whole attribute is dropped rather
     * than partially rewritten.
     */
    static #sanitizeStyleAttribute(elementNode)
    {
        const styleValue = (elementNode.getAttribute("style") || "").toLowerCase();

        const hasDangerousToken = /expression\s*\(|javascript:|vbscript:|@import|behavior\s*:|-moz-binding/.test(styleValue);

        let hasUnsafeUrl = false;
        const urlReferenceMatches = styleValue.match(/url\s*\(([^)]*)\)/g) || [];
        for (const urlReference of urlReferenceMatches)
        {
            const innerUrl = urlReference
                .replace(/^url\s*\(/, "")
                .replace(/\)$/, "")
                .replace(/['"]/g, "")
                .trim();
            if (!HtmlSanitizer.#isSafeUrl(innerUrl, "src"))
            {
                hasUnsafeUrl = true;
                break;
            }
        }

        if (hasDangerousToken || hasUnsafeUrl)
        {
            elementNode.removeAttribute("style");
        }
    }

    /**
     * Replace `elementNode` with its children in the parent — drops a
     * disallowed-but-harmless wrapper (e.g. <span>, <font> when it carried
     * nothing keepable) while preserving the prose inside it.
     */
    static #unwrapElement(elementNode)
    {
        const parentNode = elementNode.parentNode;
        if (!parentNode)
        {
            return;
        }
        while (elementNode.firstChild)
        {
            parentNode.insertBefore(elementNode.firstChild, elementNode);
        }
        parentNode.removeChild(elementNode);
    }
}

export default HtmlSanitizer;
