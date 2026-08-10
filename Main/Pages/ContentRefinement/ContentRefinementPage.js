import DialogBox from "../../CommonComponents/DialogBox.js";
import PageNavigator from "../../Globals/Classes/PageNavigator.js";
import HtmlSanitizer from "../../Globals/Classes/HtmlSanitizer.js";
import GenericSelection from "../../Globals/Classes/GenericSelection.js";
import GeneratedFigureIndex from "../../Globals/Classes/GeneratedFigureIndex.js";
import GeneratedVisualRenderer from "../../Globals/Classes/GeneratedVisualRenderer.js";
import RefinementProposalDialog from "../../CommonComponents/RefinementProposalDialog.js";
import ContentRefinementClient from "./Classes/ContentRefinementClient.js";
import BatchRefinementRunner from "./Classes/BatchRefinementRunner.js";
import RefinementEntityContextMenu from "./Components/RefinementEntityContextMenu.js";
import RefinementProgressOverlay from "./Components/RefinementProgressOverlay.js";
import RefinementSourceAttachment from "./Components/RefinementSourceAttachment.js";
import SyncManager from "../../Globals/Classes/SyncManager.js";
import { htmlToSearchableText } from "../../Globals/UtilityFunctions/HtmlToSearchableText.js";
import { refinementTargetKinds } from "../../Globals/Enumerations/RefinementTargetKinds.js";

/**
 * ContentRefinementPage — where a subject expert corrects generated content
 * before it is published.
 *
 * The flow is deliberately three steps and not one: pick a passage, say what is
 * wrong with it, then look at what the model proposes and decide. Nothing is
 * written until that last decision. An expert reviewing a deck they are about to
 * sell needs to see the change, not be told one was made.
 *
 * The page lists the deck's own study materials and cards plus everything in its
 * sub-decks, because a reviewer thinks in terms of the unit they are checking
 * rather than the exact deck node an entity happens to sit on.
 *
 * TWO PIECES OF STATE, not one. The set of entities a refinement applies to and
 * the passage rendered on the right are separate, because the moment more than
 * one entity can be selected they stop agreeing: clicking a second row to look
 * at it would otherwise throw away the selection being built. So a plain click
 * moves both, ctrl/shift-click move only the selection, and the right-click
 * "Preview this" moves only the anchor. A reviewer correcting the same
 * systematic error across thirty cards writes the instruction once.
 *
 * Searching FILTERS rather than rebuilds. Rows are hidden and shown rather than
 * re-rendered, so a selection assembled across several search terms survives —
 * which is the whole reason to have both features on one screen.
 *
 * Withheld from purchased decks. A buyer's copy holds the seller's encrypted
 * content, which is not theirs to rewrite — their edits go to a personal overlay
 * through the ordinary editors instead. The deck menu already hides the entry
 * point; this page refuses as well, because a hidden button is UX and not a
 * constraint.
 */
class ContentRefinementPage extends HTMLElement
{
    #deck = null;
    #entities = [];
    #entityRows = [];
    #selection = null;
    #previewAnchorIndex = -1;
    #sourceAttachment = null;

    initialize(deck)
    {
        this.#deck = deck;
    }

    connectedCallback()
    {
        if (!this.#deck)
        {
            PageNavigator.back();
            return;
        }

        // The app's ONLY page-level scroller is the [page] rule in Theme.css —
        // both `html` and `body` are `overflow-y: hidden`, so an element that
        // does not carry this attribute simply overflows the viewport and is
        // clipped with no scrollbar anywhere. Every other page sets it; this one
        // did not, which is why the submit button at the bottom of a tall detail
        // column could not be reached at all.
        this.setAttribute("page", "");

        this.innerHTML = `
            <header-component title="Refine content"></header-component>
            <div class="content-refinement-page">
                <div class="content-refinement-intro">
                    Correct or extend the content in <strong>${ContentRefinementPage.#escape(this.#deck.getName())}</strong>.
                    Select one item, or several to apply the same instruction to all of them.
                    Every change is shown to you before it is applied.
                </div>
                <div class="content-refinement-layout">
                    <div class="content-refinement-list-column">
                        <div class="content-refinement-search">
                            <input type="search" class="content-refinement-search-input" data-role="entity-search"
                                placeholder="Search this deck's content…" autocomplete="off">
                            <button type="button" class="content-refinement-search-clear" data-role="clear-search" hidden>Clear</button>
                        </div>
                        <div class="content-refinement-list" data-role="entity-list"></div>
                    </div>
                    <div class="content-refinement-detail" data-role="entity-detail"></div>
                </div>
            </div>
        `;

        this.#selection = new GenericSelection(
            (rowElement) => rowElement.classList.add("is-selected"),
            (rowElement) => rowElement.classList.remove("is-selected"),
        );

        this.#entities = this.#collectEntities();
        this.#renderEntityList();
        this.#renderDetailShell();
        this.#wireSearchBar();
        this.#refreshSelectionState();
    }

