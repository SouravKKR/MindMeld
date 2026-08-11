import LocalLlmModelSelector from "./LocalLlmModelSelector.js";
import { askAiPromptModes } from "../../Enumerations/AskAiPromptModes.js";
import { askAiContextKinds } from "../../Enumerations/AskAiContextKinds.js";


/**
 * LocalLlmPromptBuilder
 *
 * Builds the system + user prompt for a Free-tier query, entirely on the
 * device. Nothing here is sent to a server, which is why the prompt cannot
 * come from Agent/Workflows/AskAi/AskAiPromptBuilder.py the way every paid
 * tier's does.
 *
 * It is a purpose-built compact builder rather than a port of the server
 * templates, for one concrete reason: the server prompts assume a very large
 * context window. Their HTML style block alone runs past a thousand
 * characters and a study material is allowed six thousand, which together
 * exceed the entire window of the models this tier runs. A 1.5B model handed
 * that prompt produces nothing useful even when it fits.
 *
 * Budgets are derived from the SELECTED MODEL's own `contextWindowTokens`, not
 * from constants here, so provisioning a model with a larger window
 * automatically widens the context a learner gets — no code change.
 *
 * Truncation order is fixed and asserted by tests: context is shed before the
 * learner's own question. A question the model never sees produces a confident
 * answer to something nobody asked, which is worse than an answer with thin
 * context.
 *
 * Pure by construction — no DOM, no persistence, no network — so the whole
 * mode x context matrix is exercisable under Node.
 */
class LocalLlmPromptBuilder
{
    // Deliberately conservative: English prose runs nearer 4 characters per
    // token, so budgeting at 3.2 leaves headroom for the technical vocabulary
    // and markup that tokenise worse. Overrunning the window truncates the
    // prompt inside the engine, silently and from the wrong end.
    static APPROXIMATE_CHARACTERS_PER_TOKEN = 3.2;

    // Room the answer needs. Must comfortably exceed the largest
    // MAXIMUM_NEW_TOKENS below, or a long answer runs into the prompt.
    static RESERVED_OUTPUT_TOKENS = 420;

    // Shares of the remaining prompt budget. They sum to less than 1 on
    // purpose — the leftover absorbs the fixed instruction text, which is not
    // itself budgeted.
    static SYSTEM_PROMPT_BUDGET_SHARE = 0.10;
    static CARD_FIELD_BUDGET_SHARE = 0.18;
    static STUDY_MATERIAL_BUDGET_SHARE = 0.45;
    static SELECTED_TEXT_BUDGET_SHARE = 0.12;
    static USER_QUERY_BUDGET_SHARE = 0.10;
    static DECK_CONTEXT_BUDGET_SHARE = 0.55;

    // The learner's question is the one thing never sacrificed to make room,
    // so it keeps a floor independent of the share above.
    static MINIMUM_USER_QUERY_CHARACTERS = 240;

    // One line, not a specification. AskAiResultView sanitises the output
    // anyway, so this is a nudge towards usable markup rather than a
    // guarantee — and a small model ignores a long style contract regardless.
    static STYLE_CLAUSE = "Reply as an HTML fragment using only <p>, <h3>, <ul>, <ol>, <li>, <strong>, <em> and <code>. No markdown, no asterisks, no hash headings, no backticks. Start with a tag.";

    static SYSTEM_PROMPT = "You are a tutor inside the CogniumLearn study app, running on the learner's own device. Answer directly in plain language — no preamble, no restating the question, no filler. Keep the technical meaning intact and unpack jargon when it appears. If the provided material does not contain the answer, say so briefly instead of inventing one.";

    // Per-mode answer length. Short on purpose: on-device generation is slow,
    // and a small model's quality falls off sharply the longer it runs.
    static MAXIMUM_NEW_TOKENS =
    {
        EXPLAIN: 320,
        ASK: 320,
        GIVE_EXAMPLES: 320,
        SUMMARIZE: 200,
        GLOSSARY: 200,
        MAKE_MNEMONIC: 200,
    };

