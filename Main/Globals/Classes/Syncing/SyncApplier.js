import { serialize } from "../../../ThirdParty/Bson/bson.js";
import { entityTypes } from "../../Enumerations/EntityTypes.js";
import Card from "../../Model/Card.js";
import Deck from "../../Model/Deck.js";
import Lifecycle from "../../Model/Lifecycle.js";
import MockTest from "../../Model/MockTest.js";
import StudyMaterial from "../../Model/StudyMaterial.js";
import ActiveEntityTracker from "../ActiveEntityTracker.js";
import Persistence from "../Persistence.js";
import SyncTransport from "./SyncTransport.js";
import ContentOverlayStore from "../Content/ContentOverlayStore.js";


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

    // additionalData slots holding records that sync as their own entity type.
    // Deck.toSyncJson strips these from every deck push, so an incoming deck
    // must never be treated as authoritative for them. Kept in step with
    // Deck's own list.
    static ENTITY_CHANNEL_ADDITIONAL_DATA_KEYS = ["askAiPopupLinks", "contentOverlays"];

    // Decks that arrived in a chunked-drain cycle before their parent did.
    // Keyed by deck id, carrying the raw incoming deck data.
    //
    // A deck can only be attached once its parent is in the local tree, so
    // #applyDeckChangesInOrder used to treat "parent not found" as a genuine
    // orphan and queue a DELETION tombstone for it — which is correct for a
    // single-cycle pull, but destroys data mid-drain, where the parent may
    // simply be scheduled for a later chunk. Unresolved decks are parked here
    // instead and retried at the head of every subsequent cycle; the final
    // (non-chunked) cycle applies the original tombstone rule to whatever is
    // still unresolved, so genuine orphans are still cleaned up.
    static #deferredOrphanDeckDataById = new Map();

    // ── Apply server changes ──────────────────────────────────────────

    /**
     * Hydrates the local Deck tree with the server's incoming changes.
     *
     * Orphan handling: when an incoming deck references a parent that
     * exists neither locally nor in the same batch, the orphan is
     * queued as a deletion tombstone (via SyncTransport.setPendingChange)
     * so the next push tells the server to remove it. The server's
     * cascading delete handler (SyncQueryEngine.bulkRecordDeletions)
     * then propagates the removal to every other device. We never force
     * a full resync — historically the "force resync to pull missing
     * parents" path was self-reinforcing because the missing parent
     * was genuinely gone server-side and the catastrophic resync just
     * re-uploaded the orphan from stale local state.
     *
     * @param {boolean} [bDeferUnresolvedDecks=false] Pass true while a chunked
     *   drain is still running (the server reported `morePending`). A missing
     *   parent is then treated as "not delivered yet" and the deck is parked in
     *   #deferredOrphanDeckDataById for the next cycle instead of being
     *   tombstoned. The final cycle passes false, so anything still unresolved
     *   goes through the normal orphan cleanup.
     */
    static async applyServerChanges(changes, dirtyDeckIds, onProgress = null, bDeferUnresolvedDecks = false)
    {
        const deckChanges          = [];
        const cardChanges          = [];
        const studyMaterialChanges = [];
        const mockTestChanges      = [];
        const popupLinkChanges     = [];
        const contentOverlayChanges = [];

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
            else if (change.entityType === entityTypes.ASK_AI_POPUP_LINK)
            {
                popupLinkChanges.push(change.data);
            }
            else if (change.entityType === entityTypes.CONTENT_OVERLAY)
            {
                contentOverlayChanges.push(change.data);
            }
        }

        SyncApplier.#applyDeckChangesInOrder(deckChanges, dirtyDeckIds, bDeferUnresolvedDecks);

        const totalApplyableCount = cardChanges.length + studyMaterialChanges.length + mockTestChanges.length + popupLinkChanges.length + contentOverlayChanges.length;

        if (totalApplyableCount === 0)
        {
            if (onProgress)
            {
                onProgress(1.0);
            }
            return;
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

        const allLocalCards = Deck.getRoot()?.getCards(true, true) || [];
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

        for (let popupIndex = 0; popupIndex < popupLinkChanges.length; popupIndex++)
        {
            SyncApplier.#applyPopupLinkChange(popupLinkChanges[popupIndex], dirtyDeckIds);
            appliedCount++;
            await tickAndYieldIfDue();
        }

        // Overlays apply last: each targets a card or study material, so the
        // entity it overlays has already been applied above.
        for (let overlayIndex = 0; overlayIndex < contentOverlayChanges.length; overlayIndex++)
        {
            SyncApplier.#applyContentOverlayChange(contentOverlayChanges[overlayIndex], dirtyDeckIds);
            appliedCount++;
            await tickAndYieldIfDue();
        }

        if (onProgress)
        {
            onProgress(1.0);
        }
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
        const popupLinkDeletionIds     = [];
        const contentOverlayDeletionIds = [];

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
            else if (deletion.entityType === entityTypes.ASK_AI_POPUP_LINK)
            {
                popupLinkDeletionIds.push(deletion.entityId);
            }
            else if (deletion.entityType === entityTypes.CONTENT_OVERLAY)
            {
                contentOverlayDeletionIds.push(deletion.entityId);
            }
        }

        // Deck deletions are real on-disk deletes (deck.delete()), not full-
        // blob rewrites — they can't be deferred via the dirty set.
        // bSuppressDispatch=true so the server-driven teardown doesn't
        // re-fire ENTITY_DELETED back through SyncOrchestrator's handler
        // and echo the tombstone back to the server next cycle. This is
        // the replacement for the old #bApplyingServerChanges gate —
        // suppress events at their source instead of dropping them at
        // the listener, so user mutations that happen to race the apply
        // phase still queue their events normally.
        for (let deckIndex = 0; deckIndex < deckDeletionIds.length; deckIndex++)
        {
            const deckId = deckDeletionIds[deckIndex];
            const deck   = Deck.getById(deckId);

            if (deck && !deck.isRoot())
            {
                await deck.delete(true, true);
                dirtyDeckIds.delete(deckId);
            }
            processedDeletionCount++;
        }
        reportProgress();

        if (cardDeletionIds.length > 0)
        {
            const cardIdToOwningDeck = new Map();
            const allLocalCards      = Deck.getRoot()?.getCards(true, true) || [];

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
                const materials = deck.getStudyMaterials(false, true);

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

        if (popupLinkDeletionIds.length > 0)
        {
            // Popup records live in deck.additionalData.askAiPopupLinks
            // — same in-memory home as before, just synced via the
            // dedicated entity channel. We don't know which deck a
            // popup belongs to from the deletion event alone, so iterate
            // every deck once and probe the map.
            const popupIdToOwningDeck = new Map();
            const allDecks            = Deck.getAll();

            for (let deckIndex = 0; deckIndex < allDecks.length; deckIndex++)
            {
                const deck = allDecks[deckIndex];
                const popupMap = (deck.getAdditionalData?.() || {}).askAiPopupLinks || {};
                for (const popupId of Object.keys(popupMap))
                {
                    popupIdToOwningDeck.set(popupId, deck);
                }
            }

            for (let deletionIndex = 0; deletionIndex < popupLinkDeletionIds.length; deletionIndex++)
            {
                const popupId = popupLinkDeletionIds[deletionIndex];
                const owningDeck = popupIdToOwningDeck.get(popupId);
                if (owningDeck)
                {
                    const additionalData = owningDeck.getAdditionalData() || {};
                    const popupMap = additionalData.askAiPopupLinks;
                    if (popupMap && Object.prototype.hasOwnProperty.call(popupMap, popupId))
                    {
                        delete popupMap[popupId];
                        dirtyDeckIds.add(owningDeck.getId());
                    }
                }
                processedDeletionCount++;
            }
        }

        if (contentOverlayDeletionIds.length > 0)
        {
            // An overlay id encodes its target entity but not its deck, and a
            // tombstone carries only the id — so, exactly like popup links,
            // find the owning deck by probing every deck's map once.
            const overlayIdToOwningDeck = new Map();
            const allDecksForOverlays   = Deck.getAll();

            for (let deckIndex = 0; deckIndex < allDecksForOverlays.length; deckIndex++)
            {
                const deck = allDecksForOverlays[deckIndex];
                const overlayMap = (deck.getAdditionalData?.() || {})[ContentOverlayStore.DECK_ADDITIONAL_DATA_KEY] || {};
                for (const overlayId of Object.keys(overlayMap))
                {
                    overlayIdToOwningDeck.set(overlayId, deck);
                }
            }

            for (let deletionIndex = 0; deletionIndex < contentOverlayDeletionIds.length; deletionIndex++)
            {
                const overlayId = contentOverlayDeletionIds[deletionIndex];
                const owningDeck = overlayIdToOwningDeck.get(overlayId);
                if (owningDeck && ContentOverlayStore.removeRecordById(owningDeck, overlayId))
                {
                    dirtyDeckIds.add(owningDeck.getId());
                }
                processedDeletionCount++;
            }
        }

        if (onProgress)
        {
            onProgress(1.0);
        }
    }

    /**
     * Applies one incoming popup-link change to the appropriate deck's
     * `additionalData.askAiPopupLinks` map. The owning deck is named
     * explicitly on the payload so a missing deck doesn't trigger an
     * expensive O(decks * popups) probe.
     *
     * Compares lifecycle.lastModified to skip stale incoming records —
     * the same last-write-wins rule the other entities use.
     */
    static #applyPopupLinkChange(popupData, dirtyDeckIds)
    {
        if (!popupData || !popupData.id || !popupData.deckId)
        {
            return;
        }
        const owningDeck = Deck.getById(popupData.deckId);
        if (!owningDeck)
        {
            console.warn(`[SyncApplier] popup ${popupData.id}: owning deck ${popupData.deckId} not found locally. Skipping.`);
            return;
        }

        const additionalData = owningDeck.getAdditionalData() || {};
        const popupMap = additionalData.askAiPopupLinks || {};

        const existingRecord = popupMap[popupData.id];
        if (existingRecord && existingRecord.lifecycle && popupData.lifecycle)
        {
            const incomingLastModified = new Date(popupData.lifecycle.lastModified);
            const existingLastModified = new Date(existingRecord.lifecycle.lastModified);
            if (existingLastModified >= incomingLastModified)
            {
                return;
            }
        }

        popupMap[popupData.id] = {
            title:         popupData.title         || "",
            content:       popupData.content       || "",
            promptMode:    popupData.promptMode,
            savedAtMillis: popupData.savedAtMillis || Date.now(),
            lifecycle:     popupData.lifecycle     || null,
        };
        additionalData.askAiPopupLinks = popupMap;
        // Mutate in place to avoid bumping deck.lifecycle (which would
        // queue a redundant deck push). The dirty-deck flush below
        // persists the new state.
        dirtyDeckIds.add(owningDeck.getId());
    }

    /**
     * Applies one incoming content-overlay record — a learner's own edit to a
     * card or study material, made on another device.
     *
     * The record's `value` stays exactly as it arrived: for a paid deck it is a
     * ciphertext envelope the server re-encrypted on the wire, and only
     * decryptForStudy (after the deck is unlocked) turns it into readable text.
     * Nothing here ever holds plaintext.
     */
    static #applyContentOverlayChange(overlayData, dirtyDeckIds)
    {
        if (!overlayData || !overlayData.id || !overlayData.deckId)
        {
            return;
        }

        const owningDeck = Deck.getById(overlayData.deckId);
        if (!owningDeck)
        {
            console.warn(`[SyncApplier] content overlay ${overlayData.id}: owning deck ${overlayData.deckId} not found locally. Skipping.`);
            return;
        }

        // Mutates the map in place (no deck.lifecycle bump, so no redundant
        // deck push) and applies last-write-wins on lifecycle.lastModified,
        // matching the server's own upsert gate.
        if (ContentOverlayStore.applyIncomingRecord(owningDeck, overlayData))
        {
            dirtyDeckIds.add(owningDeck.getId());
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
        // bSuppressDispatch=true so server-applied changes don't fire
        // ENTITY_CHANGED back through SyncOrchestrator and queue a
        // server-echo on the next push. This replaces the old apply-
        // phase event gate, allowing user mutations that race the apply
        // phase (study-progress writes, edits, deletes) to queue
        // their events normally.
        const savePromises = deckIds.map(async (deckId) =>
        {
            const deck = Deck.getById(deckId);
            if (deck)
            {
                await deck.save(false, true);
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
     * @param {{decks:Array, cards:Array, studyMaterials:Array, mockTests:Array, popupLinks:Array}} snapshot
     * @returns {Promise<{decks:number, cards:number, studyMaterials:number, mockTests:number, popupLinks:number}>}
     */
    static async applyBulkSnapshot(snapshot)
    {
        const incomingDecks          = Array.isArray(snapshot?.decks)          ? snapshot.decks          : [];
        const incomingCards          = Array.isArray(snapshot?.cards)          ? snapshot.cards          : [];
        const incomingStudyMaterials = Array.isArray(snapshot?.studyMaterials) ? snapshot.studyMaterials : [];
        const incomingMockTests      = Array.isArray(snapshot?.mockTests)      ? snapshot.mockTests      : [];
        const incomingPopupLinks     = Array.isArray(snapshot?.popupLinks)     ? snapshot.popupLinks     : [];
        const incomingContentOverlays = Array.isArray(snapshot?.contentOverlays) ? snapshot.contentOverlays : [];

        console.log(`[SyncApplier] applyBulkSnapshot: ${incomingDecks.length} decks, ${incomingCards.length} cards, ${incomingStudyMaterials.length} study materials, ${incomingMockTests.length} mock tests, ${incomingPopupLinks.length} popup link(s), ${incomingContentOverlays.length} content overlay(s).`);

        // The snapshot replaces the whole tree, so any deck parked by a drain
        // that this bulk pull is superseding is stale by definition.
        SyncApplier.clearDeferredOrphanDecks();

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

        // Popup-link records — drop each into its owning deck's
        // additionalData.askAiPopupLinks map. The map is the same in-
        // memory storage AskAi lookup reads from at click time, so
        // populating it here is what makes a fresh-device pull
        // immediately serve the popup body when the user taps a marker.
        let droppedPopupLinks = 0;
        for (let popupIndex = 0; popupIndex < incomingPopupLinks.length; popupIndex++)
        {
            const popupData  = incomingPopupLinks[popupIndex];
            const targetDeck = Deck.getById(popupData.deckId);
            if (!targetDeck)
            {
                droppedPopupLinks++;
                continue;
            }
            const additionalData = targetDeck.getAdditionalData() || {};
            if (!additionalData.askAiPopupLinks)
            {
                additionalData.askAiPopupLinks = {};
            }
            additionalData.askAiPopupLinks[popupData.id] = {
                title:         popupData.title         || "",
                content:       popupData.content       || "",
                promptMode:    popupData.promptMode,
                savedAtMillis: popupData.savedAtMillis || Date.now(),
                lifecycle:     popupData.lifecycle     || null,
            };
        }

        // Content overlays — a learner's own edits. Applied after the cards and
        // materials above so their targets already exist in the tree. The value
        // stays as it arrived (ciphertext for a paid deck); only
        // decryptForStudy, after an unlock, ever renders it readable.
        let droppedContentOverlays = 0;
        for (let overlayIndex = 0; overlayIndex < incomingContentOverlays.length; overlayIndex++)
        {
            const overlayData = incomingContentOverlays[overlayIndex];
            const targetDeck  = Deck.getById(overlayData?.deckId);
            if (!targetDeck)
            {
                droppedContentOverlays++;
                continue;
            }
            ContentOverlayStore.applyIncomingRecord(targetDeck, overlayData);
        }

        if (droppedCards || droppedStudyMaterials || droppedMockTests || droppedPopupLinks || droppedContentOverlays)
        {
            console.warn(`[SyncApplier] applyBulkSnapshot: dropped ${droppedCards} orphan card(s), ${droppedStudyMaterials} study material(s), ${droppedMockTests} mock test(s), ${droppedPopupLinks} popup link(s), ${droppedContentOverlays} content overlay(s) — referenced deckId not present in snapshot.`);
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
            mockTests:      incomingMockTests.length      - droppedMockTests,
            popupLinks:     incomingPopupLinks.length     - droppedPopupLinks,
            contentOverlays: incomingContentOverlays.length - droppedContentOverlays,
        };
    }

    // ── First-sync gather ─────────────────────────────────────────────

    /**
     * Snapshots in-memory entities into change records, indexed by id.
     * Returned as a plain object so SyncTransport's pendingChanges can be
     * replaced wholesale (full push) or merged (reconciliation) by the
     * orchestrator.
     *
     * @param {number} [sinceMilliseconds=0] When > 0, only entities whose
     *   lifecycle.lastModified is strictly newer than this epoch-millis
     *   value are gathered — the reconciliation "modified since last sync"
     *   pass that lets sync converge local -> server even when the
     *   opportunistically-persisted pending queue dropped a change (e.g. an
     *   offline edit lost on a hard app close). 0 gathers everything (the
     *   first-sync / wipe-recovery full push). An entity whose timestamp
     *   cannot be read is included — fail toward pushing, never toward
     *   silently orphaning local data.
     */
    static gatherAllLocalEntities(sinceMilliseconds = 0)
    {
        const gatheredChanges = {};
        const allDecks        = Deck.getAll();

        const isModifiedSinceCutoff = (entityWithLifecycle) =>
        {
            if (sinceMilliseconds <= 0)
            {
                return true;
            }
            try
            {
                const lastModified = entityWithLifecycle.getLifecycle().getLastModified();
                return new Date(lastModified).getTime() > sinceMilliseconds;
            }
            catch (timestampError)
            {
                return true;
            }
        };

        let totalCards          = 0;
        let totalStudyMaterials = 0;
        let totalMockTests      = 0;
        let orphanCount         = 0;

        for (let deckIndex = 0; deckIndex < allDecks.length; deckIndex++)
        {
            const deck = allDecks[deckIndex];

            // Defensive orphan check: a non-root deck whose persisted
            // `parent` id no longer resolves in the in-memory id map
            // is broken local state — pushing it would re-create the
            // orphan server-side and re-trigger the resync loop. Push
            // a deletion tombstone instead so the server (and every
            // other device) drops it.
            const deckSyncData = deck.toSyncJson();
            const isOrphan     = !deck.isRoot()
                && deckSyncData.parent
                && !Deck.getById(deckSyncData.parent);

            if (isOrphan)
            {
                // In reconciliation mode a long-standing orphan (unchanged
                // since the cutoff) is already-known broken state; only
                // (re)queue its deletion when it is fresh, so we don't spam
                // the same tombstone every cycle.
                if (isModifiedSinceCutoff(deck))
                {
                    console.warn(`[SyncApplier] gatherAllLocalEntities — local orphan deck "${deck.getName?.() || deckSyncData.name}" (${deck.getId()}); parent ${deckSyncData.parent} not in id map. Queuing deletion.`);
                    gatheredChanges[deck.getId()] =
                    {
                        entityId: deck.getId(),
                        entityType: entityTypes.DECK,
                        data: null,
                        deleted: true,
                    };
                    orphanCount++;
                }
                continue;
            }

            // The deck record itself is gathered only when it changed since
            // the cutoff, but its children are always scanned below — a card
            // touched under an otherwise-unchanged deck must still be caught.
            if (isModifiedSinceCutoff(deck))
            {
                gatheredChanges[deck.getId()] =
                {
                    entityId:   deck.getId(),
                    entityType: entityTypes.DECK,
                    data:       deckSyncData,
                    deleted:    false,
                };
            }

            const directCards = deck.getCards(false, true);
            totalCards += directCards.length;
            for (let cardIndex = 0; cardIndex < directCards.length; cardIndex++)
            {
                const card = directCards[cardIndex];
                if (!isModifiedSinceCutoff(card))
                {
                    continue;
                }
                gatheredChanges[card.getId()] =
                {
                    entityId:   card.getId(),
                    entityType: entityTypes.CARD,
                    data:       card.toJson(),
                    deleted:    false,
                };
            }

            const studyMaterials = deck.getStudyMaterials(false, true);
            totalStudyMaterials += studyMaterials.length;
            for (let materialIndex = 0; materialIndex < studyMaterials.length; materialIndex++)
            {
                const studyMaterial = studyMaterials[materialIndex];
                if (!isModifiedSinceCutoff(studyMaterial))
                {
                    continue;
                }
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
                if (!isModifiedSinceCutoff(mockTest))
                {
                    continue;
                }
                gatheredChanges[mockTest.getId()] =
                {
                    entityId:   mockTest.getId(),
                    entityType: entityTypes.MOCK_TEST,
                    data:       mockTest.toJson(),
                    deleted:    false,
                };
            }

            // Popup records live inside this deck's additionalData but
            // sync as standalone entities. Gather them here so a full
            // local→server resync (e.g. wipe-recovery push) ships them
            // alongside cards / materials. Each record carries a
            // lifecycle stamp post-migration; if a legacy record is
            // somehow still un-stamped at this point, stamp it now so
            // the server's lastModified gate can do its job.
            const additionalData = deck.getAdditionalData?.() || {};
            const popupMap = additionalData.askAiPopupLinks;
            if (popupMap && typeof popupMap === "object")
            {
                for (const popupId of Object.keys(popupMap))
                {
                    const popupRecord = popupMap[popupId];
                    if (!popupRecord) continue;
                    if (!popupRecord.lifecycle || !popupRecord.lifecycle.lastModified)
                    {
                        const stampedAt = new Date();
                        popupRecord.lifecycle =
                        {
                            creationDate: stampedAt,
                            lastModified: stampedAt,
                        };
                    }
                    // Popups carry a plain lifecycle object (no getLifecycle
                    // accessor), so the shared helper can't be reused here.
                    if (sinceMilliseconds > 0
                        && !(new Date(popupRecord.lifecycle.lastModified).getTime() > sinceMilliseconds))
                    {
                        continue;
                    }
                    gatheredChanges[popupId] =
                    {
                        entityId:   popupId,
                        entityType: entityTypes.ASK_AI_POPUP_LINK,
                        data:
                        {
                            id:            popupId,
                            deckId:        deck.getId(),
                            title:         popupRecord.title         || "",
                            content:       popupRecord.content       || "",
                            promptMode:    popupRecord.promptMode,
                            savedAtMillis: popupRecord.savedAtMillis || Date.now(),
                            lifecycle:     popupRecord.lifecycle,
                        },
                        deleted:    false,
                    };
                }
            }

            // Content overlays live in this deck's additionalData for exactly
            // the same reason as popup records, and sync as their own entity
            // too — so a full local->server resync has to ship them or the
            // learner's edits would be dropped on wipe recovery. The stored
            // record is already the wire shape, so it ships as-is.
            for (const overlayRecord of ContentOverlayStore.collectAllRecords(deck))
            {
                if (!overlayRecord || typeof overlayRecord.id !== "string")
                {
                    continue;
                }

                const overlayLastModified = overlayRecord.lifecycle?.lastModified;
                if (sinceMilliseconds > 0
                    && overlayLastModified
                    && !(new Date(overlayLastModified).getTime() > sinceMilliseconds))
                {
                    continue;
                }

                gatheredChanges[overlayRecord.id] =
                {
                    entityId:   overlayRecord.id,
                    entityType: entityTypes.CONTENT_OVERLAY,
                    data:       overlayRecord,
                    deleted:    false,
                };
            }
        }

        console.log(`[SyncApplier] gathered ${allDecks.length - orphanCount} decks, ${totalCards} cards, ${totalStudyMaterials} study materials, ${totalMockTests} mock tests${orphanCount > 0 ? ` (skipped ${orphanCount} local orphan deck(s) — queued as deletions)` : ""}.`);
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
     * Drops every deck parked by #applyDeckChangesInOrder without applying or
     * tombstoning it. Called when the drain that parked them is abandoned (a
     * failed cycle, or a bulk snapshot replacing the tree wholesale) so stale
     * deck data can never leak into an unrelated later cycle.
     */
    static clearDeferredOrphanDecks()
    {
        if (SyncApplier.#deferredOrphanDeckDataById.size > 0)
        {
            console.warn(`[SyncApplier] Discarding ${SyncApplier.#deferredOrphanDeckDataById.size} deferred deck(s) — the drain that parked them is no longer running.`);
        }
        SyncApplier.#deferredOrphanDeckDataById.clear();
    }

    /**
     * Applies the queued deck-data array in dependency order so a child
     * deck whose parent is in the same batch isn't created before its
     * parent. Orphans (whose parent exists neither locally nor in the
     * batch) are queued as deletion tombstones via SyncTransport — the
     * next push tells the server to remove them and the server-side
     * cascade ensures every device converges on the same state — unless
     * bDeferUnresolvedDecks says the drain still has chunks to deliver, in
     * which case they are parked for the next cycle instead.
     */
    static #applyDeckChangesInOrder(deckDataArray, dirtyDeckIds, bDeferUnresolvedDecks = false)
    {
        // Decks parked by an earlier chunk go back in at the head of the batch,
        // then this cycle's decks overwrite any duplicate id — the incoming
        // copy is always the fresher one. Taking ownership of the buffer here
        // means a cycle that resolves everything leaves it empty without any
        // separate bookkeeping.
        const pendingDeckDataById = new Map(SyncApplier.#deferredOrphanDeckDataById);
        SyncApplier.#deferredOrphanDeckDataById = new Map();

        // Deck data with no usable id can't be keyed, and collapsing several of
        // them onto a single `undefined` key would silently drop all but the
        // last. They bypass the dedup and go straight into the batch, where the
        // existing per-deck apply handles (and logs) them exactly as before.
        const unkeyableDeckDataArray = [];

        for (let deckIndex = 0; deckIndex < deckDataArray.length; deckIndex++)
        {
            const incomingDeckData = deckDataArray[deckIndex];
            if (typeof incomingDeckData.id === "string" && incomingDeckData.id.length > 0)
            {
                pendingDeckDataById.set(incomingDeckData.id, incomingDeckData);
            }
            else
            {
                unkeyableDeckDataArray.push(incomingDeckData);
            }
        }

        const remaining = [...pendingDeckDataById.values(), ...unkeyableDeckDataArray];
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

        if (remaining.length > 0 && bDeferUnresolvedDecks)
        {
            // Mid-drain: the parent may simply belong to a later chunk. Park
            // these and retry them next cycle rather than tombstoning a deck
            // (and, via the server-side cascade, every card under it) that is
            // about to become attachable.
            for (let remainingIndex = 0; remainingIndex < remaining.length; remainingIndex++)
            {
                const deferredDeckData = remaining[remainingIndex];
                if (typeof deferredDeckData.id === "string" && deferredDeckData.id.length > 0)
                {
                    SyncApplier.#deferredOrphanDeckDataById.set(deferredDeckData.id, deferredDeckData);
                }
            }
            console.warn(`[SyncApplier] ${remaining.length} deck(s) deferred to the next drain chunk — parent not delivered yet.`);
            return;
        }

        if (remaining.length > 0)
        {
            // Orphans: parent exists neither locally nor in this batch.
            // The missing parent is almost always a deck that was deleted
            // on another device without its descendants being cascaded
            // (historical bug — server-side cascade now prevents new
            // occurrences). Queue a deletion tombstone for each orphan
            // so the next push instructs the server to remove it. We
            // bypass the SyncEvents.ENTITY_DELETED event because its
            // handler in SyncOrchestrator gates on #bApplyingServerChanges
            // (true right now) and would drop our tombstone.
            console.warn(`[SyncApplier] ${remaining.length} orphan deck(s) detected — queuing deletion tombstones (parent not found locally or in batch).`);
            for (let remainingIndex = 0; remainingIndex < remaining.length; remainingIndex++)
            {
                const orphan = remaining[remainingIndex];
                console.warn(`[SyncApplier]   • deck "${orphan.name}" (${orphan.id}) — missing parent ${orphan.parent}`);
                SyncTransport.setPendingChange(orphan.id,
                {
                    entityId: orphan.id,
                    entityType: entityTypes.DECK,
                    data: null,
                    deleted: true,
                });
            }
        }
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

            // Mirror the server's additionalData wholesale so things
            // like lastAnalysisTopics, autoGenerateCuratedStudyEnabled
            // and ask-AI preferences propagate. Last-write-wins is
            // safe — the lifecycle gate above already ensured the
            // server's view is newer than the local one.
            //
            // Carve-out: the entity-channel slots (askAiPopupLinks,
            // contentOverlays). Those records live under the deck on disk but
            // sync as standalone entities, and Deck.toSyncJson strips them from
            // every deck push — so the server's copy of these slots is
            // intentionally empty. Taking the server's view as the source of
            // truth would wipe the local map every time the deck updated for
            // any unrelated reason (a rename, an analysis stamp). Preserve
            // whatever the local deck holds; each record's own sync channel
            // keeps it correct.
            const localExistingAdditionalData = existingDeck.getAdditionalData() || {};
            const incomingAdditionalData = { ...(deckData.additionalData || {}) };
            for (const entityChannelKey of SyncApplier.ENTITY_CHANNEL_ADDITIONAL_DATA_KEYS)
            {
                if (localExistingAdditionalData[entityChannelKey])
                {
                    incomingAdditionalData[entityChannelKey] = localExistingAdditionalData[entityChannelKey];
                }
            }
            existingDeck.setAdditionalData(incomingAdditionalData);

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
            // Deck pushes don't embed study materials anymore — they
            // sync as standalone entities. `deckData.studyMaterials`
            // is therefore undefined on post-refactor pushes; left as
            // an array fallback so legacy server docs (created before
            // the field was stripped from toSyncJson) also load.
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

        const existingMaterials = targetDeck.getStudyMaterials(false, true);
        const existing = existingMaterials.find(material => material.getId() === studyMaterialData.id);

        if (existing)
        {
            const serverLastModified = new Date(studyMaterialData.lifecycle.lastModified);
            const localLastModified  = existing.getLifecycle().getLastModified();

            if (serverLastModified <= localLastModified)
            {
                return;
            }

            // Replace the material wholesale rather than patching #content
            // in place. The old setContent() path updated ONLY the content
            // field and left additionalData (the curated lifecycle fields —
            // batchReviewState / sessionOutcome / generatedForAnalysisAt),
            // detailLevel and syllabusPosition stale, so server-driven batch
            // transitions (LIVE → SUPERSEDED / ARCHIVED from an auto-replace
            // or a regen on another device) never landed on the client. Worse,
            // setContent() calls lifecycle.touch(), bumping local lastModified
            // PAST the server's — so the stale LIVE state could be pushed back
            // up on the next sync and resurrect a batch the server had retired.
            // Mirrors #applyCardChange / #applyMockTestChange.
            targetDeck.removeStudyMaterial(existing);
        }

        const material = StudyMaterial.fromJson(studyMaterialData);
        targetDeck.addStudyMaterial(material);

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