    disconnectedCallback()
    {
        RefinementEntityContextMenu.removeAll();
    }

    /**
     * Every refinable entity in the deck subtree, flattened.
     *
     * getCards / getStudyMaterials are asked for THIS deck's own entities only —
     * both default to recursive, and letting that default stand while also
     * recursing here listed every entity once per ancestor. That was cosmetic
     * while one row could be selected; with a selection it is a correctness and
     * billing bug, because "select all" would submit the same entity several
     * times, pay for each, and fail the base-content check on every copy after
     * the first.
     *
     * Mock tests are deliberately absent: their content is not a single field
     * this pipeline treats as refinable, and offering the option only to fail on
     * apply would be worse than not offering it.
     */
    #collectEntities()
    {
        const collected = [];

        const walkDeck = (deck) =>
        {
            for (const studyMaterial of deck.getStudyMaterials(false))
            {
                collected.push(ContentRefinementPage.#buildEntity({
                    entityId: studyMaterial.getId(),
                    deckName: deck.getName(),
                    targetKind: refinementTargetKinds.STUDY_MATERIAL,
                    label: "Study material",
                    contentHtml: studyMaterial.getContent(),
                }));
            }

            for (const card of deck.getCards(false))
            {
                collected.push(ContentRefinementPage.#buildEntity({
                    entityId: card.getId(),
                    deckName: deck.getName(),
                    targetKind: refinementTargetKinds.CARD_QUESTION,
                    label: "Card — question",
                    contentHtml: card.getQuestion(),
                }));

                collected.push(ContentRefinementPage.#buildEntity({
                    entityId: card.getId(),
                    deckName: deck.getName(),
                    targetKind: refinementTargetKinds.CARD_ANSWER,
                    label: "Card — answer",
                    contentHtml: card.getAnswer(),
                }));
            }

            for (const subDeck of deck.getSubDecks())
            {
                walkDeck(subDeck);
            }
        };

        walkDeck(this.#deck);

        return collected;
    }

    /**
     * The searchable haystack is built from the FULL passage, not the truncated
     * preview line — a reviewer searching for the wrong constant is looking for
     * something that is almost never in the first hundred characters. Extraction
     * goes through htmlToSearchableText, which parses in an inert document, so a
     * generated passage carrying <img onerror> cannot fire it here.
     */
    static #buildEntity({ entityId, deckName, targetKind, label, contentHtml })
    {
        const plainText = htmlToSearchableText(contentHtml).replace(/\s+/g, " ").trim();

        return {
            entityId: entityId,
            deckName: deckName,
            targetKind: targetKind,
            label: label,
            previewText: plainText.length > 110 ? `${plainText.substring(0, 110)}…` : (plainText || "(empty)"),
            searchText: `${label} ${deckName} ${plainText}`.toLowerCase(),
            contentHtml: contentHtml,
        };
    }

    // ── Entity list ─────────────────────────────────────────────────────────

    #renderEntityList()
    {
        const listHost = this.querySelector('[data-role="entity-list"]');

        this.#selection.deselectAll();
        this.#entityRows = [];
        this.#previewAnchorIndex = -1;

        if (this.#entities.length === 0)
        {
            listHost.innerHTML = `<div class="content-refinement-empty">This deck has no study materials or cards to refine.</div>`;
            return;
        }

        listHost.innerHTML = this.#entities.map((entity, entityIndex) => `
            <button type="button" class="content-refinement-entity" data-entity-index="${entityIndex}">
                <span class="content-refinement-entity-label">${ContentRefinementPage.#escape(entity.label)}</span>
                <span class="content-refinement-entity-deck">${ContentRefinementPage.#escape(entity.deckName)}</span>
                <span class="content-refinement-entity-preview">${ContentRefinementPage.#escape(entity.previewText)}</span>
            </button>
        `).join("");

        this.#entityRows = Array.from(listHost.querySelectorAll(".content-refinement-entity"));

        for (const entityRow of this.#entityRows)
        {
            entityRow.addEventListener("click", (clickEvent) => this.#handleRowClick(entityRow, clickEvent));

            entityRow.addEventListener("contextmenu", (contextMenuEvent) =>
            {
                contextMenuEvent.preventDefault();
                contextMenuEvent.stopPropagation();

                RefinementEntityContextMenu.create(
                    { x: contextMenuEvent.clientX, y: contextMenuEvent.clientY },
                    entityRow,
                    this,
                );
            });
        }
    }

    /**
     * Plain click replaces the selection AND moves the preview. Ctrl and shift
     * change the selection only — moving the preview while a range is being
     * assembled would make the right-hand pane flicker through passages nobody
     * asked to read.
     */
    #handleRowClick(entityRow, clickEvent)
    {
        if (clickEvent.ctrlKey || clickEvent.metaKey)
        {
            this.#selection.toggleSelection([entityRow]);
        }
        else if (clickEvent.shiftKey)
        {
            const visibleRows = this.getVisibleRows();
            const lastSelectedRow = this.#selection.getLastSelectedItem();
            const indexOfLastSelection = visibleRows.indexOf(lastSelectedRow);
            const indexOfThisRow = visibleRows.indexOf(entityRow);

            if (indexOfLastSelection === -1 || indexOfThisRow === -1)
            {
                this.#selection.addSelection([entityRow]);
            }
            else
            {
                // The range spans VISIBLE rows only. Drawn across the raw row
                // list it would silently pick up entities the current search
                // term is hiding, which the reviewer cannot see to check.
                const rangeStart = Math.min(indexOfLastSelection, indexOfThisRow);
                const rangeEnd = Math.max(indexOfLastSelection, indexOfThisRow);
                this.#selection.addSelection(visibleRows.slice(rangeStart, rangeEnd + 1));
            }
        }
        else
        {
            this.#selection.deselectAll();
            this.#selection.addSelection([entityRow]);
            this.setPreviewAnchor(Number(entityRow.dataset.entityIndex));
            return;
        }

        this.#refreshSelectionState();
    }

    // ── Search ──────────────────────────────────────────────────────────────

    #wireSearchBar()
    {
        const searchInput = this.querySelector('[data-role="entity-search"]');
        const clearButton = this.querySelector('[data-role="clear-search"]');

        searchInput.addEventListener("input", () => this.#applySearchFilter(searchInput.value));

        clearButton.addEventListener("click", () =>
        {
            searchInput.value = "";
            this.#applySearchFilter("");
            searchInput.focus();
        });
    }

    /**
     * Hides and shows existing rows rather than re-rendering the list. Rebuilding
     * would destroy the row elements the selection is held against, so every
     * keystroke would silently drop a selection the reviewer had spent a minute
     * assembling.
     */
    #applySearchFilter(searchTerm)
    {
        const normalizedSearchTerm = String(searchTerm || "").trim().toLowerCase();

        this.querySelector('[data-role="clear-search"]').hidden = normalizedSearchTerm.length === 0;

        for (const entityRow of this.#entityRows)
        {
            const entity = this.#entities[Number(entityRow.dataset.entityIndex)];
            entityRow.hidden = normalizedSearchTerm.length > 0 && !entity.searchText.includes(normalizedSearchTerm);
        }
    }

    #getSearchTerm()
    {
        const searchInput = this.querySelector('[data-role="entity-search"]');
        return searchInput ? searchInput.value : "";
    }

    // ── Surface used by RefinementEntityContextMenu ──────────────────────────

    getSelection()
    {
        return this.#selection;
    }

    getVisibleRows()
    {
        return this.#entityRows.filter(entityRow => !entityRow.hidden);
    }

    /**
     * Moves the preview WITHOUT touching the selection. This is the whole point
     * of the right-click entry: with several entities selected there is no way
     * to look at one of them by clicking, because clicking is what selects.
     */
    setPreviewAnchor(entityIndex)
    {
        this.#previewAnchorIndex = Number.isInteger(entityIndex) ? entityIndex : -1;

        for (const entityRow of this.#entityRows)
        {
            entityRow.classList.toggle("is-preview-anchor", Number(entityRow.dataset.entityIndex) === this.#previewAnchorIndex);
        }

        this.#renderPreview();
        this.#renderFigureSection();
        this.#refreshSelectionState();
    }

    clearSelection()
    {
        this.#selection.deselectAll();
        this.#refreshSelectionState();
    }

    refreshSelectionState()
    {
        this.#refreshSelectionState();
    }

    // ── Detail pane ─────────────────────────────────────────────────────────

    /**
     * Built ONCE. The instruction textarea and the attached source have to
     * outlive a change of preview — with a selection open the anchor moves while
     * an instruction is being composed, and re-rendering the whole pane the way
     * the single-selection version did would throw away both.
     */
    #renderDetailShell()
    {
        const detailHost = this.querySelector('[data-role="entity-detail"]');

        detailHost.innerHTML = `
            <div class="content-refinement-preview refinement-rendered-passage" data-role="content-preview"></div>

            <div class="content-refinement-section">
                <div class="content-refinement-selection-summary" data-role="selection-summary"></div>
                <h3>What should change?</h3>
                <textarea class="content-refinement-instruction" data-role="instruction" rows="4"
                    placeholder="e.g. The stated value of the gas constant is wrong — it should be 8.314 J/(mol K). Or: add a paragraph on hybrid deployment models, which the exam covers."></textarea>
                <div data-role="source-attachment"></div>
                <button type="button" class="content-refinement-submit" data-role="refine-text">Suggest a change</button>
            </div>

            <div data-role="figure-section"></div>
        `;

        this.#sourceAttachment = new RefinementSourceAttachment();
        this.#sourceAttachment.mount(detailHost.querySelector('[data-role="source-attachment"]'));

        detailHost.querySelector('[data-role="refine-text"]')
            .addEventListener("click", () => this.#requestTextRefinement());

        this.#renderPreview();
    }

    #renderPreview()
    {
        const previewHost = this.querySelector('[data-role="content-preview"]');
        const anchorEntity = this.#getPreviewAnchorEntity();

        if (anchorEntity === null)
        {
            previewHost.innerHTML = `<div class="content-refinement-empty">Pick a study material or card on the left to start.</div>`;
            return;
        }

        previewHost.innerHTML = HtmlSanitizer.sanitize(anchorEntity.contentHtml);

        // Diagrams in the preview need their libraries driven, exactly as they
        // are during study — otherwise a Mermaid figure shows as source text and
        // a SMILES structure as an empty span.
        GeneratedVisualRenderer.render(previewHost);
    }

    #getPreviewAnchorEntity()
    {
        return this.#previewAnchorIndex >= 0 ? (this.#entities[this.#previewAnchorIndex] || null) : null;
    }

    /**
     * The entities a refinement would apply to, in list order rather than in the
     * order they happened to be clicked, so a batch reads down the screen.
     */
    #getSelectedEntities()
    {
        return this.#entityRows
            .filter(entityRow => this.#selection.contains(entityRow))
            .map(entityRow => this.#entities[Number(entityRow.dataset.entityIndex)]);
    }

    #refreshSelectionState()
    {
        const summaryHost = this.querySelector('[data-role="selection-summary"]');
        const submitButton = this.querySelector('[data-role="refine-text"]');

        if (!summaryHost || !submitButton)
        {
            return;
        }

        const selectionCount = this.#selection.getSelectionCount();
        const anchorEntity = this.#getPreviewAnchorEntity();

        submitButton.disabled = selectionCount === 0;
        submitButton.textContent = selectionCount > 1 ? `Suggest changes for ${selectionCount} items` : "Suggest a change";

        if (selectionCount === 0)
        {
            summaryHost.innerHTML = `<span class="content-refinement-selection-count">Nothing selected</span>`;
            return;
        }

        const previewingLine = anchorEntity
            ? ` — previewing <strong>${ContentRefinementPage.#escape(anchorEntity.label)} · ${ContentRefinementPage.#escape(anchorEntity.deckName)}</strong>`
            : "";

        summaryHost.innerHTML = `
            <span class="content-refinement-selection-count">${selectionCount} item${selectionCount === 1 ? "" : "s"} selected${previewingLine}</span>
            <button type="button" class="content-refinement-selection-clear" data-role="clear-selection">Clear</button>
        `;

        summaryHost.querySelector('[data-role="clear-selection"]')
            .addEventListener("click", () => this.clearSelection());
    }

    /**
     * Figures belong to ONE passage — a figure ordinal has no meaning across a
     * selection, and the address a visual refinement is built from names a single
     * entity. So the section is offered only when exactly one entity is selected
     * and it is the one on screen.
     */
    #renderFigureSection()
    {
        const figureHost = this.querySelector('[data-role="figure-section"]');

        if (!figureHost)
        {
            return;
        }

        const anchorEntity = this.#getPreviewAnchorEntity();

        if (anchorEntity === null)
        {
            figureHost.innerHTML = "";
            return;
        }

        const figures = GeneratedFigureIndex.listFigures(anchorEntity.contentHtml);

        if (figures.length === 0)
        {
            figureHost.innerHTML = "";
            return;
        }

        if (this.#selection.getSelectionCount() > 1)
        {
            figureHost.innerHTML = `
                <div class="content-refinement-section">
                    <h3>Diagrams in this passage</h3>
                    <div class="content-refinement-figure-note">
                        Diagram changes apply to one passage at a time. Select just this item to work on its figures.
                    </div>
                </div>
            `;
            return;
        }

        figureHost.innerHTML = ContentRefinementPage.#buildFigureSectionMarkup(figures);

        figureHost.querySelectorAll("[data-figure-action]").forEach((figureButton) =>
        {
            figureButton.addEventListener("click", () => this.#requestVisualRefinement(
                anchorEntity,
                figures[Number(figureButton.dataset.figureOrdinal)],
                figureButton.dataset.figureAction,
            ));
        });
    }

    static #buildFigureSectionMarkup(figures)
    {
        const figureRows = figures.map(figure => `
            <div class="content-refinement-figure">
                <div class="content-refinement-figure-heading">
                    Figure ${figure.ordinal + 1}${figure.bIsComposite ? ` (${figure.panelCount}-panel plate)` : ""}
                    ${figure.method ? `<span class="content-refinement-figure-method">${ContentRefinementPage.#escape(figure.method)}</span>` : ""}
                </div>
                <div class="content-refinement-figure-caption">${ContentRefinementPage.#escape(figure.captionText || "(no caption)")}</div>
                <div class="content-refinement-figure-actions">
                    <button type="button" data-figure-action="REFINE" data-figure-ordinal="${figure.ordinal}">Refine</button>
                    <button type="button" data-figure-action="REPLACE" data-figure-ordinal="${figure.ordinal}">Replace</button>
                    <button type="button" data-figure-action="REMOVE" data-figure-ordinal="${figure.ordinal}">Remove</button>
                </div>
            </div>
        `).join("");

        return `
            <div class="content-refinement-section">
                <h3>Diagrams in this passage</h3>
                <div class="content-refinement-figure-note">
                    A redrawn diagram is checked by a vision model against the description it was drawn from,
                    the same way the original was, and you see the verdict before you accept it.
                </div>
                ${figureRows}
            </div>
        `;
    }

    // ── Refinement ──────────────────────────────────────────────────────────

    async #requestTextRefinement()
    {
        const instruction = this.querySelector('[data-role="instruction"]').value.trim();
        const selectedEntities = this.#getSelectedEntities();

        if (selectedEntities.length === 0)
        {
            await DialogBox.alert("Nothing selected", "Pick at least one study material or card on the left.");
            return;
        }

        if (instruction.length === 0)
        {
            await DialogBox.alert("Nothing to do", "Describe what should change first.");
            return;
        }

        const submitButton = this.querySelector('[data-role="refine-text"]');
        const originalButtonLabel = submitButton.textContent;
        submitButton.disabled = true;

        try
        {
            // Progress is the overlay's job now, not this button's. The label
            // was the only signal the flow had, and it lived on the control that
            // is furthest down a column that can be scrolled away from.
            const runOutcome = await BatchRefinementRunner.run({
                entities: selectedEntities,
                instruction: instruction,
                subjectName: this.#deck.getName(),
                sourceAttachment: this.#sourceAttachment,
            });

            if (runOutcome.appliedCount > 0)
            {
                await this.#reloadAfterApply();
            }

            await BatchRefinementRunner.reportOutcome(runOutcome);
        }
        catch (refinementError)
        {
            // The runner already absorbs every per-item refusal, so anything
            // arriving here failed the run as a whole — a sync that could not
            // complete, most often. Reported through the same ladder rather than
            // left as an unhandled rejection with the button stuck on "Refining".
            await ContentRefinementClient.explainFailure(refinementError);
        }
        finally
        {
            submitButton.textContent = originalButtonLabel;
            this.#refreshSelectionState();
        }
    }

    async #requestVisualRefinement(anchorEntity, figure, action)
    {
        let description = "";
        let visualKind = figure.method || "";

        if (action !== "REMOVE")
        {
            description = await DialogBox.prompt(
                action === "REFINE" ? "What is wrong with this diagram?" : "What should the new diagram show?",
                "Describe what the figure must show, naming the objects and everything that has to be labelled.",
                "text",
            );

            if (!description)
            {
                return;
            }

            visualKind = await ContentRefinementClient.promptForVisualKind(figure.method);

            if (!visualKind)
            {
                return;
            }
        }
        else
        {
            const bConfirmed = await DialogBox.confirm(
                "Remove this figure?",
                `Figure ${figure.ordinal + 1} will be taken out of the passage. You will see the result before it is applied.`,
            );

            if (!bConfirmed)
            {
                return;
            }
        }

        // The longest wait in the whole feature — the visual worker's timeout is
        // five minutes against the text worker's two, because a diagram is
        // generated, rasterised AND reviewed by a vision model — and until now
        // it was the one path that showed nothing at all while it ran.
        const progressOverlay = new RefinementProgressOverlay();
        progressOverlay.open({ totalCount: 1, bAllowStop: false });

        try
        {
            progressOverlay.setStatus({ statusText: "Fetching the latest copy…" });

            // Sync BEFORE asking, so the proposal is built from the newest copy
            // the server holds. Without this a proposal can be generated against
            // content another device has already replaced, and the apply then
            // fails the base-content check for a reason the reviewer cannot see.
            await SyncManager.sync();

            progressOverlay.setStatus({
                statusText: action === "REMOVE" ? "Removing the diagram…" : "Drawing and reviewing the diagram…",
                entityLabel: `Figure ${figure.ordinal + 1}`,
            });

            const proposal = await ContentRefinementClient.proposeVisualRevision({
                entityId: anchorEntity.entityId,
                targetKind: anchorEntity.targetKind,
                action: action,
                ...GeneratedFigureIndex.buildAddress(figure),
                description: description,
                visualKind: visualKind,
                captionText: figure.captionText,
                subjectName: this.#deck.getName(),
                topicChain: [anchorEntity.deckName],
            });

            progressOverlay.close();

            const reviewOutcome = await RefinementProposalDialog.show(proposal, {
                bVisualComparison: true,
                onApply: async () => await ContentRefinementClient.applyProposal({
                    proposal: proposal,
                    instruction: description,
                    informationSourceId: this.#sourceAttachment ? this.#sourceAttachment.getInformationSourceId() : "",
                    referenceSourceUrl: this.#sourceAttachment ? this.#sourceAttachment.getReferenceUrl() : "",
                }),
            });

            if (reviewOutcome.result !== RefinementProposalDialog.RESULT_APPLIED)
            {
                return;
            }

            await this.#reloadAfterApply();
            await DialogBox.alert("Applied", "The change has been applied and recorded.");
        }
        catch (refinementError)
        {
            await ContentRefinementClient.explainFailure(refinementError);
        }
        finally
        {
            // Already closed on the happy path; idempotent, and here so a
            // failure cannot leave a modal overlay covering its own dialog.
            progressOverlay.close();
        }
    }

    /**
     * Pulls the applied change straight back down rather than waiting for the
     * five-minute sync cycle, so the passage on screen matches what was just
     * written and a second refinement starts from the new text. The search term
     * is deliberately re-applied: a reviewer working through a filtered list
     * should not be dropped back into the whole deck after every apply.
     */
    async #reloadAfterApply()
    {
        await SyncManager.sync();

        const searchTerm = this.#getSearchTerm();

        this.#entities = this.#collectEntities();
        this.#renderEntityList();
        this.#applySearchFilter(searchTerm);
        this.setPreviewAnchor(-1);
    }

    static #escape(rawValue)
    {
        return String(rawValue ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }
}

customElements.define("content-refinement-page", ContentRefinementPage);

export default ContentRefinementPage;