    // FORMAT is absent deliberately. It asks the model to restructure content
    // into tables, ordered sections and figure placements — markup discipline
    // the models this tier runs do not hold over a whole document, and a
    // half-restructured card written back over the learner's own content is a
    // worse outcome than an honest refusal.
    static SUPPORTED_PROMPT_MODE_NAMES = ["EXPLAIN", "ASK", "SUMMARIZE", "MAKE_MNEMONIC", "GIVE_EXAMPLES", "GLOSSARY"];

    static INSTRUCTIONS =
    {
        EXPLAIN: "Explain this so the learner walks away understanding it — what it means and how it fits. One or two short paragraphs.",
        ASK: "Answer the learner's question using the material above. Be specific and stay on the question.",
        SUMMARIZE: "Summarise the material above in a few sentences, keeping every point that matters and dropping everything that does not.",
        MAKE_MNEMONIC: "Give one memorable mnemonic for the material above, then one line saying what each part stands for.",
        GIVE_EXAMPLES: "Give two or three concrete worked examples of the idea above. Show the reasoning, not just the answer.",
        GLOSSARY: "List the key terms in the material above. For each, give the term in <strong> followed by a one-sentence definition.",
    };

    static #PROMPT_MODE_NAME_LOOKUP = new Map(
        Object.entries(askAiPromptModes).map(([modeName, modeValue]) => [modeValue, modeName])
    );

    static #CONTEXT_KIND_NAME_LOOKUP = new Map(
        Object.entries(askAiContextKinds).map(([kindName, kindValue]) => [kindValue, kindName])
    );

    /**
     * The prompt modes the on-device model is trusted with. Callers check this
     * before offering an action on the Free tier so an unsupported mode is
     * refused with an explanation rather than producing mangled output.
     */
    static getSupportedPromptModes()
    {
        return LocalLlmPromptBuilder.SUPPORTED_PROMPT_MODE_NAMES
            .map((modeName) => askAiPromptModes[modeName])
            .filter((modeValue) => modeValue !== undefined);
    }

    static isPromptModeSupported(promptMode)
    {
        return LocalLlmPromptBuilder.getSupportedPromptModes().includes(promptMode);
    }

    /**
     * Total characters of prompt this model can accept, once the answer's own
     * token budget is set aside.
     */
    static getPromptBudgetCharacters(modelKey)
    {
        const descriptor = LocalLlmModelSelector.getDescriptor(modelKey);
        const contextWindowTokens = descriptor && Number.isFinite(descriptor.contextWindowTokens)
            ? descriptor.contextWindowTokens
            : 2048;
        const usableTokens = Math.max(256, contextWindowTokens - LocalLlmPromptBuilder.RESERVED_OUTPUT_TOKENS);
        return Math.floor(usableTokens * LocalLlmPromptBuilder.APPROXIMATE_CHARACTERS_PER_TOKEN);
    }

    /**
     * Per-snippet caps for deck chat's client-side retrieval. ChatSession asks
     * for these instead of hardcoding its own, so the amount of deck content a
     * Free chat turn carries tracks the selected model's window.
     */
    static getDeckContextBudget(modelKey)
    {
        const promptBudget = LocalLlmPromptBuilder.getPromptBudgetCharacters(modelKey);
        const deckBudget = Math.floor(promptBudget * LocalLlmPromptBuilder.DECK_CONTEXT_BUDGET_SHARE);

        return {
            maximumContextPayloadCharacters: deckBudget,
            maximumCardSnippetCharacters: Math.max(200, Math.floor(deckBudget * 0.2)),
            maximumStudyMaterialSnippetCharacters: Math.max(400, Math.floor(deckBudget * 0.5)),
            maximumConversationTurns: 2,
        };
    }

    /**
     * @returns {{systemPrompt: string, userPrompt: string, maximumNewTokens: number}}
     */
    static build({ modelKey, promptMode, contextKind, contextPayload, selectedText, userQuery })
    {
        const promptBudgetCharacters = LocalLlmPromptBuilder.getPromptBudgetCharacters(modelKey);
        const promptModeName = LocalLlmPromptBuilder.#PROMPT_MODE_NAME_LOOKUP.get(promptMode) || "EXPLAIN";
        const contextKindName = LocalLlmPromptBuilder.#CONTEXT_KIND_NAME_LOOKUP.get(contextKind) || "CARD";

        const systemPrompt = LocalLlmPromptBuilder.#truncate(
            LocalLlmPromptBuilder.SYSTEM_PROMPT,
            Math.floor(promptBudgetCharacters * LocalLlmPromptBuilder.SYSTEM_PROMPT_BUDGET_SHARE)
        );

        const promptSections = [];
        promptSections.push(LocalLlmPromptBuilder.#buildContextSection(
            contextKindName,
            contextPayload,
            promptBudgetCharacters
        ));

        // SUMMARIZE is whole-entity by definition — summarising a single
        // highlighted phrase is not a meaningful request — so it ignores the
        // selection even when one exists.
        const trimmedSelection = String(selectedText || "").trim();
        if (trimmedSelection.length > 0 && promptModeName !== "SUMMARIZE")
        {
            const selectionBudget = Math.floor(promptBudgetCharacters * LocalLlmPromptBuilder.SELECTED_TEXT_BUDGET_SHARE);
            promptSections.push(`Highlighted fragment:\n${LocalLlmPromptBuilder.#truncate(trimmedSelection, selectionBudget)}`);
        }

        const trimmedQuery = String(userQuery || "").trim();
        if (trimmedQuery.length > 0)
        {
            const queryBudget = Math.max(
                LocalLlmPromptBuilder.MINIMUM_USER_QUERY_CHARACTERS,
                Math.floor(promptBudgetCharacters * LocalLlmPromptBuilder.USER_QUERY_BUDGET_SHARE)
            );
            promptSections.push(`The learner asks:\n${LocalLlmPromptBuilder.#truncate(trimmedQuery, queryBudget)}`);
        }

        const instruction = LocalLlmPromptBuilder.INSTRUCTIONS[promptModeName] || LocalLlmPromptBuilder.INSTRUCTIONS.EXPLAIN;
        promptSections.push(`${instruction}\n\n${LocalLlmPromptBuilder.STYLE_CLAUSE}`);

        const userPrompt = LocalLlmPromptBuilder.#fitToBudget(
            promptSections,
            promptBudgetCharacters - systemPrompt.length
        );

        return {
            systemPrompt: systemPrompt,
            userPrompt: userPrompt,
            maximumNewTokens: LocalLlmPromptBuilder.MAXIMUM_NEW_TOKENS[promptModeName]
                || LocalLlmPromptBuilder.MAXIMUM_NEW_TOKENS.EXPLAIN,
        };
    }

    static #buildContextSection(contextKindName, contextPayload, promptBudgetCharacters)
    {
        const payload = contextPayload || {};

        if (contextKindName === "STUDY_MATERIAL")
        {
            const materialBudget = Math.floor(promptBudgetCharacters * LocalLlmPromptBuilder.STUDY_MATERIAL_BUDGET_SHARE);
            const materialText = LocalLlmPromptBuilder.#toPlainText(payload.content);
            return `Study material:\n${LocalLlmPromptBuilder.#truncate(materialText, materialBudget)}`;
        }

        if (contextKindName === "DECK")
        {
            return LocalLlmPromptBuilder.#buildDeckContextSection(payload, promptBudgetCharacters);
        }

        const fieldBudget = Math.floor(promptBudgetCharacters * LocalLlmPromptBuilder.CARD_FIELD_BUDGET_SHARE);
        const questionText = LocalLlmPromptBuilder.#truncate(LocalLlmPromptBuilder.#toPlainText(payload.question), fieldBudget);
        const answerText = LocalLlmPromptBuilder.#truncate(LocalLlmPromptBuilder.#toPlainText(payload.answer), fieldBudget);
        return `Flashcard question:\n${questionText}\n\nFlashcard answer:\n${answerText}`;
    }

    /**
     * Deck chat's grounding. Snippets arrive relevance-ordered from
     * DeckRetriever, so overflow is dropped from the tail — the least relevant
     * material goes first.
     */
    static #buildDeckContextSection(payload, promptBudgetCharacters)
    {
        const deckBudget = Math.floor(promptBudgetCharacters * LocalLlmPromptBuilder.DECK_CONTEXT_BUDGET_SHARE);
        const snippets = Array.isArray(payload.snippets) ? payload.snippets : [];
        const renderedSnippets = [];
        let usedCharacters = 0;

        for (const snippet of snippets)
        {
            const renderedSnippet = snippet && snippet.kind === "STUDY_MATERIAL"
                ? `From a study material:\n${LocalLlmPromptBuilder.#toPlainText(snippet.content)}`
                : `From a flashcard:\nQ: ${LocalLlmPromptBuilder.#toPlainText(snippet && snippet.question)}\nA: ${LocalLlmPromptBuilder.#toPlainText(snippet && snippet.answer)}`;

            if (usedCharacters + renderedSnippet.length > deckBudget)
            {
                break;
            }
            renderedSnippets.push(renderedSnippet);
            usedCharacters += renderedSnippet.length;
        }

        const conversation = Array.isArray(payload.conversation) ? payload.conversation : [];
        const renderedConversation = conversation
            .map((turn) => `${turn && turn.role === "assistant" ? "You" : "Learner"}: ${LocalLlmPromptBuilder.#toPlainText(turn && turn.text)}`)
            .join("\n");

        const sections = [];
        if (renderedSnippets.length > 0)
        {
            sections.push(`From this deck:\n${renderedSnippets.join("\n\n")}`);
        }
        else
        {
            sections.push("No relevant material was found in this deck.");
        }
        if (renderedConversation.length > 0)
        {
            sections.push(`Earlier in this conversation:\n${LocalLlmPromptBuilder.#truncate(renderedConversation, Math.floor(deckBudget * 0.3))}`);
        }

        return sections.join("\n\n");
    }

    /**
     * Assembles the sections, shedding from the FRONT if the total overruns.
     * The instruction and the learner's question are the last two sections, so
     * front-shedding drops context first and never the ask itself. A final
     * hard truncation guards the pathological case where even the instruction
     * alone exceeds the window.
     */
    static #fitToBudget(promptSections, budgetCharacters)
    {
        const sections = promptSections.filter((section) => typeof section === "string" && section.length > 0);
        const usableBudget = Math.max(200, budgetCharacters);

        while (sections.length > 1)
        {
            const assembled = sections.join("\n\n");
            if (assembled.length <= usableBudget)
            {
                return assembled;
            }
            sections.shift();
        }

        return LocalLlmPromptBuilder.#truncate(sections.join("\n\n"), usableBudget);
    }

    /**
     * Card and study-material content is HTML. The model is asked to emit HTML
     * but reads better plain, and inline base64 images would eat the entire
     * window on their own, so both are stripped here.
     */
    static #toPlainText(rawValue)
    {
        return String(rawValue === null || rawValue === undefined ? "" : rawValue)
            .replace(/<img\b[^>]*>/gi, " [image] ")
            .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
            .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<[^>]*>/g, " ")
            .replace(/&nbsp;/gi, " ")
            .replace(/&amp;/gi, "&")
            .replace(/&lt;/gi, "<")
            .replace(/&gt;/gi, ">")
            .replace(/&quot;/gi, "\"")
            .replace(/[ \t]+/g, " ")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }

    static #truncate(rawText, maximumCharacters)
    {
        const text = String(rawText === null || rawText === undefined ? "" : rawText);
        if (maximumCharacters <= 0)
        {
            return "";
        }
        return text.length <= maximumCharacters ? text : `${text.slice(0, maximumCharacters - 1)}…`;
    }
}

export default LocalLlmPromptBuilder;
