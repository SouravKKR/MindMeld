const { MongoClient, Db } = require('mongodb');
const App = require('../App');
const DatabaseConstants = require('../../Constants/DatabaseConstants');

// NOTE: GenerationTemplateSeeder is lazy-loaded inside #setupCollections.
// Top-level require would form a cycle: DatabaseConnector → Seeder →
// GenerationTemplateQueryEngine → DatabaseConnector. By the time that
// last require resolves, this module's exports object is still empty
// (we have not reached `module.exports = DatabaseConnector` yet), so
// QueryEngine#getCollection sees `DatabaseConnector.getDatabase` as
// undefined and the first /Templates/Search request crashes.

class DatabaseConnector
{
    static #mongoClient = null;
    static #bConnected = false;
    static #database = null;

    // Atlas Vector Search index on the textEmbeddings collection. The name and
    // dimensions are shared with the Agent's EmbeddingsQueryEngine (Python),
    // which issues the $vectorSearch queries against this index — keep both in
    // sync. 768 is the output dimensionality of nomic-ai/nomic-embed-text-v1,
    // the model the Agent embeds chunks with.
    static TEXT_EMBEDDINGS_VECTOR_INDEX_NAME = "textEmbeddingsVectorSearch";
    static TEXT_EMBEDDINGS_VECTOR_DIMENSIONS = 768;

    static async #connect()
    {
        try
        {
            const databaseUrl = App.getDatabaseUrl();

            // Validate before constructing. `new MongoClient(undefined)` throws
            // synchronously ("Cannot read properties of undefined (reading
            // 'startsWith')") — keeping it inside the try means a missing or
            // blank MONGODB_URL degrades to a handled "not connected" (callers
            // get null) instead of an uncaught throw that 500s every request.
            if (typeof databaseUrl !== "string" || databaseUrl.trim() === "")
            {
                console.log("MONGODB_URL is not configured; cannot connect to MongoDB");
                DatabaseConnector.#bConnected = false;
                DatabaseConnector.#database = null;
                return false;
            }

            DatabaseConnector.#mongoClient = new MongoClient(databaseUrl);

            await DatabaseConnector.#mongoClient.connect();

            DatabaseConnector.#database = await DatabaseConnector.#mongoClient.db(App.getDatabaseName());

            await DatabaseConnector.#database.command({ ping: 1 });

            // CRITICAL: mark the connection live BEFORE running collection
            // setup. Anything that calls getDatabase() recursively during
            // setup (the template seeder, for one) must see this live
            // handle instead of recursing back into #connect() and
            // spinning up a fresh MongoClient — that path blocks each
            // call for the full ~30s connect timeout, multiplies by the
            // 20-template loop, and effectively wedges Dock boot for ten
            // minutes. Rolled back in the catch if setup itself throws.
            DatabaseConnector.#bConnected = true;

            await DatabaseConnector.#setupCollections();

            return true;
        }
        catch (error)
        {
            console.log(error);

            DatabaseConnector.#bConnected = false;
            DatabaseConnector.#database = null;
            console.log("Failed to connect to MongoDB");

            return false;
        }
    }

    static async #disconnect()
    {
        await this.#mongoClient?.close();

        DatabaseConnector.#bConnected = false;
    }

    static isConnected()
    {
        return DatabaseConnector.#bConnected;
    }

    /**
     * Returns the MongoClient instance used by the DatabaseConnector
     * @return {MongoClient} The MongoClient instance
     */
    static getMongoClient()
    {
        return DatabaseConnector.#mongoClient;
    }

