import { askAiPromptModes } from "../../../Globals/Enumerations/AskAiPromptModes.js";
import Card from "../../../Globals/Model/Card.js";
import StudyMaterial from "../../../Globals/Model/StudyMaterial.js";
import DialogBox from "../../../CommonComponents/DialogBox.js";
import { getRandomUuid } from "../../../Globals/UtilityFunctions/GetRandomUuid.js";
import AskAiPopupLink from "./AskAiPopupLink.js";


/**
 * AskAiActionDispatcher
 *
 * Owns the actions that ship inside the AskAi dialog's bottom
 * actions bar:
 *
 *   1. Insert all into <entity>       — drop ONE popup-link button
 *                                      containing the whole response.
 *                                      Anchored after the heading of
 *                                      the relevant section.
 *   2. Insert selected into <entity>  — only offered when the response
 *                                      naturally splits into 2+ blocks
 *                                      (multi-mnemonic, multi-example,
 *                                      glossary-with-many-terms). The
 *                                      learner toggles which blocks
 *                                      they want via an in-dialog
 *                                      selection mode; each chosen
 *                                      block lands as ITS OWN popup-
 *                                      link button, placed near the
 *                                      entity section it's about.
 *   3. Append                         — paste the full response inline
 *                                      at the very end of the entity.
 *   4. Append after relevant section  — paste the full response inline
 *                                      at the END of the relevant
 *                                      section.
 *
 * Storage / propagation: every popup-link record lives under the
 * owning Deck's `additionalData.askAiPopupLinks[<id>]` (see
 * AskAiPopupLink). The entity HTML carries only the lightweight
 * <button class="ask-ai-popup-link" data-popup-id …> marker, so raw-
 * HTML edits don't risk corrupting the content and Deck sync ships
 * the content across the user's devices for free.
 *
 * "Relevant section" is determined deterministically — no LLM calls.
 * For per-block inserts the topic source is the block's leading text
 * (the <h3> in a mnemonic block, the <strong>-wrapped term in a
 * glossary <li>); for whole-response inserts it's the user's
 * selectedText if present, else the popup body's first heading. We
 * keyword-match against the entity's h1/h2/h3 set and place the
 * marker after the best-scoring heading. Stop-words filter out the
 * mode-name nouns ("example", "mnemonic", …) so they don't dominate.
 *
 * For ASK mode (free-form learner question) only the two append
 * actions are exposed, and each appended block prepends a Q-header
 * with the original user query so the dump reads as a proper Q&A
 * snippet.
 */
class AskAiActionDispatcher
{
    static #SECTION_HEADING_SELECTOR = "h1, h2, h3";
    static #INJECTED_WRAPPER_CLASS = "ask-ai-injected";
    static #BUTTON_TITLE_MAX_CHARS = 48;

    static #VIEW_LABELS_BY_PROMPT_MODE =
    {
        [askAiPromptModes.EXPLAIN]:       "View Explanation",
        [askAiPromptModes.SUMMARIZE]:     "View Summary",
        [askAiPromptModes.FORMAT]:        "View Format",
        [askAiPromptModes.MAKE_MNEMONIC]: "View Mnemonic",
        [askAiPromptModes.GIVE_EXAMPLES]: "View Example",
        [askAiPromptModes.GLOSSARY]:      "View Glossary",
    };

