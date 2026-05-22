import DialogBox from "../../CommonComponents/DialogBox.js";
import { dataFormats } from "../../Globals/Enumerations/DataFormats.js";
import DeckEvents from "../../Globals/Events/DeckEvents.js";
import Deck from "../../Globals/Model/Deck.js";
import Lifecycle from "../../Globals/Model/Lifecycle.js";
import PageNavigator from "../../Globals/Classes/PageNavigator.js";
import Persistence from "../../Globals/Classes/Persistence.js";
import ActiveEntityTracker from "../../Globals/Classes/ActiveEntityTracker.js";
import { entityTypes } from "../../Globals/Enumerations/EntityTypes.js";
import TutorialEngine from "../../Globals/Classes/TutorialEngine.js";
import AutoAnalysisDeckFields from "../../Globals/Classes/Analysis/AutoAnalysisDeckFields.js";
import StudyMaterial from "../../Globals/Model/StudyMaterial.js";
import AiFeatureGate from "../../Globals/Classes/AiFeatureGate.js";

class DeckEditorPage extends HTMLElement
{
    #deck = null;
    #bNewDeck = false;
    #bCommitted = false;
    #pendingParent = null;
    #originalValues = {};

    /**
     * Initializes a DeckEditorPage element with the given deck.
     * @param {Deck} deck - The deck to associate with the DeckEditorPage.
     */
    initialize(deck, parent = null)
    {
        this.#deck = deck;

        // For a brand-new deck, construct the in-memory Deck with a null
        // parent so the constructor does NOT auto-attach it to the
        // parent's subDecks list. The intended parent is stashed on
        // #pendingParent and only wired in on Save. Without this, any
        // non-Cancel exit (header back button, hardware back, navigating
        // elsewhere) would leave a phantom empty deck attached to the
        // parent's subDecks list.
        if (this.#deck == null)
        {
            this.#deck = new Deck(Deck.generateId(), "", "", [], [], new Lifecycle(), [], [], [], null, {});
            this.#bNewDeck = true;
            this.#pendingParent = parent;
        }

        this.#originalValues =
        {
            name: this.#deck.getName(),
            shortName: this.#deck.getShortName(),
            tags: this.#deck.getTags(),
            parentId: this.#bNewDeck ? (this.#pendingParent?.getId() || null) : this.#deck.getParent()?.getId()
        };
    }

    #fillInputs()
    {
        const deckNameInput = this.querySelector(".deck-name-input");
        const deckShortNameInput = this.querySelector(".deck-short-name-input");
        const deckTagsInput = this.querySelector(".deck-tags-input");
        const deckParentInput = this.querySelector(".deck-parent-input");
        const autoPerformanceAnalysisInput = this.querySelector(".deck-auto-performance-analysis-input");
        const autoGenerateCuratedStudyInput = this.querySelector(".deck-auto-generate-curated-study-input");

        deckNameInput.value = this.#deck.getName();
        deckShortNameInput.value = this.#deck.getShortName();
        deckTagsInput.value = this.#deck.getTags().join(",");

        const additionalData = this.#deck.getAdditionalData() || {};
        autoPerformanceAnalysisInput.checked = additionalData[AutoAnalysisDeckFields.AUTO_PERFORMANCE_ANALYSIS_ENABLED] === true;
        autoGenerateCuratedStudyInput.checked = additionalData[AutoAnalysisDeckFields.AUTO_GENERATE_CURATED_STUDY_ENABLED] === true;

        const filter = (deck) =>
        {
            return (deck.getId() != this.#deck.getId()) && (!this.#deck.isParentOf(deck, true));
        };

        const currentParentId = this.#bNewDeck
            ? (this.#pendingParent?.getId() || Deck.getRoot().getId())
            : this.#deck.getParent().getId();

        Deck.configureSearchableSelector(deckParentInput, filter, Deck.getRoot(), currentParentId, "Select parent...");
    }

    /**
     * Removes the study materials referenced by the deck's curated and archived
     * curated arrays. Called from the "Clear Analysis Data" button so wiping
     * cached topic results also reclaims the disk space used by the materials.
     */
    async #removeCuratedStudyMaterials()
    {
        const additionalData = this.#deck.getAdditionalData() || {};
        const liveIds = Array.isArray(additionalData[AutoAnalysisDeckFields.CURATED_STUDY_MATERIAL_IDS])
            ? additionalData[AutoAnalysisDeckFields.CURATED_STUDY_MATERIAL_IDS]
            : [];
        const archivedIds = Array.isArray(additionalData[AutoAnalysisDeckFields.ARCHIVED_CURATED_STUDY_MATERIAL_IDS])
            ? additionalData[AutoAnalysisDeckFields.ARCHIVED_CURATED_STUDY_MATERIAL_IDS]
            : [];

        const targetIds = new Set([...liveIds, ...archivedIds]);
        if (targetIds.size === 0)
        {
            return;
        }

        const materials = this.#deck.getStudyMaterials(true);
        const deletions = [];
        for (const material of materials)
        {
            if (targetIds.has(material.getId()))
            {
                deletions.push(material.delete());
            }
        }

        if (deletions.length > 0)
        {
            await Promise.all(deletions);
        }
    }

    #handleEvents()
    {
        const cancelButton = this.querySelector(".deck-cancel-input");
        const saveButton = this.querySelector(".deck-save-input");
        const parentInput = this.querySelector(".deck-parent-input");
        const nameInput = this.querySelector(".deck-name-input");
        const shortNameInput = this.querySelector(".deck-short-name-input");
        const tagsInput = this.querySelector(".deck-tags-input");
        const deleteButton = this.querySelector(".deck-delete-input");
        const resetProgressButton = this.querySelector(".deck-reset-progress-input");
        const autoPerformanceAnalysisInput = this.querySelector(".deck-auto-performance-analysis-input");
        const autoGenerateCuratedStudyInput = this.querySelector(".deck-auto-generate-curated-study-input");
        const clearAnalysisDataButton = this.querySelector(".deck-clear-analysis-data-input");

        nameInput.addEventListener("change", () => 
        {
            this.#deck.setName(nameInput.value);
        });

        shortNameInput.addEventListener("change", () => 
        {
            this.#deck.setShortName(shortNameInput.value);
        });

        tagsInput.addEventListener("change", () => 
        {
            this.#deck.setTags(tagsInput.value.split(","));
        });

        parentInput.addEventListener("change", () =>
        {
            const chosenParent = Deck.getById(parentInput.value);

            if (this.#bNewDeck)
            {
                // Don't wire the deck into any parent's subDecks yet;
                // just remember the user's intent for the Save step.
                this.#pendingParent = chosenParent || null;
                return;
            }

            this.#deck.setParent(chosenParent);
            chosenParent?.addSubDeck(this.#deck);
        });

        deleteButton.addEventListener("click", async () => 
        {
            const confirm = await DialogBox.confirm("Delete Deck", "Are you sure you want to delete this deck? This cannot be undone.");

            if(!confirm) return;

            const deckParent = this.#deck.getParent();
            await this.#deck.delete(); 
            window.dispatchEvent(new CustomEvent(DeckEvents.DELETE, {detail: {deck: this, parent: deckParent}}));
            
            PageNavigator.back();
        });

        resetProgressButton.addEventListener("click", async () =>
        {
            const confirm = await DialogBox.confirm("Reset Progress", "Are you sure you want to reset all card progress in this deck and all its subdecks? This cannot be undone.");

            if (!confirm) return;

            const cards = this.#deck.getCards(true);

            await Promise.all(cards.map(card => card.reset()));
        });

        autoPerformanceAnalysisInput.addEventListener("change", async () =>
        {
            // Only the toggle-ON path costs LLM credits — toggle-OFF is
            // always allowed so a non-admin who somehow ended up with the
            // flag set can still disable it.
            if (autoPerformanceAnalysisInput.checked && !await AiFeatureGate.ensureAdminOrShowAlert())
            {
                autoPerformanceAnalysisInput.checked = false;
                return;
            }

            this.#deck.setAdditionalDataField(
                AutoAnalysisDeckFields.AUTO_PERFORMANCE_ANALYSIS_ENABLED,
                autoPerformanceAnalysisInput.checked
            );

            if (!autoPerformanceAnalysisInput.checked)
            {
                autoGenerateCuratedStudyInput.checked = false;
                this.#deck.setAdditionalDataField(
                    AutoAnalysisDeckFields.AUTO_GENERATE_CURATED_STUDY_ENABLED,
                    false
                );
            }
        });

        autoGenerateCuratedStudyInput.addEventListener("change", async () =>
        {
            if (autoGenerateCuratedStudyInput.checked && !await AiFeatureGate.ensureAdminOrShowAlert())
            {
                autoGenerateCuratedStudyInput.checked = false;
                return;
            }

            if (autoGenerateCuratedStudyInput.checked && !autoPerformanceAnalysisInput.checked)
            {
                autoPerformanceAnalysisInput.checked = true;
                this.#deck.setAdditionalDataField(
                    AutoAnalysisDeckFields.AUTO_PERFORMANCE_ANALYSIS_ENABLED,
                    true
                );
            }

            this.#deck.setAdditionalDataField(
                AutoAnalysisDeckFields.AUTO_GENERATE_CURATED_STUDY_ENABLED,
                autoGenerateCuratedStudyInput.checked
            );
        });

        clearAnalysisDataButton.addEventListener("click", async () =>
        {
            const confirmed = await DialogBox.confirm(
                "Clear Analysis Data",
                "This deletes all cached weak/strong topic results and all curated study materials generated for this deck (live and archived). The next eligible login will trigger a fresh analysis. Continue?"
            );

            if (!confirmed) return;

            await this.#removeCuratedStudyMaterials();

            this.#deck.setAdditionalDataField(AutoAnalysisDeckFields.LAST_ANALYZED_AT, null);
            this.#deck.setAdditionalDataField(AutoAnalysisDeckFields.LAST_ANALYSIS_TOPICS, null);
            this.#deck.setAdditionalDataField(AutoAnalysisDeckFields.CURATED_STUDY_MATERIAL_IDS, []);
            this.#deck.setAdditionalDataField(AutoAnalysisDeckFields.ARCHIVED_CURATED_STUDY_MATERIAL_IDS, []);
            this.#deck.setAdditionalDataField(AutoAnalysisDeckFields.PENDING_BATCH_REVIEW_MATERIAL_IDS, []);

            await this.#deck.save(false);

            await DialogBox.alert("Analysis Data Cleared", "All cached topic results and curated materials for this deck have been removed.");
        });

        cancelButton.addEventListener("click", async () =>
        {
            const confirm = await DialogBox.confirm("Discard Changes", "Are you sure you want to discard your changes?");

            if (!confirm) return;

            if (this.#bNewDeck)
            {
                // The new deck never attached to a parent's subDecks, so
                // a full delete() would no-op on the parent side anyway.
                // delete() also removes from Deck.#idMap and clears any
                // on-disk fragments that might have been written. Flag
                // committed BEFORE back() so onPageLeft doesn't re-delete.
                this.#bCommitted = true;
                await this.#deck.delete();
                PageNavigator.back();
                return;
            }

            this.#deck.setName(this.#originalValues.name);
            this.#deck.setShortName(this.#originalValues.shortName);
            this.#deck.setTags(this.#originalValues.tags);
            this.#deck.setParent(Deck.getById(this.#originalValues.parentId));

            const newParent = this.#deck.getParent();
            newParent?.addSubDeck(this.#deck);

            PageNavigator.back();
        });

        saveButton.addEventListener("click", async () =>
        {
            const trimmedName      = (this.#deck.getName()      || "").trim();
            const trimmedShortName = (this.#deck.getShortName() || "").trim();

            if (trimmedName.length === 0)
            {
                await DialogBox.alert("Name required", "Please enter a name for the deck before saving.");
                this.querySelector(".deck-name-input")?.focus();
                return;
            }

            if (trimmedShortName.length === 0)
            {
                await DialogBox.alert("Short name required", "Please enter a short name for the deck before saving.");
                this.querySelector(".deck-short-name-input")?.focus();
                return;
            }

            // Normalise the buffered values so leading/trailing whitespace
            // never sneaks into persisted decks.
            this.#deck.setName(trimmedName);
            this.#deck.setShortName(trimmedShortName);

            // First-time wiring of a brand-new deck into its parent's
            // subDecks list. Skipped during the edit session above so
            // that an unsaved exit leaves the parent untouched.
            if (this.#bNewDeck)
            {
                const targetParent = this.#pendingParent || Deck.getRoot();
                this.#deck.setParent(targetParent);
                targetParent.addSubDeck(this.#deck);
            }

            // Tag decks that the user creates while a tutorial is running so
            // the tutorial's "Clear all items" / "Start over" flow can find
            // and remove them later — see TutorialEntityCleanup.
            if (this.#bNewDeck && TutorialEngine.isRunning())
            {
                this.#deck.setAdditionalDataField(TutorialEngine.CREATED_DURING_TUTORIAL_KEY, true);
            }

            // Only save the files that actually changed. Previously this
            // path called grandparent.save(true) which walked and rewrote
            // every deck in the subtree, generating one ENTITY_CHANGED per
            // descendant — for users with many decks that produced a giant
            // pendingChanges set and a multi-chunk push for a single edit.
            const currentParent    = this.#deck.getParent();
            const originalParentId = this.#originalValues.parentId;
            const newParentId      = currentParent?.getId() || null;
            const bReparented      = originalParentId && originalParentId !== newParentId;

            this.#bCommitted = true;

            await this.#deck.save(false);

            // The current parent's subDecks list changed if this is a new
            // deck (added) or a reparented deck (added on the new side).
            if (currentParent && (this.#bNewDeck || bReparented))
            {
                await currentParent.save(false);
            }

            // If the deck was reparented, the original parent's subDecks
            // list also changed (it no longer references this deck).
            // Without this its on-disk file still points at the deck and
            // the next boot would re-attach the deck to the old parent.
            if (bReparented)
            {
                const originalParent = Deck.getById(originalParentId);
                if (originalParent)
                {
                    await originalParent.save(false);
                }
            }

            window.dispatchEvent(new CustomEvent(DeckEvents.UPDATE, { detail: { deck: this.#deck } }));
            PageNavigator.back();
        });


    }

    connectedCallback()
    {
        this.setAttribute("page", "");

        this.innerHTML = 
        `
            <header-component title="Deck Editor"></header-component>

            <div class="deck-editor-container">
                <div class="deck-field deck-name-container">
                    <div class="deck-field-label">Deck Name</div>
                    <input type="text" placeholder="Enter Deck Name..." maxlength="45" class="deck-field-input deck-name-input">
                </div>
                <div class="deck-field deck-short-name-container">
                    <div class="deck-field-label">Deck Short Name</div>
                    <input type="text" placeholder="Enter Deck Short Name..." maxlength="16" class="deck-field-input deck-short-name-input">
                </div>
                <div class="deck-field deck-tags-container">
                    <div class="deck-field-label">Tags (Comma Separated)</div>
                    <input type="text" placeholder="Enter Deck Tags..." class="deck-field-input deck-tags-input">
                </div>
                <div class="deck-field deck-parent-container">
                    <div class="deck-field-label">Parent</div>
                    <button type="button" class="deck-field-input deck-parent-input"></button>
                </div>
                <div style="height: 25px"></div>
                <div class="deck-field-section-label">Auto-Analysis</div>
                <div class="deck-field deck-auto-performance-analysis-container">
                    <label class="deck-field-checkbox-label">
                        <input type="checkbox" class="deck-auto-performance-analysis-input">
                        <span>Auto Performance Analysis</span>
                    </label>
                    <div class="deck-field-helper">Once a week, find the weakest and strongest topics in this deck (eligible after 10+ progress points).</div>
                </div>
                <div class="deck-field deck-auto-generate-curated-study-container">
                    <label class="deck-field-checkbox-label">
                        <input type="checkbox" class="deck-auto-generate-curated-study-input">
                        <span>Auto Generate Curated Study Material</span>
                    </label>
                    <div class="deck-field-helper">Generate one tailored study material per weak topic each week. Uses generation credits.</div>
                </div>
                <div class="deck-field deck-clear-analysis-data-container">
                    <button class="deck-field-input deck-clear-analysis-data-input">Clear Analysis Data</button>
                </div>
                <div style="height: 25px"></div>
                <div class="deck-field deck-delete-container">
                    <button class="deck-field-input deck-delete-input">Delete Deck</button>
                </div>
                <div class="deck-field deck-reset-progress-container">
                    <button class="deck-field-input deck-reset-progress-input">Reset Progress</button>
                </div>
                <div style="height: 25px"></div>
                <div class="deck-field deck-save-cancel-container">
                    <button class="deck-field-input deck-cancel-input">Cancel</button>
                    <button class="deck-field-input deck-save-input">Save</button>
                </div>
            </div>
        `;
        
        this.#fillInputs();
        this.#handleEvents();

        ActiveEntityTracker.set(this.#deck.getId(), entityTypes.DECK);
    }

    onPageResumed()
    {
        if (this.#deck)
        {
            ActiveEntityTracker.set(this.#deck.getId(), entityTypes.DECK);
        }
    }

    /**
     * Fires when PageNavigator pops this page off the stack. Cleans up a
     * brand-new deck that was never saved so it doesn't linger in
     * Deck.#idMap or carry a touched lifecycle into the next sync push.
     * The Cancel button has its own confirmation flow that runs delete()
     * directly, so #bCommitted is also true in that case (the page is
     * being popped after either Save or a confirmed Cancel discard).
     */
    onPageLeft()
    {
        if (this.#bNewDeck && !this.#bCommitted && this.#deck)
        {
            // Mirror the Cancel-flow cleanup. The deck never attached to
            // any parent's subDecks during edit, so delete() just removes
            // it from Deck.#idMap and clears any disk fragments.
            this.#deck.delete().catch((deleteError) =>
            {
                console.warn("[DeckEditorPage] Failed to clean up uncommitted deck on page-left:", deleteError);
            });
            this.#bCommitted = true;
        }
    }
}

customElements.define('deck-editor-page', DeckEditorPage);
export default DeckEditorPage;