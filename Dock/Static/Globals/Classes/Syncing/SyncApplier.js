import { serialize } from "../../../ThirdParty/Bson/bson.js";
import { entityTypes } from "../../Enumerations/EntityTypes.js";
import Card from "../../Model/Card.js";
import Deck from "../../Model/Deck.js";
import Lifecycle from "../../Model/Lifecycle.js";
import MockTest from "../../Model/MockTest.js";
import StudyMaterial from "../../Model/StudyMaterial.js";
import ActiveEntityTracker from "../ActiveEntityTracker.js";
import Persistence from "../Persistence.js";


/**
 * SyncApplier
 *
 * Hydrates the local Deck tree with server-returned changes / deletions
 * and flushes the resulting dirty decks to disk. Also owns the
 * first-sync "gather every local entity" helper and the active-entity
 * detection used to raise the SyncBlockingOverlay.
 *
 * No network, no state mutation outside the Deck tree — everything is
 * driven by the arguments passed in by SyncOrchestrator.
 */
class SyncApplier
{
    static #APPLY_YIELD_BATCH_SIZE = 50;

    // ── Apply server changes ──────────────────────────────────────────

    /**
     * Returns the new lastSyncTimestamp the orchestrator should use, or
     * 0 if a full resync should be forced because some incoming decks
     * referenced unknown parents.
     */
    static async applyServerChanges(changes, dirtyDeckIds, onProgress = null)
    {
        const deckChanges          = [];
        const cardChanges          = [];
        const studyMaterialChanges = [];
        const mockTestChanges      = [];

        for (let changeIndex = 0; changeIndex < changes.length; changeIndex++)
        {
            const change = changes[changeIndex];

            if (change.entityType === entityTypes.DECK)
            {
                deckChanges.push(change.data);
            }
            else if (change.entityType === entityTypes.CARD)
            {
                cardChanges.push(change.data);
            }
            else if (change.entityType === entityTypes.STUDY_MATERIAL)
            {
                studyMaterialChanges.push(change.data);
            }
            else if (change.entityType === entityTypes.MOCK_TEST)
            {
                mockTestChanges.push(change.data);
            }
        }

        const bForceFullResync = SyncApplier.#applyDeckChangesInOrder(deckChanges, dirtyDeckIds);

        const totalApplyableCount = cardChanges.length + studyMaterialChanges.length + mockTestChanges.length;

        if (totalApplyableCount === 0)
        {
            if (onProgress)
            {
                onProgress(1.0);
            }
            return { bForceFullResync };
        }

        let appliedCount = 0;
        const tickAndYieldIfDue = async () =>
        {
            if (appliedCount % SyncApplier.#APPLY_YIELD_BATCH_SIZE === 0)
            {
                if (onProgress)
                {
                    onProgress(appliedCount / totalApplyableCount);
                }
                // Yield to the browser so the progress event actually paints.
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
        };

        const allLocalCards = Deck.getRoot()?.getCards(true) || [];
        const cardLookup = new Map();
        for (let cardIndex = 0; cardIndex < allLocalCards.length; cardIndex++)
        {
            cardLookup.set(allLocalCards[cardIndex].getId(), allLocalCards[cardIndex]);
        }

        for (let cardIndex = 0; cardIndex < cardChanges.length; cardIndex++)
        {
            SyncApplier.#applyCardChange(cardChanges[cardIndex], cardLookup, dirtyDeckIds);
            appliedCount++;
            await tickAndYieldIfDue();
        }

        for (let materialIndex = 0; materialIndex < studyMaterialChanges.length; materialIndex++)
        {
            SyncApplier.#applyStudyMaterialChange(studyMaterialChanges[materialIndex], dirtyDeckIds);
            appliedCount++;
            await tickAndYieldIfDue();
        }

        for (let mockTestIndex = 0; mockTestIndex < mockTestChanges.length; mockTestIndex++)
        {
            SyncApplier.#applyMockTestChange(mockTestChanges[mockTestIndex], dirtyDeckIds);
            appliedCount++;
            await tickAndYieldIfDue();
        }

        if (onProgress)
        {
            onProgress(1.0);
        }

        return { bForceFullResync };
    }

    // ── Apply server deletions ────────────────────────────────────────

    static async applyServerDeletions(deletions, dirtyDeckIds, onProgress = null)
    {
        if (deletions.length === 0)
        {
            if (onProgress)
            {
                onProgress(1.0);
            }
            return;
        }

        const totalDeletionCount  = deletions.length;
        let processedDeletionCount = 0;
        const reportProgress = () =>
        {
            if (onProgress && totalDeletionCount > 0)
            {
                onProgress(processedDeletionCount / totalDeletionCount);
            }
        };

        const deckDeletionIds          = [];
        const cardDeletionIds          = [];
        const studyMaterialDeletionIds = [];
        const mockTestDeletionIds      = [];

        for (let deletionIndex = 0; deletionIndex < deletions.length; deletionIndex++)
        {
            const deletion = deletions[deletionIndex];

            if (deletion.entityType === entityTypes.DECK)
            {
                deckDeletionIds.push(deletion.entityId);
            }
            else if (deletion.entityType === entityTypes.CARD)
            {
                cardDeletionIds.push(deletion.entityId);
            }
            else if (deletion.entityType === entityTypes.STUDY_MATERIAL)
            {
                studyMaterialDeletionIds.push(deletion.entityId);
            }
            else if (deletion.entityType === entityTypes.MOCK_TEST)
            {
                mockTestDeletionIds.push(deletion.entityId);
            }
        }

        // Deck deletions are real on-disk deletes (deck.delete()), not full-
        // blob rewrites — they can't be deferred via the dirty set.
        for (let deckIndex = 0; deckIndex < deckDeletionIds.length; deckIndex++)
        {
            const deckId = deckDeletionIds[deckIndex];
            const deck   = Deck.getById(deckId);

            if (deck && !deck.isRoot())
            {
                await deck.delete();
                dirtyDeckIds.delete(deckId);
            }
            processedDeletionCount++;
        }
        reportProgress();

        if (cardDeletionIds.length > 0)
        {
            const cardIdToOwningDeck = new Map();
            const allLocalCards      = Deck.getRoot()?.getCards(true) || [];

            for (let cardIndex = 0; cardIndex < allLocalCards.length; cardIndex++)
            {
                const card = allLocalCards[cardIndex];
                cardIdToOwningDeck.set(card.getId(), { card, deck: card.getDeck() });
            }

            for (let deletionIndex = 0; deletionIndex < cardDeletionIds.length; deletionIndex++)
            {
                const entry = cardIdToOwningDeck.get(cardDeletionIds[deletionIndex]);
                if (entry && entry.deck)
                {
                    entry.deck.removeCard(entry.card);
                    dirtyDeckIds.add(entry.deck.getId());
                }
                processedDeletionCount++;
            }
        }
        reportProgress();

        if (studyMaterialDeletionIds.length > 0)
        {
            const materialIdToOwningDeck = new Map();
            const allDecks               = Deck.getAll();

            for (let deckIndex = 0; deckIndex < allDecks.length; deckIndex++)
            {
                const deck      = allDecks[deckIndex];
                const materials = deck.getStudyMaterials(false);

                for (let materialIndex = 0; materialIndex < materials.length; materialIndex++)
                {
                    materialIdToOwningDeck.set(materials[materialIndex].getId(), { material: materials[materialIndex], deck });
                }
            }

            for (let deletionIndex = 0; deletionIndex < studyMaterialDeletionIds.length; deletionIndex++)
            {
                const entry = materialIdToOwningDeck.get(studyMaterialDeletionIds[deletionIndex]);
                if (entry)
                {
                    entry.deck.removeStudyMaterial(entry.material);
                    dirtyDeckIds.add(entry.deck.getId());
                }
                processedDeletionCount++;
            }
        }
        reportProgress();

        if (mockTestDeletionIds.length > 0)
        {
            const mockTestIdToOwningDeck = new Map();
            const allDecks               = Deck.getAll();

            for (let deckIndex = 0; deckIndex < allDecks.length; deckIndex++)
            {
                const deck      = allDecks[deckIndex];
                const mockTests = deck.getMockTests ? deck.getMockTests(false) : [];

                for (let mockTestIndex = 0; mockTestIndex < mockTests.length; mockTestIndex++)
                {
                    mockTestIdToOwningDeck.set(mockTests[mockTestIndex].getId(), { mockTest: mockTests[mockTestIndex], deck });
                }
            }

            for (let deletionIndex = 0; deletionIndex < mockTestDeletionIds.length; deletionIndex++)
            {
                const entry = mockTestIdToOwningDeck.get(mockTestDeletionIds[deletionIndex]);
                if (entry)
                {
                    entry.deck.removeMockTest(entry.mockTest);
                    dirtyDeckIds.add(entry.deck.getId());
                }
                processedDeletionCount++;
            }
        }

        if (onProgress)
        {
            onProgress(1.0);
        }
    }

    // ── Flush dirty decks ─────────────────────────────────────────────

    static async flushDirtyDecks(dirtyDeckIds, onProgress = null)
    {
        const deckIds        = Array.from(dirtyDeckIds);
        const totalDeckCount = deckIds.length;

        if (totalDeckCount === 0)
        {
            if (onProgress)
            {
                onProgress(1.0);
            }
            return;
        }

        let completedDeckCount = 0;

        // Wrap each save so per-deck completions tick the bar — Promise.all
        // on bare deck.save() promises would only tick once at the end.
        const savePromises = deckIds.map(async (deckId) =>
        {
            const deck = Deck.getById(deckId);
            if (deck)
            {
                await deck.save(false);
            }
            completedDeckCount++;
            if (onProgress)
            {
                onProgress(completedDeckCount / totalDeckCount);
            }
        });

        await Promise.all(savePromises);
    }

    // ── Bulk snapshot apply (Force Pull fast path) ────────────────────

    static #DEFAULT_ROOT_DECK_ID = "0";

    /**
     * Replaces the entire in-memory deck tree with the supplied server
     * snapshot, then commits the result to IDB in a SINGLE bulk
     * transaction. Used by the Force Pull / NO_DATA auto-retry paths:
     * a 2000-deck chunked drain spends most of its time on per-deck
     * IDB transactions, but this commits everything in one shot.
     *
     * Behaviour:
     *   - Wipes Deck.#root, Deck.#current and the static id-map.
     *   - Re-creates every deck from `snapshot.decks` and parents them
     *     topologically (root first → leaves).
     *   - Attaches every card / study material / mock test to its
     *     `deckId` target deck. Orphans are logged and dropped.
     *   - If the snapshot has no root (`parent: null`) deck, creates
     *     one so the app always boots into a usable home page.
     *   - Bulk-deletes stale `Decks/<id>.mmd` IDB entries and bulk-
     *     writes the new set in one IndexedDB transaction.
     *
     * @param {{decks:Array, cards:Array, studyMaterials:Array, mockTests:Array}} snapshot
     * @returns {Promise<{decks:number, cards:number, studyMaterials:number, mockTests:number}>}
     */
    static async applyBulkSnapshot(snapshot)
    {
        const incomingDecks          = Array.isArray(snapshot?.decks)          ? snapshot.decks          : [];
        const incomingCards          = Array.isArray(snapshot?.cards)          ? snapshot.cards          : [];
        const incomingStudyMaterials = Array.isArray(snapshot?.studyMaterials) ? snapshot.studyMaterials : [];
        const incomingMockTests      = Array.isArray(snapshot?.mockTests)      ? snapshot.mockTests      : [];

        console.log(`[SyncApplier] applyBulkSnapshot: ${incomingDecks.length} decks, ${incomingCards.length} cards, ${incomingStudyMaterials.length} study materials, ${incomingMockTests.length} mock tests.`);

        // Snapshot the existing in-memory deck IDs so we can blow away
        // their on-disk entries in the same IDB transaction as the
        // bulk write. (Without this, deleted-on-server decks would
        // linger in IDB until the next save touches them.)
        const previousDeckIds = Deck.getAll().map((existingDeck) => existingDeck.getId());

        Deck.clearAllInMemory();

        // ── Phase 1: instantiate every deck WITHOUT parent/children
        // wiring. The Deck constructor registers it in the static
        // id-map, so subsequent topological lookups via Deck.getById
        // work without any explicit indexing here.
        for (let deckIndex = 0; deckIndex < incomingDecks.length; deckIndex++)
        {
            const deckData  = incomingDecks[deckIndex];
            const lifecycle = Lifecycle.fromJson(deckData.lifecycle);
            new Deck(
                deckData.id,
                deckData.name,
                deckData.shortName,
                deckData.tags || [],
                [],
                lifecycle,
                [],
                [],
                [],
                null,
                deckData.additionalData || {}
            );
        }

        // ── Phase 2: link parents. Single pass — IDs are already in
        // the map from phase 1, so every parent is resolvable without
        // multi-pass iteration.
        let rootDeck = null;
        for (let deckIndex = 0; deckIndex < incomingDecks.length; deckIndex++)
        {
            const deckData = incomingDecks[deckIndex];
            const deck     = Deck.getById(deckData.id);
            if (!deck)
            {
                continue;
            }

            if (deckData.parent === null || deckData.parent === undefined)
            {
                rootDeck = deck;
                continue;
            }

            const parentDeck = Deck.getById(deckData.parent);
            if (!parentDeck)
            {
                console.warn(`[SyncApplier] applyBulkSnapshot: deck "${deckData.name}" (${deckData.id}) references missing parent ${deckData.parent} — attaching to root.`);
                continue;
            }

            deck.setParent(parentDeck);
            parentDeck.addSubDeck(deck);
        }

        // ── Phase 2.5: ensure a root exists. If the snapshot was
        // empty OR every deck had a parent (shouldn't happen, but be
        // defensive), create the standard empty root so the UI has a
        // sensible home page and subsequent local edits have a parent.
        if (!rootDeck)
        {
            const rootLifecycle = new Lifecycle(new Date(0), new Date(0), 0, 0, 0);
            rootDeck = new Deck(SyncApplier.#DEFAULT_ROOT_DECK_ID, "Root", "Root", [], [], rootLifecycle, [], [], [], null, {});
            console.warn("[SyncApplier] applyBulkSnapshot: snapshot had no root deck; created an empty one locally.");
        }

        // Attach any decks whose parent was missing to the root, so
        // they're not orphaned out of the tree.
        for (let deckIndex = 0; deckIndex < incomingDecks.length; deckIndex++)
        {
            const deckData = incomingDecks[deckIndex];
            const deck     = Deck.getById(deckData.id);
            if (!deck || deck === rootDeck)
            {
                continue;
            }
            if (deck.getParent() === null && deckData.parent !== null && deckData.parent !== undefined)
            {
                deck.setParent(rootDeck);
                rootDeck.addSubDeck(deck);
            }
        }

        Deck.setRoot(rootDeck);

        // ── Phase 3: attach cards, study materials, mock tests.
        let droppedCards          = 0;
        let droppedStudyMaterials = 0;
        let droppedMockTests      = 0;

        for (let cardIndex = 0; cardIndex < incomingCards.length; cardIndex++)
        {
            const cardData   = incomingCards[cardIndex];
            const targetDeck = Deck.getById(cardData.deckId);
            if (!targetDeck)
            {
                droppedCards++;
                continue;
            }
            targetDeck.addCard(Card.fromJson(cardData));
        }

        for (let materialIndex = 0; materialIndex < incomingStudyMaterials.length; materialIndex++)
        {
            const materialData = incomingStudyMaterials[materialIndex];
            const targetDeck   = Deck.getById(materialData.deckId);
            if (!targetDeck)
            {
                droppedStudyMaterials++;
                continue;
            }
            targetDeck.addStudyMaterial(StudyMaterial.fromJson(materialData));
        }

        for (let mockTestIndex = 0; mockTestIndex < incomingMockTests.length; mockTestIndex++)
        {
            const mockTestData = incomingMockTests[mockTestIndex];
            const targetDeck   = Deck.getById(mockTestData.deckId);
            if (!targetDeck)
            {
                droppedMockTests++;
                continue;
            }
            targetDeck.addMockTest(MockTest.fromJson(mockTestData));
        }

        if (droppedCards || droppedStudyMaterials || droppedMockTests)
        {
            console.warn(`[SyncApplier] applyBulkSnapshot: dropped ${droppedCards} orphan card(s), ${droppedStudyMaterials} study material(s), ${droppedMockTests} mock test(s) — referenced deckId not present in snapshot.`);
        }

        // ── Phase 4: persist. Serialize every deck's toJson() into
        // BSON and bulk-write under `Decks/<id>.mmd`. Stale on-disk
        // decks (in `previousDeckIds` but not in the new tree) are
        // deleted first to keep IDB in lockstep with memory.
        const newDeckIds   = new Set();
        const allNewDecks  = Deck.getAll();
        const entriesMap   = new Map();

        for (let newDeckIndex = 0; newDeckIndex < allNewDecks.length; newDeckIndex++)
        {
            const deck     = allNewDecks[newDeckIndex];
            const deckJson = deck.toJson();
            const deckBson = serialize(deckJson);
            entriesMap.set(`Decks/${deck.getId()}.mmd`, deckBson);
            newDeckIds.add(deck.getId());
        }

        const staleDeckPaths = [];
        for (let previousIndex = 0; previousIndex < previousDeckIds.length; previousIndex++)
        {
            const previousDeckId = previousDeckIds[previousIndex];
            if (!newDeckIds.has(previousDeckId))
            {
                staleDeckPaths.push(`Decks/${previousDeckId}.mmd`);
            }
        }

        if (staleDeckPaths.length > 0)
        {
            await Persistence.deleteMany(staleDeckPaths);
        }

        await Persistence.writeMany(entriesMap);

        return {
            decks:          allNewDecks.length,
            cards:          incomingCards.length          - droppedCards,
            studyMaterials: incomingStudyMaterials.length - droppedStudyMaterials,
            mockTests:      incomingMockTests.length      - droppedMockTests
        };
    }

    // ── First-sync gather ─────────────────────────────────────────────

    /**
     * Snapshots every in-memory entity into change records, indexed by id.
     * Returned as a plain object so SyncTransport's pendingChanges can be
     * replaced wholesale by the orchestrator.
     */
    static gatherAllLocalEntities()
    {
        const gatheredChanges = {};
        const allDecks        = Deck.getAll();

        let totalCards          = 0;
        let totalStudyMaterials = 0;
        let totalMockTests      = 0;

        for (let deckIndex = 0; deckIndex < allDecks.length; deckIndex++)
        {
            const deck = allDecks[deckIndex];

            gatheredChanges[deck.getId()] =
            {
                entityId:   deck.getId(),
                entityType: entityTypes.DECK,
                data:       deck.toSyncJson(),
                deleted:    false,
            };

            const directCards = deck.getCards(false);
            totalCards += directCards.length;
            for (let cardIndex = 0; cardIndex < directCards.length; cardIndex++)
            {
                const card = directCards[cardIndex];
                gatheredChanges[card.getId()] =
                {
                    entityId:   card.getId(),
                    entityType: entityTypes.CARD,
                    data:       card.toJson(),
                    deleted:    false,
                };
            }

            const studyMaterials = deck.getStudyMaterials(false);
            totalStudyMaterials += studyMaterials.length;
            for (let materialIndex = 0; materialIndex < studyMaterials.length; materialIndex++)
            {
                const studyMaterial = studyMaterials[materialIndex];
                gatheredChanges[studyMaterial.getId()] =
                {
                    entityId:   studyMaterial.getId(),
                    entityType: entityTypes.STUDY_MATERIAL,
                    data:       studyMaterial.toJson(),
                    deleted:    false,
                };
            }

            const mockTests = deck.getMockTests ? deck.getMockTests(false) : [];
            totalMockTests += mockTests.length;
            for (let mockTestIndex = 0; mockTestIndex < mockTests.length; mockTestIndex++)
            {
                const mockTest = mockTests[mockTestIndex];
                gatheredChanges[mockTest.getId()] =
                {
                    entityId:   mockTest.getId(),
                    entityType: entityTypes.MOCK_TEST,
                    data:       mockTest.toJson(),
                    deleted:    false,
                };
            }
        }

        console.log(`[SyncApplier] gathered ${allDecks.length} decks, ${totalCards} cards, ${totalStudyMaterials} study materials, ${totalMockTests} mock tests.`);
        return gatheredChanges;
    }

    // ── Active-entity check ───────────────────────────────────────────

    /**
     * Returns true if the entity currently being studied or edited
     * appears in the incoming server pull (either changes or deletions).
     * SyncOrchestrator uses this to decide whether to raise the
     * SyncBlockingOverlay around apply/delete/flush.
     */
    static isActiveEntityAffected(serverChanges, serverDeletions)
    {
        const activeEntityId = ActiveEntityTracker.getId();
        if (!activeEntityId)
        {
            return false;
        }

        const activeEntityType = ActiveEntityTracker.getType();

        for (let changeIndex = 0; changeIndex < serverChanges.length; changeIndex++)
        {
            const change = serverChanges[changeIndex];
            if (change.entityId === activeEntityId && change.entityType === activeEntityType)
            {
                return true;
            }
        }

        for (let deletionIndex = 0; deletionIndex < serverDeletions.length; deletionIndex++)
        {
            const deletion = serverDeletions[deletionIndex];
            if (deletion.entityId === activeEntityId && deletion.entityType === activeEntityType)
            {
                return true;
            }
        }

        return false;
    }

    // ── Per-entity helpers (private) ──────────────────────────────────

    /**
     * Applies the queued deck-data array in dependency order so a child
     * deck whose parent is in the same batch isn't created before its
     * parent. Returns true if any decks were dropped because their
     * parent was unknown — the caller should force a full resync.
     */
    static #applyDeckChangesInOrder(deckDataArray, dirtyDeckIds)
    {
        const remaining = [...deckDataArray];
        let processedCount;

        do
        {
            processedCount = 0;

            for (let remainingIndex = remaining.length - 1; remainingIndex >= 0; remainingIndex--)
            {
                const deckData = remaining[remainingIndex];
                const parentId = deckData.parent;

                if (!parentId || Deck.getById(parentId))
                {
                    SyncApplier.#applyDeckChange(deckData, dirtyDeckIds);
                    remaining.splice(remainingIndex, 1);
                    processedCount++;
                }
            }
        }
        while (processedCount > 0 && remaining.length > 0);

        if (remaining.length > 0)
        {
            // Dropping these decks rather than re-parenting them to root
            // — silent reparenting would corrupt the tree. A full resync
            // on the next cycle will pull the missing parents.
            console.warn(`[SyncApplier] ${remaining.length} deck(s) have unknown parents. Dropping and forcing full resync.`);
            for (let remainingIndex = 0; remainingIndex < remaining.length; remainingIndex++)
            {
                console.warn(`[SyncApplier]   • deck "${remaining[remainingIndex].name}" (${remaining[remainingIndex].id}) — missing parent ${remaining[remainingIndex].parent}`);
            }
            return true;
        }

        return false;
    }

    static #applyDeckChange(deckData, dirtyDeckIds)
    {
        const existingDeck = Deck.getById(deckData.id);

        if (existingDeck)
        {
            const serverLastModified = new Date(deckData.lifecycle.lastModified);
            const localLastModified  = existingDeck.getLifecycle().getLastModified();

            if (serverLastModified <= localLastModified)
            {
                return;
            }

            existingDeck.setName(deckData.name);
            existingDeck.setShortName(deckData.shortName);
            existingDeck.setTags(deckData.tags || []);

            const expectedParentId = deckData.parent;
            const currentParentId  = existingDeck.getParent()?.getId() || null;

            if (expectedParentId !== currentParentId)
            {
                const newParent = Deck.getById(expectedParentId);

                if (!newParent)
                {
                    console.warn(`[SyncApplier] deck "${deckData.name}" (${deckData.id}): new parent ${expectedParentId} not found locally. Skipping reparent.`);
                }
                else
                {
                    existingDeck.setParent(newParent);
                    newParent.addSubDeck(existingDeck);
                    dirtyDeckIds.add(newParent.getId());

                    // Without flushing the OLD parent the on-disk file
                    // still lists this deck as its child, and the next
                    // boot-time recursive load re-attaches the deck.
                    if (currentParentId)
                    {
                        dirtyDeckIds.add(currentParentId);
                    }
                }
            }

            existingDeck.getLifecycle().setLastModified(serverLastModified);
            dirtyDeckIds.add(existingDeck.getId());
        }
        else
        {
            const lifecycle      = Lifecycle.fromJson(deckData.lifecycle);
            const studyMaterials = (deckData.studyMaterials || []).map((studyMaterialJson) => StudyMaterial.fromJson(studyMaterialJson));

            const parentDeck = deckData.parent ? Deck.getById(deckData.parent) : Deck.getRoot();

            if (deckData.parent && !parentDeck)
            {
                console.warn(`[SyncApplier] deck "${deckData.name}" (${deckData.id}): parent ${deckData.parent} not found locally. Skipping.`);
                return;
            }

            const deck = new Deck(
                deckData.id,
                deckData.name,
                deckData.shortName,
                deckData.tags || [],
                [],
                lifecycle,
                studyMaterials,
                [],
                [],
                parentDeck,
                deckData.additionalData || {},
            );

            dirtyDeckIds.add(deck.getId());
            dirtyDeckIds.add(parentDeck.getId());
        }
    }

    static #applyCardChange(cardData, cardLookup, dirtyDeckIds)
    {
        const targetDeck = Deck.getById(cardData.deckId);

        if (!targetDeck)
        {
            console.warn(`[SyncApplier] card ${cardData.id}: target deck ${cardData.deckId} not found locally. Skipping.`);
            return;
        }

        const existingCard = cardLookup.get(cardData.id);

        if (existingCard)
        {
            const serverLastModified = new Date(cardData.lifecycle.lastModified);
            const localLastModified  = existingCard.getLifecycle().getLastModified();

            if (serverLastModified <= localLastModified)
            {
                return;
            }

            const currentDeck = existingCard.getDeck();
            if (currentDeck)
            {
                currentDeck.removeCard(existingCard);
                if (currentDeck.getId() !== targetDeck.getId())
                {
                    dirtyDeckIds.add(currentDeck.getId());
                }
            }
        }

        const newCard = Card.fromJson(cardData);
        targetDeck.addCard(newCard);
        dirtyDeckIds.add(targetDeck.getId());
    }

    static #applyStudyMaterialChange(studyMaterialData, dirtyDeckIds)
    {
        const targetDeck = Deck.getById(studyMaterialData.deckId);
        if (!targetDeck)
        {
            return;
        }

        const existingMaterials = targetDeck.getStudyMaterials(false);
        const existing = existingMaterials.find(material => material.getId() === studyMaterialData.id);

        if (existing)
        {
            const serverLastModified = new Date(studyMaterialData.lifecycle.lastModified);
            const localLastModified  = existing.getLifecycle().getLastModified();

            if (serverLastModified <= localLastModified)
            {
                return;
            }

            existing.setContent(studyMaterialData.content);
        }
        else
        {
            const material = StudyMaterial.fromJson(studyMaterialData);
            targetDeck.addStudyMaterial(material);
        }

        dirtyDeckIds.add(targetDeck.getId());
    }

    static #applyMockTestChange(mockTestData, dirtyDeckIds)
    {
        const targetDeck = Deck.getById(mockTestData.deckId);
        if (!targetDeck)
        {
            console.warn(`[SyncApplier] mock test ${mockTestData.id}: target deck ${mockTestData.deckId} not found locally. Skipping.`);
            return;
        }

        const existingMockTests = targetDeck.getMockTests ? targetDeck.getMockTests(false) : [];
        const existing = existingMockTests.find(mockTest => mockTest.getId() === mockTestData.id);

        if (existing)
        {
            const serverLastModified = new Date(mockTestData.lifecycle.lastModified);
            const localLastModified  = existing.getLifecycle().getLastModified();

            if (serverLastModified <= localLastModified)
            {
                return;
            }

            targetDeck.removeMockTest(existing);
        }

        const mockTest = MockTest.fromJson(mockTestData);
        targetDeck.addMockTest(mockTest);
        dirtyDeckIds.add(targetDeck.getId());
    }
}

export default SyncApplier;
