/**
 * AskAiStreamRenderer
 *
 * Sanitises and re-renders the running accumulator of streamed Gemini
 * markup into a host container. Called on every token arrival, so it
 * needs to tolerate partial / unbalanced HTML — DOMParser handles that
 * by auto-closing tags during parse, which is exactly what we want for
 * a live ticker that shows "...the resul" mid-stream.
 *
 * House style: structure-only HTML. The LLM is told in the prompt not
 * to emit color, but this is the second line of defence — we strip
 * style="..." / class / id / color / bgcolor / fgcolor and any on*
 * event handler on every kept element. The tag allow-list mirrors the
 * tags the system prompt asks for.
 */
class AskAiStreamRenderer
{
    static #ALLOWED_TAG_NAMES = new Set([
        "h2", "h3", "p", "ul", "ol", "li",
        "pre", "code", "strong", "em", "blockquote", "br",
        // Richer structural tags used by FORMAT mode (tables + grouped
        // layouts). The Explain / Ask / Summarize prompts don't ask the
        // LLM to emit these so they're effectively unused there, but the
        // sanitiser tolerates them everywhere — if a model decides a
        // table fits, we keep it.
        "table", "thead", "tbody", "tr", "th", "td",
        "figure", "figcaption", "div",
        // Web images — only ever emitted by the Pro / Pro Plus prompt when
        // google-search grounding is on. Kept <img>s are hardened in
        // #enforceSafeImage (http(s) src only, src/alt/width/height attrs);
        // AskAiResultView additionally drops any that fail to load.
        "img",
    ]);

    static #STRIPPED_ATTRIBUTE_NAMES = new Set([
        "style", "id", "color", "bgcolor", "fgcolor",
    ]);

    // Class names the renderer preserves on kept elements. FORMAT mode's
    // prompt instructs the LLM to use these for a card-grid layout
    // (frontend CSS in AskAiDialog.css renders them as a responsive
    // grid). Any other class value is stripped — keeps the surface
    // closed against arbitrary class injection while still allowing the
    // one layout we explicitly support.
    static #ALLOWED_CLASS_VALUES = new Set([
        "ask-ai-grid",
        "ask-ai-grid-item",
        // Block markers used by multi-item prompts (mnemonics, examples
        // — anywhere the prompt asks the LLM to wrap each item in
        // <div class="ask-ai-block">). Detection in
        // AskAiActionDispatcher.#detectBlocks pivots on this class.
        "ask-ai-block",
    ]);

    /**
     * Replace `containerElement.innerHTML` with the sanitised version of
     * `rawMarkup`. Safe to call on every chunk — typical 8 KB responses
     * cost <1ms per re-render in current Chrome.
     */
    static render(rawMarkup, containerElement)
    {
        if (!containerElement)
        {
            return;
        }
        const sanitisedHtml = AskAiStreamRenderer.sanitiseToStructuralHtml(rawMarkup || "");
        containerElement.innerHTML = sanitisedHtml;
    }

    /**
     * Returns a sanitised HTML fragment string. Exposed for callers that
     * want the markup without writing it into a container (e.g. unit
     * tests, or future copy-to-clipboard support).
     */
    static sanitiseToStructuralHtml(rawMarkup)
    {
        const withoutCodeFences = AskAiStreamRenderer.#stripCodeFenceWrappers(rawMarkup);
        const parsedDocument = new DOMParser().parseFromString(
            "<!doctype html><body>" + withoutCodeFences + "</body>",
            "text/html"
        );
        AskAiStreamRenderer.#sanitiseSubtree(parsedDocument.body);
        return parsedDocument.body.innerHTML;
    }

    /**
     * LLMs occasionally wrap their output in ```html ... ``` fences even
     * when the system prompt tells them not to. Strip a single leading
     * fence and matching trailing fence; leave fences in the middle
     * alone (they may be legitimate <pre><code> intent).
     */
    static #stripCodeFenceWrappers(rawMarkup)
    {
        let trimmedMarkup = rawMarkup.trim();
        const leadingFenceMatch = trimmedMarkup.match(/^```(?:html|xml)?\s*\n?/i);
        if (leadingFenceMatch)
        {
            trimmedMarkup = trimmedMarkup.slice(leadingFenceMatch[0].length);
            if (trimmedMarkup.endsWith("```"))
            {
                trimmedMarkup = trimmedMarkup.slice(0, -3);
            }
        }
        return trimmedMarkup.trim();
    }

    /**
     * Walks the subtree depth-first. For every element:
     *   - Strip every disallowed attribute (per the static set above + any on*).
     *   - If the tag is not allowed, unwrap it (replace with its children).
     * Comment nodes are removed outright.
     */
    static #sanitiseSubtree(rootElement)
    {
        // Snapshot children to a static array first — unwrapping mutates
        // childNodes mid-iteration, which leads to skipped nodes.
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
                continue;
            }

            // Recurse before deciding what to do with the element itself —
            // we want a clean subtree even if we're about to unwrap the
            // parent into the grandparent.
            AskAiStreamRenderer.#sanitiseSubtree(childNode);
            AskAiStreamRenderer.#stripDisallowedAttributes(childNode);

            const tagName = childNode.tagName.toLowerCase();
            if (!AskAiStreamRenderer.#ALLOWED_TAG_NAMES.has(tagName))
            {
                AskAiStreamRenderer.#unwrapElement(childNode);
            }
            else if (tagName === "img")
            {
                AskAiStreamRenderer.#enforceSafeImage(childNode);
            }
        }
    }

    /**
     * Hardens a kept <img>. The Pro prompt asks the model to embed real
     * web images, but the URL is model-supplied and therefore untrusted:
     *   - keep ONLY src / alt / width / height (drop srcset, loading,
     *     referrerpolicy, etc. — nothing else has a reason to ride along);
     *   - require an http(s) src — anything else (javascript:, data:,
     *     relative, empty) means a malformed or hostile link, so the whole
     *     element is removed rather than rendered.
     * A surviving-but-dead URL is handled later in the view layer
     * (AskAiResultView drops images that fail to load).
     */
    static #enforceSafeImage(imageElement)
    {
        const keptAttributeNames = new Set(["src", "alt", "width", "height"]);
        const attributeNames = Array.from(imageElement.attributes).map((attribute) => attribute.name);
        for (const attributeName of attributeNames)
        {
            if (!keptAttributeNames.has(attributeName.toLowerCase()))
            {
                imageElement.removeAttribute(attributeName);
            }
        }

        const sourceValue = (imageElement.getAttribute("src") || "").trim();
        if (!/^https?:\/\//i.test(sourceValue))
        {
            imageElement.remove();
        }
    }

    static #stripDisallowedAttributes(elementNode)
    {
        const attributeNames = Array.from(elementNode.attributes).map((attribute) => attribute.name);
        for (const attributeName of attributeNames)
        {
            const lowered = attributeName.toLowerCase();

            if (lowered === "class")
            {
                // Allow only the small known set of layout classes that
                // frontend CSS supports — strip everything else so the
                // LLM can't pull in arbitrary styling hooks.
                const rawClassValue = elementNode.getAttribute("class") || "";
                const keptClasses   = rawClassValue
                    .split(/\s+/)
                    .filter((candidateClass) => AskAiStreamRenderer.#ALLOWED_CLASS_VALUES.has(candidateClass));
                if (keptClasses.length > 0)
                {
                    elementNode.setAttribute("class", keptClasses.join(" "));
                }
                else
                {
                    elementNode.removeAttribute("class");
                }
                continue;
            }

            if (AskAiStreamRenderer.#STRIPPED_ATTRIBUTE_NAMES.has(lowered) || lowered.startsWith("on"))
            {
                elementNode.removeAttribute(attributeName);
            }
        }
    }

    /**
     * Replace `elementNode` with its child nodes in the parent. Used
     * when an LLM emits a tag outside our allow-list (e.g. <div>,
     * <span>, <font>) — we keep the prose, drop the wrapper.
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

export default AskAiStreamRenderer;
