import AskAiStreamRenderer from "../Classes/AskAiStreamRenderer.js";
import { askAiPromptModes } from "../../../Globals/Enumerations/AskAiPromptModes.js";

/**
 * AskAiResultView
 *
 * Web component that owns the body of the AskAi result dialog —
 * title, streaming markup region, citations footer, error/status
 * footer, and a reserved actions bar at the bottom.
 *
 * AskAiSession renders this element inside DialogBox.modal and then
 * pushes streamed chunks to it via the public methods below. Keeping
 * the dialog's content inside a web component (rather than raw HTML
 * inside AskAiSession) gives us a clean home for the future actions
 * bar — Insert into card, Copy as HTML, Regenerate, etc. — without
 * tangling the session's network logic with DOM construction.
 *
 * Public API:
 *   .setPromptMode(promptMode)           — sets the dialog title label
 *   .appendStreamingText(chunkValue)     — append a streamed chunk
 *   .renderCitations(sources)            — show citation footer
 *   .renderError(message)                — surface an error
 *   .markStreamComplete()                — drop the "Thinking…" state
 *   .getAccumulatedMarkup()              — read back current markup
 *   .populateActions(actionDescriptors)  — future: render action buttons
 *
 * The actions bar is intentionally hidden until populateActions() is
 * called with a non-empty list, so today it leaves no visual artefact.
 */
class AskAiResultView extends HTMLElement
{
    static tagName = "ask-ai-result-view";

    #titleElement = null;
    #bodyElement = null;
    #imagesElement = null;
    #citationsElement = null;
    #statusElement = null;
    #actionsElement = null;
    #accumulatedMarkup = "";
    #bCitationsRendered = false;
    #bImagesRendered = false;
    #bDoneReceived = false;

    connectedCallback()
    {
        this.innerHTML =
        `
            <h2 class="ask-ai-dialog-title" data-role="title"></h2>
            <div class="ask-ai-streaming-body generated-content ask-ai-pending" data-role="streaming-body">
                <p class="ask-ai-pending-indicator">Thinking…</p>
            </div>
            <div class="ask-ai-images" data-role="images" hidden></div>
            <div class="ask-ai-citations" data-role="citations" hidden></div>
            <div class="ask-ai-status" data-role="status" hidden></div>
            <div class="ask-ai-actions" data-role="actions" hidden>
                <!--
                  Reserved for future per-mode actions (Insert into card,
                  Copy as HTML, Regenerate, …). populateActions(...) renders
                  buttons here; until that ships the slot stays hidden so
                  it reserves no vertical space.
                -->
            </div>
        `;

        this.#titleElement     = this.querySelector('[data-role="title"]');
        this.#bodyElement      = this.querySelector('[data-role="streaming-body"]');
        this.#imagesElement    = this.querySelector('[data-role="images"]');
        this.#citationsElement = this.querySelector('[data-role="citations"]');
        this.#statusElement    = this.querySelector('[data-role="status"]');
        this.#actionsElement   = this.querySelector('[data-role="actions"]');
    }

