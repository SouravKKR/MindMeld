// Reads and seeds the synced collections straight from MongoDB for
// run_sync_ui_tests.js.
//
// Sync is the one subsystem whose correctness is only half visible from the
// app. The client can show a tidy "Synced ✓" over a library that never reached
// the server, and the server can hold rows the client silently dropped — both
// look identical from the browser. So every case in the sync suite asserts a
// browser-visible outcome AGAINST the server's own state, and this is where
// that second half comes from.
//
// It also does the seeding no UI can do at a sensible speed: the chunked-drain
// cases need more entities than MAX_PULL_PER_COLLECTION, and authoring 260
// cards through the card editor would take longer than the whole rest of the
// suite. Those rows are CLONED from a card the suite really did author through
// the UI, so their shape can never drift from what the app writes.
//
// Borrows Dock's driver and .env rather than installing its own copy, exactly
// as CreditLedgerProbe does: the test directory installs only Puppeteer, and a
// second Mongo driver here would be a second version to keep in step with the
// server's.

const path = require("path");

class SyncDatabaseProbe
{
    // Mirrored from Common/Enumerations/EntityTypes.json — the deletions
    // collection stores the numeric value, so a tombstone sweep needs them.
    static ENTITY_TYPE_DECK = 0;
    static ENTITY_TYPE_CARD = 1;
    static ENTITY_TYPE_STUDY_MATERIAL = 2;
    static ENTITY_TYPE_MOCK_TEST = 3;

    static DECKS_COLLECTION = "decks";
    static CARDS_COLLECTION = "cards";
    static STUDY_MATERIALS_COLLECTION = "studyMaterials";
    static MOCK_TESTS_COLLECTION = "mockTests";
    static DELETIONS_COLLECTION = "deletions";

    // Every collection whose rows the client pulls. Kept in one place so a
    // count, a sweep and a cursor bump can never disagree about what "the
    // user's synced data" means.
    static SYNCED_COLLECTIONS =
    [
        SyncDatabaseProbe.DECKS_COLLECTION,
        SyncDatabaseProbe.CARDS_COLLECTION,
        SyncDatabaseProbe.STUDY_MATERIALS_COLLECTION,
        SyncDatabaseProbe.MOCK_TESTS_COLLECTION,
    ];

    #client = null;
    #database = null;
    #accountId = "";

    constructor(accountId)
    {
        this.#accountId = accountId;
    }

    /**
     * Connects using Dock's driver and configuration. Returns false when the
     * database is not configured or unreachable — callers treat that as an
     * ENVIRONMENT problem, never as the app being wrong.
     */
    async connect(repositoryRoot)
    {
        const dockDirectory = path.join(repositoryRoot, "Dock");

        try
        {
            require(path.join(dockDirectory, "node_modules", "dotenv"))
                .config({ path: path.join(dockDirectory, ".env"), quiet: true });

            const { MongoClient } = require(path.join(dockDirectory, "node_modules", "mongodb"));

            const databaseUrl = process.env.MONGODB_URL;
            const databaseName = process.env.MONGODB_DATABASE_NAME;

            if (!databaseUrl || !databaseName)
            {
                return false;
            }

            this.#client = new MongoClient(databaseUrl, { serverSelectionTimeoutMS: 10000 });
            await this.#client.connect();
            this.#database = this.#client.db(databaseName);

            // Prove the connection rather than trusting a lazily-created client.
            await this.#database.command({ ping: 1 });
            return true;
        }
        catch (connectionError)
        {
            this.#client = null;
            this.#database = null;
            return false;
        }
    }

