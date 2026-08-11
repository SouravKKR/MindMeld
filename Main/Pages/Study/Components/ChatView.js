import LlmTierSelect from "../../../CommonComponents/LlmTierSelect.js";
import ModelTierKeyLookup from "../../../Globals/Classes/ModelTierKeyLookup.js";

// The ChatGPT-style surface for the deck Chat study mode. Owns the message list,
// the input bar (tier picker + textarea + send), and the "Save as study material"
// action. It is a dumb view: ChatSession drives it (onSend / onSave callbacks and
// the bubble controller returned by beginAssistantMessage). Styles are inline so
// the component is self-contained, theme-consistent, and responsive on PC +
// mobile (portrait/landscape) without a separate stylesheet to register.
class ChatView extends HTMLElement
{
    static tagName = "deck-chat-view";

    // Rotated in the assistant bubble while waiting for the first answer token,
    // so the chat never looks frozen during the LLM round-trip.
    static #THINKING_PHRASES = ["Thinking", "Phrasing", "Connecting ideas", "Consulting your deck", "Composing", "Reasoning"];

    #scrollContainer = null;
    #messageList = null;
    #inputElement = null;
    #sendButton = null;
    #tierSelect = null;
    #saveButton = null;
    #sendCallback = null;
    #saveCallback = null;
    #busy = false;

