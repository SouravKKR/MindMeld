import StudySession from "./StudySession.js";
import ChatView from "../Components/ChatView.js";
import DeckRetriever from "../../../Globals/Classes/Embeddings/DeckRetriever.js";
import DeckImageHarvester from "../../../Globals/Classes/Embeddings/DeckImageHarvester.js";
import EmbeddingPrewarmer from "../../../Globals/Classes/Embeddings/EmbeddingPrewarmer.js";
import GeneratedVisualRenderer from "../../../Globals/Classes/GeneratedVisualRenderer.js";
import HtmlSanitizer from "../../../Globals/Classes/HtmlSanitizer.js";
import ModelTierMetadata from "../../../Globals/Constants/ModelTierMetadata.js";
import StudyMaterial from "../../../Globals/Model/StudyMaterial.js";
import Lifecycle from "../../../Globals/Model/Lifecycle.js";
import ChatStudyMaterialFields from "../../../Globals/Classes/Analysis/ChatStudyMaterialFields.js";
import DeckEvents from "../../../Globals/Events/DeckEvents.js";
import DialogBox from "../../../CommonComponents/DialogBox.js";
import LocalLlmCapability from "../../../Globals/Classes/LocalLlm/LocalLlmCapability.js";
import LocalLlmPromptBuilder from "../../../Globals/Classes/LocalLlm/LocalLlmPromptBuilder.js";
import LocalAskAiRunner from "../../../Globals/Classes/LocalLlm/LocalAskAiRunner.js";
import { localLlmDownloadStates } from "../../../Globals/Enumerations/LocalLlmDownloadStates.js";
import { studyMaterialDetailLevels } from "../../../Globals/Enumerations/StudyMaterialDetailLevels.js";

/**
 * Deck-level "Chat" study mode. A multi-turn, ChatGPT-style assistant whose
 * answers are grounded in THIS deck's own cards + study materials, retrieved
 * entirely client-side (static embeddings — zero server load) and streamed back
 * through the existing AskAi endpoint with contextKind=DECK. The transcript is
 * held client-side only (never persisted server-side); the user can save it as a
 * "Chat" study material.
 */
class ChatSession extends StudySession
{
    static #MAX_CONVERSATION_TURNS = 6;   // prior turns sent for context

    // Used when the strategy call is unavailable or fails. The Free tier
    // always uses it: the strategy call is a cheap cloud LLM hop, and a tier
    // whose whole premise is "nothing leaves the device" cannot make it.
    static #DEFAULT_STRATEGY = { nearestCards: 4, nearestMaterials: 3, expandedQueries: [] };

    // Per-snippet caps on the grounding TEXT sent to a CLOUD model. Inline
    // base64 images are stripped BEFORE these apply (they travel to the model
    // as dedicated vision input via DeckImageHarvester), so these bound real
    // text. The payload ceiling is kept safely below the server's own
    // DECK_CONTEXT_MAX_CHARS (200000) so a content-rich deck can never trip
    // the 400 body validator; least-relevant snippets are dropped from the
    // tail until the payload fits.
    //
    // The Free tier does NOT use these — it asks LocalLlmPromptBuilder for
    // caps sized to whichever on-device model this device resolved to, which
    // is smaller by two orders of magnitude and varies per device.
    static #CLOUD_CONTEXT_BUDGET =
    {
        maximumContextPayloadCharacters:       150000,
        maximumCardSnippetCharacters:          2000,
        maximumStudyMaterialSnippetCharacters: 8000,
        maximumConversationTurns:              ChatSession.#MAX_CONVERSATION_TURNS,
    };

    #chatView = null;
    #transcript = [];          // [{ role, text, htmlForSave }]
    #busy = false;
    #activeAbortController = null;

    constructor(studyPage, deck = null)
    {
        super(studyPage, deck);
    }