    static #STOP_WORDS = new Set([
        "the", "a", "an", "and", "or", "of", "in", "on", "for", "to",
        "is", "are", "was", "were", "this", "that", "with", "by", "at",
        "be", "as", "from", "it", "its", "into", "about", "what", "how",
        "why", "which", "who", "whom", "whose", "where", "when",
        "explain", "explanation", "ask", "question", "answer",
        "example", "examples", "mnemonic", "summary", "format",
        "glossary", "view"
    ]);

    static buildActionDescriptors({ contextEntity, promptMode, userQuery, selectedText, getRenderedHtml, resultView, onComplete })
    {
        const bIsAskMode  = promptMode === askAiPromptModes.ASK;
        const entityLabel = AskAiActionDispatcher.#getEntityLabel(contextEntity);
        const actionDescriptors = [];

        // Snapshot the rendered HTML once so every action sees the same
        // body (the stream has settled by the time the descriptors are
        // built, so this is stable). Block detection runs against the
        // snapshot — we only offer "Insert selected" if the response
        // naturally splits into 2+ logical blocks.
        const renderedHtmlSnapshot = getRenderedHtml?.() || "";
        const detectedBlocks = AskAiActionDispatcher.#detectBlocks(renderedHtmlSnapshot);

        // Activate inline block selection on the result view. Once
        // turned on, each `.ask-ai-block` in the popup body responds
        // to click → toggle .selected. The user picks blocks before
        // clicking "Insert selected", which reads the current
        // selection at click-time via resultView.getSelectedBlockIndices().
        if (resultView && detectedBlocks.length >= 2)
        {
            resultView.activateBlockSelection(detectedBlocks);
        }

        if (!bIsAskMode)
        {
            actionDescriptors.push(
            {
                label: `Insert all into ${entityLabel}`,
                onClick: async () =>
                {
                    // When the response naturally splits into 2+ blocks
                    // (mnemonics, examples, glossary entries) "Insert
                    // all" means "insert every block, each as its own
                    // popup link anchored under its relevant section".
                    // For a single-block response it stays as one
                    // popup link with the whole body.
                    if (detectedBlocks.length >= 2)
                    {
                        await AskAiActionDispatcher.#insertBlocksAsPopupLinks(contextEntity, detectedBlocks, promptMode);
                    }
                    else
                    {
                        await AskAiActionDispatcher.#performInsertWholeResponse(contextEntity, renderedHtmlSnapshot, promptMode, selectedText);
                    }
                    AskAiActionDispatcher.#refreshEntityRendering(contextEntity);
                    onComplete?.();
                }
            });

            // Only meaningful when the popup contains multiple
            // self-contained units (e.g. several mnemonics, a multi-
            // term glossary). A single-block response has nothing to
            // select.
            if (detectedBlocks.length >= 2)
            {
                actionDescriptors.push(
                {
                    label: `Insert selected into ${entityLabel}`,
                    onClick: async () =>
                    {
                        const selectedIndices = resultView?.getSelectedBlockIndices?.() || [];
                        if (selectedIndices.length === 0)
                        {
                            await DialogBox.alert(
                                "Nothing selected",
                                "Click on the blocks you want to insert — they highlight when selected. Click again to deselect. Then click \"Insert selected\" again to commit."
                            );
                            return;
                        }
                        const chosenBlocks = selectedIndices
                            .map((blockIndex) => detectedBlocks[blockIndex])
                            .filter((block) => block);
                        await AskAiActionDispatcher.#insertBlocksAsPopupLinks(contextEntity, chosenBlocks, promptMode);
                        AskAiActionDispatcher.#refreshEntityRendering(contextEntity);
                        onComplete?.();
                    }
                });
            }
        }

        actionDescriptors.push(
        {
            label: "Append",
            onClick: async () =>
            {
                await AskAiActionDispatcher.#performAppendAtEnd(contextEntity, renderedHtmlSnapshot, userQuery, bIsAskMode);
                AskAiActionDispatcher.#refreshEntityRendering(contextEntity);
                onComplete?.();
            }
        });

        actionDescriptors.push(
        {
            label: "Append after relevant section",
            onClick: async () =>
            {
                await AskAiActionDispatcher.#performAppendAfterRelevantSection(contextEntity, renderedHtmlSnapshot, userQuery, bIsAskMode, selectedText);
                AskAiActionDispatcher.#refreshEntityRendering(contextEntity);
                onComplete?.();
            }
        });

        return actionDescriptors;
    }

    /**
     * Inserts each block as its own popup-link marker into the
     * entity. Each marker is anchored independently under its own
     * relevant section (the block's `topicSource` is used as the
     * keyword pool against the entity's headings). Shared by "Insert
     * all" (when blocks ≥ 2) and "Insert selected".
     */
    static async #insertBlocksAsPopupLinks(entity, blocks, promptMode)
    {
        for (const block of blocks)
        {
            await AskAiActionDispatcher.#insertSingleBlockAsPopupLink(entity, block, promptMode);
        }
    }

    // ── Insert (single-block, both flows route through here) ──────

    /**
     * Inserts ONE popup-link marker into the entity. Used by both
     * "Insert all" (the block contains the full popup HTML) and
     * "Insert selected" (the block is one extracted unit). Each call
     * mints a fresh popup id and stores the content on the deck.
     *
     * `block.topicSource` is what we keyword-match against entity
     * headings to choose the anchor — the block's leading text for
     * per-block inserts, or a fallback chain for "Insert all" (see
     * #buildInsertAllBlock).
     */
    static async #insertSingleBlockAsPopupLink(entity, block, promptMode)
    {
        const owningDeck = entity?.getDeck?.();
        if (!owningDeck)
        {
            console.warn("[AskAiActionDispatcher] Cannot store popup link: entity has no owning deck.");
            return;
        }

        const popupId   = getRandomUuid();
        const titleText = AskAiActionDispatcher.#buildButtonTitle(promptMode, block.leadingText);

        AskAiPopupLink.writeRecord(owningDeck, popupId,
        {
            title:         titleText,
            content:       block.contentHtml || "",
            promptMode:    promptMode,
            savedAtMillis: Date.now(),
        });

        const markerHtml = AskAiPopupLink.buildMarkerHtml(
        {
            popupId: popupId,
            deckId:  owningDeck.getId(),
            title:   titleText,
        });

        const currentEntityHtml = AskAiActionDispatcher.#getEntityHtml(entity);
        const newEntityHtml = AskAiActionDispatcher.#insertAfterRelevantHeading(currentEntityHtml, markerHtml, block.topicSource);
        await AskAiActionDispatcher.#commitEntityHtml(entity, newEntityHtml);
    }

    /**
     * Single-popup-link Insert path used when the response is one
     * indivisible block (Explain, Summarize, single-list output).
     * Multi-block responses route through #insertBlocksAsPopupLinks
     * instead — see the "Insert all" onClick above.
     */
    static async #performInsertWholeResponse(entity, renderedHtml, promptMode, selectedText)
    {
        const fallbackTopicSource = (selectedText && selectedText.trim().length > 0)
            ? selectedText
            : AskAiActionDispatcher.#extractFirstHeadingText(renderedHtml);

        await AskAiActionDispatcher.#insertSingleBlockAsPopupLink(
            entity,
            {
                contentHtml: renderedHtml || "",
                leadingText: "",                       // generic "View Mnemonic" / "View Example" title
                topicSource: fallbackTopicSource,      // for section anchoring
            },
            promptMode
        );
    }

    // ── Append actions ────────────────────────────────────────────

    static async #performAppendAtEnd(entity, renderedHtml, userQuery, bIsAskMode)
    {
        const blockHtml = AskAiActionDispatcher.#buildInlineBlockHtml(renderedHtml, userQuery, bIsAskMode);
        const currentEntityHtml = AskAiActionDispatcher.#getEntityHtml(entity);
        await AskAiActionDispatcher.#commitEntityHtml(entity, currentEntityHtml + blockHtml);
    }

    static async #performAppendAfterRelevantSection(entity, renderedHtml, userQuery, bIsAskMode, selectedText)
    {
        const inlineBlock = AskAiActionDispatcher.#buildInlineBlockHtml(renderedHtml, userQuery, bIsAskMode);
        const topicSource = (selectedText && selectedText.trim().length > 0)
            ? selectedText
            : AskAiActionDispatcher.#extractFirstHeadingText(renderedHtml);
        const currentEntityHtml = AskAiActionDispatcher.#getEntityHtml(entity);
        const newEntityHtml = AskAiActionDispatcher.#insertAtEndOfRelevantSection(currentEntityHtml, inlineBlock, topicSource);
        await AskAiActionDispatcher.#commitEntityHtml(entity, newEntityHtml);
    }

    // ── Block detection ───────────────────────────────────────────

    /**
     * Inspects the popup HTML for natural break points and returns an
     * array of `{ contentHtml, leadingText, topicSource }`. Returns
     * `[]` (no "Insert selected" offered) when the body is a single
     * indivisible unit.
     *
     * Detection priority:
     *
     *   1. EXPLICIT — top-level <div class="ask-ai-block"> wrappers.
     *      Mnemonic + Examples prompts instruct the LLM to emit these,
     *      and the sanitiser preserves the class. This is the reliable
     *      path; we hit it whenever the prompt asked for marked blocks.
     *
     *   2. Glossary shape — a single top-level <ul> with 2+ <li>s.
     *      We can't ask the LLM to wrap each <li> in a <div> (invalid
     *      HTML), so each <li> is the block. Leading text comes from
     *      the <strong> term or the li text.
     *
     *   3. Heading-grouped fallback — 2+ top-level headings at the
     *      same dominant level. Survives older / unmarked output from
     *      prompts the wrapper hasn't been added to.
     *
     * Other shapes (single paragraph, mixed prose) return [] — the
     * "Insert selected" affordance simply doesn't appear, and "Insert
     * all" remains the only insert action.
     */
    static #detectBlocks(htmlString)
    {
        const parsedBody = AskAiActionDispatcher.#parseToBody(htmlString);
        const topChildren = Array.from(parsedBody.children);
        if (topChildren.length === 0)
        {
            return [];
        }

        // ── 1. Explicit wrappers ─────────────────────────────
        const explicitBlockElements = topChildren.filter((child) =>
            child.tagName === "DIV" && child.classList.contains("ask-ai-block")
        );
        if (explicitBlockElements.length >= 2)
        {
            return explicitBlockElements.map((blockElement) =>
            {
                const leadingHeading = blockElement.querySelector("h1, h2, h3, h4");
                const leadingText = (leadingHeading?.textContent || blockElement.textContent || "")
                    .trim()
                    .substring(0, 200);
                return {
                    // Keep the wrapper around the saved content so the
                    // popup view re-applies our block padding / styling
                    // when the marker is re-opened later.
                    contentHtml: blockElement.outerHTML,
                    leadingText: leadingText,
                    topicSource: leadingText,
                };
            });
        }

        // ── 2. Glossary shape ────────────────────────────────
        if (topChildren.length === 1 && topChildren[0].tagName === "UL")
        {
            const listItems = Array.from(topChildren[0].children).filter((child) => child.tagName === "LI");
            if (listItems.length >= 2)
            {
                return listItems.map((listItem) =>
                {
                    const leadingTerm = listItem.querySelector("strong");
                    const leadingText = (leadingTerm?.textContent || listItem.textContent || "").trim();
                    return {
                        contentHtml: `<ul>${listItem.outerHTML}</ul>`,
                        leadingText: leadingText,
                        topicSource: leadingText,
                    };
                });
            }
        }

        // ── 3. Heading-grouped fallback ──────────────────────
        const topHeadingElements = topChildren.filter((child) => /^H[1-6]$/.test(child.tagName));
        if (topHeadingElements.length >= 2)
        {
            const headingLevels = topHeadingElements.map((heading) => parseInt(heading.tagName.substring(1), 10));
            const dominantLevel = Math.min(...headingLevels);

            const blocks = [];
            let currentGroup = null;
            for (const child of topChildren)
            {
                const bIsDominantHeading = /^H[1-6]$/.test(child.tagName)
                    && parseInt(child.tagName.substring(1), 10) === dominantLevel;
                if (bIsDominantHeading)
                {
                    if (currentGroup)
                    {
                        blocks.push(currentGroup);
                    }
                    currentGroup = { elements: [child], leadingText: (child.textContent || "").trim() };
                }
                else if (currentGroup)
                {
                    currentGroup.elements.push(child);
                }
                // Pre-heading content (rare — a stray <p> before the
                // first heading) is intentionally dropped from the
                // selection set.
            }
            if (currentGroup)
            {
                blocks.push(currentGroup);
            }

            if (blocks.length >= 2)
            {
                return blocks.map((group) =>
                ({
                    contentHtml: group.elements.map((element) => element.outerHTML).join(""),
                    leadingText: group.leadingText,
                    topicSource: group.leadingText,
                }));
            }
        }

        return [];
    }

    // ── HTML placement primitives ─────────────────────────────────

    static #insertAfterRelevantHeading(entityHtml, snippetHtml, topicSource)
    {
        const parsedBody = AskAiActionDispatcher.#parseToBody(entityHtml);
        const relevantHeading = AskAiActionDispatcher.#findRelevantHeading(parsedBody, topicSource);

        if (relevantHeading)
        {
            relevantHeading.insertAdjacentHTML("afterend", snippetHtml);
        }
        else
        {
            parsedBody.insertAdjacentHTML("afterbegin", snippetHtml);
        }
        return parsedBody.innerHTML;
    }

    static #insertAtEndOfRelevantSection(entityHtml, snippetHtml, topicSource)
    {
        const parsedBody = AskAiActionDispatcher.#parseToBody(entityHtml);
        const relevantHeading = AskAiActionDispatcher.#findRelevantHeading(parsedBody, topicSource);

        if (!relevantHeading)
        {
            parsedBody.insertAdjacentHTML("beforeend", snippetHtml);
            return parsedBody.innerHTML;
        }

        const nextSectionStart = AskAiActionDispatcher.#findNextSectionHeading(relevantHeading);
        if (nextSectionStart)
        {
            nextSectionStart.insertAdjacentHTML("beforebegin", snippetHtml);
        }
        else
        {
            parsedBody.insertAdjacentHTML("beforeend", snippetHtml);
        }
        return parsedBody.innerHTML;
    }

    static #findNextSectionHeading(currentHeading)
    {
        const currentLevel = parseInt(currentHeading.tagName.substring(1), 10);
        let walker = currentHeading.nextElementSibling;
        while (walker)
        {
            if (/^H[1-6]$/.test(walker.tagName))
            {
                const walkerLevel = parseInt(walker.tagName.substring(1), 10);
                if (walkerLevel <= currentLevel)
                {
                    return walker;
                }
            }
            walker = walker.nextElementSibling;
        }
        return null;
    }

    static #findRelevantHeading(parsedBody, topicSource)
    {
        const entityHeadings = Array.from(parsedBody.querySelectorAll(AskAiActionDispatcher.#SECTION_HEADING_SELECTOR));
        if (entityHeadings.length === 0)
        {
            return null;
        }

        const matchKeywords = AskAiActionDispatcher.#extractKeywords(topicSource);
        if (matchKeywords.length === 0)
        {
            return entityHeadings[0];
        }

        let bestHeading = entityHeadings[0];
        let bestScore = 0;
        for (const entityHeading of entityHeadings)
        {
            const headingText = (entityHeading.textContent || "").toLowerCase();
            let score = 0;
            for (const keyword of matchKeywords)
            {
                if (headingText.includes(keyword))
                {
                    score += 1;
                }
            }
            if (score > bestScore)
            {
                bestScore = score;
                bestHeading = entityHeading;
            }
        }
        return bestHeading;
    }

    static #extractFirstHeadingText(htmlFragment)
    {
        if (!htmlFragment) return "";
        const parsedBody = AskAiActionDispatcher.#parseToBody(htmlFragment);
        const firstHeading = parsedBody.querySelector("h1, h2, h3, h4");
        return firstHeading ? (firstHeading.textContent || "") : "";
    }

    static #extractKeywords(rawText)
    {
        if (!rawText) return [];
        const lowercaseTokens = String(rawText).toLowerCase().split(/[^a-z0-9]+/i);
        const uniqueKeywords = new Set();
        for (const token of lowercaseTokens)
        {
            if (token.length > 2 && !AskAiActionDispatcher.#STOP_WORDS.has(token))
            {
                uniqueKeywords.add(token);
            }
        }
        return Array.from(uniqueKeywords);
    }

    static #parseToBody(rawHtml)
    {
        const documentParser = new DOMParser();
        const parsedDocument = documentParser.parseFromString("<!doctype html><body>" + (rawHtml || "") + "</body>", "text/html");
        return parsedDocument.body;
    }

    static #buildInlineBlockHtml(renderedHtml, userQuery, bIsAskMode)
    {
        const wrapperClass = AskAiActionDispatcher.#INJECTED_WRAPPER_CLASS;
        if (bIsAskMode && userQuery)
        {
            const safeQuestion = AskAiActionDispatcher.#escapeHtmlContent(userQuery);
            return `<div class="${wrapperClass}"><h3>Q: ${safeQuestion}</h3>${renderedHtml || ""}</div>`;
        }
        return `<div class="${wrapperClass}">${renderedHtml || ""}</div>`;
    }

    static #buildButtonTitle(promptMode, blockLeadingText)
    {
        const modeLabel = AskAiActionDispatcher.#VIEW_LABELS_BY_PROMPT_MODE[promptMode] || "View AI response";
        if (!blockLeadingText)
        {
            return modeLabel;
        }
        const trimmedLeadingText = String(blockLeadingText).trim();
        if (trimmedLeadingText.length === 0)
        {
            return modeLabel;
        }
        const truncatedLeadingText = trimmedLeadingText.length > AskAiActionDispatcher.#BUTTON_TITLE_MAX_CHARS
            ? trimmedLeadingText.substring(0, AskAiActionDispatcher.#BUTTON_TITLE_MAX_CHARS - 1).trimEnd() + "…"
            : trimmedLeadingText;
        return `${modeLabel}: ${truncatedLeadingText}`;
    }

    // ── Entity bridge ─────────────────────────────────────────────

    static #getEntityHtml(entity)
    {
        if (entity instanceof Card)          return entity.getAnswer() || "";
        if (entity instanceof StudyMaterial) return entity.getContent() || "";
        return "";
    }

    /**
     * Push the entity's new HTML into the study page's currently-
     * visible render slots so the learner sees the insertion land
     * immediately (instead of having to navigate away and back).
     *
     * StudySession renders cards via:
     *   .question-section .innerHTML = card.getQuestion();
     *   .answer-section   .innerHTML = card.getAnswer();
     *
     * ContentStudySession renders materials via:
     *   .study-material-content-section .innerHTML = material.getContent();
     *   then calls studyPage.renderLatex().
     *
     * We mirror those writes here. The answer-section refresh is
     * gated on it already having content — otherwise we'd reveal
     * the answer side of a card the learner hasn't flipped yet.
     * Question section refresh is unconditional (it's always visible
     * when a card is on screen).
     *
     * Scoping note: queries run against the <study-page> custom
     * element when one is mounted, falling back to document scope.
     * That keeps the refresh from accidentally targeting nodes
     * inside other surfaces (the open AskAi dialog, a card-editor
     * page in the navigation stack, etc.).
     */
    static #refreshEntityRendering(entity)
    {
        const studyPageElement = document.querySelector("study-page") || document;

        if (entity instanceof Card)
        {
            const questionSection = studyPageElement.querySelector(".question-section");
            if (questionSection)
            {
                questionSection.innerHTML = entity.getQuestion() || "";
            }
            const answerSection = studyPageElement.querySelector(".answer-section");
            // Only refresh the answer if it's currently revealed —
            // checking textContent (not innerHTML) so an empty
            // wrapper element doesn't fool us into thinking the
            // answer was shown.
            if (answerSection && (answerSection.textContent || "").trim().length > 0)
            {
                answerSection.innerHTML = entity.getAnswer() || "";
            }
            return;
        }
        if (entity instanceof StudyMaterial)
        {
            const materialContentSection = studyPageElement.querySelector(".study-material-content-section");
            if (materialContentSection)
            {
                materialContentSection.innerHTML = entity.getContent() || "";
                // ContentStudySession re-runs LaTeX rendering after every
                // content swap; mirror that here so any KaTeX-rendered
                // math inside the new content displays correctly. The
                // function is exposed on <study-page>; check both
                // signatures since the element may not be mounted in
                // every test surface.
                if (typeof studyPageElement.renderLatex === "function")
                {
                    studyPageElement.renderLatex();
                }
            }
        }
    }

    static async #commitEntityHtml(entity, newHtml)
    {
        if (entity instanceof Card)
        {
            entity.setAnswer(newHtml);
            await entity.save();
            return;
        }
        if (entity instanceof StudyMaterial)
        {
            entity.setContent(newHtml);
            await entity.save();
        }
    }

    static #getEntityLabel(entity)
    {
        if (entity instanceof Card)          return "card";
        if (entity instanceof StudyMaterial) return "study material";
        return "entity";
    }

    static #escapeHtmlContent(rawString)
    {
        if (rawString === null || rawString === undefined) return "";
        return String(rawString)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    }
}

export default AskAiActionDispatcher;