    connectedCallback()
    {
        this.innerHTML = `
            <style>
                study-page:has(.chat-page-wrapper) { display: flex; flex-direction: column; height: 100dvh; }
                .chat-page-wrapper { flex: 1 1 auto; min-height: 0; display: flex; }
                .chat-container { flex: 1 1 auto; min-height: 0; display: flex; }
                deck-chat-view { flex: 1 1 auto; min-height: 0; display: flex; width: 100%; }

                .chat-view-root
                {
                    flex: 1 1 auto;
                    min-height: 0;
                    display: flex;
                    flex-direction: column;
                    width: 100%;
                }

                /* Full-width scroll container so its scrollbar sits at the viewport
                   edge, not at the centred content column's boundary (mid-screen). */
                .chat-message-list
                {
                    flex: 1 1 auto;
                    min-height: 0;
                    overflow-y: auto;
                }

                /* The centred, max-width column the bubbles actually live in. */
                .chat-messages-inner
                {
                    max-width: 920px;
                    margin: 0 auto;
                    width: 100%;
                    min-height: 100%;
                    box-sizing: border-box;
                    display: flex;
                    flex-direction: column;
                    gap: 12px;
                    padding: 16px 14px;
                }

                .chat-empty-hint
                {
                    margin: auto;
                    text-align: center;
                    color: #b8b8c4;
                    font-size: 14px;
                    line-height: 1.5;
                    padding: 20px;
                }

                .chat-status
                {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    color: #b8b8c4;
                    font-style: italic;
                }
                .chat-spinner-inline
                {
                    width: 14px;
                    height: 14px;
                    flex: 0 0 auto;
                    border-radius: 50%;
                    border: 2px solid #34343f;
                    border-top-color: #0098C4;
                    animation: chat-spin 0.8s linear infinite;
                }
                @keyframes chat-spin { to { transform: rotate(360deg); } }

                .chat-bubble
                {
                    max-width: 85%;
                    padding: 10px 14px;
                    border-radius: 14px;
                    font-size: 14.5px;
                    line-height: 1.5;
                    word-wrap: break-word;
                    overflow-wrap: anywhere;
                }
                .chat-bubble-body { overflow-wrap: anywhere; }
                .chat-bubble-body img { max-width: 100%; height: auto; border-radius: 8px; margin: 6px 0; }
                .chat-bubble-body table { max-width: 100%; border-collapse: collapse; display: block; overflow-x: auto; }
                .chat-bubble-body pre { white-space: pre-wrap; overflow-wrap: anywhere; }

                .chat-user
                {
                    align-self: flex-end;
                    background: linear-gradient(45deg, #0098C4, #B55BD0);
                    color: #ffffff;
                }

                .chat-assistant
                {
                    align-self: flex-start;
                    background-color: #242430;
                    color: #f0f0f5;
                    border: 1px solid #34343f;
                }

                .chat-assistant.chat-error { border-color: #b3402b; color: #f0b8ad; }

                .chat-typing { font-style: italic; color: #b8b8c4; }

                .chat-sources-row
                {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 6px;
                    margin-top: 8px;
                }
                .chat-source-chip
                {
                    font-size: 12px;
                    padding: 4px 9px;
                    border-radius: 999px;
                    background-color: #1d1d27;
                    border: 1px solid #3a3a47;
                    color: #cfcfda;
                    cursor: pointer;
                    max-width: 220px;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .chat-source-chip:hover { border-color: #0098C4; color: #ffffff; }

                .chat-input-bar
                {
                    flex: 0 0 auto;
                    border-top: 1px solid #2c2c34;
                    padding: 10px 12px calc(10px + env(safe-area-inset-bottom, 0px));
                    background-color: #16161c;
                }
                .chat-input-inner
                {
                    max-width: 920px;
                    margin: 0 auto;
                    width: 100%;
                    box-sizing: border-box;
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                }

                .chat-tier-row { display: flex; align-items: flex-start; gap: 8px; }
                .chat-tier-select { flex: 0 1 auto; min-width: 0; }
                .chat-tier-select .llm-tier-select-element
                {
                    max-width: 100%;
                    background-color: #1d1d27;
                    color: #e6e6ee;
                    border: 1px solid #3a3a47;
                    border-radius: 8px;
                    padding: 6px 8px;
                    font-size: 13px;
                }
                .chat-tier-select .llm-tier-select-status
                {
                    display: block;
                    margin-top: 4px;
                    color: #9a9aa8;
                    font-size: 11px;
                    line-height: 1.35;
                }
                .chat-tier-select .llm-tier-select-status[data-clickable]
                {
                    cursor: pointer;
                    text-decoration: underline;
                }
                .chat-save-button
                {
                    margin-left: auto;
                    background-color: #1d1d27;
                    color: #cccccc;
                    border: 1px solid #383843;
                    border-radius: 8px;
                    padding: 6px 12px;
                    font-size: 13px;
                    font-weight: 600;
                    cursor: pointer;
                }
                .chat-save-button:hover:not(:disabled) { color: #ffffff; border-color: #555560; }
                .chat-save-button:disabled { opacity: 0.5; cursor: default; }

                .chat-input-row { display: flex; align-items: flex-end; gap: 8px; }
                .chat-input
                {
                    flex: 1 1 auto;
                    resize: none;
                    min-height: 44px;
                    max-height: 160px;
                    background-color: #1d1d27;
                    color: #ffffff;
                    border: 1px solid #3a3a47;
                    border-radius: 12px;
                    padding: 11px 14px;
                    font-size: 15px;
                    font-family: inherit;
                    line-height: 1.4;
                }
                .chat-input:focus { outline: none; border-color: #0098C4; }
                .chat-send-button
                {
                    flex: 0 0 auto;
                    width: 44px;
                    height: 44px;
                    border-radius: 12px;
                    border: none;
                    background: linear-gradient(45deg, #0098C4, #B55BD0);
                    color: #ffffff;
                    font-size: 18px;
                    font-weight: 700;
                    cursor: pointer;
                    transition: opacity 0.2s ease-in-out;
                }
                .chat-send-button:hover:not(:disabled) { opacity: 0.85; }
                .chat-send-button:disabled { opacity: 0.5; cursor: default; }

                @media (max-width: 640px), (orientation: portrait)
                {
                    .chat-bubble { max-width: 92%; font-size: 14px; }
                    .chat-message-list { padding: 12px 10px; gap: 10px; }
                    .chat-input-bar { padding: 8px 8px calc(8px + env(safe-area-inset-bottom, 0px)); }
                    .chat-source-chip { max-width: 150px; }
                }
            </style>

            <div class="chat-view-root">
                <div class="chat-message-list">
                    <div class="chat-messages-inner">
                        <div class="chat-empty-hint">Ask anything about this deck — answers are drawn from its own cards and study materials.</div>
                    </div>
                </div>
                <div class="chat-input-bar">
                    <div class="chat-input-inner">
                        <div class="chat-tier-row">
                            <llm-tier-select class="chat-tier-select"></llm-tier-select>
                            <button class="chat-save-button" type="button" disabled>Save as study material</button>
                        </div>
                        <div class="chat-input-row">
                            <textarea class="chat-input" rows="1" placeholder="Ask about this deck..." aria-label="Chat message"></textarea>
                            <button class="chat-send-button" type="button" aria-label="Send" title="Send">➤</button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        this.#scrollContainer = this.querySelector(".chat-message-list");
        this.#messageList = this.querySelector(".chat-messages-inner");
        this.#inputElement = this.querySelector(".chat-input");
        this.#sendButton = this.querySelector(".chat-send-button");
        this.#tierSelect = this.querySelector(".chat-tier-select");
        this.#saveButton = this.querySelector(".chat-save-button");

        this.#wireEvents();
    }

    #wireEvents()
    {
        this.#sendButton.addEventListener("click", () => this.#submit());

        this.#inputElement.addEventListener("keydown", (event) =>
        {
            if (event.key === "Enter" && !event.shiftKey)
            {
                event.preventDefault();
                this.#submit();
            }
        });

        // Auto-grow the textarea up to its max-height.
        this.#inputElement.addEventListener("input", () =>
        {
            this.#inputElement.style.height = "auto";
            this.#inputElement.style.height = `${Math.min(this.#inputElement.scrollHeight, 160)}px`;
        });

        this.#saveButton.addEventListener("click", () =>
        {
            if (typeof this.#saveCallback === "function")
            {
                this.#saveCallback();
            }
        });
    }

