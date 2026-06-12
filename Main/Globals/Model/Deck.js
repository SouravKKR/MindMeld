import { getRandomUuid } from "../UtilityFunctions/GetRandomUuid.js";
import { serialize, deserialize } from "../../ThirdParty/Bson/bson.js";
import Persistence from "../Classes/Persistence.js";
import { dataFormats } from "../Enumerations/DataFormats.js";
import DeckEvents from "../Events/DeckEvents.js";
import Card from "./Card.js";
import Progress from "./Progress.js";
import Platform from "../Classes/Platform.js";
import { platforms } from "../Enumerations/Platforms.js";
import NativeDialog from "../Classes/NativeDialog.js";
import { download } from "../UtilityFunctions/Download.js";
import { gzipSync, gunzipSync } from "../../ThirdParty/Compression/gzip.js";
import DialogBox from "../../CommonComponents/DialogBox.js";
import ProgressDialog from "../../CommonComponents/ProgressDialog.js";
import Lifecycle from "./Lifecycle.js";
import StudyMaterial from "./StudyMaterial.js";
import MockTest from "./MockTest.js";
import SyncEvents from "../Events/SyncEvents.js";
import SyncTransport from "../Classes/Syncing/SyncTransport.js";
import SyncOrchestrator from "../Classes/Syncing/SyncOrchestrator.js";
import { entityTypes } from "../Enumerations/EntityTypes.js";
import UserIdentityEvents from "../Events/UserIdentityEvents.js";
import UserIdentityManager from "../Classes/UserIdentityManager.js";
import AutoAnalysisDeckFields from "../Classes/Analysis/AutoAnalysisDeckFields.js";
import CuratedFlashcardFields from "../Classes/Analysis/CuratedFlashcardFields.js";
import CuratedStudyMaterialFields from "../Classes/Analysis/CuratedStudyMaterialFields.js";
import CuratedStudyMaterialMigration from "../Classes/Analysis/CuratedStudyMaterialMigration.js";
import BrowserLlmDownloadConstants from "../Constants/BrowserLlmDownloadConstants.js";
import SearchableDropdown from "../../CommonComponents/SearchableDropdown.js";
import InitializationEvents from "../Events/InitializationEvents.js";

class Deck
{

    static #current = null;
    static #root = null;
    static #idMap = new Map();
    static #bBooting = false;
    static #importBaseTimeMilliseconds = null;
    static #importNextOffsetMilliseconds = 0;

    #id = "";
    #name = "";
    #shortName = "";
    #tags = [];
    #cards = new Map();
    #studyMaterials = new Map();
    #mockTests = new Map();
    #lifecycle = null;
    #subDecks = [];
    #parent = null;
    #additionalData = {};
    
    static
    {
        // Boot/refresh decks whenever the active user identity changes.
        // The first change after app start (anonymous OR named user)
        // performs the initial load. Subsequent changes (login/logout,
        // switching accounts) clear in-memory state first so we never
        // leak the previous user's decks into the new identity.
        window.addEventListener(UserIdentityEvents.CHANGED, () =>
        {
            Deck.#bootForCurrentIdentity();
        });
    }

    /**
     * Clears every Deck reference held in memory. Called when the user
     * identity changes so the next #bootForCurrentIdentity loads fresh
     * data from the new identity's storage namespace.
     */
    static clearAllInMemory()
    {
        Deck.#root    = null;
        Deck.#current = null;
        Deck.#idMap   = new Map();
    }

