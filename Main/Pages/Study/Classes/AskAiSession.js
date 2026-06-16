import DialogBox from "../../../CommonComponents/DialogBox.js";
import AiFeatureGate from "../../../Globals/Classes/AiFeatureGate.js";
import ModelTierMetadata from "../../../Globals/Constants/ModelTierMetadata.js";
import { modelTiers } from "../../../Globals/Enumerations/ModelTiers.js";
import { askAiPromptModes } from "../../../Globals/Enumerations/AskAiPromptModes.js";
import { askAiContextKinds } from "../../../Globals/Enumerations/AskAiContextKinds.js";
import Card from "../../../Globals/Model/Card.js";
import StudyMaterial from "../../../Globals/Model/StudyMaterial.js";
import AskAiResultView from "../Components/AskAiResultView.js";
import AskAiActionDispatcher from "./AskAiActionDispatcher.js";
import MaintenanceNotice from "../../../Globals/Classes/MaintenanceNotice.js";


/**
 * AskAiSession
 *
 * One instance per user-triggered AskAi action (Explain / Ask /
 * Summarize / Format / Make mnemonic). Owns the lifecycle of:
 *
 *   1. Admin gate (AiFeatureGate)
 *   2. Tier → API-path resolution
 *   3. Dialog open (DialogBox.modal) — content is an <ask-ai-result-view>
 *      web component so future per-mode action buttons (Insert into
 *      card, Copy as HTML, etc.) have a clean home
 *   4. fetch() + chunked-stream reader (NDJSON line splitter)
 *   5. Live re-render delegated to the result view
 *   6. Citation footer rendering when grounding fires (Pro / Pro Plus)
 *   7. Abort wiring (dialog close → AbortController)
 *
 * The frontend NEVER assembles the actual LLM prompt — that lives in
 * Agent/Workflows/AskAi/AskAiPromptBuilder.py. We just ship the
 * structured inputs (selected text or empty for whole-entity, the card
 * or study material, the optional user question / instructions,
 * attached images, grounding sources + toggle).
 */