    #submit()
    {
        if (this.#busy)
        {
            return;
        }
        const text = this.#inputElement.value.trim();
        if (text.length === 0)
        {
            return;
        }
        if (typeof this.#sendCallback === "function")
        {
            this.#sendCallback(text);
        }
    }

    onSend(callback) { this.#sendCallback = callback; }
    onSave(callback) { this.#saveCallback = callback; }

    /**
     * The chosen tier as a ModelTierMetadata key name, which is what
     * ChatSession indexes with. The shared <llm-tier-select> speaks the
     * numeric enum, so the bridge lives here rather than duplicating a tier
     * list — which is what the bespoke <select> this replaced was doing, and
     * why Free never appeared in chat at all.
     */
    getSelectedTier()
    {
        const selectedTierValue = this.#tierSelect?.getCurrentTier?.();
        return ModelTierKeyLookup.keyFor(selectedTierValue) || "BASIC";
    }

    clearInput()
    {
        this.#inputElement.value = "";
        this.#inputElement.style.height = "auto";
    }

    setBusy(busy)
    {
        this.#busy = busy === true;
        this.#sendButton.disabled = this.#busy;
        this.#inputElement.disabled = this.#busy;
    }

    enableSave()
    {
        this.#saveButton.disabled = false;
    }

    #clearEmptyHint()
    {
        const hint = this.#messageList.querySelector(".chat-empty-hint");
        if (hint)
        {
            hint.remove();
        }
    }

    appendUserMessage(text)
    {
        this.#clearEmptyHint();
        const bubble = document.createElement("div");
        bubble.className = "chat-bubble chat-user";
        bubble.textContent = text;
        this.#messageList.appendChild(bubble);
        this.#scrollToBottom();
    }

    /**
     * Creates an assistant bubble and returns a controller the session drives:
     *   appendText(chunk)  — show streaming raw text
     *   finishHtml(html)   — replace with the final sanitized HTML
     *   addSources(chips)  — render [{label, onClick}] source chips
     *   error(message)     — mark the bubble as an error
     *   bodyElement        — the body node (for LaTeX rendering)
     */
    beginAssistantMessage()
    {
        this.#clearEmptyHint();
        const bubble = document.createElement("div");
        bubble.className = "chat-bubble chat-assistant";
        const body = document.createElement("div");
        body.className = "chat-bubble-body chat-typing";
        body.textContent = "…";
        bubble.appendChild(body);
        this.#messageList.appendChild(bubble);
        this.#scrollToBottom();

        let rawText = "";
        let thinkingIntervalId = null;
        const view = this;

        const renderStatus = (text) =>
        {
            body.classList.remove("chat-typing");
            body.classList.add("chat-status");
            body.innerHTML = "";
            const spinner = document.createElement("span");
            spinner.className = "chat-spinner-inline";
            const label = document.createElement("span");
            label.textContent = text;
            body.appendChild(spinner);
            body.appendChild(label);
            view.#scrollToBottom();
        };

        const stopThinking = () =>
        {
            if (thinkingIntervalId !== null)
            {
                window.clearInterval(thinkingIntervalId);
                thinkingIntervalId = null;
            }
        };

        const clearStatus = () =>
        {
            stopThinking();
            body.classList.remove("chat-status");
            body.classList.remove("chat-typing");
        };

        return {
            bodyElement: body,
            setStatus(text)
            {
                stopThinking();
                renderStatus(text);
            },
            beginThinking()
            {
                stopThinking();
                let phraseIndex = 0;
                renderStatus(ChatView.#THINKING_PHRASES[0] + "…");
                thinkingIntervalId = window.setInterval(() =>
                {
                    phraseIndex = (phraseIndex + 1) % ChatView.#THINKING_PHRASES.length;
                    renderStatus(ChatView.#THINKING_PHRASES[phraseIndex] + "…");
                }, 1600);
            },
            appendText(chunk)
            {
                if (!chunk)
                {
                    return;
                }
                if (rawText.length === 0)
                {
                    clearStatus();
                    body.textContent = "";
                }
                rawText += chunk;
                body.textContent = rawText;
                view.#scrollToBottom();
            },
            finishHtml(html)
            {
                clearStatus();
                body.innerHTML = html;
                view.#scrollToBottom();
            },
            addSources(chips)
            {
                if (!Array.isArray(chips) || chips.length === 0)
                {
                    return;
                }
                const row = document.createElement("div");
                row.className = "chat-sources-row";
                for (const chip of chips)
                {
                    const chipButton = document.createElement("button");
                    chipButton.type = "button";
                    chipButton.className = "chat-source-chip";
                    chipButton.textContent = chip.label;
                    chipButton.title = chip.label;
                    chipButton.addEventListener("click", chip.onClick);
                    row.appendChild(chipButton);
                }
                bubble.appendChild(row);
                view.#scrollToBottom();
            },
            error(message)
            {
                clearStatus();
                bubble.classList.add("chat-error");
                body.textContent = message;
                view.#scrollToBottom();
            }
        };
    }

    showError(message)
    {
        this.#clearEmptyHint();
        const bubble = document.createElement("div");
        bubble.className = "chat-bubble chat-assistant chat-error";
        bubble.textContent = message;
        this.#messageList.appendChild(bubble);
        this.#scrollToBottom();
    }

    #scrollToBottom()
    {
        this.#scrollContainer.scrollTop = this.#scrollContainer.scrollHeight;
    }
}

customElements.define(ChatView.tagName, ChatView);
export default ChatView;
