import Deck from "../../Globals/Model/Deck.js";
import DialogBox from "../../CommonComponents/DialogBox.js";
import PageNavigator from "../../Globals/Classes/PageNavigator.js";
import HtmlSanitizer from "../../Globals/Classes/HtmlSanitizer.js";
import GeneratedFigureIndex from "../../Globals/Classes/GeneratedFigureIndex.js";
import GeneratedVisualRenderer from "../../Globals/Classes/GeneratedVisualRenderer.js";
import RefinementProposalDialog from "../../CommonComponents/RefinementProposalDialog.js";
import ContentRefinementClient from "./Classes/ContentRefinementClient.js";
import RefinementSourceAttachment from "./Components/RefinementSourceAttachment.js";
import SyncManager from "../../Globals/Classes/SyncManager.js";
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
    #selectedEntity = null;
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

        this.innerHTML = `
            <header-component title="Refine content"></header-component>
            <div class="content-refinement-page">
                <div class="content-refinement-intro">
                    Correct or extend the content in <strong>${ContentRefinementPage.#escape(this.#deck.getName())}</strong>.
                    Every change is shown to you before it is applied.
                </div>
                <div class="content-refinement-layout">
                    <div class="content-refinement-list" data-role="entity-list"></div>
                    <div class="content-refinement-detail" data-role="entity-detail"></div>
                </div>
            </div>
        `;

        this.#entities = this.#collectEntities();
        this.#renderEntityList();
        this.#renderEmptyDetail();
    }

    /**
     * Every refinable entity in the deck subtree, flattened.
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
            for (const studyMaterial of deck.getStudyMaterials())
            {
                collected.push({
                    entityId: studyMaterial.getId(),
                    deckName: deck.getName(),
                    targetKind: refinementTargetKinds.STUDY_MATERIAL,
                    label: "Study material",
                    previewText: ContentRefinementPage.#buildPreview(studyMaterial.getContent()),
                    contentHtml: studyMaterial.getContent(),
                });
            }

            for (const card of deck.getCards())
            {
                collected.push({
                    entityId: card.getId(),
                    deckName: deck.getName(),
                    targetKind: refinementTargetKinds.CARD_QUESTION,
                    label: "Card — question",
                    previewText: ContentRefinementPage.#buildPreview(card.getQuestion()),
                    contentHtml: card.getQuestion(),
                });

                collected.push({
                    entityId: card.getId(),
                    deckName: deck.getName(),
                    targetKind: refinementTargetKinds.CARD_ANSWER,
                    label: "Card — answer",
                    previewText: ContentRefinementPage.#buildPreview(card.getAnswer()),
                    contentHtml: card.getAnswer(),
                });
            }

            for (const subDeck of deck.getSubDecks())
            {
                walkDeck(subDeck);
            }
        };

        walkDeck(this.#deck);

        return collected;
    }

    #renderEntityList()
    {
        const listHost = this.querySelector('[data-role="entity-list"]');

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

        listHost.querySelectorAll(".content-refinement-entity").forEach((entityButton) =>
        {
            entityButton.addEventListener("click", () =>
            {
                listHost.querySelectorAll(".content-refinement-entity")
                    .forEach(otherButton => otherButton.classList.remove("is-selected"));
                entityButton.classList.add("is-selected");

                this.#selectedEntity = this.#entities[Number(entityButton.dataset.entityIndex)];
                this.#renderDetail();
            });
        });
    }

    #renderEmptyDetail()
    {
        this.querySelector('[data-role="entity-detail"]').innerHTML =
            `<div class="content-refinement-empty">Pick a study material or card on the left to start.</div>`;
    }

    #renderDetail()
    {
        const detailHost = this.querySelector('[data-role="entity-detail"]');
        const figures = GeneratedFigureIndex.listFigures(this.#selectedEntity.contentHtml);

        detailHost.innerHTML = `
            <div class="content-refinement-preview" data-role="content-preview">
                ${HtmlSanitizer.sanitize(this.#selectedEntity.contentHtml)}
            </div>

            <div class="content-refinement-section">
                <h3>What should change?</h3>
                <textarea class="content-refinement-instruction" data-role="instruction" rows="4"
                    placeholder="e.g. The stated value of the gas constant is wrong — it should be 8.314 J/(mol K). Or: add a paragraph on hybrid deployment models, which the exam covers."></textarea>
                <div data-role="source-attachment"></div>
                <button type="button" class="content-refinement-submit" data-role="refine-text">Suggest a change</button>
            </div>

            ${ContentRefinementPage.#buildFigureSectionMarkup(figures)}
        `;

        // Diagrams in the preview need their libraries driven, exactly as they
        // are during study — otherwise a Mermaid figure shows as source text and
        // a SMILES structure as an empty span.
        GeneratedVisualRenderer.render(detailHost.querySelector('[data-role="content-preview"]'));

        this.#sourceAttachment = new RefinementSourceAttachment();
        this.#sourceAttachment.mount(detailHost.querySelector('[data-role="source-attachment"]'));

        detailHost.querySelector('[data-role="refine-text"]')
            .addEventListener("click", () => this.#requestTextRefinement());

        detailHost.querySelectorAll("[data-figure-action]").forEach((figureButton) =>
        {
            figureButton.addEventListener("click", () => this.#requestVisualRefinement(
                figures[Number(figureButton.dataset.figureOrdinal)],
                figureButton.dataset.figureAction,
            ));
        });
    }

    static #buildFigureSectionMarkup(figures)
    {
        if (figures.length === 0)
        {
            return "";
        }

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

    async #requestTextRefinement()
    {
        const instruction = this.querySelector('[data-role="instruction"]').value.trim();

        if (instruction.length === 0)
        {
            await DialogBox.alert("Nothing to do", "Describe what should change first.");
            return;
        }

        const submitButton = this.querySelector('[data-role="refine-text"]');
        submitButton.disabled = true;
        submitButton.textContent = "Thinking…";

        try
        {
            // Sync BEFORE asking, so the proposal is built from the newest copy
            // the server holds. Without this a proposal can be generated against
            // content another device has already replaced, and the apply then
            // fails the base-content check for a reason the reviewer cannot see.
            await SyncManager.sync();

            const proposal = await ContentRefinementClient.proposeContentRevision({
                entityId: this.#selectedEntity.entityId,
                targetKind: this.#selectedEntity.targetKind,
                instruction: instruction,
                subjectName: this.#deck.getName(),
                topicChain: [this.#selectedEntity.deckName],
                informationSourceId: this.#sourceAttachment.getInformationSourceId(),
                referenceSourceUrl: this.#sourceAttachment.getReferenceUrl(),
            });

            await this.#reviewProposal(proposal, instruction, false);
        }
        catch (refinementError)
        {
            await ContentRefinementClient.explainFailure(refinementError);
        }
        finally
        {
            submitButton.disabled = false;
            submitButton.textContent = "Suggest a change";
        }
    }

    async #requestVisualRefinement(figure, action)
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

        try
        {
            await SyncManager.sync();

            const proposal = await ContentRefinementClient.proposeVisualRevision({
                entityId: this.#selectedEntity.entityId,
                targetKind: this.#selectedEntity.targetKind,
                action: action,
                ...GeneratedFigureIndex.buildAddress(figure),
                description: description,
                visualKind: visualKind,
                captionText: figure.captionText,
                subjectName: this.#deck.getName(),
                topicChain: [this.#selectedEntity.deckName],
            });

            await this.#reviewProposal(proposal, description, true);
        }
        catch (refinementError)
        {
            await ContentRefinementClient.explainFailure(refinementError);
        }
    }

    async #reviewProposal(proposal, instruction, bVisualComparison)
    {
        const reviewOutcome = await RefinementProposalDialog.show(proposal, {
            bVisualComparison: bVisualComparison,
            onApply: async () => await ContentRefinementClient.applyProposal({
                proposal: proposal,
                instruction: instruction,
                informationSourceId: this.#sourceAttachment ? this.#sourceAttachment.getInformationSourceId() : "",
                referenceSourceUrl: this.#sourceAttachment ? this.#sourceAttachment.getReferenceUrl() : "",
            }),
        });

        if (reviewOutcome.result !== RefinementProposalDialog.RESULT_APPLIED)
        {
            return;
        }

        // Pull the applied change straight back down rather than waiting for the
        // five-minute sync cycle, so the passage on screen matches what was just
        // written and a second refinement starts from the new text.
        await SyncManager.sync();

        this.#entities = this.#collectEntities();
        this.#renderEntityList();
        this.#renderEmptyDetail();
        this.#selectedEntity = null;

        await DialogBox.alert("Applied", "The change has been applied and recorded.");
    }

    static #buildPreview(contentValue)
    {
        const parsedDocument = new DOMParser().parseFromString(contentValue || "", "text/html");
        parsedDocument.querySelectorAll("figure").forEach(figureElement => figureElement.remove());

        const plainText = (parsedDocument.body.textContent || "").replace(/\s+/g, " ").trim();

        return plainText.length > 110 ? `${plainText.substring(0, 110)}…` : (plainText || "(empty)");
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