    /**
     * Returns the database instance used by the DatabaseConnector
     * @return {Db} The database instance
     */
    static async getDatabase()
    {
        if (!DatabaseConnector.#bConnected)
        {
            const bConnected = await DatabaseConnector.#connect();

            if (!bConnected)
            {
                return null;
            }

            console.log("Connected to database");
        }

        return DatabaseConnector.#database;
    }

    static async #setupCollections()
    {
        const database = DatabaseConnector.#database;
        const sessionsCollection = database.collection(DatabaseConstants.SESSIONS_COLLECTION);
        const usersCollection = database.collection(DatabaseConstants.USERS_COLLECTION);
        const purchasesCollection = database.collection(DatabaseConstants.PURCHASES_COLLECTION);
        const informationSourcesCollection = database.collection(DatabaseConstants.INFORMATION_SOURCES_COLLECTION);
        const decksCollection = database.collection(DatabaseConstants.DECKS_COLLECTION);
        const cardsCollection = database.collection(DatabaseConstants.CARDS_COLLECTION);
        const studyMaterialsCollection = database.collection(DatabaseConstants.STUDY_MATERIALS_COLLECTION);
        const syncDataCollection = database.collection(DatabaseConstants.SYNC_DATA_COLLECTION);
        const deletionsCollection = database.collection(DatabaseConstants.DELETIONS_COLLECTION);
        const mockTestsCollection = database.collection(DatabaseConstants.MOCK_TESTS_COLLECTION);

        // ── Sessions ───────────────────────────────────────────────────────────
        await sessionsCollection.createIndex({ id: 1 }, { unique: true });
        await sessionsCollection.createIndex({ expirationDate: 1 }, { expireAfterSeconds: 0 });

        // ── Users ──────────────────────────────────────────────────────────────
        await usersCollection.createIndex({ id: 1 }, { unique: true });

        // ── Users (paid-deck additions) ────────────────────────────────────────
        // Admin queries filter by role; sparse so the index only carries
        // documents that explicitly have a role set.
        await usersCollection.createIndex({ role: 1 }, { sparse: true });

        // World leaderboard ranks by counting users with a strictly higher
        // composite-XP score; sparse so only users who have earned XP are indexed.
        await usersCollection.createIndex({ "additionalData.metrics.leaderboardScore": 1 }, { sparse: true });

        // ── Purchases ──────────────────────────────────────────────────────────
        // Drop legacy indexes whose composite fields (purchaseEntityType,
        // entityId, expirationDate) no longer exist on the new Purchase
        // schema. Mongo silently keeps these as wasted-space indexes
        // otherwise.
        try { await purchasesCollection.dropIndex("userId_1_purchaseEntityType_1_expirationDate_1"); } catch (dropError) { }
        try { await purchasesCollection.dropIndex("userId_1_entityId_1"); } catch (dropError) { }

        await purchasesCollection.createIndex({ id: 1 }, { unique: true });

        // "Has this user already bought this deck?" — hit on every pricing
        // calculation and discount lookup.
        await purchasesCollection.createIndex({ userId: 1, deckId: 1 });

        // "List my purchases, newest first" — MyPurchases UI.
        await purchasesCollection.createIndex({ userId: 1, purchaseDate: -1 });

        // Filtering completed/refunded purchases for revenue stats.
        await purchasesCollection.createIndex({ userId: 1, status: 1 });

        // Verify-purchase endpoint looks up by providerOrderId to make the
        // verify call idempotent across retries.
        await purchasesCollection.createIndex({ providerOrderId: 1 });

        // Admin revenue aggregation groups by deckId / region / currency.
        await purchasesCollection.createIndex({ status: 1, purchaseDate: -1 });

        // ── Information sources ────────────────────────────────────────────────
        await informationSourcesCollection.createIndex({ id: 1 }, { unique: true });
        await informationSourcesCollection.createIndex({ userId: 1, hash: 1 }, { unique: true });
        await informationSourcesCollection.createIndex({ hash: 1 });
        await informationSourcesCollection.createIndex({ userId: 1 });

        // ── Decks ──────────────────────────────────────────────────────────────
        await decksCollection.createIndex({ userId: 1, "data.id": 1 }, { unique: true });
        await decksCollection.createIndex({ userId: 1, serverUpdatedAt: 1 });

        // ── Cards ──────────────────────────────────────────────────────────────
        await cardsCollection.createIndex({ userId: 1, "data.id": 1 }, { unique: true });
        await cardsCollection.createIndex({ userId: 1, serverUpdatedAt: 1 });

        // ── Study materials ────────────────────────────────────────────────────
        // One document per user per study material
        await studyMaterialsCollection.createIndex({ userId: 1, "data.id": 1 }, { unique: true });

        // Pull study materials updated on the server since a given timestamp (sync)
        await studyMaterialsCollection.createIndex({ userId: 1, serverUpdatedAt: 1 });

        // Fetch all study materials belonging to a specific deck
        await studyMaterialsCollection.createIndex({ userId: 1, "data.deckId": 1 });

        // ── Sync data ──────────────────────────────────────────────────────────
        await syncDataCollection.createIndex({ userId: 1, deviceId: 1 }, { unique: true });

        // ── Deletions ──────────────────────────────────────────────────────────
        await deletionsCollection.createIndex({ userId: 1, entityId: 1 }, { unique: true });
        await deletionsCollection.createIndex({ userId: 1, deletedAt: 1 });

        // TTL index on deletedAt. Mongo's `createIndex` is idempotent ONLY
        // when the new options match the existing options exactly. When we
        // bumped DELETIONS_TTL_DAYS from 90 to 365 the on-disk index was
        // already created at the old TTL — calling createIndex again with
        // the new value would either silently be a no-op or throw
        // "Index already exists with different options," depending on
        // driver version. So we do the upgrade explicitly: try collMod
        // first to retune the existing index's expireAfterSeconds in
        // place, then fall through to createIndex for the fresh-install
        // case where the index doesn't exist yet.
        const newDeletionsTtlSeconds = DatabaseConstants.DELETIONS_TTL_DAYS * 24 * 60 * 60;
        try
        {
            await database.command(
            {
                collMod: DatabaseConstants.DELETIONS_COLLECTION,
                index: { keyPattern: { deletedAt: 1 }, expireAfterSeconds: newDeletionsTtlSeconds }
            });
        }
        catch (collModError)
        {
            // IndexNotFound (code 27) is the expected fresh-install case;
            // any other failure is worth surfacing so a future TTL change
            // doesn't silently leave production on the old value.
            if (collModError?.code !== 27)
            {
                console.warn(`[DatabaseConnector] Could not collMod the deletions TTL index (will fall back to createIndex): ${collModError?.message || collModError}`);
            }
        }
        await deletionsCollection.createIndex({ deletedAt: 1 }, { expireAfterSeconds: newDeletionsTtlSeconds });

        // ── Mock tests ─────────────────────────────────────────────────────────
        // One document per user per mock test
        await mockTestsCollection.createIndex({ userId: 1, "data.id": 1 }, { unique: true });

        // Pull mock tests updated on the server since a given timestamp (sync)
        await mockTestsCollection.createIndex({ userId: 1, serverUpdatedAt: 1 });

        // Fetch all mock tests belonging to a specific deck
        await mockTestsCollection.createIndex({ userId: 1, "data.deckId": 1 });

        // ── Ask-AI popup links ─────────────────────────────────────────────────
        // Standalone sync entity (used to live under deck.additionalData but
        // moved to its own collection so heavy popups don't bloat the deck doc
        // past Mongo's 16 MB cap). Index set mirrors decks/cards/materials so
        // the sync pull, the upsert-by-id lookup, and the deletion cascade's
        // by-deckId frontier query all hit indexes instead of full collection
        // scans. Without these every sync cycle was O(N_popups) per pull.
        const askAiPopupLinksCollection = database.collection(DatabaseConstants.ASK_AI_POPUP_LINKS_COLLECTION);
        await askAiPopupLinksCollection.createIndex({ userId: 1, "data.id": 1 }, { unique: true });
        await askAiPopupLinksCollection.createIndex({ userId: 1, serverUpdatedAt: 1 });
        await askAiPopupLinksCollection.createIndex({ userId: 1, "data.deckId": 1 });

        // ── Text embeddings (RAG chunk store — written by the Agent) ────────────
        // The AskAi grounding retrieval (EmbeddingsQueryEngine.vector_search), the
        // embed-coverage check (get_pages_without_embeddings), and the chunk
        // upsert all filter by informationSourceHash (+ pageNumber). Without this
        // index every one of those reads was a FULL collection scan — O(all
        // embeddings in the DB) on each AskAi call. The compound turns the
        // candidate fetch into an index range scan scoped to the queried sources.
        // (The cosine ranking that follows is still a brute-force pass over the
        // matched chunks — that is inherent to not using an Atlas $vectorSearch
        // index and is acceptable at this candidate-set size.)
        const textEmbeddingsCollection = database.collection(DatabaseConstants.TEXT_EMBEDDINGS_COLLECTION);
        await textEmbeddingsCollection.createIndex({ informationSourceHash: 1, pageNumber: 1 });

        // Atlas Vector Search index for the semantic retrieval path. The Agent's
        // EmbeddingsQueryEngine.vector_search (AskAi grounding) and the curated-
        // study textbook search issue $vectorSearch aggregations against this
        // instead of pulling every chunk and scoring cosine in Python. The
        // informationSourceHash filter field lets AskAi scope the search to the
        // active sources inside the index (a pre-filter, not a post-filter).
        //
        // Search-index management only exists on Atlas / the mongodb-atlas-local
        // image (the bundled mongot). On a plain mongod this command throws — we
        // swallow it (logging a warning) so the connection still succeeds; the
        // Agent transparently falls back to brute-force cosine when the index is
        // absent or still building. Creation is idempotent: skipped if present,
        // and the build itself runs asynchronously server-side.
        try
        {
            const existingSearchIndexes = await textEmbeddingsCollection.listSearchIndexes().toArray();
            const bVectorIndexExists = existingSearchIndexes.some(searchIndex => searchIndex.name === DatabaseConnector.TEXT_EMBEDDINGS_VECTOR_INDEX_NAME);

            if (!bVectorIndexExists)
            {
                await textEmbeddingsCollection.createSearchIndex
                ({
                    name: DatabaseConnector.TEXT_EMBEDDINGS_VECTOR_INDEX_NAME,
                    type: "vectorSearch",
                    definition:
                    {
                        fields:
                        [
                            { type: "vector", path: "embedding", numDimensions: DatabaseConnector.TEXT_EMBEDDINGS_VECTOR_DIMENSIONS, similarity: "cosine" },
                            { type: "filter", path: "informationSourceHash" }
                        ]
                    }
                });

                console.log(`[DatabaseConnector] Creating vector search index '${DatabaseConnector.TEXT_EMBEDDINGS_VECTOR_INDEX_NAME}' on ${DatabaseConstants.TEXT_EMBEDDINGS_COLLECTION} (builds asynchronously)`);
            }
        }
        catch (searchIndexError)
        {
            console.warn(`[DatabaseConnector] Could not ensure the text-embeddings vector search index (not an Atlas / atlas-local deployment?): ${searchIndexError?.message || searchIndexError}`);
        }

        // ── Figures (image-extraction cache — written by the Agent) ─────────────
        // PrepareImages looks up previously-extracted figures by
        // informationSourceHash to reuse cached perceptual hashes + embeddings
        // instead of re-processing unchanged images on every run.
        const figuresCollection = database.collection(DatabaseConstants.FIGURES_COLLECTION);
        await figuresCollection.createIndex({ informationSourceHash: 1 });

        // ── Generation templates ───────────────────────────────────────────────
        // Curated exam-prep blueprints (JEE Mains, NEET UG, CBSE, etc.) the
        // picker dialog reads. The catalogue is seeded from the on-disk JSON
        // file every boot so the file stays the source of truth for built-ins.
        // Templates may be either global (no userId) or owned by a specific
        // user (userId set to the user's id). Both kinds coexist; a user
        // sees globals union with their own.
        const generationTemplatesCollection = database.collection(DatabaseConstants.GENERATION_TEMPLATES_COLLECTION);

        // Migrate away from the legacy global-only unique index. A unique
        // index on `key` alone would block per-user duplicates (which are
        // legitimate now), so drop it and replace with a composite that
        // tolerates one global + one per-user template per key.
        try
        {
            await generationTemplatesCollection.dropIndex("key_1");
        }
        catch (dropError)
        {
            // Index didn't exist (fresh DB or already migrated) — fine.
        }

        // Constant-time lookup for the "fetch full template by key" path
        // the picker hits when the user makes a selection. The composite
        // makes `(global, "JEE_MAINS")` and `(userA, "JEE_MAINS")` distinct
        // uniqueness rows. Missing userId is coerced to `null` by the
        // seeder so the index key is always concrete.
        await generationTemplatesCollection.createIndex({ userId: 1, key: 1 }, { unique: true });

        // Search-as-you-type uses a case-insensitive regex on these fields;
        // a regular ascending index lets Mongo cap the scan + sort cost
        // without needing a full-text index (which would lose partial-match
        // semantics on prefixes like "jee m" → "JEE Mains").
        await generationTemplatesCollection.createIndex({ displayName: 1 });
        await generationTemplatesCollection.createIndex({ tagline: 1 });

        // Insert any templates whose `key` is missing from the collection.
        // Existing entries are left untouched — the seed file is a
        // "deliver new templates" channel, not a destructive sync. Awaited
        // so that the very first request to /Templates/Search after a
        // fresh boot sees the newly-seeded entries. Lazy-required to
        // break the DatabaseConnector → Seeder → QueryEngine cycle.
        const GenerationTemplateSeeder = require('./GenerationTemplateSeeder');
        await GenerationTemplateSeeder.seedNewFromJsonFile();

        // ── Legal documents (Terms of Service / Privacy Policy) ────────────────
        // Versioned HTML documents shown to every user on login. Seeded
        // from Dock/SeedData/LegalDocuments.json. Bumping a document's
        // version in the JSON propagates to every existing record at the
        // next Dock boot; lower-or-equal versions never overwrite the
        // stored copy so an admin can hand-edit a document body in Mongo
        // without losing the change on the next restart.
        const legalDocumentsCollection = database.collection(DatabaseConstants.LEGAL_DOCUMENTS_COLLECTION);
        await legalDocumentsCollection.createIndex({ key: 1 }, { unique: true });

        const LegalDocumentSeeder = require('./LegalDocumentSeeder');
        await LegalDocumentSeeder.seedFromJsonFile();

        // ── Paid decks ─────────────────────────────────────────────────────────
        // Marketplace catalogue. The library page filters by isPublished
        // and sorts by publishedAt; the search engine adds category /
        // tags / price range / seller filters on top. Each index below
        // matches a query the search engine actually issues — adding
        // single-field indexes for every filter would create dozens of
        // unused indexes, so the strategy is compound indexes on
        // (isPublished, hot-sort-field).
        const paidDecksCollection = database.collection(DatabaseConstants.PAID_DECKS_COLLECTION);
        await paidDecksCollection.createIndex({ id: 1 }, { unique: true });
        await paidDecksCollection.createIndex({ isPublished: 1, publishedAt: -1 });
        await paidDecksCollection.createIndex({ isPublished: 1, category: 1 });
        await paidDecksCollection.createIndex({ isPublished: 1, basePriceMinor: 1 });
        await paidDecksCollection.createIndex({ isPublished: 1, tags: 1 });
        await paidDecksCollection.createIndex({ sellerId: 1 });
        // Bundle navigation: "give me all bundles that include this deck".
        await paidDecksCollection.createIndex({ parentBundleIds: 1 });

        // ── Paid deck pricings ─────────────────────────────────────────────────
        // Hot path: "pricing for deck X in region R at time now". Compound
        // index lets Mongo cap the candidate set to the deck+region pair
        // before scanning effectiveFrom/effectiveUntil windows.
        const paidDeckPricingsCollection = database.collection(DatabaseConstants.PAID_DECK_PRICINGS_COLLECTION);
        await paidDeckPricingsCollection.createIndex({ deckId: 1, region: 1, effectiveFrom: -1 });

        // ── Paid deck assets (master meta) ─────────────────────────────────────
        // Small per-(deckId, keyVersion) meta doc: wrapped deck content key +
        // manifest. The encrypted CONTENT lives per-entity in
        // paidDeckMasterEntities (below) so a large deck is never one document.
        const paidDeckAssetsCollection = database.collection(DatabaseConstants.PAID_DECK_ASSETS_COLLECTION);
        await paidDeckAssetsCollection.createIndex({ deckId: 1, keyVersion: 1 }, { unique: true });

        // ── Paid deck master entities ──────────────────────────────────────────
        // One encrypted doc per entity of the seller's master copy, keyed by
        // (deckId, keyVersion, entityId). Bulk read/delete by (deckId, keyVersion)
        // on purchase-clone and key rotation.
        const paidDeckMasterEntitiesCollection = database.collection(DatabaseConstants.PAID_DECK_MASTER_ENTITIES_COLLECTION);
        await paidDeckMasterEntitiesCollection.createIndex({ deckId: 1, keyVersion: 1, entityId: 1 }, { unique: true });
        await paidDeckMasterEntitiesCollection.createIndex({ deckId: 1, keyVersion: 1 });

        // ── Paid deck user content (manifest) ──────────────────────────────────
        // One small per-(userId, deckId) doc holding the buyer's manifest. The
        // per-entity plaintext lives in paidDeckUserContentEntities (below).
        const paidDeckUserContentCollection = database.collection(DatabaseConstants.PAID_DECK_USER_CONTENT_COLLECTION);
        await paidDeckUserContentCollection.createIndex({ userId: 1, deckId: 1 }, { unique: true });

        // ── Paid deck user content entities ────────────────────────────────────
        // One plaintext doc per entity of the buyer's editable copy, keyed by
        // (userId, deckId, entityId). Per-entity fetch ($in entityIds) + update
        // ride the unique index; bulk seed/teardown by (userId, deckId).
        const paidDeckUserContentEntitiesCollection = database.collection(DatabaseConstants.PAID_DECK_USER_CONTENT_ENTITIES_COLLECTION);
        await paidDeckUserContentEntitiesCollection.createIndex({ userId: 1, deckId: 1, entityId: 1 }, { unique: true });
        await paidDeckUserContentEntitiesCollection.createIndex({ userId: 1, deckId: 1 });

        // ── Deck licenses ──────────────────────────────────────────────────────
        // Per-user, per-deck license. Lookups: "my licenses" (userId),
        // "license for this deck" (userId+deckId), key rotation
        // ("all licenses for deck X currently ACTIVE"), sync delta pull
        // ("licenses updated since timestamp T").
        const deckLicensesCollection = database.collection(DatabaseConstants.DECK_LICENSES_COLLECTION);
        await deckLicensesCollection.createIndex({ userId: 1, deckId: 1 }, { unique: true });
        await deckLicensesCollection.createIndex({ userId: 1, rotatedAt: -1 });
        await deckLicensesCollection.createIndex({ deckId: 1, status: 1 });
        // ExpiredLicenseSweeper scans "ACTIVE licenses with a finite expiry now
        // in the past" server-wide; the status+expiresAt compound keeps that
        // periodic sweep an index scan rather than a full collection scan.
        await deckLicensesCollection.createIndex({ status: 1, expiresAt: 1 });

        // ── Devices ────────────────────────────────────────────────────────────
        // Login-flow checks: "list devices for this user, sorted by
        // recency"; "count devices seen in the last N days".
        const devicesCollection = database.collection(DatabaseConstants.DEVICES_COLLECTION);
        await devicesCollection.createIndex({ id: 1 }, { unique: true });
        await devicesCollection.createIndex({ userId: 1, lastSeenDate: -1 });

        // Cross-browser physical-device identity. The PhysicalDeviceFingerprint
        // client class computes a SHA-256 from stable OS/hardware signals; the
        // server resolves an incoming registration by (userId, fingerprintHash)
        // so different browsers on the same machine land on the same Device row.
        // partialFilterExpression keeps legacy rows (empty fingerprintHash) from
        // colliding on a unique index until they backfill on next login.
        await devicesCollection.createIndex
        (
            { userId: 1, fingerprintHash: 1 },
            { unique: true, partialFilterExpression: { fingerprintHash: { $type: "string", $gt: "" } } }
        );

        // ── Upload quotas ──────────────────────────────────────────────────────
        // The check/record pair always queries by (userId, windowStart).
        const uploadQuotasCollection = database.collection(DatabaseConstants.UPLOAD_QUOTAS_COLLECTION);
        await uploadQuotasCollection.createIndex({ userId: 1, windowStart: 1 }, { unique: true });

        // ── Bundle discounts ───────────────────────────────────────────────────
        // Two-way lookup: "what does this bundle include?" and "which
        // bundles include this deck?" (used when computing pro-rated
        // pricing on the included side).
        const bundleDiscountsCollection = database.collection(DatabaseConstants.BUNDLE_DISCOUNTS_COLLECTION);
        await bundleDiscountsCollection.createIndex({ bundleDeckId: 1 });
        await bundleDiscountsCollection.createIndex({ includedDeckId: 1 });

        // ── Screenshot events ──────────────────────────────────────────────────
        // Telemetry log; admin reviews recent events per user. TTL keeps
        // the collection from growing unbounded — 90 days matches the
        // deletions TTL convention used elsewhere in this file.
        const screenshotEventsCollection = database.collection(DatabaseConstants.SCREENSHOT_EVENTS_COLLECTION);
        await screenshotEventsCollection.createIndex({ userId: 1, timestamp: -1 });
        await screenshotEventsCollection.createIndex({ timestamp: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

        // ── Task history ───────────────────────────────────────────────────────
        // Long-term archive of generation tasks once they leave Redis.
        // Activity feed renders newest-first and filters by status, so
        // both queries get compound indexes anchored on userId.
        const taskHistoryCollection = database.collection(DatabaseConstants.TASK_HISTORY_COLLECTION);
        await taskHistoryCollection.createIndex({ id: 1 }, { unique: true });
        await taskHistoryCollection.createIndex({ userId: 1, completedAt: -1 });
        await taskHistoryCollection.createIndex({ userId: 1, status: 1 });

        // ── Admin emails ───────────────────────────────────────────────────────
        // Allowlist that drives the login-time role promotion in
        // HandleLoginCallback. Lookups are point queries on email; the
        // unique index also blocks duplicate-with-different-case rows
        // because the QueryEngine lowercases on every write.
        const adminEmailsCollection = database.collection(DatabaseConstants.ADMIN_EMAILS_COLLECTION);
        await adminEmailsCollection.createIndex({ email: 1 }, { unique: true });

        const AdminEmailSeeder = require('./AdminEmailSeeder');
        await AdminEmailSeeder.seedFromJsonFile();

        // ── Allowed login emails (per-environment login allowlist) ──────────────
        // Drives the login-time AccessGate check when the environment
        // allowlist is enabled (dev / test only). Lookups are point queries
        // on email; the unique index also blocks duplicate-with-different-case
        // rows because the QueryEngine lowercases on every write. Being on
        // this list only permits login — it never grants the admin role.
        const allowedLoginEmailsCollection = database.collection(DatabaseConstants.ALLOWED_LOGIN_EMAILS_COLLECTION);
        await allowedLoginEmailsCollection.createIndex({ email: 1 }, { unique: true });

        const AllowedLoginEmailSeeder = require('./AllowedLoginEmailSeeder');
        await AllowedLoginEmailSeeder.seedFromJsonFile();

        // ── OTP requests ───────────────────────────────────────────────────────
        // One active OTP per email; the absolute-expiry TTL mirrors the
        // sessions collection so the cleanup pattern is consistent.
        const otpRequestsCollection = database.collection(DatabaseConstants.OTP_REQUESTS_COLLECTION);
        await otpRequestsCollection.createIndex({ email: 1 }, { unique: true });
        await otpRequestsCollection.createIndex({ expirationDate: 1 }, { expireAfterSeconds: 0 });

        // ── Release notes ──────────────────────────────────────────────────────
        // Versioned changelog the admin publishes; clients filter on
        // versionSortKey > user.additionalData.lastSeenReleaseNoteVersionSortKey
        // to find unseen entries. version + versionSortKey are unique so a
        // concurrent admin race fails E11000 and the create handler retries
        // with a freshly-computed sort key.
        const releaseNotesCollection = database.collection(DatabaseConstants.RELEASE_NOTES_COLLECTION);
        await releaseNotesCollection.createIndex({ id: 1 }, { unique: true });
        await releaseNotesCollection.createIndex({ version: 1 }, { unique: true });
        await releaseNotesCollection.createIndex({ versionSortKey: -1 }, { unique: true });
        await releaseNotesCollection.createIndex({ releaseDate: -1 });

        // ── Organizations ──────────────────────────────────────────────────────
        // B2B partnership entities. One row per org; the admin user is
        // looked up by adminEmail (login-time reconciliation) so the email
        // gets its own non-unique index. Multi-org admins are allowed, so
        // adminEmail is intentionally NOT unique. Status filtering on
        // listing pages is small enough not to warrant a dedicated index.
        const organizationsCollection = database.collection(DatabaseConstants.ORGANIZATIONS_COLLECTION);
        await organizationsCollection.createIndex({ id: 1 }, { unique: true });
        await organizationsCollection.createIndex({ adminEmail: 1 });

        // ── Organization members ───────────────────────────────────────────────
        // Membership is keyed by email — the userId is back-filled on
        // first login. Unique on (organizationId, email) blocks duplicates.
        // The standalone `email` index powers the pricing-engine lookup
        // "what orgs is this email a member of?" which fires on every
        // paid-deck price calculation for org members.
        const organizationMembersCollection = database.collection(DatabaseConstants.ORGANIZATION_MEMBERS_COLLECTION);
        await organizationMembersCollection.createIndex({ id: 1 }, { unique: true });
        await organizationMembersCollection.createIndex({ organizationId: 1, email: 1 }, { unique: true });
        await organizationMembersCollection.createIndex({ email: 1 });

        // ── Organization deck perks ────────────────────────────────────────────
        // The deal terms — at most one perk row per (org, paidDeckId).
        // Lookups: "all perks for this org" (admin panel render),
        // "perk for this org+deck" (pricing engine).
        const organizationDeckPerksCollection = database.collection(DatabaseConstants.ORGANIZATION_DECK_PERKS_COLLECTION);
        await organizationDeckPerksCollection.createIndex({ id: 1 }, { unique: true });
        await organizationDeckPerksCollection.createIndex({ organizationId: 1, deckId: 1 }, { unique: true });

        // ── Org-admin verifications ────────────────────────────────────────────
        // Short-lived (1h) record proving the super-admin completed the
        // emailed-OTP step for a given email. Two phases: code-hash phase
        // (rate-limited like login OTPs), then verification-token phase
        // (consumed by Create / VerifyCreationPayment). Single row per
        // email at a time; TTL purges stale rows on the absolute expiry.
        const orgAdminVerificationsCollection = database.collection(DatabaseConstants.ORG_ADMIN_VERIFICATIONS_COLLECTION);
        await orgAdminVerificationsCollection.createIndex({ email: 1 }, { unique: true });
        await orgAdminVerificationsCollection.createIndex({ verificationToken: 1 });
        await orgAdminVerificationsCollection.createIndex({ expirationDate: 1 }, { expireAfterSeconds: 0 });

        // ── Organization payments ──────────────────────────────────────────────
        // Audit log of Razorpay charges tied to an org (creation +
        // expansions). providerOrderId is the idempotency key the webhook
        // uses to recognise duplicate deliveries.
        const organizationPaymentsCollection = database.collection(DatabaseConstants.ORGANIZATION_PAYMENTS_COLLECTION);
        await organizationPaymentsCollection.createIndex({ id: 1 }, { unique: true });
        await organizationPaymentsCollection.createIndex({ providerOrderId: 1 }, { unique: true });
        await organizationPaymentsCollection.createIndex({ organizationId: 1, kind: 1, createdAt: -1 });

        // ── Alerts ─────────────────────────────────────────────────────────────
        // Operational alert log surfaced in the admin panel. Open
        // (unacknowledged) rows are deduped by (source, title), so that pair
        // is indexed to make the dedupe lookup cheap. createdAt/lastSeenAt
        // power the newest-first listing and the admin notifier's
        // "lastSeenAt > since" poll.
        const alertsCollection = database.collection(DatabaseConstants.ALERTS_COLLECTION);
        await alertsCollection.createIndex({ id: 1 }, { unique: true });
        await alertsCollection.createIndex({ lastSeenAt: -1 });
        await alertsCollection.createIndex({ acknowledged: 1, lastSeenAt: -1 });
        await alertsCollection.createIndex({ source: 1, title: 1, acknowledged: 1 });

        // ── Rate-limit events ───────────────────────────────────────────────────
        // Server-side 429 log; admin reviews recent events and per-identity
        // abuse. TTL prunes the collection so it never grows unbounded.
        const rateLimitEventsCollection = database.collection(DatabaseConstants.RATE_LIMIT_EVENTS_COLLECTION);
        await rateLimitEventsCollection.createIndex({ id: 1 }, { unique: true });
        await rateLimitEventsCollection.createIndex({ occurredAt: -1 });
        await rateLimitEventsCollection.createIndex({ identityKey: 1, occurredAt: -1 });
        await rateLimitEventsCollection.createIndex({ occurredAt: 1 }, { expireAfterSeconds: DatabaseConstants.RATE_LIMIT_EVENTS_TTL_DAYS * 24 * 60 * 60 });

        // ── Admin audit events ──────────────────────────────────────────────────
        // Persistent trail of privileged actions (who hit which admin endpoint,
        // with what outcome). actorUserId/occurredAt power the newest-first and
        // per-admin listings; TTL prunes the collection so it never grows
        // unbounded (retained longer than rate-limit events — audit relevance).
        const adminAuditEventsCollection = database.collection(DatabaseConstants.ADMIN_AUDIT_EVENTS_COLLECTION);
        await adminAuditEventsCollection.createIndex({ id: 1 }, { unique: true });
        await adminAuditEventsCollection.createIndex({ occurredAt: -1 });
        await adminAuditEventsCollection.createIndex({ actorUserId: 1, occurredAt: -1 });
        await adminAuditEventsCollection.createIndex({ occurredAt: 1 }, { expireAfterSeconds: DatabaseConstants.ADMIN_AUDIT_EVENTS_TTL_DAYS * 24 * 60 * 60 });

        // ── Credit transactions ────────────────────────────────────────────────
        // Append-only ledger. The unique referenceKey index is load-bearing:
        // it is the idempotency guard that makes every charge / grant safe
        // against task retries and replays. The per-user, newest-first index
        // powers the in-app transaction history view.
        const creditTransactionsCollection = database.collection(DatabaseConstants.CREDIT_TRANSACTIONS_COLLECTION);
        await creditTransactionsCollection.createIndex({ referenceKey: 1 }, { unique: true });
        await creditTransactionsCollection.createIndex({ userId: 1, createdAt: -1 });

        // ── Task states (pause / resume) ────────────────────────────────────────
        // A paused task a user can resume after, e.g., topping up credits. The
        // unique userId index enforces AT MOST ONE per user (so this can't be
        // abused as general storage); the TTL on expiresAt auto-deletes a stale
        // state after a week. The full state content lives in the GCS bucket;
        // this collection is the lean index + lifecycle owner.
        const taskStatesCollection = database.collection(DatabaseConstants.TASK_STATES_COLLECTION);
        await taskStatesCollection.createIndex({ userId: 1 }, { unique: true });
        await taskStatesCollection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

        // ── Periodic credit assignments ────────────────────────────────────────
        // First-class recurring-grant definitions managed in the admin panel.
        // The lazy reconciler (fired on GetUser / before an AI charge) queries
        // active assignments two ways: by the member's current organizations
        // (scopeType + organizationId) and by an explicit people-set that names
        // the email (the multikey peopleEmails index). The (status, scopeType)
        // index backs the admin listing.
        const periodicCreditAssignmentsCollection = database.collection(DatabaseConstants.PERIODIC_CREDIT_ASSIGNMENTS_COLLECTION);
        await periodicCreditAssignmentsCollection.createIndex({ id: 1 }, { unique: true });
        await periodicCreditAssignmentsCollection.createIndex({ status: 1, scopeType: 1 });
        await periodicCreditAssignmentsCollection.createIndex({ scopeType: 1, organizationId: 1 });
        await periodicCreditAssignmentsCollection.createIndex({ peopleEmails: 1 });

        // ── Periodic assignment recipients ─────────────────────────────────────
        // Per-(assignment, email) cursor + denormalised report data. The row is
        // the fast lookup for "has this email already been paid for this period
        // / on-join?" — but the creditTransactions referenceKey remains the true
        // idempotency guard; this collection is a rebuildable perf + report
        // index. The unique (assignmentId, email) blocks duplicate rows; the
        // by-email index lets the reconciler find every assignment a returning
        // user has ever touched.
        const periodicAssignmentRecipientsCollection = database.collection(DatabaseConstants.PERIODIC_ASSIGNMENT_RECIPIENTS_COLLECTION);
        await periodicAssignmentRecipientsCollection.createIndex({ assignmentId: 1, email: 1 }, { unique: true });
        await periodicAssignmentRecipientsCollection.createIndex({ assignmentId: 1 });
        await periodicAssignmentRecipientsCollection.createIndex({ email: 1 });

        // ── Credit deal payments ───────────────────────────────────────────────
        // Standalone, non-gating money record attachable to a periodic
        // assignment OR a one-time fixed grant (targetType + targetId). The
        // sparse providerOrderId index makes the in-page Razorpay capture and
        // the webhook safety-net lookup idempotent without indexing the many
        // INDEPENDENT rows that carry no order id.
        const creditDealPaymentsCollection = database.collection(DatabaseConstants.CREDIT_DEAL_PAYMENTS_COLLECTION);
        await creditDealPaymentsCollection.createIndex({ id: 1 }, { unique: true });
        await creditDealPaymentsCollection.createIndex({ targetType: 1, targetId: 1 });
        await creditDealPaymentsCollection.createIndex({ providerOrderId: 1 }, { sparse: true });

        // Promo codes. The unique codeString index forbids duplicate codes
        // (codes are stored normalized uppercase); the unique (promoCodeId,
        // userId) index forbids a second redemption by the same user.
        const promoCodesCollection = database.collection(DatabaseConstants.PROMO_CODES_COLLECTION);
        await promoCodesCollection.createIndex({ codeString: 1 }, { unique: true });
        await promoCodesCollection.createIndex({ id: 1 }, { unique: true });
        await promoCodesCollection.createIndex({ createdAt: -1 });

        const promoCodeRedemptionsCollection = database.collection(DatabaseConstants.PROMO_CODE_REDEMPTIONS_COLLECTION);
        await promoCodeRedemptionsCollection.createIndex({ promoCodeId: 1, userId: 1 }, { unique: true });
        await promoCodeRedemptionsCollection.createIndex({ promoCodeId: 1, redeemedAt: -1 });
        await promoCodeRedemptionsCollection.createIndex({ userId: 1, redeemedAt: -1 });

        // ── Log events ─────────────────────────────────────────────────────────
        // The central, live application log written by every service (Dock, Agent,
        // burst workers, Web). It DELIBERATELY has NO TTL index: unlike the other
        // event logs above, these entries are MOVED to cloud storage by
        // LogArchivalScheduler (write → verify → delete), which is the SOLE deleter.
        // A TTL here would silently delete entries before they were archived and
        // break the "no logs lost" guarantee. `timestamp` is a BSON Date so the
        // admin DateRangeFilter and the range/archival queries compare natively.
        const logEventsCollection = database.collection(DatabaseConstants.LOG_EVENTS_COLLECTION);
        await logEventsCollection.createIndex({ id: 1 }, { unique: true });
        await logEventsCollection.createIndex({ timestamp: -1 });
        await logEventsCollection.createIndex({ level: 1, timestamp: -1 });
        await logEventsCollection.createIndex({ category: 1, timestamp: -1 });
        await logEventsCollection.createIndex({ accountId: 1, timestamp: -1 });

        // ── Log archives (manifest) ─────────────────────────────────────────────
        // One row per cloud-storage archive object written by LogArchivalScheduler,
        // recording the time range it covers so a download spanning cold data can
        // find and merge the overlapping archives. The bucket object is the durable
        // record; this manifest is the queryable index into it.
        const logArchivesCollection = database.collection(DatabaseConstants.LOG_ARCHIVES_COLLECTION);
        await logArchivesCollection.createIndex({ id: 1 }, { unique: true });
        await logArchivesCollection.createIndex({ coveredFrom: 1, coveredTo: 1 });
        await logArchivesCollection.createIndex({ createdAt: -1 });
    }
}

module.exports = DatabaseConnector;