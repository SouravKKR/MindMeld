import BrowserLlmCapability from "./BrowserLlmCapability.js";
import BrowserLlmPromptBuilder from "./BrowserLlmPromptBuilder.js";
import BrowserLlmSessionController from "./BrowserLlmSessionController.js";
import { askAiContextKinds } from "../../Enumerations/AskAiContextKinds.js";
import { askAiPromptModes } from "../../Enumerations/AskAiPromptModes.js";


/**
 * LocalAskAiRunner
 *
 * The Free tier's answer to `fetch("/AskAi/Query/…")`. It builds the prompt on
 * the device, runs it through the on-device model, and hands back a
 * ReadableStream of exactly the same newline-delimited JSON events the paid
 * tiers' endpoint emits.
 *
 * Returning a real stream rather than a callback is a deliberate choice.
 * AskAiSession and ChatSession each already own a working NDJSON reader with
 * partial-line buffering, abort handling and post-stream wiring; matching
 * their input shape means each call site swaps one fetch for one openStream
 * and nothing downstream changes. Any other shape would have forked both
 * readers.
 *
 * Events emitted: `{"type":"text","value":"…"}` repeatedly, then
 * `{"type":"done"}`; or `{"type":"error","message":"…"}`. Never `citations`,
 * `images` or `metricsUpdate` — nothing is searched on the web, no vision
 * model runs, and no credits are spent, so there is nothing to report. Both
 * readers already ignore event types they do not handle.
 *
 * Nothing here contacts the server. That is the point of the tier: a
 * learner's card content never leaves the device.
 */
class LocalAskAiRunner
{
    static #textEncoder = new TextEncoder();

    /**
     * Opens a local answer stream for an Ask AI request payload — the same
     * payload shape the paid tiers POST.
     *
     * @param {object}      requestPayload  promptMode / contextKind / contextPayload / selectedText / userQuery
     * @param {AbortSignal} abortSignal     closing the dialog aborts here
     *
     * @returns {Promise<ReadableStream<Uint8Array>>}
     */
    static async openStream(requestPayload, abortSignal)
    {
        const modelKey = BrowserLlmCapability.getSelectedModelKey();
        const promptMode = LocalAskAiRunner.#resolvePromptMode(requestPayload.promptMode);
        const contextKind = LocalAskAiRunner.#resolveContextKind(requestPayload.contextKind);

        const builtPrompt = BrowserLlmPromptBuilder.build(
        {
            modelKey: modelKey,
            promptMode: promptMode,
            contextKind: contextKind,
            contextPayload: requestPayload.contextPayload,
            selectedText: requestPayload.selectedText,
            userQuery: requestPayload.userQuery,
        });

        return new ReadableStream(
        {
            async start(streamController)
            {
                const enqueueEvent = (event) =>
                {
                    streamController.enqueue(LocalAskAiRunner.#textEncoder.encode(`${JSON.stringify(event)}\n`));
                };

                // A user who closes the dialog mid-answer should stop paying
                // for it in battery and heat, not just stop seeing it.
                const handleAbort = () =>
                {
                    BrowserLlmSessionController.interrupt();
                };
                if (abortSignal)
                {
                    abortSignal.addEventListener("abort", handleAbort, { once: true });
                }

                try
                {
                    await BrowserLlmSessionController.generate(builtPrompt, (deltaText) =>
                    {
                        if (abortSignal && abortSignal.aborted)
                        {
                            return;
                        }
                        enqueueEvent({ type: "text", value: deltaText });
                    },
                    (loadProgress) =>
                    {
                        // The first question on a device that has not got the
                        // model yet pays for the whole download here — up to
                        // ~1.8 GB on the processor backend. Reported as a
                        // status so the dialog can say so; silence for that
                        // long is indistinguishable from a hang, which is
                        // exactly how it was read.
                        if (abortSignal && abortSignal.aborted)
                        {
                            return;
                        }
                        const percent = Math.round(Math.max(0, Math.min(1, loadProgress?.fraction || 0)) * 100);
                        enqueueEvent({ type: "status", value: `Preparing the on-device model… ${percent}%` });
                    });

                    enqueueEvent({ type: "done" });
                }
                catch (generationError)
                {
                    if (generationError?.name === "AbortError" || (abortSignal && abortSignal.aborted))
                    {
                        // The reader is already gone; closing quietly avoids
                        // rendering an error over a dialog the user dismissed.
                        streamController.close();
                        return;
                    }
                    enqueueEvent(
                    {
                        type: "error",
                        message: LocalAskAiRunner.#describeFailure(generationError)
                    });
                }
                finally
                {
                    if (abortSignal)
                    {
                        abortSignal.removeEventListener("abort", handleAbort);
                    }
                }

                streamController.close();
            }
        });
    }

    /**
     * Whether the on-device model should be offered this action at all.
     * Callers use it to explain the refusal before opening a dialog.
     */
    static isPromptModeSupported(promptMode)
    {
        return BrowserLlmPromptBuilder.isPromptModeSupported(LocalAskAiRunner.#resolvePromptMode(promptMode));
    }

    /**
     * The Ask AI payload carries mode and context as key NAMES (the paid
     * endpoint parses them server-side), while the enums are numeric. Callers
     * may hand over either form, so both are accepted.
     */
    static #resolvePromptMode(rawPromptMode)
    {
        if (typeof rawPromptMode === "number")
        {
            return rawPromptMode;
        }
        const resolvedMode = askAiPromptModes[rawPromptMode];
        return resolvedMode === undefined ? askAiPromptModes.EXPLAIN : resolvedMode;
    }

    static #resolveContextKind(rawContextKind)
    {
        if (typeof rawContextKind === "number")
        {
            return rawContextKind;
        }
        const resolvedKind = askAiContextKinds[rawContextKind];
        return resolvedKind === undefined ? askAiContextKinds.CARD : resolvedKind;
    }

    /**
     * Turns an engine failure into something a learner can act on. Running
     * out of memory is by far the most common one on a phone, and "the model
     * ran out of memory" tells them to switch tiers where the raw WebGPU text
     * would not.
     */
    static #describeFailure(generationError)
    {
        const rawMessage = generationError?.message ? String(generationError.message) : String(generationError);

        if (/out of memory|allocation failed|oom/i.test(rawMessage))
        {
            return "This device ran out of memory running the on-device model. Try a shorter question, or pick Basic, Pro or Pro Plus.";
        }
        if (/webgpu|adapter|device lost/i.test(rawMessage))
        {
            return "The device's graphics acceleration stopped responding. Reload the page, or pick Basic, Pro or Pro Plus.";
        }
        return `The on-device model could not answer: ${rawMessage}`;
    }
}

export default LocalAskAiRunner;