    static async #bootForCurrentIdentity()
    {
        if (Deck.#bBooting)
        {
            return;
        }

        Deck.#bBooting = true;
        Deck.clearAllInMemory();

        // Login is enforced at the app entry point — an anonymous identity
        // means the user is being routed to the login gate and has nothing
        // to load. Skip the deck bootstrap entirely and fire COMPLETE so
        // the initialization overlay clears immediately, revealing the
        // login page rather than sitting on a frozen progress bar.
        if (UserIdentityManager.isAnonymous())
        {
            Deck.#bBooting = false;
            window.dispatchEvent(new CustomEvent(InitializationEvents.COMPLETE));
            return;
        }

        window.dispatchEvent(new CustomEvent(InitializationEvents.PROGRESS, { detail: { fraction: 0.02, message: "Preparing your library…" } }));

        try
        {
            const bExists = await Persistence.exists("Decks/0.mmd");

            if (!bExists)
            {
                window.dispatchEvent(new CustomEvent(InitializationEvents.PROGRESS, { detail: { fraction: 0.5, message: "Setting up your library…" } }));

                const lifecycle = new Lifecycle(new Date(0), new Date(0), 0, 0, 0);
                Deck.#root = new Deck("0", "Root", "Root", [], [], lifecycle, [], [], [], null, {});
                await Deck.#root.save(true);
            }
            else
            {
                const startMilliseconds = performance.now();

                // Single-pass load with a running counter. Total deck
                // count is unknown without a separate read-everything-
                // first pass (which doubles disk I/O), so the bar uses
                // an asymptotic estimate: it climbs toward 0.95 as the
                // counter grows but never reaches 1.0 until the actual
                // INITIALIZATION_COMPLETE fires. Halving constant of 50
                // means: 25 decks → ~33%, 50 → 50%, 100 → 67%, 200 → 80%.
                let loadedCount = 0;
                const ASYMPTOTIC_HALVING_CONSTANT = 50;
                const progressCallback = () =>
                {
                    loadedCount++;
                    const asymptoticFraction = 0.05 + 0.90 * (loadedCount / (loadedCount + ASYMPTOTIC_HALVING_CONSTANT));
                    window.dispatchEvent(new CustomEvent(InitializationEvents.PROGRESS, {
                        detail: {
                            fraction: asymptoticFraction,
                            message: `Loading decks (${loadedCount} loaded)…`,
                        },
                    }));
                };

                Deck.#root = await Deck.load("0", true, progressCallback);
                console.log(`Loaded decks in ${performance.now() - startMilliseconds} ms`);
            }

            if (Deck.#root === null)
            {
                console.error("Root deck failed to initialise.");
                window.dispatchEvent(new CustomEvent(InitializationEvents.FAILED, { detail: { error: "Root deck failed to initialise." } }));
                return;
            }

            Deck.#current = Deck.#root;

            // Run one-shot curated-study migrations before announcing
            // boot-complete. Idempotent + gated by their own
            // localStorage flags, so re-runs are no-ops. Doing it here
            // means listeners reacting to InitializationEvents.COMPLETE
            // (e.g. the auto-analysis dispatcher, the entry dialog)
            // already see the migrated state.
            try
            {
                await CuratedStudyMaterialMigration.runIfNeeded();
            }
            catch (migrationError)
            {
                console.warn("[Deck.boot] CuratedStudyMaterialMigration.runIfNeeded threw:", migrationError);
            }

            window.dispatchEvent(new CustomEvent(DeckEvents.CREATE, { detail: { deck: Deck.#root } }));
            window.dispatchEvent(new CustomEvent(InitializationEvents.COMPLETE));
        }
        catch (error)
        {
            console.error("Failed to initialise deck storage.", error);
            window.dispatchEvent(new CustomEvent(InitializationEvents.FAILED, { detail: { error: error?.message || String(error) } }));
        }
        finally
        {
            Deck.#bBooting = false;
        }
    }

    /**
     * Returns the root deck. All decks are children of this deck.
     * @returns {Deck} The root deck.
     */
    static getRoot()
    {
        return Deck.#root;
    }

    /**
     * Retrieves a deck by its id.
     * @param {string} id - The id of the deck to retrieve.
     * @returns {Deck} The deck with the given id, or null if it does not exist.
     */
    static getById(id)
    {
        return Deck.#idMap.get(id);
    }

    static #storeInIdMap(deck)
    {
        Deck.#idMap.set(deck.getId(), deck);
    }

    static getAll(filter = (deck)=>{ return true; }, root = Deck.#root)
    {
        let allDecks = [];

        if(filter(root))
        {
            allDecks.push(root);
        }

        for(let subDeckIndex = 0; subDeckIndex < root.getSubDecks().length; subDeckIndex++)
        {
            allDecks = allDecks.concat(Deck.getAll(filter, root.getSubDecks()[subDeckIndex]));
        }

        return allDecks;
    }

    /**
     * Generates a unique id for a deck
     * @returns {string} A unique id for a deck
     */
    static generateId()
    {
        return getRandomUuid();
    }

    /**
     * Promotes the given deck to root and sets it as the current deck.
     * Used by the Force Pull bulk-snapshot path, which clears in-memory
     * state and reconstructs the tree from a server snapshot without
     * going through the standard `#bootForCurrentIdentity` flow.
     */
    static setRoot(deck)
    {
        Deck.#root    = deck;
        Deck.#current = deck;
    }

    /**
     * Returns the current deck being used.
     * @returns {Deck} The current deck being used.
     * @static
     */
    static getCurrentDeck()
    {
        return Deck.#current;
    }

    /**
     * Sets the current deck to the given deck.
     * @param {Deck} deck - The deck to set as the current deck.
     * @static
    */
    static setCurrentDeck(deck)
    {
        Deck.#current = deck;
    }
    
    /**
     * Returns true if the deck is the root deck, false otherwise.
     * @returns {boolean} True if the deck is the root deck, false otherwise.
     */
    isRoot()
    {
        return this.#id == "0";
    }
    
    /**
     * Returns the name of the deck.
     * @returns {string} The name of the deck
     */
    getName() 
    { 
        return this.#name; 
    }
    
    /**
     * Sets the name of the deck.
     * @param {string} name - The new name of the deck.
     */
    setName(name)
    {
        this.#name = name.substring(0, 45);
        this.#lifecycle?.touch();
    }

    getNameWithAncestors(bUseShortName = false, bIncludeRoot = true) 
    { 
        let parts = [];
        let deck = this;

        while (deck != null)
        {
            if (deck.isRoot())
            {
                if (!bIncludeRoot) 
                {
                    break; 
                }
            }
            const namePart = bUseShortName ? deck.getShortName() : deck.getName();

            parts.unshift(namePart);
            deck = deck.getParent();
        }
        
        return parts.join("->");
    }

    /**
     * Returns the shorter name for the deck.
     * @returns {string} The shorter name for the deck.
     */
    getShortName() 
    { 
        return this.#shortName; 
    }

    /**
     * Sets the shorter name for the deck.
     * @param {string} name - The new shorter name for the deck.
     */
    setShortName(name)
    {
        this.#shortName = name.substring(0, 16);
        this.#lifecycle?.touch();
    }

    /**
     * Returns the id of the deck.
     * @returns {string} The id of the deck.
     */
    getId()
    {
        return this.#id;
    }
    
    /**
     * Returns the tags associated with the deck.
     * @returns {string[]} Tags associated with the deck.
     */
    getTags()
    {
        return this.#tags;
    }

    /**
     * Sets the tags associated with the deck to the given tags.
     * This function also removes any duplicate tags from the given array.
     * @param {string[]} tags - The tags to associate with the deck.
     */
    setTags(tags)
    {
        this.#tags = Array.from(new Set(tags.map(tag => tag.trim())));
        this.#lifecycle?.touch();
    }
    
    /**
     * Returns the subdecks that are part of the deck, sorted by their
     * syllabusPosition (set by the server when generating from a syllabus).
     * Sub-decks without a position fall to the end in insertion order.
     * @returns {Deck[]} The subdecks that are part of the deck.
     */
    getSubDecks()
    {
        return [...this.#subDecks].sort((firstDeck, secondDeck) =>
        {
            const firstPosition = firstDeck.getAdditionalData()?.syllabusPosition;
            const secondPosition = secondDeck.getAdditionalData()?.syllabusPosition;

            const firstResolved = typeof firstPosition === "number" ? firstPosition : Infinity;
            const secondResolved = typeof secondPosition === "number" ? secondPosition : Infinity;

            if (firstResolved !== secondResolved)
            {
                return firstResolved - secondResolved;
            }

            const firstCreatedAt = firstDeck.getLifecycle()?.getCreationDate()?.getTime() ?? 0;
            const secondCreatedAt = secondDeck.getLifecycle()?.getCreationDate()?.getTime() ?? 0;
            return firstCreatedAt - secondCreatedAt;
        });
    }

    /**
     * Returns the parent of the deck.
     * @returns {Deck|null} The parent of the deck, or null if the deck does not have a parent.
     */
    getParent()
    {
        return this.#parent;
    }

    /**
     * Returns the lifecycle of the deck.
     * @returns {Lifecycle} The lifecycle of the deck.
     */
    getLifecycle()
    {
        return this.#lifecycle;
    }

    /**
     * Adds a card to the deck.
     * @param {Card} card - The card to add to the deck.
     */
    addCard(card)
    {
        // Same re-stamp as addStudyMaterial — keeps card.getDeck() reliable
        // even when the persisted JSON carried a stale deckId.
        card.setDeckId(this.#id);
        this.#cards.set(card.getId(), card);
    }
    
    removeCard(card)
    {
        this.#cards.delete(card.getId());
    }
    
    /**
     * Retrieves all cards in the deck, optionally including cards from subdecks.
     * Curated flashcards (additionalData.bCurated === true) are excluded by
     * default so the standard FSRS / Spaced Repetition / Mastery surfaces
     * never accidentally consume them. Pass bIncludeCurated=true (or use
     * getCuratedCards) when curated cards are actually wanted.
     * @param {boolean} bRecursive - Whether to include cards from subdecks.
     * @param {boolean} bIncludeCurated - Whether curated flashcards are
     *   returned alongside regular cards. Defaults to false.
     * @returns {Card[]} An array of cards in the deck.
     */
    getCards(bRecursive = true, bIncludeCurated = false)
    {
        const ownCards = Array.from(this.#cards.values());
        const allCards = bRecursive
            ? ownCards.concat(this.#subDecks.flatMap((subDeck) => subDeck.getCards(bRecursive, bIncludeCurated)))
            : ownCards;

        const filteredCards = bIncludeCurated
            ? allCards
            : allCards.filter((card) => card.getAdditionalData()?.[CuratedFlashcardFields.B_CURATED] !== true);

        return filteredCards.sort((firstCard, secondCard) =>
            (firstCard.getAdditionalData()?.syllabusPosition ?? Infinity) -
            (secondCard.getAdditionalData()?.syllabusPosition ?? Infinity)
        );
    }

    getCardCount(bRecursive = true, bIncludeCurated = false)
    {
        return this.getCards(bRecursive, bIncludeCurated).length;
    }

    hasCard(card)
    {
        return this.hasCardWithId(card.getId());
    }

    hasCardWithId(id)
    {
        return this.#cards.has(id);
    }

    getDueCardCount(bRecursive = true, bIncludeCurated = false)
    {
        return this.getCards(bRecursive, bIncludeCurated).filter(card => card.isDue()).length;
    }

    /**
     * Retrieves only curated flashcards (those carrying
     * additionalData.bCurated === true). Optionally narrows to a single
     * batch via batchTag (matched against
     * additionalData.generatedForAnalysisAt). Used by CuratedStudySession
     * and the archive view.
     */
    getCuratedCards(batchTag = null, bRecursive = true)
    {
        const allCuratedCards = this.getCards(bRecursive, true).filter((card) => card.getAdditionalData()?.[CuratedFlashcardFields.B_CURATED] === true);
        if (batchTag === null)
        {
            return allCuratedCards;
        }
        return allCuratedCards.filter((card) => card.getAdditionalData()?.[CuratedFlashcardFields.GENERATED_FOR_ANALYSIS_AT] === batchTag);
    }

    /**
     * Retrieves only curated study materials (those for which
     * StudyMaterial.isCurated() is true). Optionally narrows to a single
     * batch via batchTag.
     */
    getCuratedStudyMaterials(batchTag = null, bRecursive = true)
    {
        const allCuratedMaterials = this.getStudyMaterials(bRecursive, true).filter((material) => material.isCurated());
        if (batchTag === null)
        {
            return allCuratedMaterials;
        }
        return allCuratedMaterials.filter((material) => material.getAdditionalData()?.[CuratedStudyMaterialFields.GENERATED_FOR_ANALYSIS_AT] === batchTag);
    }

    addStudyMaterial(studyMaterial)
    {
        // Re-stamp deckId on every insertion so a stale value on the
        // incoming entity (e.g. loaded from an older persistence file
        // that predated a rename / merge) can't outlive this call. Keeps
        // StudyMaterial.getDeck() reliable for downstream save()/view().
        studyMaterial.setDeckId(this.#id);
        this.#studyMaterials.set(studyMaterial.getId(), studyMaterial);
    }

    removeStudyMaterial(studyMaterial)
    {
        this.#studyMaterials.delete(studyMaterial.getId());
    }

    /**
     * Retrieves all study materials in the deck.
     * Order: own materials (sorted by syllabusPosition) first, then materials
     * from each subdeck (in deck-tree order via getSubDecks()) recursively.
     * Mirrors getCards() so the Browser page shows the same tree-traversal
     * order regardless of which entity type is being viewed.
     *
     * Curated study materials (StudyMaterial.isCurated() === true) are
     * excluded by default so generic surfaces (Content Study, Browser,
     * detail-level picker, AskAi context) never accidentally consume
     * them. Pass bIncludeCurated=true (or use getCuratedStudyMaterials)
     * when curated materials are actually wanted.
     */
    getStudyMaterials(bRecursive = true, bIncludeCurated = false)
    {
        const ownMaterialsAll = Array.from(this.#studyMaterials.values()).sort((firstMaterial, secondMaterial) =>
        {
            const firstPosition = firstMaterial.getSyllabusPosition() ?? Infinity;
            const secondPosition = secondMaterial.getSyllabusPosition() ?? Infinity;

            if (firstPosition !== secondPosition)
            {
                return firstPosition - secondPosition;
            }

            const firstCreatedAt = firstMaterial.getLifecycle()?.getCreationDate()?.getTime() ?? 0;
            const secondCreatedAt = secondMaterial.getLifecycle()?.getCreationDate()?.getTime() ?? 0;
            return firstCreatedAt - secondCreatedAt;
        });

        const ownMaterials = bIncludeCurated
            ? ownMaterialsAll
            : ownMaterialsAll.filter((material) => !material.isCurated());

        if (!bRecursive)
        {
            return ownMaterials;
        }

        return ownMaterials.concat(
            this.getSubDecks().flatMap((subDeck) => subDeck.getStudyMaterials(true, bIncludeCurated))
        );
    }

    /**
     * Returns the distinct detail-level enum values present across this
     * deck's study materials. Used by the Content Study launcher to decide
     * whether the detail-level picker dialog needs to appear at all.
     */
    getAvailableStudyMaterialDetailLevels(bRecursive = true)
    {
        const materials = this.getStudyMaterials(bRecursive);
        const detailLevelSet = new Set();

        for (const material of materials)
        {
            const detailLevel = material.getDetailLevel?.();
            if (typeof detailLevel === "number")
            {
                detailLevelSet.add(detailLevel);
            }
        }

        return Array.from(detailLevelSet).sort((firstLevel, secondLevel) => firstLevel - secondLevel);
    }

    addMockTest(mockTest)
    {
        // Same re-stamp as addCard / addStudyMaterial — keeps
        // mockTest.getDeck() reliable across stale persistence files.
        mockTest.setDeckId(this.#id);
        this.#mockTests.set(mockTest.getId(), mockTest);
    }

    removeMockTest(mockTest)
    {
        this.#mockTests.delete(mockTest.getId());
    }

    /**
     * Retrieves all mock tests in the deck.
     * Order: own mock tests first, then mock tests from each subdeck in deck-tree
     * order (subdecks come from getSubDecks() which is sorted by syllabusPosition).
     */
    getMockTests(bRecursive = true)
    {
        const ownMockTests = Array.from(this.#mockTests.values()).sort((firstMockTest, secondMockTest) =>
        {
            const firstCreatedAt = firstMockTest.getLifecycle()?.getCreationDate()?.getTime() ?? 0;
            const secondCreatedAt = secondMockTest.getLifecycle()?.getCreationDate()?.getTime() ?? 0;
            return firstCreatedAt - secondCreatedAt;
        });

        if (!bRecursive)
        {
            return ownMockTests;
        }

        return ownMockTests.concat(
            this.getSubDecks().flatMap((subDeck) => subDeck.getMockTests(true))
        );
    }

    /**
     * Sets the parent of the deck.
     * @param {Deck} parent - The parent of the deck.
     */
    setParent(parent)
    {
        if(!parent || this.#parent === parent)
        {
            return;
        }

        const oldParent = this.#parent;

        if(oldParent)
        {
            oldParent.removeSubDeck(this);
        }

        this.#parent = parent;

        // Bump lastModified so the next sync push carries the new parent
        // through to other devices. Without this, bulkUpsert on the server
        // and #applyDeckChange on peer devices both skip the change as a
        // no-op (incoming lifecycle == stored lifecycle), and the move
        // silently fails to propagate.
        this.#lifecycle?.touch();
    }

    /**
     * Adds a subdeck to the deck.
     * @param {Deck} deck - The subdeck to add to the deck.
     */
    addSubDeck(deck)
    {
        if(!deck)
        {
            console.error("Undefined subDeck added", this.getId());
            return;
        }

        if(this.#subDecks.includes(deck))
        {
            return;
        }

        this.#subDecks.push(deck);

        if(deck.getParent() !== this)
        {
            deck.setParent(this);
        }
    }
    
    removeSubDeck(deck)
    {
        this.#subDecks = this.#subDecks.filter((subDeck) => subDeck.getId() != deck.getId());
    }

    /**
     * Returns true when `potentialAncestor` appears anywhere up this deck's
     * parent chain. Used by the merge flow to refuse a drop that would
     * create a cycle (e.g. dragging a parent onto its own descendant).
     * Thin alias over the existing `isChildOf` walker so callers can read
     * the intent at the call site.
     */
    isDescendantOf(potentialAncestor)
    {
        if (!potentialAncestor)
        {
            return false;
        }
        return this.isChildOf(potentialAncestor, true);
    }

    /**
     * Folds `sourceDeck` into `this`. All cards, study materials, mock tests,
     * and sub-decks owned by the source are moved onto the target; mergeable
     * scalar fields (tags, additionalData entries) are unioned; conflicts the
     * caller already resolved through the merge-flow modals arrive via
     * `resolutions`. After everything moves the source is deleted via
     * `Deck.delete()` — but because its child maps are empty by then, the
     * delete cascade only fires `ENTITY_DELETED` for the source deck itself,
     * not for the transferred entities.
     *
     * The target's `lifecycle.creationDate` is never touched — only
     * `lastModified` bumps where the setters used internally already call
     * `lifecycle.touch()`.
     *
     * @param {Deck} sourceDeck - The deck whose contents move into `this`.
     * @param {object} resolutions - Optional conflict resolutions:
     *   { name?: string, shortName?: string, additionalData?: object }
     */
    async mergeFrom(sourceDeck, resolutions = {})
    {
        if (!sourceDeck || sourceDeck === this)
        {
            return;
        }

        if (this.isDescendantOf(sourceDeck))
        {
            throw new Error("Cannot merge an ancestor into one of its descendants (would create a cycle).");
        }

        // Hold the sync mutex for the duration of the merge. Without
        // this, a debounced or periodic sync cycle can fire between any
        // of the awaits below (sub-deck saves, the target save, the
        // source delete) and push a snapshot where the target has the
        // moved children but the source is still alive — and the
        // eventual delete fires its tombstones in a separate cycle. End
        // state converges (idempotent deletes, last-write-wins upserts)
        // but the intermediate window is visible to every other device
        // on the account, which is jarring. Holding the mutex makes the
        // merge atomic from sync's perspective: the next cycle to run
        // observes only the final post-merge state.
        const releaseSyncMutex = await SyncOrchestrator.acquireSyncMutex();

        try
        {
            await this.#mergeFromUnsynced(sourceDeck, resolutions);
        }
        finally
        {
            releaseSyncMutex();
        }

        // Released before scheduling so the about-to-fire sync cycle
        // can take the mutex immediately. The ENTITY_CHANGED /
        // ENTITY_DELETED events dispatched inside #mergeFromUnsynced
        // landed in pendingChanges via the usual handler path (the gate
        // doesn't apply outside an apply phase), so they'll all be
        // picked up by the next debounced cycle.
        SyncOrchestrator.scheduleDebouncedSync();
    }

    /**
     * Inner body of mergeFrom, factored out so the public wrapper can
     * hold the sync mutex around a single try/finally without nesting
     * the existing logic three levels deep.
     */
    async #mergeFromUnsynced(sourceDeck, resolutions)
    {
        // ── Move cards ───────────────────────────────────────────────
        const sourceCards = Array.from(sourceDeck.#cards.values());
        for (const movingCard of sourceCards)
        {
            sourceDeck.removeCard(movingCard);
            movingCard.setDeckId(this.getId());
            movingCard.getLifecycle()?.touch();
            this.addCard(movingCard);

            window.dispatchEvent(new CustomEvent(SyncEvents.ENTITY_CHANGED,
            {
                detail:
                {
                    entityId: movingCard.getId(),
                    entityType: entityTypes.CARD,
                    data: movingCard.toJson()
                }
            }));
        }

        // ── Move study materials ─────────────────────────────────────
        const sourceStudyMaterials = Array.from(sourceDeck.#studyMaterials.values());
        for (const movingMaterial of sourceStudyMaterials)
        {
            sourceDeck.removeStudyMaterial(movingMaterial);
            movingMaterial.setDeckId(this.getId());
            movingMaterial.getLifecycle()?.touch();
            this.addStudyMaterial(movingMaterial);

            window.dispatchEvent(new CustomEvent(SyncEvents.ENTITY_CHANGED,
            {
                detail:
                {
                    entityId: movingMaterial.getId(),
                    entityType: entityTypes.STUDY_MATERIAL,
                    data: movingMaterial.toJson()
                }
            }));
        }

        // ── Move mock tests ──────────────────────────────────────────
        const sourceMockTests = Array.from(sourceDeck.#mockTests.values());
        for (const movingMockTest of sourceMockTests)
        {
            sourceDeck.removeMockTest(movingMockTest);
            movingMockTest.setDeckId(this.getId());
            movingMockTest.getLifecycle()?.touch();
            this.addMockTest(movingMockTest);

            window.dispatchEvent(new CustomEvent(SyncEvents.ENTITY_CHANGED,
            {
                detail:
                {
                    entityId: movingMockTest.getId(),
                    entityType: entityTypes.MOCK_TEST,
                    data: movingMockTest.toJson()
                }
            }));
        }

        // ── Reparent sub-decks ───────────────────────────────────────
        // setParent() already removes from the old parent's #subDecks
        // and bumps the moving deck's lifecycle. addSubDeck() pushes
        // onto the new parent's list and is idempotent.
        const sourceSubDecks = [...sourceDeck.#subDecks];
        for (const movingSubDeck of sourceSubDecks)
        {
            movingSubDeck.setParent(this);
            this.addSubDeck(movingSubDeck);
            await movingSubDeck.save(false);
        }

        // ── Merge tags (Set union, only persist when the union differs) ─
        const existingTagSet = new Set(this.#tags);
        const sourceTagSet = new Set(sourceDeck.getTags() || []);
        let unionGrew = false;
        for (const incomingTag of sourceTagSet)
        {
            if (!existingTagSet.has(incomingTag))
            {
                existingTagSet.add(incomingTag);
                unionGrew = true;
            }
        }
        if (unionGrew)
        {
            this.setTags(Array.from(existingTagSet));
        }

        // ── Apply user-chosen scalar resolutions ─────────────────────
        if (typeof resolutions.name === "string" && resolutions.name !== this.#name)
        {
            this.setName(resolutions.name);
        }
        if (typeof resolutions.shortName === "string" && resolutions.shortName !== this.#shortName)
        {
            this.setShortName(resolutions.shortName);
        }

        // ── Merge additionalData ─────────────────────────────────────
        const mergedAdditionalData = Deck.#mergeAdditionalData(
            this.#additionalData || {},
            sourceDeck.getAdditionalData() || {},
            resolutions.additionalData || null
        );
        if (Deck.#additionalDataDiffers(this.#additionalData || {}, mergedAdditionalData))
        {
            for (const fieldKey of Object.keys(mergedAdditionalData))
            {
                this.setAdditionalDataField(fieldKey, mergedAdditionalData[fieldKey]);
            }
        }

        // ── Persist target then delete source ────────────────────────
        await this.save(false);

        // After the cards/materials/mocktests/subdecks have all moved out,
        // the source's internal maps are empty — so Deck.delete()'s cascade
        // fires ENTITY_DELETED only for the source deck itself.
        await sourceDeck.delete();
    }

    static #mergeAdditionalData(targetData, sourceData, userResolutions)
    {
        const mergedResult = { ...targetData };
        const allKeys = new Set([...Object.keys(targetData), ...Object.keys(sourceData)]);

        for (const fieldKey of allKeys)
        {
            const hasTarget = Object.prototype.hasOwnProperty.call(targetData, fieldKey);
            const hasSource = Object.prototype.hasOwnProperty.call(sourceData, fieldKey);

            // User explicitly chose this field via the resolutions modal.
            if (userResolutions && Object.prototype.hasOwnProperty.call(userResolutions, fieldKey))
            {
                mergedResult[fieldKey] = userResolutions[fieldKey];
                continue;
            }

            if (hasSource && !hasTarget)
            {
                mergedResult[fieldKey] = sourceData[fieldKey];
            }
            // If both decks carry the same value, keep target's. If they
            // differ and the resolutions modal didn't surface them, the
            // target's value wins by default — the source is being absorbed,
            // not preserved.
        }

        return mergedResult;
    }

    static #additionalDataDiffers(firstData, secondData)
    {
        const firstKeys = Object.keys(firstData);
        const secondKeys = Object.keys(secondData);
        if (firstKeys.length !== secondKeys.length)
        {
            return true;
        }
        for (const fieldKey of firstKeys)
        {
            if (firstData[fieldKey] !== secondData[fieldKey])
            {
                return true;
            }
        }
        return false;
    }

    /**
     * Returns the per-deck `additionalData` blob. Used for ad-hoc flags
     * (e.g. `bCreatedDuringTutorial` consumed by TutorialEntityCleanup).
     */
    getAdditionalData()
    {
        return this.#additionalData;
    }

    /**
     * Sets a single field inside the deck's `additionalData` object. Bumps
     * lifecycle.lastModified so the next sync push includes the change.
     */
    setAdditionalDataField(key, value)
    {
        if (!this.#additionalData)
        {
            this.#additionalData = {};
        }

        this.#additionalData[key] = value;
        this.#lifecycle?.touch();
    }

    /**
     * Replaces the deck's `additionalData` blob wholesale. Used by the
     * sync apply path to mirror what the server has after a remote edit
     * (e.g. an AskAi popup link inserted on another device — the popup
     * record lives under `additionalData.askAiPopupLinks` and would
     * otherwise never propagate, because the incremental deck-update
     * path historically only synced name / tags / parent / lifecycle).
     *
     * Touches lifecycle to stay consistent with the other setters; the
     * sync applier explicitly overwrites lastModified to the server's
     * timestamp right after calling this so the touch doesn't trigger
     * a push-back loop.
     */
    setAdditionalData(data)
    {
        this.#additionalData = data || {};
        this.#lifecycle?.touch();
    }

    /**
     * Saves the deck to the local storage.
     * This function serializes the deck object to a JSON object,
     * then serializes the JSON object to a BSON object, and
     * finally writes the BSON object to the local storage at
     * `Decks/${this.getId()}.mmd` with the data format of
     * `dataFormats.BUFFER`.
     */
    async save(bRecursive = false, bSuppressDispatch = false)
    {
        // Paid decks persist + sync exactly like normal decks now. Their
        // sensitive card / material / mock-test CONTENT is stored as ciphertext
        // envelopes (encrypted by the server on the sync wire), so writing the
        // deck to local storage and queuing it for sync never exposes plaintext.
        // The deck node itself (name / structure / additionalData) is plaintext
        // by design — only the content fields are protected.
        const deckJson = this.toJson();
        const deckBson = serialize(deckJson);

        await Persistence.write(`Decks/${this.getId()}.mmd`, deckBson, dataFormats.BUFFER);

        // bSuppressDispatch exists so SyncApplier.flushDirtyDecks can
        // persist server-applied state to disk without firing an
        // ENTITY_CHANGED that SyncOrchestrator would queue as a
        // pending push — which would echo the server's own write back
        // to it on the next cycle. Every other caller (user edits,
        // import direct-queue, merge mutations) leaves it at the
        // default so the change reaches pendingChanges. With this
        // parameter in place, SyncOrchestrator's entity-event handlers
        // no longer need an apply-phase gate, which means user
        // mutations that happen to coincide with an in-flight apply
        // phase (deletes, edits, study-progress flushes from a card
        // attempt) are no longer silently dropped.
        if (!bSuppressDispatch)
        {
            window.dispatchEvent(new CustomEvent(SyncEvents.ENTITY_CHANGED,
            {
                detail:
                {
                    entityId: this.getId(),
                    entityType: entityTypes.DECK,
                    data: this.toSyncJson()
                }
            }));
        }

        if(bRecursive)
        {
            for(let subDeckIndex = 0; subDeckIndex < this.#subDecks.length; subDeckIndex++)
            {
                const subDeck = this.#subDecks[subDeckIndex];
                await subDeck.save(bRecursive, bSuppressDispatch);
            }
        }
    }

    static async load(deckId, bRecursive = false, progressCallback = null)
    {
        const deckBson = await Persistence.read(`Decks/${deckId}.mmd`, dataFormats.BUFFER);
        const deckJson = deserialize(deckBson);

        const cards = deckJson.cards.map((cardJson) => Card.fromJson(cardJson));
        const lifecycle = Lifecycle.fromJson(deckJson.lifecycle);
        const studyMaterials = deckJson.studyMaterials.map((studyMaterialJson) => StudyMaterial.fromJson(studyMaterialJson));
        const mockTests = (deckJson.mockTests || []).map((mockTestJson) => MockTest.fromJson(mockTestJson));

        const deck = new Deck(deckJson.id, deckJson.name, deckJson.shortName, deckJson.tags, cards, lifecycle, studyMaterials, mockTests, [], Deck.getById(deckJson.parent), deckJson.additionalData);

        if(progressCallback)
        {
            progressCallback();
        }

        if(bRecursive)
        {
            for(let subDeckIndex = 0; subDeckIndex < deckJson.subDecks.length; subDeckIndex++)
            {
                const subDeckId = deckJson.subDecks[subDeckIndex];
                const subDeck = await Deck.load(subDeckId, bRecursive, progressCallback);

                deck.addSubDeck(subDeck);
            }
        }

        return deck;
    }

    getExportData(options = { bRecursive: true, bRetainProgress: true, bRetainAutoAnalysisSettings: false }, decks = [], onDeckCollected = null)
    {
        // Defence in depth: never collect paid-deck content for export, even on a
        // direct programmatic call that bypasses export()'s user-facing gate.
        // Every paid node carries the paidDeckId tag, so this self-check —
        // propagated through the recursion below — aborts the whole export if any
        // node in the subtree is paid.
        if (this.#additionalData && this.#additionalData.paidDeckId)
        {
            throw new Error("Paid-deck content cannot be exported.");
        }

        const deckJson = this.toJson();

        // Curated study materials + curated flashcards are generated
        // per-user per-analysis. They reflect one user's gap-filling
        // pipeline and would be meaningless (or confusing) to anyone
        // importing the deck. Strip them unconditionally — there's no
        // valid case where exporting them helps. The repair pass on the
        // importing side would archive them anyway, but stripping at
        // export time also avoids leaking generation context (deck
        // chain, topic strength, etc.) to a third party.
        if (Array.isArray(deckJson.studyMaterials))
        {
            deckJson.studyMaterials = deckJson.studyMaterials.filter((material) =>
            {
                return material?.additionalData?.[CuratedStudyMaterialFields.B_CURATED] !== true;
            });
        }
        if (Array.isArray(deckJson.cards))
        {
            deckJson.cards = deckJson.cards.filter((card) =>
            {
                return card?.additionalData?.[CuratedFlashcardFields.B_CURATED] !== true;
            });
        }

        if(!options.bRetainProgress)
        {
            const cards = deckJson.cards;

            for(let cardIndex = 0; cardIndex < cards.length; cardIndex++)
            {
                cards[cardIndex].progress = new Progress().toJson();

                // Drop the per-user "marked for review" study flag so a
                // published / shared copy carries no personal study state.
                if (cards[cardIndex].additionalData && typeof cards[cardIndex].additionalData === "object")
                {
                    delete cards[cardIndex].additionalData.review;
                }
            }

            // Mock-test attempt history is "progress" for tests — the same
            // retain-progress toggle that wipes card FSRS state should also
            // wipe per-attempt answers/scores. The test definition itself
            // (items, marking scheme, duration) is preserved, but each
            // question's recorded answer / awarded score / examiner remarks
            // are attempt artifacts, so reset them too — only the authored
            // question + expected-answer content survives.
            const mockTests = Array.isArray(deckJson.mockTests) ? deckJson.mockTests : [];
            for(let mockTestIndex = 0; mockTestIndex < mockTests.length; mockTestIndex++)
            {
                mockTests[mockTestIndex].history = [];

                const items = Array.isArray(mockTests[mockTestIndex].items) ? mockTests[mockTestIndex].items : [];
                for (const item of items)
                {
                    if (item && typeof item === "object")
                    {
                        if ("answer" in item)  { item.answer = ""; }
                        if ("score" in item)   { item.score = 0; }
                        if ("remarks" in item) { item.remarks = ""; }
                    }
                }
            }
        }

        if (!options.bRetainAutoAnalysisSettings && deckJson.additionalData && typeof deckJson.additionalData === "object")
        {
            for (const analysisKey of AutoAnalysisDeckFields.getAllKeys())
            {
                if (analysisKey in deckJson.additionalData)
                {
                    delete deckJson.additionalData[analysisKey];
                }
            }
        }

        // Always strip the ask-AI preferences (document-grounding flag +
        // information-source list) from exports. They're per-account
        // context the importer has no use for — and the source list can
        // reference files only the original user has access to.
        if (deckJson.additionalData && typeof deckJson.additionalData === "object")
        {
            delete deckJson.additionalData[BrowserLlmDownloadConstants.DECK_PREFERENCES_FIELD_KEY];
        }

        decks.push(deckJson);

        if(typeof onDeckCollected === "function")
        {
            onDeckCollected(this);
        }

        if(options.bRecursive)
        {
            for(let subDeckIndex = 0; subDeckIndex < deckJson.subDecks.length; subDeckIndex++)
            {
                const subDeckId = deckJson.subDecks[subDeckIndex];
                const subDeck = Deck.getById(subDeckId);

                subDeck.getExportData(options, decks, onDeckCollected);
            }
        }

        return decks;
    }

    /**
     * Counts every deck (this one plus, optionally, all descendants).
     * Used by export() to set a denominator before the recursive walk runs.
     */
    getDeckCount(bRecursive = true)
    {
        let count = 1;

        if(bRecursive)
        {
            for(let subDeckIndex = 0; subDeckIndex < this.#subDecks.length; subDeckIndex++)
            {
                count += this.#subDecks[subDeckIndex].getDeckCount(true);
            }
        }

        return count;
    }
    
    getExportMetadata()
    {
        return {
            exportDate: new Date().toUTCString(),
            version: 1
        };
    }
    
    #isAnyAncestorOrSelfPaidLicensed()
    {
        let walker = this;
        while (walker !== null && walker !== undefined)
        {
            const walkerPaidDeckId = walker.getAdditionalData?.()?.paidDeckId;
            if (typeof walkerPaidDeckId === "string" && walkerPaidDeckId.length > 0)
            {
                return true;
            }
            walker = walker.getParent();
        }
        return false;
    }

    #hasAnyPaidDeckedDescendant()
    {
        const subDecks = this.getSubDecks();
        for (let subDeckIndex = 0; subDeckIndex < subDecks.length; subDeckIndex++)
        {
            const subDeck = subDecks[subDeckIndex];
            const subDeckPaidDeckId = subDeck.getAdditionalData?.()?.paidDeckId;
            if (typeof subDeckPaidDeckId === "string" && subDeckPaidDeckId.length > 0)
            {
                return true;
            }
            if (subDeck.#hasAnyPaidDeckedDescendant())
            {
                return true;
            }
        }
        return false;
    }

    async export(options = { bRecursive: true, bRetainProgress: true })
    {
        // Paid-deck content carries an upstream licence; exporting it
        // would surface plaintext encrypted-on-the-server material as a
        // freely-redistributable .emmd file. Block at the root and at
        // every descendant — covers the case where the user opens the
        // export from a deeper subdeck whose ancestor is paid.
        if (this.#isAnyAncestorOrSelfPaidLicensed() || this.#hasAnyPaidDeckedDescendant())
        {
            await DialogBox.alert
            (
                "Export blocked",
                "Paid decks can't be exported. Edits to a paid deck are stored on the server only."
            );
            return;
        }

        const progressDialog = ProgressDialog.show("Exporting Deck");

        try
        {
            const totalDeckCount = this.getDeckCount(options.bRecursive);
            let decksCollected = 0;

            await progressDialog.setProgressAndYield(0, `Collecting decks (0 / ${totalDeckCount})`);

            const metadata = this.getExportMetadata();
            const data = this.getExportData(options, [], () =>
            {
                decksCollected++;
                // 0 → 40% during collection. Update without yielding so the
                // sync recursion isn't stretched out unnecessarily; the next
                // await below gives the bar a chance to paint.
                const collectionFraction = (decksCollected / totalDeckCount) * 0.4;
                progressDialog.setProgress(collectionFraction, `Collecting decks (${decksCollected} / ${totalDeckCount})`);
            });

            await progressDialog.setProgressAndYield(0.4, "Serializing data");

            data[0].parent = null;

            const exportJson =
            {
                metadata: metadata,
                data: data
            };

            const exportBuffer = serialize(exportJson);

            await progressDialog.setProgressAndYield(0.7, "Compressing");

            const compressedExportBuffer = gzipSync(exportBuffer);

            await progressDialog.setProgressAndYield(0.9, "Saving file");

            if(Platform.get() == platforms.APP)
            {
                const directory = await NativeDialog.directorySelector(false);

                if(directory)
                {
                    console.log(`Exporting to directory ${directory[0].path}`);
                }
            }
            else if(Platform.get() == platforms.WEB)
            {
                download(compressedExportBuffer, `${this.getName()}.emmd`, "application/octet-stream");
            }

            await progressDialog.setProgressAndYield(1, "Done");
        }
        finally
        {
            progressDialog.close();
        }
    }

    async import()
    {
        if (this.#isAnyAncestorOrSelfPaidLicensed())
        {
            await DialogBox.alert
            (
                "Import blocked",
                "Paid decks can't accept imported content — every edit must go through the protected server flow."
            );
            return;
        }

        const file = await NativeDialog.fileSelector(false, [".emmd"]);

        const acknowledged = await DialogBox.confirm
        (
            "Copyright & IPR responsibility",
            "By importing this deck you confirm you have the right to use its contents and accept full responsibility for any copyright or intellectual-property implications of doing so. MindMeld does not verify the ownership of imported material."
        );

        if(!acknowledged)
        {
            return;
        }

        const progressDialog = ProgressDialog.show("Importing Deck");
        let bImportSucceeded = false;

        // Acquire the sync mutex for the entire tree-mutation portion
        // of the import. Without this, a concurrent forcePullFromServer
        // (which also takes this mutex) could land its
        // applyBulkSnapshot call between any of the awaits below — and
        // because applyBulkSnapshot runs Deck.clearAllInMemory() the
        // tree we're importing into vanishes mid-flight. The imported
        // root would attach to an orphaned `this` reference, and the
        // direct-queue loop at the end would walk a now-stale subtree.
        // Periodic sync cycles also acquire this mutex inside sync(),
        // so the price of this guard is that they sit queued while the
        // import runs — acceptable because the next debounced cycle
        // (scheduled below) pushes everything the moment we release.
        const releaseSyncMutex = await SyncOrchestrator.acquireSyncMutex();

        try
        {
            await progressDialog.setProgressAndYield(0.05, "Decompressing");
            const decompressedContent = gunzipSync(new Uint8Array(file.buffer));

            await progressDialog.setProgressAndYield(0.15, "Parsing data");
            const importJson = deserialize(decompressedContent);

            const deckJsons = importJson.data;
            const oldIdNewIdMap = new Map();
            const newIdJsonMap = new Map();
            const totalDeckCount = deckJsons.length;

            await progressDialog.setProgressAndYield(0.2, `Preparing ${totalDeckCount} deck${totalDeckCount === 1 ? "" : "s"}`);

            for(let deckIndex = 0; deckIndex < deckJsons.length; deckIndex++)
            {
                const deckJson = deckJsons[deckIndex];

                const oldId = deckJson.id;
                const newId = Deck.generateId();

                oldIdNewIdMap.set(oldId, newId);
                newIdJsonMap.set(newId, deckJson);

                deckJson.id = newId;

                if(deckJson.parent)
                {
                    if(oldIdNewIdMap.has(deckJson.parent))
                    {
                        deckJson.parent = oldIdNewIdMap.get(deckJson.parent);
                    }
                    else
                    {
                        deckJson.parent = this.getId();
                    }
                }

                // Re-stamp every child entity's id AND deckId.
                //
                // deckId remap keeps the child resolvable via Deck.getById on
                // the importer's side — without it StudyMaterial.getDeck()
                // returns undefined and save()/view() crashes the study
                // session.
                //
                // id regeneration makes "two imports of the same export file"
                // produce two genuinely independent decks at every level. The
                // deck doc already gets a fresh UUID above; before this fix
                // the children kept the exporter's UUIDs, which silently
                // collided with any tombstones a previous delete had left in
                // DELETIONS_COLLECTION — a later sync on a third device then
                // pulled both the re-upserted entity AND the stale tombstone
                // and (apply order: changes first, deletions second) wiped
                // the entity right after recreating it.
                for(let cardIndex = 0; cardIndex < (deckJson.cards || []).length; cardIndex++)
                {
                    deckJson.cards[cardIndex].id = Card.generateId();
                    deckJson.cards[cardIndex].deckId = newId;
                }
                for(let materialIndex = 0; materialIndex < (deckJson.studyMaterials || []).length; materialIndex++)
                {
                    deckJson.studyMaterials[materialIndex].id = StudyMaterial.generateId();
                    deckJson.studyMaterials[materialIndex].deckId = newId;
                }
                for(let mockTestIndex = 0; mockTestIndex < (deckJson.mockTests || []).length; mockTestIndex++)
                {
                    deckJson.mockTests[mockTestIndex].id = MockTest.generateId();
                    deckJson.mockTests[mockTestIndex].deckId = newId;
                }
            }

            await progressDialog.setProgressAndYield(0.4, "Rebuilding deck hierarchy");

            for(let deckIndex = 0; deckIndex < deckJsons.length; deckIndex++)
            {
                const deckJson = deckJsons[deckIndex];

                for(let subDeckIndex = 0; subDeckIndex < deckJson.subDecks.length; subDeckIndex++)
                {
                    const oldSubDeckId = deckJson.subDecks[subDeckIndex];
                    deckJson.subDecks[subDeckIndex] = oldIdNewIdMap.get(oldSubDeckId);
                }
            }

            await progressDialog.setProgressAndYield(0.55, "Constructing decks");

            Deck.beginImport();
            let importedRoot;
            try
            {
                importedRoot = Deck.constructDeckStructureFromDeckJson(deckJsons[0], newIdJsonMap);
            }
            finally
            {
                Deck.endImport();
            }
            this.addSubDeck(importedRoot);

            await progressDialog.setProgressAndYield(0.75, "Saving to storage");

            await this.save(true);

            await progressDialog.setProgressAndYield(0.9, "Queuing for sync");

            // Walk the imported tree and queue every deck, card, study
            // material, and mock test into SyncTransport.pendingChanges.
            //
            // We push records DIRECTLY into pendingChanges instead of
            // dispatching SyncEvents.ENTITY_CHANGED, because the event
            // handler at SyncOrchestrator.#handleEntityChanged is gated on
            // #bApplyingServerChanges — and that gate can be true here.
            // The import flow includes several `await` points above
            // (progress yields, the recursive `this.save(true)` which
            // itself awaits Persistence writes per deck). Any sync cycle
            // that entered its apply phase during one of those yields
            // sets the gate to true; when control returns to this
            // synchronous loop, every dispatchEvent would be silently
            // dropped. Direct setPendingChange bypasses the gate — the
            // same pattern SyncApplier.gatherAllLocalEntities and
            // SyncApplier's orphan-tombstoner already use for their
            // bulk programmatic queues (see SyncApplier.js comments).
            //
            // Decks are queued explicitly here for the same reason —
            // the recursive Deck.save inside `this.save(true)` already
            // fired ENTITY_CHANGED for each deck through window dispatch,
            // but those events are also subject to the gate; queuing
            // them again here makes the import's "everything goes up"
            // promise robust regardless of any concurrent apply phase.
            // The reference-aware removePushedChanges at end-of-sync
            // de-dupes naturally.
            const deckTraversalStack = [importedRoot];
            while(deckTraversalStack.length > 0)
            {
                const currentDeck = deckTraversalStack.pop();

                SyncTransport.setPendingChange(currentDeck.getId(),
                {
                    entityId:   currentDeck.getId(),
                    entityType: entityTypes.DECK,
                    data:       currentDeck.toSyncJson(),
                    deleted:    false
                });

                const directCards = currentDeck.getCards(false, true);
                for(let cardIndex = 0; cardIndex < directCards.length; cardIndex++)
                {
                    const importedCard = directCards[cardIndex];
                    SyncTransport.setPendingChange(importedCard.getId(),
                    {
                        entityId:   importedCard.getId(),
                        entityType: entityTypes.CARD,
                        data:       importedCard.toJson(),
                        deleted:    false
                    });
                }

                const directMaterials = currentDeck.getStudyMaterials(false, true);
                for(let materialIndex = 0; materialIndex < directMaterials.length; materialIndex++)
                {
                    const importedMaterial = directMaterials[materialIndex];
                    SyncTransport.setPendingChange(importedMaterial.getId(),
                    {
                        entityId:   importedMaterial.getId(),
                        entityType: entityTypes.STUDY_MATERIAL,
                        data:       importedMaterial.toJson(),
                        deleted:    false
                    });
                }

                const directMockTests = currentDeck.getMockTests(false);
                for(let mockTestIndex = 0; mockTestIndex < directMockTests.length; mockTestIndex++)
                {
                    const importedMockTest = directMockTests[mockTestIndex];
                    SyncTransport.setPendingChange(importedMockTest.getId(),
                    {
                        entityId:   importedMockTest.getId(),
                        entityType: entityTypes.MOCK_TEST,
                        data:       importedMockTest.toJson(),
                        deleted:    false
                    });
                }

                const childDecks = currentDeck.getSubDecks();
                for(let childIndex = 0; childIndex < childDecks.length; childIndex++)
                {
                    deckTraversalStack.push(childDecks[childIndex]);
                }
            }

            // Direct setPendingChange skips the
            // SyncOrchestrator.#handleEntityChanged path that would
            // normally schedule a debounced sync. Schedule one
            // explicitly so the just-queued records don't sit until the
            // next periodic tick (up to 5 minutes).
            SyncOrchestrator.scheduleDebouncedSync();

            await progressDialog.setProgressAndYield(1, "Done");

            window.dispatchEvent(new CustomEvent(DeckEvents.EXPAND, {detail: {deck: this}}));
            bImportSucceeded = true;
        }
        catch(error)
        {
            progressDialog.close();
            DialogBox.alert("Error", "The file selected is not a valid deck file.");
            return;
        }
        finally
        {
            // Release the sync mutex acquired above so the debounced
            // sync we just scheduled (or any periodic / force-pull
            // request that was queued behind us) can run. Release
            // happens BEFORE the success/error dialog so the dialog
            // doesn't hold up sync activity while waiting for the
            // user to dismiss it.
            releaseSyncMutex();
            progressDialog.close();
        }

        if(bImportSucceeded)
        {
            DialogBox.alert("Success", "Successfully imported the deck.");
        }
    }

    /**
     * Starts an import session: subsequent calls to
     * `constructDeckStructureFromDeckJson` will stamp each deck's
     * `lifecycle.creationDate` to `Date.now() + offset` (offset bumps by 1ms
     * per deck constructed), so imported decks land in the home-page list
     * in their import-array order even when the original export shared a
     * single creation date across siblings. Non-import callers (sync
     * rehydration, etc.) leave the cursor at null and replay the persisted
     * lifecycle untouched.
     */
    static beginImport()
    {
        Deck.#importBaseTimeMilliseconds = Date.now();
        Deck.#importNextOffsetMilliseconds = 0;
    }

    static endImport()
    {
        Deck.#importBaseTimeMilliseconds = null;
        Deck.#importNextOffsetMilliseconds = 0;
    }

    static constructDeckStructureFromDeckJson(deckJson, idJsonMap)
    {
        const cards = deckJson.cards.map((cardJson) => Card.fromJson(cardJson));

        const originalLifecycleJson = deckJson.lifecycle || {};
        let lifecycle;
        if (Deck.#importBaseTimeMilliseconds !== null)
        {
            const importedCreationDate = new Date(Deck.#importBaseTimeMilliseconds + Deck.#importNextOffsetMilliseconds);
            Deck.#importNextOffsetMilliseconds++;
            lifecycle = new Lifecycle(
                importedCreationDate,
                importedCreationDate,
                originalLifecycleJson.views ?? 0,
                originalLifecycleJson.attempts ?? 0,
                originalLifecycleJson.timeSpentInSeconds ?? 0
            );
        }
        else
        {
            lifecycle = Lifecycle.fromJson(originalLifecycleJson);
        }

        const studyMaterials = deckJson.studyMaterials.map((studyMaterialJson) => StudyMaterial.fromJson(studyMaterialJson));
        const mockTests = (deckJson.mockTests || []).map((mockTestJson) => MockTest.fromJson(mockTestJson));

        const deck = new Deck(deckJson.id, deckJson.name, deckJson.shortName, deckJson.tags, cards, lifecycle, studyMaterials, mockTests, [], Deck.getById(deckJson.parent), deckJson.additionalData);

        for(let subDeckIndex = 0; subDeckIndex < deckJson.subDecks.length; subDeckIndex++)
        {
            const subDeckId = deckJson.subDecks[subDeckIndex];
            const subDeckJson = idJsonMap.get(subDeckId);

            if(!subDeckJson)
            {
                console.warn(`Sub-deck with id ${subDeckId} not found in import data. Skipping.`);
                continue;
            }

            Deck.constructDeckStructureFromDeckJson(subDeckJson, idJsonMap);

            const constructedSubDeck = Deck.getById(subDeckId);

            if(constructedSubDeck)
            {
                deck.addSubDeck(constructedSubDeck);
            }
        }

        for(let cardIndex = 0; cardIndex < cards.length; cardIndex++)
        {
            const card = cards[cardIndex];
            card.setDeckId(deck.getId());
        }

        return deck;
    }

    /**
     * Configures the given element as a searchable deck dropdown. Lists
     * every deck under `root` that passes `filter`, each labelled with its
     * full ancestor path, behind a SearchableDropdown trigger. From the
     * caller's point of view it behaves like a native <select>: the picked
     * deck id lands on `triggerElement.value` and a "change" event fires so
     * existing listeners keep working unchanged.
     *
     * Pass any element that can host the trigger markup (typically a
     * <button> or <div>). The old native-<select> population was retired —
     * every deck selector in the app is searchable now.
     *
     * @param {HTMLElement} triggerElement
     * @param {(deck: Deck) => boolean} filter
     * @param {Deck} root
     * @param {string|null} defaultSelection
     * @param {string} [placeholderLabel]
     */
    static configureSelector(triggerElement, filter = (deck) => { return true; }, root = Deck.#root, defaultSelection = null, placeholderLabel = "Select a deck...")
    {
        const allDecks = Deck.getAll(filter, root);
        const items = allDecks.map(deck =>
        ({
            key: deck.getId(),
            label: deck.getNameWithAncestors(),
        }));

        // Expose a synthetic `value` property so existing `.value` reads /
        // writes keep working against the trigger element. The trigger's
        // dataset.selectedKey is the source of truth.
        Object.defineProperty(triggerElement, "value",
        {
            configurable: true,
            get() { return triggerElement.dataset.selectedKey || ""; },
            set(newValue)
            {
                triggerElement.dataset.selectedKey = newValue == null ? "" : String(newValue);
                const matchingItem = items.find(item => item.key === triggerElement.dataset.selectedKey);
                const labelSlot = triggerElement.querySelector(".searchable-dropdown-trigger-label");
                if (labelSlot)
                {
                    labelSlot.textContent = matchingItem ? matchingItem.label : placeholderLabel;
                }
            },
        });

        if (!triggerElement.querySelector(".searchable-dropdown-trigger-label"))
        {
            triggerElement.classList.add("searchable-dropdown-trigger");
            triggerElement.innerHTML =
            `
                <span class="searchable-dropdown-trigger-label"></span>
                <span class="searchable-dropdown-trigger-chevron" aria-hidden="true"></span>
            `;
        }

        SearchableDropdown.attach(triggerElement,
        {
            title:             "Select parent deck",
            searchPlaceholder: "Search decks...",
            items:             items,
            initialKey:        defaultSelection,
            placeholderLabel:  placeholderLabel,
            emptyStateMessage: "No decks match your search.",
            labelSelector:     ".searchable-dropdown-trigger-label",
        });

        if (defaultSelection != null)
        {
            triggerElement.value = defaultSelection;
        }
        else
        {
            const labelSlot = triggerElement.querySelector(".searchable-dropdown-trigger-label");
            if (labelSlot)
            {
                labelSlot.textContent = placeholderLabel;
            }
        }
    }

    /**
     * @deprecated Alias for {@link configureSelector}, which is searchable
     * by default now. Kept so existing call sites keep working — prefer
     * `configureSelector` in new code.
     *
     * @param {HTMLElement} triggerElement
     * @param {(deck: Deck) => boolean} filter
     * @param {Deck} root
     * @param {string|null} defaultSelection
     * @param {string} [placeholderLabel]
     */
    static configureSearchableSelector(triggerElement, filter = (deck) => { return true; }, root = Deck.#root, defaultSelection = null, placeholderLabel = "Select a deck...")
    {
        return Deck.configureSelector(triggerElement, filter, root, defaultSelection, placeholderLabel);
    }

    /**
     * Deletes the deck and all of its sub-decks recursively.
     * @param {boolean} bTopLevel - True when called directly (not from a parent delete cascade).
     *   Only the top-level call saves the parent, which is the only ancestor that
     *   actually survives and needs to be updated.  Intermediate cascade calls must NOT
     *   save their parent, because that parent is itself being deleted; saving it would
     *   fire ENTITY_CHANGED and overwrite its own ENTITY_DELETED in pendingChanges,
     *   turning a deletion into an upsert on the server.
     * @param {boolean} bSuppressDispatch - True only when called from
     *   SyncApplier.applyServerDeletions: we are deleting locally
     *   *because* the server already tombstoned the entity. Re-firing
     *   ENTITY_DELETED would queue our own redundant tombstone, which
     *   the next push would echo back to the server — wasteful and on
     *   a rare schedule could pre-empt a legitimate later resurrection
     *   if the user undeletes via another channel. Recursive cascade
     *   calls forward the same flag so an entire server-driven
     *   sub-tree teardown stays event-free; the parent save at the
     *   end also forwards it so the parent's own state-snapshot doesn't
     *   get pushed back to the server as a fresh write either.
     */
    async delete(bTopLevel = true, bSuppressDispatch = false)
    {
        const existsInFileSystem = await Persistence.exists(`Decks/${this.getId()}.mmd`);

        if(existsInFileSystem)
        {
            await Persistence.delete(`Decks/${this.getId()}.mmd`);
        }

        // Dispatch ENTITY_DELETED for every direct child and for this
        // deck itself, unless the caller is the sync apply path (see
        // bSuppressDispatch jsdoc). The events drive the
        // SyncOrchestrator handler which enqueues tombstones into
        // pendingChanges for the next push.
        if (!bSuppressDispatch)
        {
            const directCards = Array.from(this.#cards.values());
            for(let cardIndex = 0; cardIndex < directCards.length; cardIndex++)
            {
                window.dispatchEvent(new CustomEvent(SyncEvents.ENTITY_DELETED,
                {
                    detail:
                    {
                        entityId: directCards[cardIndex].getId(),
                        entityType: entityTypes.CARD
                    }
                }));
            }

            const directStudyMaterials = Array.from(this.#studyMaterials.values());
            for(let materialIndex = 0; materialIndex < directStudyMaterials.length; materialIndex++)
            {
                window.dispatchEvent(new CustomEvent(SyncEvents.ENTITY_DELETED,
                {
                    detail:
                    {
                        entityId: directStudyMaterials[materialIndex].getId(),
                        entityType: entityTypes.STUDY_MATERIAL
                    }
                }));
            }

            const directMockTests = Array.from(this.#mockTests.values());
            for(let mockTestIndex = 0; mockTestIndex < directMockTests.length; mockTestIndex++)
            {
                window.dispatchEvent(new CustomEvent(SyncEvents.ENTITY_DELETED,
                {
                    detail:
                    {
                        entityId: directMockTests[mockTestIndex].getId(),
                        entityType: entityTypes.MOCK_TEST
                    }
                }));
            }

            window.dispatchEvent(new CustomEvent(SyncEvents.ENTITY_DELETED,
            {
                detail:
                {
                    entityId: this.getId(),
                    entityType: entityTypes.DECK
                }
            }));
        }

        // Cascade delete. Snapshot first because each recursive delete()
        // calls removeSubDeck on us, splicing #subDecks mid-iteration —
        // without the snapshot every other child is skipped, leaving
        // orphans on the server. bTopLevel=false on the cascade so the
        // children do NOT save their parent (which is this deck, also
        // being deleted). bSuppressDispatch propagates so server-driven
        // tree teardowns stay event-free all the way down.
        const childDecksSnapshot = Array.from(this.#subDecks);
        for(let childIndex = 0; childIndex < childDecksSnapshot.length; childIndex++)
        {
            await childDecksSnapshot[childIndex].delete(false, bSuppressDispatch);
        }

        this.#parent?.removeSubDeck(this);
        Deck.#idMap.delete(this.getId());

        // Only persist the parent when we are the top-level deletion.
        // Intermediate cascade calls skip this to avoid re-saving a deck
        // that is itself being deleted (which would corrupt
        // pendingChanges). bSuppressDispatch forwards: a sync-apply
        // teardown saves the parent's new state to disk but does not
        // push it back as a fresh ENTITY_CHANGED, because the server
        // already knows about both the deletion and the parent's
        // updated subDecks list.
        if(bTopLevel)
        {
            await this.#parent?.save(false, bSuppressDispatch);
        }
    }

    isChildOf(deck, bRecursive = true)
    {
        if(this.#parent == deck)
        {
            return true;
        }

        if(!bRecursive)
        {
            return false;
        }

        return this.#parent?.isChildOf(deck, bRecursive) || false;
    }

    isParentOf(deck, bRecursive = true)
    {
        return deck.isChildOf(this, bRecursive);
    }

    toJson()
    {
        return {
            id: this.#id,
            name: this.#name,
            shortName: this.#shortName,
            tags: this.#tags,
            lifecycle: this.#lifecycle.toJson(),
            studyMaterials: Array.from(this.#studyMaterials.values()).map((studyMaterial) => studyMaterial.toJson()),
            mockTests: Array.from(this.#mockTests.values()).map((mockTest) => mockTest.toJson()),
            subDecks: this.#subDecks.map((subDeck) => subDeck.getId()),
            parent: this.#parent?.getId() || null,
            cards: Array.from(this.#cards.values()).map((card) => card.toJson()),
            additionalData: this.#additionalData
        }
    }

    // A fromJson method doesnt exist since it would be difficult to handle a recursive load. Load function handles it.

    /**
     * Returns a JSON representation of the deck suitable for syncing.
     * Excludes payloads that already have their own dedicated sync
     * channel so the deck doc stays small (Mongo's per-doc cap is
     * 16 MB):
     *
     *   - Cards never lived here; they sync via entityTypes.CARD.
     *   - StudyMaterials USED to be embedded for convenience, but each
     *     can carry pasted base64 images and a handful of image-heavy
     *     materials would push a deck past 16 MB. They sync as
     *     entityTypes.STUDY_MATERIAL — embedding them was just dead
     *     weight that the apply path never read anyway.
     *   - AskAi popup records used to sit under
     *     additionalData.askAiPopupLinks; they now sync as
     *     entityTypes.ASK_AI_POPUP_LINK against their own server-side
     *     collection. The field is stripped here so deck pushes never
     *     re-bloat the deck document with them.
     *
     * @returns {object}
     */
    toSyncJson()
    {
        const filteredAdditionalData = Deck.#additionalDataWithoutPopupLinks(this.#additionalData);
        return {
            id: this.#id,
            name: this.#name,
            shortName: this.#shortName,
            tags: this.#tags,
            lifecycle: this.#lifecycle.toJson(),
            subDecks: this.#subDecks.map((subDeck) => subDeck.getId()),
            parent: this.#parent?.getId() || null,
            additionalData: filteredAdditionalData
        }
    }

    /**
     * Shallow copy of additionalData with the askAiPopupLinks slot
     * removed. Lives next to toSyncJson so the stripping rule has one
     * obvious home — extend this if more first-class-entity-shaped
     * fields ever take up residence under additionalData.
     */
    static #additionalDataWithoutPopupLinks(additionalData)
    {
        if (!additionalData || typeof additionalData !== "object")
        {
            return {};
        }
        const cloned = { ...additionalData };
        delete cloned.askAiPopupLinks;
        return cloned;
    }

    /**
     * Constructor for a Deck object
     * @param {string} id - The id of the deck
     * @param {string} name - The name of the deck
     * @param {string} shortName - A shorter name for the deck
     * @param {string[]} tags - Tags associated with the deck
     * @param {Card[]} cards - Cards that are part of the deck
     * @param {Lifecycle} lifecycle - The lifecycle of the deck
     * @param {StudyMaterial[]} studyMaterials - Study materials that are part of the deck
     * @param {Deck[]} subDecks - Subdecks that are part of the deck
     * @param {Deck} parent - The parent deck
     * @param {object} additionalData - Additional data associated with the deck such as a background
     */
    constructor(id, name, shortName, tags, cards, lifecycle, studyMaterials, mockTests = [], subDecks = [], parent = null, additionalData = {})
    {   
        this.#id = id;
        this.#name = name;
        this.#shortName = shortName;
        this.#tags = tags;
        this.#cards = new Map();

        // Re-stamp deckId on every incoming entity so a stale value on the
        // persisted JSON (e.g. legacy imports that pre-dated the import-side
        // deckId-remap fix) is healed in memory immediately. The next save()
        // then writes the corrected deckId back to disk.
        for(let cardIndex = 0; cardIndex < cards.length; cardIndex++)
        {
            const card = cards[cardIndex];
            card.setDeckId(this.#id);
            this.#cards.set(card.getId(), card);
        }

        this.#lifecycle = lifecycle;

        this.#studyMaterials = new Map();

        for(let materialIndex = 0; materialIndex < studyMaterials.length; materialIndex++)
        {
            const studyMaterial = studyMaterials[materialIndex];
            studyMaterial.setDeckId(this.#id);
            this.#studyMaterials.set(studyMaterial.getId(), studyMaterial);
        }

        this.#mockTests = new Map();

        for(let mockTestIndex = 0; mockTestIndex < mockTests.length; mockTestIndex++)
        {
            const mockTest = mockTests[mockTestIndex];
            mockTest.setDeckId(this.#id);
            this.#mockTests.set(mockTest.getId(), mockTest);
        }
        
        this.#subDecks = subDecks;
        this.#parent = parent || null;
        this.#additionalData = additionalData;

        if(this.#parent)
        {
            if(this.#parent.getSubDecks().includes(this) == false)
            {
                this.#parent.addSubDeck(this);
            }
        }

        Deck.#storeInIdMap(this);
    }
}

export default Deck;