class AskAiSession
{
    static #PROMPT_MODE_LOOKUP = new Map(
        Object.entries(askAiPromptModes).map(([keyName, value]) => [value, keyName])
    );

    static #CONTEXT_KIND_LOOKUP = new Map(
        Object.entries(askAiContextKinds).map(([keyName, value]) => [value, keyName])
    );

    #promptMode = askAiPromptModes.EXPLAIN;
    #chosenTier = modelTiers.BASIC;
    #contextEntity = null;
    #selectedText = "";
    #userQuery = null;
    #attachedImages = [];
    #informationSources = [];
    #bUseInformationSources = false;
    #selectedLanguage = "ENGLISH";
    #combineWithEnglish = false;

    #dialogElement = null;
    #resultView = null;
    #abortController = null;
    #bUserClosedDialog = false;

    constructor({ promptMode, chosenTier, contextEntity, selectedText, userQuery, attachedImages, informationSources, useInformationSources, selectedLanguage, combineWithEnglish })
    {
        this.#promptMode = promptMode;
        this.#chosenTier = chosenTier;
        this.#contextEntity = contextEntity;
        this.#selectedText = selectedText || "";
        this.#userQuery = userQuery || null;
        this.#attachedImages = Array.isArray(attachedImages) ? attachedImages : [];
        this.#informationSources = Array.isArray(informationSources) ? informationSources : [];
        this.#bUseInformationSources = Boolean(useInformationSources);
        this.#selectedLanguage = selectedLanguage || "ENGLISH";
        this.#combineWithEnglish = Boolean(combineWithEnglish);
    }

    async run()
    {
        if (!await AiFeatureGate.ensureAdminOrShowAlert())
        {
            return;
        }

        const apiPath = AskAiSession.#resolveApiPath(this.#chosenTier);
        if (!apiPath)
        {
            await DialogBox.alert(
                "Tier not available",
                "The Free tier is offline-only and not wired for streaming yet. Pick Basic, Pro, or Pro Plus."
            );
            return;
        }

        const requestPayload = this.#buildRequestPayload();
        if (requestPayload === null)
        {
            await DialogBox.alert(
                "Cannot proceed",
                "No flashcard or study material is currently in view. Open a deck and start a study session."
            );
            return;
        }

        this.#openStreamingDialog();

        this.#abortController = new AbortController();

        try
        {
            const fetchResponse = await fetch(apiPath,
            {
                method:      "POST",
                credentials: "include",
                signal:      this.#abortController.signal,
                headers:     { "Content-Type": "application/json" },
                body:        JSON.stringify(requestPayload),
            });

            if (fetchResponse.status === 503)
            {
                // Scheduled maintenance — show the "check back at <time>" dialog
                // and an inline notice instead of a bare status code.
                const maintenanceHandled = await MaintenanceNotice.handleIfMaintenance(fetchResponse);
                if (maintenanceHandled)
                {
                    this.#resultView?.renderError("AI is paused for scheduled maintenance. Please check back later.");
                    return;
                }
            }

            if (fetchResponse.status === 402)
            {
                // The credit preflight refused the tier — surface a
                // human-readable shortfall instead of a bare status code.
                const creditRefusal = await fetchResponse.json().catch(() => null);
                const balance = typeof creditRefusal?.balance === "number" ? creditRefusal.balance : null;
                this.#resultView?.renderError(balance !== null
                    ? `Not enough credits for this AI tier (balance: ${balance}). Top up or switch to a cheaper tier.`
                    : "Not enough credits for this AI tier. Top up or switch to a cheaper tier.");
                return;
            }
            if (!fetchResponse.ok)
            {
                this.#resultView?.renderError(`Server returned ${fetchResponse.status} ${fetchResponse.statusText}.`);
                return;
            }
            if (!fetchResponse.body)
            {
                this.#resultView?.renderError("Streaming not supported by this fetch response.");
                return;
            }

            await this.#consumeNdjsonStream(fetchResponse.body);
        }
        catch (fetchError)
        {
            if (fetchError?.name === "AbortError" || this.#bUserClosedDialog)
            {
                // User closed the dialog mid-stream — fetch was aborted by
                // our own controller. Dialog is already gone, so there's
                // no surface left to render anything on.
                return;
            }
            this.#resultView?.renderError(`Network error: ${fetchError?.message || fetchError}`);
        }
    }

    #buildRequestPayload()
    {
        const contextEntity = this.#contextEntity;
        if (!contextEntity)
        {
            return null;
        }

        let contextKindEnumValue;
        let contextPayload;

        if (contextEntity instanceof Card)
        {
            contextKindEnumValue = askAiContextKinds.CARD;
            contextPayload =
            {
                question: contextEntity.getQuestion?.() ?? "",
                answer:   contextEntity.getAnswer?.()   ?? "",
            };
        }
        else if (contextEntity instanceof StudyMaterial)
        {
            contextKindEnumValue = askAiContextKinds.STUDY_MATERIAL;
            contextPayload =
            {
                content: contextEntity.getContent?.() ?? "",
            };
        }
        else
        {
            return null;
        }

        const informationSourcesPayload = this.#informationSources.map((extractableInformationSource) =>
        {
            // The selector hands us ExtractableInformationSource instances; the
            // worker only needs the hash + name to look up indexed chunks.
            const json = extractableInformationSource.toJson?.() ?? extractableInformationSource;
            return json;
        });

        return {
            promptMode:             AskAiSession.#PROMPT_MODE_LOOKUP.get(this.#promptMode) ?? "EXPLAIN",
            contextKind:            AskAiSession.#CONTEXT_KIND_LOOKUP.get(contextKindEnumValue) ?? "CARD",
            contextPayload:         contextPayload,
            selectedText:           this.#selectedText,
            userQuery:              this.#userQuery,
            attachedImages:         this.#attachedImages,
            informationSources:     informationSourcesPayload,
            useInformationSources:  this.#bUseInformationSources,
            selectedLanguage:       this.#selectedLanguage,
            combineWithEnglish:     this.#combineWithEnglish,
        };
    }

    #openStreamingDialog()
    {
        // The dialog body is the <ask-ai-result-view> web component —
        // it owns the title, streaming body, citations, status footer,
        // and the (currently hidden) actions bar slot. The session just
        // talks to it through the methods AskAiResultView exposes.
        this.#resultView = document.createElement(AskAiResultView.tagName);

        this.#dialogElement = DialogBox.modal('<div class="ask-ai-dialog" data-role="ask-ai-dialog-host"></div>');
        const hostElement = this.#dialogElement.querySelector('[data-role="ask-ai-dialog-host"]');
        hostElement?.appendChild(this.#resultView);

        // setPromptMode must run AFTER the element is connected to the
        // DOM — connectedCallback wires up the internal title node.
        this.#resultView.setPromptMode(this.#promptMode);

        // Dialog removal = user closed it (X button, Escape, etc.).
        // Setting #bUserClosedDialog lets the consumer-loop's AbortError
        // catch tell "user closed mid-stream" apart from a genuine
        // network failure.
        const observer = new MutationObserver(() =>
        {
            if (!document.body.contains(this.#dialogElement))
            {
                observer.disconnect();
                this.#bUserClosedDialog = true;
                if (this.#abortController && !this.#abortController.signal.aborted)
                {
                    this.#abortController.abort();
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: false });
    }

    async #consumeNdjsonStream(readableStream)
    {
        const streamReader = readableStream.getReader();
        const textDecoder = new TextDecoder("utf-8");
        let unparsedBuffer = "";

        while (true)
        {
            const { value: chunkBytes, done: bStreamDone } = await streamReader.read();
            if (bStreamDone)
            {
                if (unparsedBuffer.length > 0)
                {
                    this.#handleNdjsonLine(unparsedBuffer);
                    unparsedBuffer = "";
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
                    this.#handleNdjsonLine(ndjsonLine);
                }
                newlineIndex = unparsedBuffer.indexOf("\n");
            }
        }
    }

    #handleNdjsonLine(ndjsonLine)
    {
        let event;
        try
        {
            event = JSON.parse(ndjsonLine);
        }
        catch (parseError)
        {
            console.warn(`[AskAiSession] Skipping malformed NDJSON line: ${ndjsonLine.slice(0, 200)}`);
            return;
        }

        if (event?.type === "text" && typeof event.value === "string")
        {
            this.#resultView?.appendStreamingText(event.value);
        }
        else if (event?.type === "citations")
        {
            this.#resultView?.renderCitations(Array.isArray(event.sources) ? event.sources : []);
        }
        else if (event?.type === "error")
        {
            this.#resultView?.renderError(event.message || "Unknown error.");
        }
        else if (event?.type === "done")
        {
            this.#resultView?.markStreamComplete();
            this.#wirePostStreamActions();
        }
    }

    /**
     * Hand the result view a populated actions bar once the stream has
     * settled. The dispatcher builds the right set of `{ label, onClick }`
     * descriptors based on the prompt mode (ASK gets only the two
     * Append options; every other mode gets Insert + both Append
     * variants) and on the entity in scope (the "Insert into …" label
     * picks up "card" vs "study material" from there). `onComplete`
     * closes the dialog so the learner sees the insertion land in the
     * underlying entity instead of having to dismiss the popup first.
     */
    #wirePostStreamActions()
    {
        if (!this.#resultView || !this.#contextEntity)
        {
            return;
        }

        const actionDescriptors = AskAiActionDispatcher.buildActionDescriptors(
        {
            contextEntity:   this.#contextEntity,
            promptMode:      this.#promptMode,
            userQuery:       this.#userQuery,
            // Forwarded so the dispatcher can anchor the Insert / Append-
            // after-relevant-section placements to the right section of
            // the entity. When the user kicked off the action from a
            // text selection (TextSelectionContextMenu), this carries
            // the exact phrase they highlighted — a much stronger topic
            // signal than re-deriving keywords from the LLM's output.
            selectedText:    this.#selectedText,
            getRenderedHtml: () => this.#resultView?.getRenderedBodyHtml() || "",
            // The dispatcher activates inline block selection on this
            // view (turns each detected block into a click-to-toggle
            // card) and later reads the user's selection back via the
            // same reference at "Insert selected" click time. No
            // separate state machine; the DOM IS the state.
            resultView:      this.#resultView,
            onComplete:      () => this.#dialogElement?.close?.(),
        });

        this.#resultView.populateActions(actionDescriptors);
    }

    static #resolveApiPath(chosenTier)
    {
        for (const [tierKeyName, candidateValue] of Object.entries(modelTiers))
        {
            if (candidateValue === chosenTier)
            {
                return ModelTierMetadata[tierKeyName]?.apiPath ?? null;
            }
        }
        return null;
    }
}

export default AskAiSession;
