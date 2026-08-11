import DialogBox from "../../../CommonComponents/DialogBox.js";
import AiFeatureGate from "../../../Globals/Classes/AiFeatureGate.js";
import ModelTierKeyLookup from "../../../Globals/Classes/ModelTierKeyLookup.js";
import LocalLlmCapability from "../../../Globals/Classes/LocalLlm/LocalLlmCapability.js";
import LocalLlmDownloadManager from "../../../Globals/Classes/LocalLlm/LocalLlmDownloadManager.js";
import LocalAskAiRunner from "../../../Globals/Classes/LocalLlm/LocalAskAiRunner.js";
import { localLlmDownloadStates } from "../../../Globals/Enumerations/LocalLlmDownloadStates.js";
import { modelTiers } from "../../../Globals/Enumerations/ModelTiers.js";
import { askAiPromptModes } from "../../../Globals/Enumerations/AskAiPromptModes.js";
import { askAiContextKinds } from "../../../Globals/Enumerations/AskAiContextKinds.js";
import Card from "../../../Globals/Model/Card.js";
import StudyMaterial from "../../../Globals/Model/StudyMaterial.js";
import AskAiResultView from "../Components/AskAiResultView.js";
import AskAiActionDispatcher from "./AskAiActionDispatcher.js";
import MaintenanceNotice from "../../../Globals/Classes/MaintenanceNotice.js";
import MilestoneBadgeCelebrationController from "../../../Globals/Classes/Metrics/MilestoneBadgeCelebrationController.js";
import TutorialEngine from "../../../Globals/Classes/TutorialEngine.js";
import TutorialDemoResponses from "../../../Globals/Constants/TutorialDemoResponses.js";


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
        // While a tutorial is running, never touch the server: replay a
        // canned response through the real dialog + rendering path. No
        // credits are spent, no request is made, and there is nothing to
        // exploit (the client simply never contacts the server). This also
        // closes the "user clicks a real AI button mid-tutorial" gap.
        if (TutorialEngine.isRunning())
        {
            await this.#runTutorialDemo();
            return;
        }

        if (!await AiFeatureGate.ensureAllowedOrShowAlert())
        {
            return;
        }

        // The Free tier answers on the device: no endpoint, no request, no
        // credits. Everything after the stream is opened is shared with the
        // cloud tiers, because the local runner emits the same NDJSON events.
        if (this.#chosenTier === modelTiers.FREE)
        {
            await this.#runLocal();
            return;
        }

        const apiPath = AskAiSession.#resolveApiPath(this.#chosenTier);
        if (!apiPath)
        {
            await DialogBox.alert(
                "Tier not available",
                "That model tier isn't available. Pick Basic, Pro, or Pro Plus."
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

    /**
     * The Free tier's run(). Loads the on-device model if the learner has not
     * already, then streams an answer from it through the same dialog and the
     * same NDJSON consumer the cloud tiers use.
     *
     * Two refusals are handled before anything opens, because both are worth
     * explaining rather than failing silently: the model may not be present
     * on this device yet, and a few actions are beyond what a small on-device
     * model can do reliably.
     */
    async #runLocal()
    {
        await LocalLlmCapability.initialize();

        if (LocalLlmCapability.getState() !== localLlmDownloadStates.READY)
        {
            await this.#offerModelDownload();
            return;
        }

        if (!LocalAskAiRunner.isPromptModeSupported(this.#promptMode))
        {
            await DialogBox.alert(
                "Not available on Free",
                "This action needs a cloud model — the on-device model can't do it reliably. Pick Basic, Pro, or Pro Plus for this one."
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
            const localStream = await LocalAskAiRunner.openStream(requestPayload, this.#abortController.signal);
            await this.#consumeNdjsonStream(localStream);
        }
        catch (localError)
        {
            if (localError?.name === "AbortError" || this.#bUserClosedDialog)
            {
                return;
            }
            this.#resultView?.renderError(`The on-device model failed: ${localError?.message || localError}`);
        }
    }

    /**
     * Explains why Free is not usable yet and, when the learner can fix it
     * themselves, starts the download from here. The model is hundreds of
     * megabytes, so it is never fetched without an explicit yes.
     */
    async #offerModelDownload()
    {
        const reasonText = LocalLlmCapability.getDisabledReasonText()
            || "The on-device model isn't ready yet.";

        if (!LocalLlmCapability.isRecoverableByUser())
        {
            await DialogBox.alert("Free tier unavailable", reasonText);
            return;
        }

        const bAcceptedDownload = await DialogBox.confirm("Download the on-device model?", reasonText);
        if (!bAcceptedDownload)
        {
            return;
        }

        // Deliberately not awaited into the answer: the download runs for
        // minutes and reports into the activity feed and the tier picker, so
        // holding a modal open over it would be worse than letting the
        // learner carry on studying.
        LocalLlmDownloadManager.start().catch((downloadError) =>
        {
            console.error("[AskAiSession] On-device model download failed:", downloadError);
        });

        await DialogBox.alert(
            "Downloading",
            "The model is downloading in the background — you can keep studying. Free becomes available the moment it's ready; progress is on the Activity page."
        );
    }

    /**
     * Tutorial demo path for run(). Opens the same streaming dialog the
     * real flow uses and feeds it a hardcoded NDJSON response (chosen by
     * prompt mode) through the existing #handleNdjsonLine pipeline, with a
     * small delay between events so it visibly streams. No fetch, no
     * credits, no server.
     */
    async #runTutorialDemo()
    {
        if (!this.#contextEntity)
        {
            await DialogBox.alert(
                "Cannot proceed",
                "No flashcard or study material is currently in view. Open a deck and start a study session."
            );
            return;
        }

        this.#openStreamingDialog();

        const demoEvents = TutorialDemoResponses.getAskAiEvents(this.#promptMode);
        for (const demoEvent of demoEvents)
        {
            // The dialog's MutationObserver flips this flag when the user
            // closes the popup mid-playback — stop feeding it then.
            if (this.#bUserClosedDialog)
            {
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, TutorialDemoResponses.ASK_AI_CHUNK_DELAY_MILLISECONDS));
            this.#handleNdjsonLine(JSON.stringify(demoEvent));
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

        // The on-device model has no vision input and no access to the
        // server-indexed source chunks, so neither is assembled for Free —
        // sending them would only bloat a prompt that has to fit a very
        // small window.
        const bIsLocalTier = this.#chosenTier === modelTiers.FREE;

        const informationSourcesPayload = bIsLocalTier ? [] : this.#informationSources.map((extractableInformationSource) =>
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
            attachedImages:         bIsLocalTier ? [] : this.#attachedImages,
            informationSources:     informationSourcesPayload,
            useInformationSources:  bIsLocalTier ? false : this.#bUseInformationSources,
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
        else if (event?.type === "status" && typeof event.value === "string")
        {
            // Only the on-device tier sends these, and only while it is
            // fetching the model before it can answer at all. It replaces the
            // "Thinking…" placeholder rather than entering the answer, so
            // nothing of it survives into the text the learner keeps.
            this.#resultView?.setPendingStatus(event.value);
        }
        else if (event?.type === "citations")
        {
            this.#resultView?.renderCitations(Array.isArray(event.sources) ? event.sources : []);
        }
        else if (event?.type === "images")
        {
            this.#resultView?.renderImages(Array.isArray(event.items) ? event.items : []);
        }
        else if (event?.type === "error")
        {
            this.#resultView?.renderError(event.message || "Unknown error.");
        }
        else if (event?.type === "metricsUpdate")
        {
            // The server counts the doubt authoritatively when the stream
            // completes and sends the refreshed metrics back on this trailing
            // line. Adopt them and let the celebration controller surface any
            // milestone badge just crossed (it dedupes + acknowledges itself).
            if (event.metrics && window["user"] && typeof window["user"].getAdditionalData === "function")
            {
                const additionalData = window["user"].getAdditionalData();
                if (additionalData)
                {
                    additionalData.metrics = event.metrics;
                }
                MilestoneBadgeCelebrationController.evaluate(window["user"]);
            }
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
        // During a tutorial the response is a canned demo — don't offer the
        // "Insert into card / Append" actions, which would write demo HTML
        // into a real entity if the user triggered AI on a non-sample one.
        if (TutorialEngine.isRunning())
        {
            return;
        }

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
        return ModelTierKeyLookup.metadataFor(chosenTier)?.apiPath ?? null;
    }
}

export default AskAiSession;