    start()
    {
        // Eager: ensure the table is loading and this deck's vectors are warm.
        EmbeddingPrewarmer.init();
        if (this._deck)
        {
            EmbeddingPrewarmer.prewarmDeck(this._deck);
        }

        const container = this._studyPage.querySelector(".chat-container");
        this.#chatView = document.createElement(ChatView.tagName);
        container.appendChild(this.#chatView);

        this.#chatView.onSend((text) => this.handleUserTurn(text));
        this.#chatView.onSave(() => this.saveTranscriptAsStudyMaterial());

        this.startStudyTimer();
    }

    // Chat owns a persistent DOM surface, so resuming needs no re-render.
    onResumed() {}

    /**
     * Called by StudyPage.onPageLeft. Aborts any in-flight chat stream so the
     * user is not charged for an answer they navigated away from, and stops the
     * study-time ticker.
     */
    onPageLeft()
    {
        if (this.#activeAbortController)
        {
            try
            {
                this.#activeAbortController.abort();
            }
            catch (abortError)
            {
                // Already settled — nothing to abort.
            }
            this.#activeAbortController = null;
        }
        this.stopStudyTimer();
    }

    async handleUserTurn(userText)
    {
        const trimmed = (userText || "").trim();
        if (trimmed.length === 0 || this.#busy)
        {
            return;
        }

        const tierKey = this.#chatView.getSelectedTier();
        const apiPath = ModelTierMetadata[tierKey] ? ModelTierMetadata[tierKey].apiPath : null;

        // Free has no apiPath because it answers on the device. Retrieval is
        // already client-side for every tier, so the local path reuses it
        // wholesale and only swaps where the answer comes from.
        const bIsLocalTier = tierKey === "FREE";

        if (!apiPath && !bIsLocalTier)
        {
            this.#chatView.showError("This tier can't be used for chat — pick Basic, Pro, or Pro Plus.");
            return;
        }

        if (bIsLocalTier)
        {
            await LocalLlmCapability.initialize();
            if (LocalLlmCapability.getState() !== localLlmDownloadStates.READY)
            {
                this.#chatView.showError(LocalLlmCapability.getDisabledReasonText()
                    || "The on-device model isn't ready yet.");
                return;
            }
        }

        // Capture prior turns BEFORE pushing the current question (the current
        // question travels in userQuery, not the conversation history).
        const conversation = this.#transcript
            .slice(-ChatSession.#MAX_CONVERSATION_TURNS * 2)
            .map((turn) => ({ role: turn.role, text: turn.text }));

        this.#chatView.appendUserMessage(trimmed);
        this.#transcript.push({ role: "user", text: trimmed, htmlForSave: ChatSession.#escapeHtml(trimmed) });
        this.#chatView.clearInput();

        this.#busy = true;
        this.#chatView.setBusy(true);
        // Local controller used for BOTH the strategy fetch and the answer fetch.
        // onPageLeft aborts via the #activeAbortController field; using the local
        // for the fetches means a mid-turn abort+null can't TypeError here.
        const abortController = new AbortController();
        this.#activeAbortController = abortController;
        const bubble = this.#chatView.beginAssistantMessage();

        // One turn-wide try/finally so busy/controller ALWAYS reset — a throw in
        // the harvest/snippets/payload work (e.g. paid-content decryption) must
        // not wedge the chat with #busy stuck true.
        try
        {
            // 1. Strategy — one cheap LLM call decides how much deck content to pull
            //    and proposes alternate phrasings. Safe defaults on any failure,
            //    and skipped entirely on Free: it is a server call, and this
            //    tier makes none.
            let strategy = ChatSession.#DEFAULT_STRATEGY;
            if (!bIsLocalTier)
            {
                bubble.setStatus("Strategizing the best way to answer…");
                strategy = await this.#fetchStrategy(trimmed, conversation, abortController.signal);
            }

            // 2. Client-side retrieval over the original question + the phrasings.
            bubble.setStatus("Searching your deck…");
            let retrieval = { cards: [], materials: [] };
            try
            {
                retrieval = await DeckRetriever.retrieve(
                    this._deck,
                    [trimmed, ...strategy.expandedQueries],
                    { nearestCards: strategy.nearestCards, nearestMaterials: strategy.nearestMaterials }
                );
            }
            catch (retrievalError)
            {
                console.warn(`[ChatSession] Retrieval failed: ${retrievalError.message}`);
            }

            // The on-device model has no vision input, so harvesting deck
            // images would only produce attachments nothing can read. An
            // empty id map keeps #renderFinalHtml's image-swap a no-op.
            const { attachedImages, idToDataUrl } = bIsLocalTier
                ? { attachedImages: [], idToDataUrl: new Map() }
                : DeckImageHarvester.harvest(retrieval.cards, retrieval.materials, {});

            // Study-material / card HTML routinely embeds inline base64 images
            // (<img src="data:image/…;base64,…">) that are megabytes each. Sending
            // that verbatim in the grounding snippets (a) duplicates what
            // DeckImageHarvester already sends as proper vision input and (b) can
            // push the serialized contextPayload past the server's DECK cap, which
            // rejects the whole turn with a 400 the user sees as "Couldn't reach
            // the assistant". #buildBoundedDeckContext strips those inline images
            // and size-bounds the payload so a content-rich deck always fits.
            // The on-device model's context window is a fraction of the
            // cloud's, so Free gets caps derived from the selected model
            // rather than the cloud budget — 150 000 characters is roughly
            // forty thousand tokens into a window that holds a couple of
            // thousand, which would fail every turn.
            const contextBudget = bIsLocalTier
                ? LocalLlmPromptBuilder.getDeckContextBudget(LocalLlmCapability.getSelectedModelKey())
                : ChatSession.#CLOUD_CONTEXT_BUDGET;

            const boundedConversation = conversation.slice(-contextBudget.maximumConversationTurns * 2);

            const contextPayload = ChatSession.#buildBoundedDeckContext(
                retrieval,
                boundedConversation,
                attachedImages.map((image) => image.id),
                contextBudget
            );

            const payload = {
                promptMode:     "ASK",
                contextKind:    "DECK",
                contextPayload: contextPayload,
                userQuery:      trimmed,
                attachedImages: attachedImages,
                selectedLanguage: "ENGLISH"
            };

            // 3. Stream the answer — rotating "Thinking / Phrasing…" status until the
            //    first token arrives (the bubble switches to streamed text then).
            bubble.beginThinking();

            if (bIsLocalTier)
            {
                // Same NDJSON events, same reader — only the source differs.
                const localStream = await LocalAskAiRunner.openStream(payload, abortController.signal);
                await this.#consumeStream(localStream, bubble, retrieval, idToDataUrl);
                return;
            }

            const response = await fetch(apiPath,
            {
                method:      "POST",
                credentials: "include",
                signal:      abortController.signal,
                headers:     { "Content-Type": "application/json" },
                body:        JSON.stringify(payload)
            });

            if (!response.ok || !response.body)
            {
                // Surface the server's own reason to the console — the generic
                // bubble message hid it, which is why a 400 (e.g. an oversized
                // contextPayload) was previously invisible from the client side.
                let serverReason = "";
                try
                {
                    serverReason = await response.text();
                }
                catch (readError)
                {
                    serverReason = "";
                }
                console.warn(`[ChatSession] AskAi request failed (${response.status}): ${serverReason}`);
                bubble.error("Couldn't reach the assistant just now. Please try again in a moment.");
            }
            else
            {
                await this.#consumeStream(response.body, bubble, retrieval, idToDataUrl);
            }
        }
        catch (turnError)
        {
            console.error("[ChatSession] Chat turn failed:", turnError);
            bubble.error("Something went wrong. Please try again in a moment.");
        }
        finally
        {
            this.#activeAbortController = null;
            this.#busy = false;
            this.#chatView.setBusy(false);
        }
    }

    /**
     * Calls the unmetered strategy endpoint to get { nearestCards, nearestMaterials,
     * expandedQueries }. Always resolves to usable values — any failure (offline,
     * non-200, malformed, aborted) returns safe defaults so the turn still proceeds.
     */
    async #fetchStrategy(userQuery, conversation, signal)
    {
        const fallback = ChatSession.#DEFAULT_STRATEGY;
        try
        {
            const response = await fetch("/AskAi/Chat/Strategy",
            {
                method:      "POST",
                credentials: "include",
                signal:      signal,
                headers:     { "Content-Type": "application/json" },
                body:        JSON.stringify({ userQuery, conversation })
            });

            if (!response.ok)
            {
                return fallback;
            }

            const data = await response.json();
            return {
                nearestCards:     Number.isFinite(data.nearestCards) ? data.nearestCards : fallback.nearestCards,
                nearestMaterials: Number.isFinite(data.nearestMaterials) ? data.nearestMaterials : fallback.nearestMaterials,
                expandedQueries:  Array.isArray(data.expandedQueries) ? data.expandedQueries.filter((entry) => typeof entry === "string").slice(0, 4) : []
            };
        }
        catch (strategyError)
        {
            console.warn(`[ChatSession] Strategy fetch failed: ${strategyError.message}`);
            return fallback;
        }
    }

    async #consumeStream(readableStream, bubble, retrieval, idToDataUrl)
    {
        const streamReader = readableStream.getReader();
        const textDecoder = new TextDecoder("utf-8");
        let unparsedBuffer = "";
        let accumulatedText = "";
        let erroredMessage = null;

        const handleLine = (ndjsonLine) =>
        {
            let event;
            try
            {
                event = JSON.parse(ndjsonLine);
            }
            catch (parseError)
            {
                return;
            }

            if (event && event.type === "text" && typeof event.value === "string")
            {
                accumulatedText += event.value;
                bubble.appendText(event.value);
            }
            else if (event && event.type === "status" && typeof event.value === "string")
            {
                // On-device tier only, and only while it is still fetching the
                // model. Uses the same status line the deck-search phases use,
                // so a first question that has to download ~1.8 GB says so
                // instead of rotating "Thinking…" for minutes.
                bubble.setStatus(event.value);
            }
            else if (event && event.type === "error")
            {
                erroredMessage = event.message || "Unknown error.";
            }
        };

        while (true)
        {
            const { value: chunkBytes, done: bStreamDone } = await streamReader.read();
            if (bStreamDone)
            {
                if (unparsedBuffer.length > 0)
                {
                    handleLine(unparsedBuffer);
                }
                break;
            }
            unparsedBuffer += textDecoder.decode(chunkBytes, { stream: true });

            let newlineIndex = unparsedBuffer.indexOf("\n");
            while (newlineIndex !== -1)
            {
                const ndjsonLine = unparsedBuffer.slice(0, newlineIndex);
                unparsedBuffer = unparsedBuffer.slice(newlineIndex + 1);
                if (ndjsonLine.length > 0)
                {
                    handleLine(ndjsonLine);
                }
                newlineIndex = unparsedBuffer.indexOf("\n");
            }
        }

        if (erroredMessage !== null && accumulatedText.length === 0)
        {
            bubble.error(erroredMessage);
            return;
        }

        // Zero-token success — show a placeholder but don't pollute the transcript
        // (and don't enable Save) with an empty assistant turn.
        if (accumulatedText.trim().length === 0)
        {
            bubble.finishHtml("(no response)");
            return;
        }

        const finalHtml = ChatSession.#renderFinalHtml(accumulatedText, idToDataUrl);
        bubble.finishHtml(finalHtml || "(no response)");
        ChatSession.#renderLatex(bubble.bodyElement);
        bubble.addSources(this.#buildSourceChips(retrieval));
        this.#transcript.push({ role: "assistant", text: accumulatedText, htmlForSave: finalHtml });
        this.#chatView.enableSave();
    }

    #buildSourceChips(retrieval)
    {
        const chips = [];

        for (const card of retrieval.cards)
        {
            chips.push({
                label: ChatSession.#labelFromHtml(card.getQuestion(), "Card"),
                onClick: () => ChatSession.#previewHtml("Card", `<p><strong>Q:</strong> ${card.getQuestion()}</p><p><strong>A:</strong> ${card.getAnswer()}</p>`)
            });
        }

        for (const material of retrieval.materials)
        {
            chips.push({
                label: ChatSession.#labelFromHtml(material.getContent(), "Study material"),
                onClick: () => ChatSession.#previewHtml("Study material", material.getContent())
            });
        }

        return chips;
    }

    async saveTranscriptAsStudyMaterial()
    {
        if (this.#transcript.length === 0 || !this._deck)
        {
            return;
        }

        // Format like a normal study material: each question becomes a heading and
        // its answer follows below — no "You" / "Assistant" labels, no raw transcript.
        const parts = [];
        for (let index = 0; index < this.#transcript.length; index++)
        {
            const turn = this.#transcript[index];
            if (turn.role !== "user")
            {
                continue;
            }
            const questionText = ChatSession.#escapeHtml(turn.text || "");
            const nextTurn = this.#transcript[index + 1];
            const answerHtml = (nextTurn && nextTurn.role === "assistant") ? (nextTurn.htmlForSave || "") : "";
            parts.push(`<h3>${questionText}</h3>${answerHtml}`);
        }
        const transcriptHtml = parts.join("\n");

        const material = new StudyMaterial(
            StudyMaterial.generateId(),
            transcriptHtml,
            this._deck.getId(),
            new Lifecycle(),
            0,
            studyMaterialDetailLevels.STANDARD,
            {
                [ChatStudyMaterialFields.B_CHAT]: true,
                [ChatStudyMaterialFields.GENERATED_AT]: new Date().toISOString()
            }
        );

        this._deck.addStudyMaterial(material);
        await this._deck.save(false);
        window.dispatchEvent(new CustomEvent(DeckEvents.UPDATE, { detail: { deck: this._deck } }));

        await DialogBox.alert("Saved", "This chat was saved as a study material — find it in this deck's study materials.");
    }

    // ── Static helpers ────────────────────────────────────────────────────────

    /**
     * Assembles the DECK contextPayload from a retrieval result while
     * GUARANTEEING the serialized size stays under the server's DECK
     * contextPayload cap.
     *
     * Two forces bloat the raw content: inline base64 images embedded in
     * study-material / card HTML (megabytes each) and very long lessons. The
     * images are stripped here — they already travel to the model as dedicated
     * vision input via DeckImageHarvester, and the worker converts snippet
     * content to plain text anyway, so keeping the base64 is pure duplicated
     * weight — and the remaining text is capped per snippet. If the assembled
     * payload is still over budget, whole snippets are dropped from the
     * least-relevant tail (retrieval is relevance-ordered) until it fits.
     */
    static #buildBoundedDeckContext(retrieval, conversation, deckImageIds, contextBudget)
    {
        const snippets = [];

        for (const card of retrieval.cards)
        {
            snippets.push({
                kind: "CARD",
                question: ChatSession.#sanitizeSnippetContent(card.getQuestion(), contextBudget.maximumCardSnippetCharacters),
                answer: ChatSession.#sanitizeSnippetContent(card.getAnswer(), contextBudget.maximumCardSnippetCharacters)
            });
        }

        for (const material of retrieval.materials)
        {
            snippets.push({
                kind: "STUDY_MATERIAL",
                content: ChatSession.#sanitizeSnippetContent(material.getContent(), contextBudget.maximumStudyMaterialSnippetCharacters)
            });
        }

        let contextPayload = { snippets, conversation, deckImageIds };
        while (snippets.length > 0 && JSON.stringify(contextPayload).length > contextBudget.maximumContextPayloadCharacters)
        {
            snippets.pop();
            contextPayload = { snippets, conversation, deckImageIds };
        }

        return contextPayload;
    }

    /**
     * Strips inline base64 data-URL images out of a snippet's HTML (replacing
     * each with a short "[image]" marker so the surrounding text still reads
     * naturally) and truncates the result to maxChars. The stripped images are
     * NOT lost — DeckImageHarvester extracts them from the same source HTML and
     * sends them as vision input; this only removes their enormous base64 twin
     * from the text context.
     */
    static #sanitizeSnippetContent(rawHtml, maxChars)
    {
        const withoutInlineImages = String(rawHtml ?? "").replace(
            /<img\b[^>]*\bsrc\s*=\s*["']data:image\/[^"']*["'][^>]*>/gi,
            "[image]"
        );
        return withoutInlineImages.length > maxChars
            ? withoutInlineImages.slice(0, maxChars)
            : withoutInlineImages;
    }

    static #renderFinalHtml(rawModelHtml, idToDataUrl)
    {
        // Swap the model's lightweight deck-image references for the real images
        // (which the client already holds) BEFORE sanitizing — the sanitizer
        // permits <img> with a data:image/ src, so the swapped images survive.
        const swapped = (rawModelHtml || "").replace(
            /<img\b[^>]*\bdata-deck-image-id\s*=\s*["'](\d+)["'][^>]*>/gi,
            (match, imageId) =>
            {
                const dataUrl = idToDataUrl.get(String(imageId));
                return dataUrl ? `<img src="${dataUrl}" class="chat-deck-image" alt="deck image">` : "";
            }
        );
        return HtmlSanitizer.sanitize(swapped);
    }

    static #renderLatex(element)
    {
        if (!element || typeof window.renderMathInElement !== "function")
        {
            return;
        }
        try
        {
            window.renderMathInElement(element, {
                delimiters: [
                    { left: "\\(", right: "\\)", display: false },
                    { left: "\\[", right: "\\]", display: true }
                ],
                throwOnError: false
            });
        }
        catch (latexError)
        {
            // A malformed expression must not break the rendered answer.
        }
    }

    static #previewHtml(title, rawHtml)
    {
        const dialog = DialogBox.modal(`
            <h3 style="margin-top:0;">${ChatSession.#escapeHtml(title)}</h3>
            <div class="chat-source-preview" style="max-height:60vh; overflow:auto;">${HtmlSanitizer.sanitize(rawHtml)}</div>
        `);

        // The previewed source is study-material HTML, so it can carry generated
        // visuals. Read-only surface, so drawing them here is safe — unlike the
        // study-material editor, which would save the rendered SVG back over the
        // diagram source.
        GeneratedVisualRenderer.render(dialog.querySelector(".chat-source-preview"));
    }

    static #labelFromHtml(html, fallback)
    {
        const text = String(html || "")
            .replace(/<[^>]*>/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        if (text.length === 0)
        {
            return fallback;
        }
        return text.length > 40 ? `${text.slice(0, 40)}…` : text;
    }

    static #escapeHtml(value)
    {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }
}

export default ChatSession;
