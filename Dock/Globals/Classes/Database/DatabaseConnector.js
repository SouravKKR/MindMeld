const { MongoClient, Db, ServerApiVersion } = require('mongodb');
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

    static async #connect()
    {
        DatabaseConnector.#mongoClient = new MongoClient(App.getDatabaseUrl(),
        {
            serverApi:
            {
                version: ServerApiVersion.v1,
                strict: true,
                deprecationErrors: true,
            }
        });

        try
        {
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
        await deletionsCollection.createIndex({ deletedAt: 1 }, { expireAfterSeconds: DatabaseConstants.DELETIONS_TTL_DAYS * 24 * 60 * 60 });

        // ── Mock tests ─────────────────────────────────────────────────────────
        // One document per user per mock test
        await mockTestsCollection.createIndex({ userId: 1, "data.id": 1 }, { unique: true });

        // Pull mock tests updated on the server since a given timestamp (sync)
        await mockTestsCollection.createIndex({ userId: 1, serverUpdatedAt: 1 });

        // Fetch all mock tests belonging to a specific deck
        await mockTestsCollection.createIndex({ userId: 1, "data.deckId": 1 });

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

        // ── Paid deck assets ───────────────────────────────────────────────────
        // Encrypted blob lookup is always by (deckId, keyVersion).
        const paidDeckAssetsCollection = database.collection(DatabaseConstants.PAID_DECK_ASSETS_COLLECTION);
        await paidDeckAssetsCollection.createIndex({ deckId: 1, keyVersion: 1 }, { unique: true });

        // ── Deck licenses ──────────────────────────────────────────────────────
        // Per-user, per-deck license. Lookups: "my licenses" (userId),
        // "license for this deck" (userId+deckId), key rotation
        // ("all licenses for deck X currently ACTIVE"), sync delta pull
        // ("licenses updated since timestamp T").
        const deckLicensesCollection = database.collection(DatabaseConstants.DECK_LICENSES_COLLECTION);
        await deckLicensesCollection.createIndex({ userId: 1, deckId: 1 }, { unique: true });
        await deckLicensesCollection.createIndex({ userId: 1, rotatedAt: -1 });
        await deckLicensesCollection.createIndex({ deckId: 1, status: 1 });

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
    }
}

module.exports = DatabaseConnector;