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
import CreditNotice from "../../Globals/Classes/Credits/CreditNotice.js";
import MockTestAttemptCleaner from "../../Globals/Classes/MockTestAttemptCleaner.js";
import TaskProgressTracker from "../../Globals/Classes/Task/TaskProgressTracker.js";
import { taskStatus } from "../../Globals/Enumerations/TaskStatus.js";

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
     * Walks this deck and every descendant, then asks the server to
     * generate readable short names from the AI beautifier (same workflow
     * used by the Good Quality Deck Short Names option in the generation
     * page). Each beautified name is applied to the matching Deck
     * instance and persisted through the normal save/sync path so other
     * devices pick the change up via the sync system.
     *
     * The chain sent for each deck is its full root-to-deck name path
     * (excluding the unnamed root). Giving the LLM the ancestral context
     * helps it pick a short name that reads sensibly in the deck tree
     * (e.g. under "Math > Algebra", "Linear Algebra" can shorten to
     * "Linear Algebra" rather than "Math Algebra Linear Algebra").
     */
    async #beautifyShortNames(triggerButton)
    {
        const subtreeDecks = [];
        const walk = (deck) =>
        {
            subtreeDecks.push(deck);
            for (const subDeck of deck.getSubDecks())
            {
                walk(subDeck);
            }
        };
        walk(this.#deck);

        const deckChains = [];
        const deckIdByKey = new Map();

        for (const subtreeDeck of subtreeDecks)
        {
            if (subtreeDeck.isRoot())
            {
                continue;
            }

            const chainParts = [];
            let cursorDeck = subtreeDeck;
            while (cursorDeck != null && !cursorDeck.isRoot())
            {
                const namePart = (cursorDeck.getName() || "").trim();
                if (namePart.length === 0)
                {
                    chainParts.length = 0;
                    break;
                }
                chainParts.unshift(namePart);
                cursorDeck = cursorDeck.getParent();
            }

            if (chainParts.length === 0)
            {
                continue;
            }

            const deckKey = chainParts.join(" > ");
            if (deckIdByKey.has(deckKey))
            {
                continue;
            }

            deckIdByKey.set(deckKey, subtreeDeck.getId());
            deckChains.push(chainParts);
        }

        if (deckChains.length === 0)
        {
            await DialogBox.alert("Nothing to beautify", "This deck and its subtree have no nameable decks to beautify.");
            return;
        }

        const confirmed = await DialogBox.confirm(
            "Beautify Short Names",
            `This will rewrite the short name of ${deckChains.length} deck(s) using AI and save them. Continue?`
        );

        if (!confirmed)
        {
            return;
        }

        const originalButtonLabel = triggerButton.textContent;
        triggerButton.disabled = true;
        triggerButton.textContent = "Beautifying...";

        try
        {
            // 1. Kick off the beautify task. It returns a taskId immediately and
            //    runs the AI workflow in the background, so this request never
            //    blocks past Cloudflare's ~100s edge timeout (HTTP 524).
            const startResponse = await fetch("/Decks/BeautifyShortNames",
            {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify({ deckChains })
            });

            if (!startResponse.ok)
            {
                let serverMessage = "";
                try
                {
                    const errorBody = await startResponse.json();
                    serverMessage = (errorBody && (errorBody.message || errorBody.error)) || "";
                }
                catch
                {
                    serverMessage = await startResponse.text().catch(() => "");
                }

                await DialogBox.alert(
                    "Beautification failed",
                    serverMessage || `The server returned ${startResponse.status}.`
                );
                return;
            }

            const startBody = await startResponse.json().catch(() => ({}));
            const taskId = startBody && startBody.taskId;

            if (!taskId)
            {
                await DialogBox.alert("Beautification failed", "The server did not return a task to track.");
                return;
            }

            // 2. Poll the task to completion (LLM round-trip; allow a generous cap).
            let finalTaskTree = null;
            try
            {
                finalTaskTree = await TaskProgressTracker.pollUntilTerminal(taskId, null, 10 * 60 * 1000);
            }
            catch (pollError)
            {
                await DialogBox.alert("Beautification failed", "Timed out waiting for the AI service. Please try again.");
                return;
            }

            if (!finalTaskTree || finalTaskTree.status !== taskStatus.COMPLETED)
            {
                // The Agent's per-task credit gate is authoritative: a denial
                // marks the task FAILED with a credit error, which GetProgress
                // surfaces as tree.outOfCredits / node.error. Route those to the
                // shared credit notice (with a top-up path) rather than the
                // generic "model overloaded" message they're not.
                const failureReason = finalTaskTree && finalTaskTree.error;
                if ((finalTaskTree && finalTaskTree.outOfCredits === true)
                    || failureReason === CreditNotice.INSUFFICIENT_CREDITS_ERROR
                    || failureReason === "SERVICE_DISABLED")
                {
                    await CreditNotice.showInsufficientCredits({ error: failureReason || CreditNotice.INSUFFICIENT_CREDITS_ERROR });
                    return;
                }

                await DialogBox.alert(
                    "Beautification failed",
                    "The AI service did not finish. The model may be temporarily overloaded — please try again."
                );
                return;
            }

            // 3. Fetch the beautified deck-key → short-name map the worker produced.
            const resultResponse = await fetch(`/Decks/BeautifyShortNames/Result?taskid=${encodeURIComponent(taskId)}`,
            {
                method: "GET"
            });

            if (!resultResponse.ok)
            {
                let serverMessage = "";
                try
                {
                    const errorBody = await resultResponse.json();
                    serverMessage = (errorBody && (errorBody.message || errorBody.error)) || "";
                }
                catch
                {
                    serverMessage = await resultResponse.text().catch(() => "");
                }

                await DialogBox.alert(
                    "Beautification failed",
                    serverMessage || `The server returned ${resultResponse.status}.`
                );
                return;
            }

            const responseBody = await resultResponse.json().catch(() => ({}));
            const shortNamesByKey = (responseBody && responseBody.shortNamesByKey) || {};

            let appliedCount = 0;
            const decksToSave = [];

            for (const [beautifiedKey, beautifiedShortName] of Object.entries(shortNamesByKey))
            {
                if (typeof beautifiedShortName !== "string" || beautifiedShortName.length === 0)
                {
                    continue;
                }

                const targetDeckId = deckIdByKey.get(beautifiedKey);
                if (!targetDeckId)
                {
                    continue;
                }

                const targetDeck = Deck.getById(targetDeckId);
                if (!targetDeck)
                {
                    continue;
                }

                if (targetDeck.getShortName() === beautifiedShortName)
                {
                    continue;
                }

                targetDeck.setShortName(beautifiedShortName);
                decksToSave.push(targetDeck);
                appliedCount++;
            }

            for (const modifiedDeck of decksToSave)
            {
                await modifiedDeck.save(false);
            }

            // Refresh the short-name input so the user sees the new
            // value for the deck they're currently editing without
            // having to close and reopen the editor.
            const shortNameInput = this.querySelector(".deck-short-name-input");
            if (shortNameInput)
            {
                shortNameInput.value = this.#deck.getShortName();
            }

            window.dispatchEvent(new CustomEvent(DeckEvents.UPDATE, { detail: { deck: this.#deck } }));

            await DialogBox.alert("Beautification complete", `${appliedCount} deck short name(s) updated.`);
        }
        catch (beautifyError)
        {
            console.error("[DeckEditorPage] Beautify short names failed:", beautifyError);
            await DialogBox.alert("Beautification failed", beautifyError.message || String(beautifyError));
        }
        finally
        {
            triggerButton.disabled = false;
            triggerButton.textContent = originalButtonLabel;
        }
    }

    /**
     * Removes every curated study material owned by this deck and its
     * sub-decks. Called from the "Clear Analysis Data" button so wiping
     * cached topic results also reclaims the disk space used by the
     * generated materials. Curated status is now self-described on each
     * material (`additionalData.bCurated`) so the filter doesn't need a
     * deck-side ID list any more.
     */
    async #removeCuratedStudyMaterials()
    {
        // bIncludeCurated=true — the whole point of this method is to
        // delete curated materials, which the new default would hide.
        const materials = this.#deck.getStudyMaterials(true, true);
        const deletions = [];
        for (const material of materials)
        {
            if (material.isCurated())
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

        const clearMockTestAttemptsButton = this.querySelector(".deck-clear-mock-test-attempts-input");
        clearMockTestAttemptsButton.addEventListener("click", async () =>
        {
            await MockTestAttemptCleaner.clearForDeck(this.#deck);
        });

        autoPerformanceAnalysisInput.addEventListener("change", async () =>
        {
            // Only the toggle-ON path costs LLM credits — toggle-OFF is
            // always allowed so a non-admin who somehow ended up with the
            // flag set can still disable it.
            if (autoPerformanceAnalysisInput.checked && !await AiFeatureGate.ensureAllowedOrShowAlert())
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
            if (autoGenerateCuratedStudyInput.checked && !await AiFeatureGate.ensureAllowedOrShowAlert())
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

        const beautifyShortNamesButton = this.querySelector(".deck-beautify-short-names-input");

        // The manual "Beautify Short Names" button is open to any signed-in
        // user; the BEAUTIFY_DECK_SHORT_NAMES task it queues is billed by the
        // Agent's per-task credit charger like any other metered AI feature.
        beautifyShortNamesButton.addEventListener("click", async () =>
        {
            await this.#beautifyShortNames(beautifyShortNamesButton);
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
                        <span class="credit-warning-note">⚠ Uses AI credits</span>
                    </label>
                    <div class="deck-field-helper">Once a week, find the weakest and strongest topics in this deck (eligible after 10+ progress points).</div>
                </div>
                <div class="deck-field deck-auto-generate-curated-study-container">
                    <label class="deck-field-checkbox-label">
                        <input type="checkbox" class="deck-auto-generate-curated-study-input">
                        <span>Auto Generate Curated Study Material</span>
                        <span class="credit-warning-note">⚠ Uses AI credits</span>
                    </label>
                    <div class="deck-field-helper">Generate one tailored study material per weak topic each week. Uses generation credits.</div>
                </div>
                <div class="deck-field deck-clear-analysis-data-container">
                    <button class="deck-field-input deck-clear-analysis-data-input">Clear Analysis Data</button>
                </div>
                <div class="deck-field deck-beautify-short-names-container">
                    <button class="deck-field-input deck-beautify-short-names-input">Beautify Short Names (AI)</button>
                    <span class="credit-warning-note">⚠ Uses AI credits</span>
                    <div class="deck-field-helper">Rewrites the short name of this deck and every sub-deck using AI based on the full deck hierarchy.</div>
                </div>
                <div style="height: 25px"></div>
                <div class="deck-field deck-delete-container">
                    <button class="deck-field-input deck-delete-input">Delete Deck</button>
                </div>
                <div class="deck-field deck-reset-progress-container">
                    <button class="deck-field-input deck-reset-progress-input">Reset Progress</button>
                </div>
                <div class="deck-field deck-clear-mock-test-attempts-container">
                    <button class="deck-field-input deck-clear-mock-test-attempts-input">Clear Mock Test Attempts</button>
                    <div class="deck-field-helper">Deletes every recorded attempt across this deck and its subdecks. Mock test definitions stay intact.</div>
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

        ActiveEntityTracker.set(this.#deck.getId(), entityTypes.DECK, true);
    }

    onPageResumed()
    {
        if (this.#deck)
        {
            ActiveEntityTracker.set(this.#deck.getId(), entityTypes.DECK, true);
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