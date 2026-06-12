import { askAiPromptModes } from "../../../Globals/Enumerations/AskAiPromptModes.js";
import Card from "../../../Globals/Model/Card.js";
import StudyMaterial from "../../../Globals/Model/StudyMaterial.js";
import HtmlSanitizer from "../../../Globals/Classes/HtmlSanitizer.js";
import DialogBox from "../../../CommonComponents/DialogBox.js";
import PageNavigator from "../../../Globals/Classes/PageNavigator.js";
import { getRandomUuid } from "../../../Globals/UtilityFunctions/GetRandomUuid.js";
import AskAiPopupLink from "./AskAiPopupLink.js";
import AskAiInjectedBlock from "./AskAiInjectedBlock.js";


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

        // Unified "Append all after relevant sections" — handles BOTH
        // shapes the response can take:
        //
        //   - Multi-block (mnemonics, examples, glossary with 2+
        //     entries): each detected block is appended inline at the
        //     end of ITS OWN relevant section, anchored by the block's
        //     leading text. Glossary terms land near where they're
        //     mentioned in the body, mnemonic blocks land under their
        //     own list heading, etc.
        //   - Single-block (Explain, single-list responses, ASK Q&A):
        //     the whole response is appended as one inline block at
        //     the end of the section the learner's selectedText points
        //     to — falls back to the response's first heading when no
        //     selection.
        //
        // This replaces the old "Append after relevant section" entry,
        // which was just the single-block flavour of the same idea.
        actionDescriptors.push(
        {
            label: "Append all after relevant sections",
            onClick: async () =>
            {
                if (detectedBlocks.length >= 2)
                {
                    await AskAiActionDispatcher.#appendBlocksInlineAtRelevantSections(contextEntity, detectedBlocks);
                }
                else
                {
                    await AskAiActionDispatcher.#performAppendAfterRelevantSection(contextEntity, renderedHtmlSnapshot, userQuery, bIsAskMode, selectedText);
                }
                AskAiActionDispatcher.#refreshEntityRendering(contextEntity);
                onComplete?.();
            }
        });

        // "Append selected after relevant sections" — per-block append
        // restricted to the blocks the learner highlighted in the in-
        // dialog selection mode. Only offered for multi-block
        // responses, since picking a subset of one block doesn't mean
        // anything. ASK mode is excluded for the same reason as the
        // Insert-selected affordance — ASK output is one Q&A snippet,
        // not a set of selectable blocks.
        if (!bIsAskMode && detectedBlocks.length >= 2)
        {
            actionDescriptors.push(
            {
                label: "Append selected after relevant sections",
                onClick: async () =>
                {
                    const selectedIndices = resultView?.getSelectedBlockIndices?.() || [];
                    if (selectedIndices.length === 0)
                    {
                        await DialogBox.alert(
                            "Nothing selected",
                            "Click on the blocks you want to append — they highlight when selected. Click again to deselect. Then click \"Append selected\" again to commit."
                        );
                        return;
                    }
                    const chosenBlocks = selectedIndices
                        .map((blockIndex) => detectedBlocks[blockIndex])
                        .filter((block) => block);
                    await AskAiActionDispatcher.#appendBlocksInlineAtRelevantSections(contextEntity, chosenBlocks);
                    AskAiActionDispatcher.#refreshEntityRendering(contextEntity);
                    onComplete?.();
                }
            });
        }

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
        const blockHtml = AskAiActionDispatcher.#buildInlineBlockHtml(entity, renderedHtml, userQuery, bIsAskMode);
        const currentEntityHtml = AskAiActionDispatcher.#getEntityHtml(entity);
        await AskAiActionDispatcher.#commitEntityHtml(entity, currentEntityHtml + blockHtml);
    }

    static async #performAppendAfterRelevantSection(entity, renderedHtml, userQuery, bIsAskMode, selectedText)
    {
        const inlineBlock = AskAiActionDispatcher.#buildInlineBlockHtml(entity, renderedHtml, userQuery, bIsAskMode);
        const topicSource = (selectedText && selectedText.trim().length > 0)
            ? selectedText
            : AskAiActionDispatcher.#extractFirstHeadingText(renderedHtml);
        const currentEntityHtml = AskAiActionDispatcher.#getEntityHtml(entity);
        const newEntityHtml = AskAiActionDispatcher.#insertAtEndOfRelevantSection(currentEntityHtml, inlineBlock, topicSource);
        await AskAiActionDispatcher.#commitEntityHtml(entity, newEntityHtml);
    }

    /**
     * Append each block inline at the end of its OWN relevant section
     * — the per-block parallel to "Insert all into <entity>". Where
     * Insert-all drops popup-link MARKERS (small buttons that pop the
     * body in a dialog), this drops the block's body INLINE into the
     * card / material so the content reads alongside the surrounding
     * section. Used by "Append all after relevant sections" and
     * "Append selected after relevant sections".
     *
     * Each block is committed sequentially: the next call reads the
     * post-commit entity HTML so anchor lookups account for the
     * already-appended siblings. The block-detector's `topicSource`
     * carries the leading text of each block (the mnemonic <h3>, the
     * glossary <strong> term, …) and drives the per-block anchor.
     */
    static async #appendBlocksInlineAtRelevantSections(entity, blocks)
    {
        for (const block of blocks)
        {
            await AskAiActionDispatcher.#appendSingleBlockInlineAtRelevantSection(entity, block);
        }
    }

    static async #appendSingleBlockInlineAtRelevantSection(entity, block)
    {
        const owningDeck  = entity?.getDeck?.();
        const deckId      = owningDeck?.getId?.() || "";
        const injectionId = getRandomUuid();

        const wrapperHtml = AskAiInjectedBlock.buildWrapperHtml(
        {
            injectionId: injectionId,
            deckId:      deckId,
            innerHtml:   block.contentHtml || "",
        });

        const currentEntityHtml = AskAiActionDispatcher.#getEntityHtml(entity);
        const newEntityHtml = AskAiActionDispatcher.#insertAtEndOfRelevantSection(
            currentEntityHtml,
            wrapperHtml,
            block.topicSource
        );
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
        const anchor     = AskAiActionDispatcher.#findRelevantAnchor(parsedBody, topicSource);

        if (anchor && anchor.element)
        {
            // Marker / popup-link always lands immediately AFTER the
            // anchor — whether that anchor is a heading or a content
            // element where the term actually appears.
            anchor.element.insertAdjacentHTML("afterend", snippetHtml);
        }
        else
        {
            // Truly nothing matched. Drop the marker at the top so the
            // learner can still find it (rather than at the very end
            // where they might miss it). "Append" stays as the only
            // path that intentionally dumps at the end of the entity.
            parsedBody.insertAdjacentHTML("afterbegin", snippetHtml);
        }
        return parsedBody.innerHTML;
    }

    static #insertAtEndOfRelevantSection(entityHtml, snippetHtml, topicSource)
    {
        const parsedBody = AskAiActionDispatcher.#parseToBody(entityHtml);
        const anchor     = AskAiActionDispatcher.#findRelevantAnchor(parsedBody, topicSource);

        if (!anchor || !anchor.element)
        {
            // No anchor at all — fall back to the top of the entity so
            // the block stays prominent. Plain "Append" remains the
            // only path that intentionally lands at the end of the
            // entity.
            parsedBody.insertAdjacentHTML("afterbegin", snippetHtml);
            return parsedBody.innerHTML;
        }

        if (anchor.kind === "content")
        {
            // A body-element match means "the term actually appears in
            // this paragraph / list item / cell" — sit immediately
            // after that element so the appended block reads next to
            // the text it relates to. Section-level "end of section"
            // semantics don't apply here because the anchor isn't a
            // heading.
            anchor.element.insertAdjacentHTML("afterend", snippetHtml);
            return parsedBody.innerHTML;
        }

        // Heading anchor: land at the END of that section (before the
        // next sibling heading at same or higher level). Falls through
        // to "end of entity" only when the heading happens to be the
        // last in the entity — same shape as before this refactor.
        const nextSectionStart = AskAiActionDispatcher.#findNextSectionHeading(anchor.element);
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

    /**
     * Find the best anchor element for a per-block insertion within
     * the entity's HTML, given a `topicSource` (typically the block's
     * leading text — a glossary <strong> term, a mnemonic <h3>
     * heading, etc.).
     *
     * Search priority:
     *
     *   1. HEADINGS — the strongest semantic anchor. If any heading's
     *      text contains a keyword from the topic source, pick the
     *      best-scoring one. Returned as `{ kind: "heading" }`.
     *
     *   2. CONTENT — paragraphs, list items, table cells, blockquotes,
     *      pre blocks. Only consulted when no heading matched. This
     *      catches the common case where a glossary term ("ATP",
     *      "Mitochondrion") never appears as a heading but DOES appear
     *      in the body, so each block lands next to the prose that
     *      talks about it instead of clustering under whichever
     *      heading happens to be first. Returned as `{ kind: "content" }`.
     *
     *   3. No match — returns `null`. Callers handle this — the marker
     *      / append-after primitives drop the block at the TOP of the
     *      entity rather than dumping at the end. Plain "Append" is
     *      the only action that intentionally lands at the end.
     *
     * Returning `null` instead of falling back to "first heading" is
     * what broke the old "every glossary term lands under the first
     * heading" clustering bug — the scorer used to initialise
     * `bestHeading = entityHeadings[0]` and never reset it, so any
     * block whose keywords missed every heading ended up at index 0.
     */
    static #findRelevantAnchor(parsedBody, topicSource)
    {
        const matchKeywords = AskAiActionDispatcher.#extractKeywords(topicSource);
        if (matchKeywords.length === 0)
        {
            return null;
        }

        // 1. Score every heading.
        const entityHeadings = Array.from(parsedBody.querySelectorAll(AskAiActionDispatcher.#SECTION_HEADING_SELECTOR));
        let bestHeading = null;
        let bestHeadingScore = 0;
        for (const entityHeading of entityHeadings)
        {
            const score = AskAiActionDispatcher.#scoreKeywordMatches(entityHeading.textContent || "", matchKeywords);
            if (score > bestHeadingScore)
            {
                bestHeadingScore = score;
                bestHeading      = entityHeading;
            }
        }
        if (bestHeading)
        {
            return { element: bestHeading, kind: "heading" };
        }

        // 2. Fall back to body content. Walk in document order so two
        //    elements at the same score resolve to the first occurrence
        //    — feels natural to the learner (top-to-bottom reading).
        const contentElements = Array.from(parsedBody.querySelectorAll("p, li, td, blockquote, pre"));
        let bestContent = null;
        let bestContentScore = 0;
        for (const contentElement of contentElements)
        {
            // Skip <li> inside an <li> we already scored — pick the
            // innermost match so the block sits as close to the
            // relevant text as possible. (querySelectorAll returns
            // descendants in tree order, so we natively visit outer
            // first; tie-break on strict-greater keeps the outer.
            // That's the desired behaviour: a term mentioned inside a
            // nested list item still anchors the outer line so the
            // block can sit at the boundary of the parent list item.)
            const score = AskAiActionDispatcher.#scoreKeywordMatches(contentElement.textContent || "", matchKeywords);
            if (score > bestContentScore)
            {
                bestContentScore = score;
                bestContent      = contentElement;
            }
        }
        if (bestContent)
        {
            return { element: bestContent, kind: "content" };
        }

        return null;
    }

    /**
     * Count how many of `matchKeywords` appear as substrings of
     * `rawText`. Substring rather than word-boundary so plural/-ies
     * forms still catch ("mitochondrion" → matches inside
     * "mitochondria" — well, technically the other way, but partial
     * matches buy more recall than they cost in precision for the
     * anchor-selection use case).
     */
    static #scoreKeywordMatches(rawText, matchKeywords)
    {
        if (!rawText || !matchKeywords || matchKeywords.length === 0)
        {
            return 0;
        }
        const lowered = String(rawText).toLowerCase();
        let score = 0;
        for (const keyword of matchKeywords)
        {
            if (lowered.includes(keyword))
            {
                score += 1;
            }
        }
        return score;
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

    /**
     * Build the neutral-wrapper HTML used by the two Append actions.
     * The wrapper is intentionally style-free (see AskAiDialog.css) so
     * the appended content reads as part of the entity, but we still
     * emit it with a class and stable identifiers so the AskAiInjectedBlock
     * delete delegation can locate and remove the block on demand.
     */
    static #buildInlineBlockHtml(entity, renderedHtml, userQuery, bIsAskMode)
    {
        const owningDeck = entity?.getDeck?.();
        const deckId     = owningDeck?.getId?.() || "";
        const injectionId = getRandomUuid();

        let innerHtml;
        if (bIsAskMode && userQuery)
        {
            const safeQuestion = AskAiActionDispatcher.#escapeHtmlContent(userQuery);
            innerHtml = `<h3>Q: ${safeQuestion}</h3>${renderedHtml || ""}`;
        }
        else
        {
            innerHtml = renderedHtml || "";
        }

        return AskAiInjectedBlock.buildWrapperHtml(
        {
            injectionId: injectionId,
            deckId:      deckId,
            innerHtml:   innerHtml,
        });
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
     * Scoping note: queries run against the CURRENTLY-VISIBLE
     * <study-page> via PageNavigator.getCurrentPage(). A bare
     * document.querySelector("study-page") would match the FIRST
     * study-page in DOM order, but PageNavigator hides previous
     * pages with `display: none` rather than removing them — so
     * after the user has opened more than one study session in a
     * row, the oldest hidden instance is still first in the DOM
     * and the refresh would land on it instead of the on-screen
     * one (symptom: "insert / append doesn't update until I view
     * it again", since the active session only re-reads
     * entity.get*() on next/previous/show-answer/onPageResumed).
     */
    static #refreshEntityRendering(entity)
    {
        const currentPage = PageNavigator.getCurrentPage?.();
        const studyPageElement = (currentPage && currentPage.tagName?.toLowerCase() === "study-page")
            ? currentPage
            : null;
        if (!studyPageElement)
        {
            return;
        }

        if (entity instanceof Card)
        {
            const questionSection = studyPageElement.querySelector(".question-section");
            if (questionSection)
            {
                questionSection.innerHTML = HtmlSanitizer.sanitize(entity.getQuestion() || "");
            }
            const answerSection = studyPageElement.querySelector(".answer-section");
            // Only refresh the answer if it's currently revealed —
            // checking textContent (not innerHTML) so an empty
            // wrapper element doesn't fool us into thinking the
            // answer was shown.
            if (answerSection && (answerSection.textContent || "").trim().length > 0)
            {
                answerSection.innerHTML = HtmlSanitizer.sanitize(entity.getAnswer() || "");
            }
            return;
        }
        if (entity instanceof StudyMaterial)
        {
            const materialContentSection = studyPageElement.querySelector(".study-material-content-section");
            if (materialContentSection)
            {
                materialContentSection.innerHTML = HtmlSanitizer.sanitize(entity.getContent() || "");
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