    async close()
    {
        if (this.#client)
        {
            await this.#client.close().catch(() => {});
            this.#client = null;
            this.#database = null;
        }
    }

    getDatabase()
    {
        return this.#database;
    }

    // -- Reads ----------------------------------------------------------------

    /**
     * One row count per synced collection, plus the total. Taken in one place
     * so a "before" and an "after" can never be measured from two different
     * shapes — the comparison that proves a drain lost nothing.
     */
    async readEntityCounts()
    {
        const counts = {};
        let total = 0;

        for (const collectionName of SyncDatabaseProbe.SYNCED_COLLECTIONS)
        {
            const count = await this.#database.collection(collectionName)
                .countDocuments({ userId: this.#accountId });
            counts[collectionName] = count;
            total = total + count;
        }

        counts.total = total;
        return counts;
    }

    async findDeckByShortName(shortName)
    {
        return this.#database.collection(SyncDatabaseProbe.DECKS_COLLECTION)
            .findOne({ userId: this.#accountId, "data.shortName": shortName });
    }

    async findDeckById(deckId)
    {
        return this.#database.collection(SyncDatabaseProbe.DECKS_COLLECTION)
            .findOne({ userId: this.#accountId, "data.id": deckId });
    }

    async countRootLevelDecks()
    {
        const rootDeck = await this.#database.collection(SyncDatabaseProbe.DECKS_COLLECTION)
            .findOne({ userId: this.#accountId, "data.parent": null });
        if (!rootDeck)
        {
            return { rootDeckId: null, childCount: 0 };
        }

        const childCount = await this.#database.collection(SyncDatabaseProbe.DECKS_COLLECTION)
            .countDocuments({ userId: this.#accountId, "data.parent": rootDeck.data.id });

        return { rootDeckId: rootDeck.data.id, childCount };
    }

    async countCardsInDeck(deckId)
    {
        return this.#database.collection(SyncDatabaseProbe.CARDS_COLLECTION)
            .countDocuments({ userId: this.#accountId, "data.deckId": deckId });
    }

    async findAnyCardInDeck(deckId)
    {
        return this.#database.collection(SyncDatabaseProbe.CARDS_COLLECTION)
            .findOne({ userId: this.#accountId, "data.deckId": deckId });
    }

    async countDeletionTombstones(entityType)
    {
        return this.#database.collection(SyncDatabaseProbe.DELETIONS_COLLECTION)
            .countDocuments({ userId: this.#accountId, entityType: entityType });
    }

    // -- Seeding --------------------------------------------------------------

    /**
     * Clones a card the suite authored through the UI into `cloneCount` fresh
     * rows in the same deck, each with its own id and question text.
     *
     * Cloning rather than hand-building the document is deliberate: `data` is
     * the client's own serialisation (progress, lifecycle, FSRS state and all),
     * and a hand-written stand-in would drift the moment Card gains a field —
     * failing as "the drain lost cards" when the truth is that the fixture was
     * malformed. Every clone carries the SAME serverUpdatedAt so the pull sees
     * one same-timestamp group, which is the shape the chunk cut-point logic
     * has to round past.
     */
    async cloneCardsIntoDeck(templateCard, cloneCount, questionPrefix)
    {
        const writeTimestamp = new Date();
        const documents = [];

        for (let cloneIndex = 0; cloneIndex < cloneCount; cloneIndex++)
        {
            const clonedData = JSON.parse(JSON.stringify(templateCard.data));
            clonedData.id = `${questionPrefix}-card-${cloneIndex}-${writeTimestamp.getTime()}`;
            clonedData.question = `${questionPrefix} question ${cloneIndex}`;
            clonedData.answer = `${questionPrefix} answer ${cloneIndex}`;

            documents.push(
            {
                userId: this.#accountId,
                data: clonedData,
                serverUpdatedAt: writeTimestamp,
            });
        }

        await this.#database.collection(SyncDatabaseProbe.CARDS_COLLECTION).insertMany(documents);
        return { insertedCount: documents.length, writeTimestamp };
    }

    /**
     * Pushes every one of the account's rows back above a client's cursor, so
     * the next incremental /Sync has the whole library to deliver — the state a
     * device that has been away long enough arrives in. Returns how many rows
     * were touched.
     */
    async bumpAllServerUpdatedAt()
    {
        const writeTimestamp = new Date();
        let modifiedCount = 0;

        for (const collectionName of SyncDatabaseProbe.SYNCED_COLLECTIONS)
        {
            const result = await this.#database.collection(collectionName).updateMany(
                { userId: this.#accountId },
                { $set: { serverUpdatedAt: writeTimestamp } });
            modifiedCount = modifiedCount + result.modifiedCount;
        }

        return { modifiedCount, writeTimestamp };
    }

    // -- Cleanup --------------------------------------------------------------

    /**
     * Removes the deletion tombstones for a set of entity ids.
     *
     * deleteFixtureData can only sweep tombstones for rows it can still FIND,
     * so an entity the suite deleted through the UI — its row already gone by
     * cleanup time — leaves its tombstone behind forever. Individually that is
     * harmless (a tombstone for an id nothing holds is a no-op on every
     * device), but this suite runs on every production deploy, and the pull
     * caps deletions at MAX_PULL_DELETIONS: left to grow, the account's
     * tombstone count would eventually start changing how the drain cases
     * behave. Callers pass the ids they deleted so the growth stops at zero.
     */
    async deleteTombstonesFor(entityIds)
    {
        const usableEntityIds = (entityIds || []).filter((entityId) => typeof entityId === "string" && entityId.length > 0);
        if (usableEntityIds.length === 0)
        {
            return 0;
        }

        const result = await this.#database.collection(SyncDatabaseProbe.DELETIONS_COLLECTION)
            .deleteMany({ userId: this.#accountId, entityId: { $in: usableEntityIds } });
        return result.deletedCount;
    }

    /**
     * Removes every row this suite created, including the tombstones its
     * deletions left behind.
     *
     * The tombstones matter as much as the rows: a leftover deck tombstone is
     * replayed to every device on their next pull, so skipping them would let
     * one run's fixtures delete the next run's. Decks are matched on the
     * fixture prefix, and anything parented to one of them is swept with it.
     */
    async deleteFixtureData(fixturePrefix)
    {
        const decksCollection = this.#database.collection(SyncDatabaseProbe.DECKS_COLLECTION);
        const fixtureDecks = await decksCollection.find(
        {
            userId: this.#accountId,
            $or:
            [
                { "data.name": { $regex: `^${fixturePrefix}` } },
                { "data.shortName": { $regex: `^${fixturePrefix}` } },
            ],
        }).toArray();

        const fixtureDeckIds = fixtureDecks.map((deckDocument) => deckDocument.data.id);
        const removedEntityIds = [...fixtureDeckIds];
        let removedRowCount = 0;

        if (fixtureDeckIds.length > 0)
        {
            for (const collectionName of [SyncDatabaseProbe.CARDS_COLLECTION,
                SyncDatabaseProbe.STUDY_MATERIALS_COLLECTION,
                SyncDatabaseProbe.MOCK_TESTS_COLLECTION])
            {
                const childDocuments = await this.#database.collection(collectionName)
                    .find({ userId: this.#accountId, "data.deckId": { $in: fixtureDeckIds } })
                    .project({ "data.id": 1 })
                    .toArray();

                for (const childDocument of childDocuments)
                {
                    removedEntityIds.push(childDocument.data.id);
                }

                const childResult = await this.#database.collection(collectionName)
                    .deleteMany({ userId: this.#accountId, "data.deckId": { $in: fixtureDeckIds } });
                removedRowCount = removedRowCount + childResult.deletedCount;
            }

            const deckResult = await decksCollection.deleteMany({ userId: this.#accountId, "data.id": { $in: fixtureDeckIds } });
            removedRowCount = removedRowCount + deckResult.deletedCount;
        }

        // Sweep the tombstones too, or the next run inherits deletions that
        // target ids it is about to reuse.
        let removedTombstoneCount = 0;
        if (removedEntityIds.length > 0)
        {
            const tombstoneResult = await this.#database.collection(SyncDatabaseProbe.DELETIONS_COLLECTION)
                .deleteMany({ userId: this.#accountId, entityId: { $in: removedEntityIds } });
            removedTombstoneCount = tombstoneResult.deletedCount;
        }

        return { removedRowCount, removedTombstoneCount, fixtureDeckCount: fixtureDeckIds.length };
    }
}

module.exports = SyncDatabaseProbe;