    setPromptMode(promptMode)
    {
        if (!this.#titleElement)
        {
            return;
        }
        this.#titleElement.textContent = AskAiResultView.#resolveHeaderLabel(promptMode);
    }

    appendStreamingText(chunkValue)
    {
        if (!this.#bodyElement || typeof chunkValue !== "string")
        {
            return;
        }
        if (this.#accumulatedMarkup.length === 0)
        {
            // First chunk — drop the "Thinking…" placeholder class so the
            // pending state doesn't blend with the streamed content.
            this.#bodyElement.classList.remove("ask-ai-pending");
        }
        this.#accumulatedMarkup += chunkValue;
        AskAiStreamRenderer.render(this.#accumulatedMarkup, this.#bodyElement);
    }

    /**
     * Render the web-image thumbnail strip. Items come from the worker's
     * DDGS image search ({imageUrl, thumbnailUrl, sourceUrl, title}) on the
     * Pro / Pro Plus path. Idempotent + hidden when empty, mirroring
     * renderCitations. Each thumbnail links out to its source page and
     * drops itself if the image fails to load (404 / hotlink-blocked), so
     * the learner never sees a broken-image icon.
     */
    renderImages(imageItems)
    {
        if (this.#bImagesRendered || !this.#imagesElement)
        {
            return;
        }
        const items = (Array.isArray(imageItems) ? imageItems : [])
            .filter((imageItem) => imageItem && /^https?:\/\//i.test(imageItem.imageUrl || ""));
        if (items.length === 0)
        {
            return;
        }
        this.#bImagesRendered = true;

        const titleElement = document.createElement("h3");
        titleElement.className = "ask-ai-images-title";
        titleElement.textContent = "Images";

        const stripElement = document.createElement("div");
        stripElement.className = "ask-ai-images-strip";

        for (const imageItem of items)
        {
            const linkElement = document.createElement("a");
            linkElement.className = "ask-ai-image-link";
            linkElement.href = imageItem.sourceUrl || imageItem.imageUrl;
            linkElement.target = "_blank";
            linkElement.rel = "noopener noreferrer";

            const imageElement = document.createElement("img");
            imageElement.className = "ask-ai-image-thumb";
            imageElement.src = imageItem.thumbnailUrl || imageItem.imageUrl;
            imageElement.alt = imageItem.title || "Related image";
            imageElement.loading = "lazy";
            // Model-supplied / scraped URLs may 404 or be hotlink-blocked;
            // drop the whole thumbnail (its link wrapper) on load failure.
            imageElement.addEventListener("error", () =>
            {
                linkElement.remove();
                if (stripElement.querySelectorAll("img").length === 0)
                {
                    this.#imagesElement.hidden = true;
                }
            });

            linkElement.appendChild(imageElement);
            stripElement.appendChild(linkElement);
        }

        this.#imagesElement.hidden = false;
        this.#imagesElement.replaceChildren(titleElement, stripElement);
    }

    renderCitations(citationSources)
    {
        if (this.#bCitationsRendered || !this.#citationsElement)
        {
            return;
        }
        const sources = Array.isArray(citationSources) ? citationSources : [];
        if (sources.length === 0)
        {
            return;
        }
        this.#bCitationsRendered = true;

        const escapedHtmlList = sources.map((citationSource) =>
        {
            const safeUri   = AskAiResultView.#escapeHtml(citationSource.uri || "");
            const safeTitle = AskAiResultView.#escapeHtml(citationSource.title || citationSource.uri || "");
            return `<li><a href="${safeUri}" target="_blank" rel="noopener noreferrer">${safeTitle}</a></li>`;
        }).join("");

        this.#citationsElement.hidden = false;
        this.#citationsElement.innerHTML = `
            <h3 class="ask-ai-citations-title">Sources</h3>
            <ol class="ask-ai-citations-list">${escapedHtmlList}</ol>
        `;
    }

    renderError(errorMessage)
    {
        const safeMessage = AskAiResultView.#escapeHtml(errorMessage);

        // Preserve any streamed content the user has already seen — surface
        // the error in the status footer rather than wiping the body.
        if (this.#accumulatedMarkup.length > 0 && this.#statusElement)
        {
            this.#statusElement.hidden = false;
            this.#statusElement.innerHTML = `<p class="ask-ai-error-footer">Stream interrupted: ${safeMessage}</p>`;
            return;
        }

        if (this.#bodyElement)
        {
            this.#bodyElement.classList.remove("ask-ai-pending");
            this.#bodyElement.innerHTML = `<p class="ask-ai-error">${safeMessage}</p>`;
        }
    }

    markStreamComplete()
    {
        this.#bDoneReceived = true;
        this.#bodyElement?.classList.remove("ask-ai-pending");
        // The body is re-rendered on every streamed chunk (innerHTML
        // replace), which would wipe any KaTeX output mid-stream — so we
        // render math and wire image error-handling exactly once, now that
        // the markup has settled.
        this.#renderLatex();
        this.#wireImageErrorHandlers();
        // Future hook: this is where AskAiSession will call
        // populateActions(...) once the actions-bar feature ships.
    }

    /**
     * Render KaTeX into the streamed body. Mirrors StudyPage.renderLatex —
     * same delimiters (\( \) inline, \[ \] block) and throwOnError:false so
     * a malformed expression degrades to its raw text rather than aborting
     * the whole render. The auto-render plugin exposes renderMathInElement
     * as a global; guard against it being absent (e.g. unit-test surface).
     */
    #renderLatex()
    {
        if (!this.#bodyElement || typeof renderMathInElement === "undefined")
        {
            return;
        }
        renderMathInElement(this.#bodyElement,
        {
            delimiters:
            [
                { left: "\\(", right: "\\)", display: false },
                { left: "\\[", right: "\\]", display: true  }
            ],
            throwOnError: false
        });
    }

    /**
     * Web images come from model-supplied URLs (Pro / Pro Plus grounding),
     * so some may 404 or be hotlink-blocked. Drop any image that fails to
     * load so the learner never sees a broken-image icon. Re-runnable: each
     * call re-binds against the current set of <img>s in the body (the body
     * is re-rendered on stream completion and again on block selection).
     */
    #wireImageErrorHandlers()
    {
        if (!this.#bodyElement)
        {
            return;
        }
        const imageElements = this.#bodyElement.querySelectorAll("img");
        for (const imageElement of imageElements)
        {
            imageElement.addEventListener("error", () =>
            {
                imageElement.remove();
            });
        }
    }

    /**
     * Read back the raw accumulated markup as the LLM produced it
     * (pre-sanitiser). Useful when a downstream consumer wants to
     * re-run the sanitiser with a different policy.
     */
    getAccumulatedMarkup()
    {
        return this.#accumulatedMarkup;
    }

    /**
     * Read back the sanitised HTML that's actually rendered in the
     * dialog body. This is what the action-bar handlers persist into
     * Card.answer / StudyMaterial.content — never the raw LLM output,
     * because the sanitiser has already stripped unsafe tags /
     * attributes and dropped any code-fence wrapper the model emitted.
     */
    getRenderedBodyHtml()
    {
        // Re-sanitise from the raw accumulated markup rather than reading
        // the live DOM: #renderLatex() mutates the body into KaTeX spans,
        // and persisting THAT would double-render when the card / material
        // re-runs renderLatex at view time. Sourcing from the accumulator
        // keeps the raw \(...\) delimiters and <img> tags intact, matching
        // how cards and study materials store math.
        return AskAiStreamRenderer.sanitiseToStructuralHtml(this.#accumulatedMarkup);
    }

    /**
     * Populate the bottom actions bar with a list of buttons. Each
     * descriptor is `{ label, onClick }`. Idempotent — replaces any
     * existing actions on each call. Hidden when called with an empty
     * list.
     */
    populateActions(actionDescriptors)
    {
        if (!this.#actionsElement)
        {
            return;
        }
        const actions = Array.isArray(actionDescriptors) ? actionDescriptors : [];
        this.#actionsElement.innerHTML = "";
        if (actions.length === 0)
        {
            this.#actionsElement.hidden = true;
            return;
        }

        for (const actionDescriptor of actions)
        {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "ask-ai-action-button";
            button.textContent = actionDescriptor.label || "Action";
            if (typeof actionDescriptor.onClick === "function")
            {
                button.addEventListener("click", actionDescriptor.onClick);
            }
            this.#actionsElement.appendChild(button);
        }
        this.#actionsElement.hidden = false;
    }

    /**
     * Turn the popup body into a set of inline-selectable blocks. No
     * mode switch — every detected block becomes clickable straight
     * away, click to highlight, click again to un-highlight. The
     * "Insert selected …" action reads the current selection at
     * click-time via getSelectedBlockIndices().
     *
     * Re-renders the body so each block is normalised to
     * <div class="ask-ai-block" data-block-index="N">. Detection
     * paths emit three possible block shapes:
     *
     *   - Explicit `<div class="ask-ai-block">` (mnemonic, examples
     *     prompts). We unwrap the outer .ask-ai-block before
     *     rendering so we don't end up with a double wrapper.
     *   - Glossary `<li>`s (rewrapped in <ul>). Rendered as-is inside
     *     the new .ask-ai-block container.
     *   - Heading-grouped legacy fallback. Rendered as-is.
     */
    activateBlockSelection(detectedBlocks)
    {
        if (!this.#bodyElement || !Array.isArray(detectedBlocks) || detectedBlocks.length < 2)
        {
            return;
        }

        const blocksHtml = detectedBlocks.map((detectedBlock, blockIndex) =>
        {
            const innerHtml = AskAiResultView.#unwrapOuterAskAiBlock(detectedBlock.contentHtml || "");
            return `<div class="ask-ai-block" data-block-index="${blockIndex}">${innerHtml}</div>`;
        }).join("");

        this.#bodyElement.innerHTML = blocksHtml;
        this.#bodyElement.classList.add("ask-ai-body-selecting");

        const blockElements = Array.from(this.#bodyElement.querySelectorAll(".ask-ai-block"));
        for (const blockElement of blockElements)
        {
            blockElement.addEventListener("click", (clickEvent) =>
            {
                clickEvent.preventDefault();
                clickEvent.stopPropagation();
                blockElement.classList.toggle("selected");
            });
        }

        // The body was just re-rendered from raw markup, so re-apply the
        // math render and image error-handling the completion path set up.
        this.#renderLatex();
        this.#wireImageErrorHandlers();
    }

    /**
     * Returns the data-block-index values of every currently-selected
     * `.ask-ai-block` in the body, in DOM order. Used by the
     * dispatcher's "Insert selected" handler to know which blocks the
     * user picked. The mapping back to the original detected-blocks
     * array is the dispatcher's job.
     */
    getSelectedBlockIndices()
    {
        if (!this.#bodyElement)
        {
            return [];
        }
        const selectedElements = this.#bodyElement.querySelectorAll(".ask-ai-block.selected");
        return Array.from(selectedElements)
            .map((selectedElement) => parseInt(selectedElement.dataset.blockIndex, 10))
            .filter((blockIndex) => Number.isFinite(blockIndex));
    }

    /**
     * If `htmlString` starts with a `<div class="ask-ai-block">`,
     * returns the inner HTML of that wrapper so the caller can
     * supply its own wrapper without double-nesting. Otherwise
     * returns `htmlString` unchanged. Used by activateBlockSelection
     * to normalise the three possible block shapes the dispatcher
     * detects into one consistent rendered form.
     */
    static #unwrapOuterAskAiBlock(htmlString)
    {
        if (!htmlString || !htmlString.includes("ask-ai-block"))
        {
            return htmlString;
        }
        const temporaryContainer = document.createElement("div");
        temporaryContainer.innerHTML = htmlString;
        const firstChild = temporaryContainer.firstElementChild;
        if (firstChild
            && firstChild.tagName === "DIV"
            && firstChild.classList.contains("ask-ai-block")
            && temporaryContainer.children.length === 1)
        {
            return firstChild.innerHTML;
        }
        return htmlString;
    }

    static #resolveHeaderLabel(promptMode)
    {
        if (promptMode === askAiPromptModes.ASK)           return "Ask";
        if (promptMode === askAiPromptModes.SUMMARIZE)     return "Summarize";
        if (promptMode === askAiPromptModes.FORMAT)        return "Format";
        if (promptMode === askAiPromptModes.MAKE_MNEMONIC) return "Make mnemonic";
        if (promptMode === askAiPromptModes.GIVE_EXAMPLES) return "Examples";
        if (promptMode === askAiPromptModes.GLOSSARY)      return "Glossary";
        return "Explain";
    }

    static #escapeHtml(rawString)
    {
        if (rawString === null || rawString === undefined) return "";
        return String(rawString)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }
}

customElements.define(AskAiResultView.tagName, AskAiResultView);
export default AskAiResultView;
