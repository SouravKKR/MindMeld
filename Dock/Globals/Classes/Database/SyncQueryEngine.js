const DatabaseConnector = require("./DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const { entityTypes } = require("../../Enumerations/EntityTypes");

class SyncQueryEngine
{
    /**
     * Upserts a deck into the decks collection.
     * Only overwrites if the incoming data has a newer lifecycle.lastModified than the existing record.
     * Sets serverUpdatedAt to the current time on every successful insert or update.
     * @param {string} userId - The id of the user who owns the deck.
     * @param {object} deckData - The deck's toSyncJson() output.
     * @returns {Promise<boolean>} True if the document was inserted or updated, false if skipped.
     */
    static async upsertDeck(userId, deckData)
    {
        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.DECKS_COLLECTION);
        const existing = await collection.findOne({ userId: userId, "data.id": deckData.id });

        if (!existing)
        {
            await collection.insertOne(
            { 
                userId: userId, 
                data: deckData, 
                serverUpdatedAt: new Date() 
            });
            return true;
        }

        const incomingLastModified = new Date(deckData.lifecycle.lastModified);
        const existingLastModified = new Date(existing.data.lifecycle.lastModified);

        if (incomingLastModified > existingLastModified)
        {
            await collection.updateOne(
                { userId: userId, "data.id": deckData.id },
                { $set: { data: deckData, serverUpdatedAt: new Date() } }
            );
            return true;
        }

        return false;
    }

    /**
     * Upserts a card into the cards collection.
     * Only overwrites if the incoming data has a newer lifecycle.lastModified than the existing record.
     * Sets serverUpdatedAt to the current time on every successful insert or update.
     * @param {string} userId - The id of the user who owns the card.
     * @param {object} cardData - The card's toJson() output.
     * @returns {Promise<boolean>} True if the document was inserted or updated, false if skipped.
     */
    static async upsertCard(userId, cardData)
    {
        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.CARDS_COLLECTION);
        const existing = await collection.findOne({ userId: userId, "data.id": cardData.id });

        if (!existing)
        {
            await collection.insertOne(
            { 
                userId: userId, 
                data: cardData, 
                serverUpdatedAt: new Date() 
            });
            return true;
        }

        const incomingLastModified = new Date(cardData.lifecycle.lastModified);
        const existingLastModified = new Date(existing.data.lifecycle.lastModified);

        if (incomingLastModified > existingLastModified)
        {
            await collection.updateOne(
                { userId: userId, "data.id": cardData.id },
                { $set: { data: cardData, serverUpdatedAt: new Date() } }
            );
            return true;
        }

        return false;
    }

    static async upsertStudyMaterial(userId, studyMaterialData)
    {
        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.STUDY_MATERIALS_COLLECTION);

        const existing = await collection.findOne({ userId: userId, "data.id": studyMaterialData.id });

        if (!existing)
        {
            await collection.insertOne(
            {
                userId: userId,
                data: studyMaterialData,
                serverUpdatedAt: new Date()
            });
            return true;
        }

        const incomingLastModified = new Date(studyMaterialData.lifecycle.lastModified);
        const existingLastModified = new Date(existing.data.lifecycle.lastModified);

        if (incomingLastModified > existingLastModified)
        {
            await collection.updateOne(
                { userId: userId, "data.id": studyMaterialData.id },
                { $set: { data: studyMaterialData, serverUpdatedAt: new Date() } }
            );
            return true;
        }

        return false;
    }

    /**
     * Upserts a mock test into the mock tests collection.
     * Only overwrites if the incoming data has a newer lifecycle.lastModified than the existing record.
     * Sets serverUpdatedAt to the current time on every successful insert or update.
     * NOTE: Add MOCK_TESTS_COLLECTION to DatabaseConstants.js to wire this up.
     * @param {string} userId - The id of the user who owns the mock test.
     * @param {object} mockTestData - The mock test's toJson() output.
     * @returns {Promise<boolean>} True if the document was inserted or updated, false if skipped.
     */
    static async upsertMockTest(userId, mockTestData)
    {
        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.MOCK_TESTS_COLLECTION);
        const existing   = await collection.findOne({ userId: userId, "data.id": mockTestData.id });

        if (!existing)
        {
            await collection.insertOne(
            {
                userId:          userId,
                data:            mockTestData,
                serverUpdatedAt: new Date()
            });
            return true;
        }

        const incomingLastModified = new Date(mockTestData.lifecycle.lastModified);
        const existingLastModified = new Date(existing.data.lifecycle.lastModified);

        if (incomingLastModified > existingLastModified)
        {
            await collection.updateOne(
                { userId: userId, "data.id": mockTestData.id },
                { $set: { data: mockTestData, serverUpdatedAt: new Date() } }
            );
            return true;
        }

        return false;
    }

    /**
     * Retrieves all decks updated on the server since the given timestamp for a user.
     * Uses the server-side serverUpdatedAt field, not the entity's own lifecycle timestamp.
     * @param {string} userId - The id of the user.
     * @param {number} lastSyncTimestamp - Epoch milliseconds.
     * @returns {Promise<object[]>} Array of deck data objects.
     */
    static async getDecksSince(userId, lastSyncTimestamp)
    {
        const collection    = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.DECKS_COLLECTION);
        const lastSyncDate  = new Date(lastSyncTimestamp);

        const documents = await collection.find(
        {
            userId: userId,
            serverUpdatedAt: { $gt: lastSyncDate }
        }).toArray();

        return documents.map((document) => document.data);
    }

    /**
     * Retrieves all cards updated on the server since the given timestamp for a user.
     * Uses the server-side serverUpdatedAt field, not the entity's own lifecycle timestamp.
     * @param {string} userId - The id of the user.
     * @param {number} lastSyncTimestamp - Epoch milliseconds.
     * @returns {Promise<object[]>} Array of card data objects.
     */
    static async getCardsSince(userId, lastSyncTimestamp)
    {
        const collection   = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.CARDS_COLLECTION);
        const lastSyncDate = new Date(lastSyncTimestamp);

        const documents = await collection.find(
        {
            userId: userId,
            serverUpdatedAt: { $gt: lastSyncDate }
        }).toArray();

        return documents.map((document) => document.data);
    }

    static async getStudyMaterialsSince(userId, lastSyncTimestamp)
    {
        const collection   = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.STUDY_MATERIALS_COLLECTION);
        const lastSyncDate = new Date(lastSyncTimestamp);

        const documents = await collection.find(
        {
            userId: userId,
            serverUpdatedAt: { $gt: lastSyncDate }
        }).toArray();

        return documents.map(doc => doc.data);
    }

    /**
     * Retrieves all mock tests updated on the server since the given timestamp for a user.
     * NOTE: Requires MOCK_TESTS_COLLECTION in DatabaseConstants.js.
     * @param {string} userId - The id of the user.
     * @param {number} lastSyncTimestamp - Epoch milliseconds.
     * @returns {Promise<object[]>} Array of mock test data objects.
     */
    static async getMockTestsSince(userId, lastSyncTimestamp)
    {
        const collection   = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.MOCK_TESTS_COLLECTION);
        const lastSyncDate = new Date(lastSyncTimestamp);

        const documents = await collection.find(
        {
            userId: userId,
            serverUpdatedAt: { $gt: lastSyncDate }
        }).toArray();

        return documents.map(doc => doc.data);
    }

    /**
     * Records a deletion in the deletions collection and removes the entity from its source collection.
     * @param {string} userId - The id of the user.
     * @param {string} entityId - The id of the entity being deleted.
     * @param {number} entityType - The entity type from the entityTypes enumeration.
     * @returns {Promise<void>}
     */
    static async recordDeletion(userId, entityId, entityType)
    {
        const deletionsCollection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.DELETIONS_COLLECTION);

        await deletionsCollection.updateOne(
            { userId: userId, entityId: entityId },
            {
                $set:
                {
                    userId:      userId,
                    entityId:    entityId,
                    entityType:  entityType,
                    deletedAt:   new Date()
                }
            },
            { upsert: true }
        );

        if (entityType === entityTypes.DECK)
        {
            const decksCollection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.DECKS_COLLECTION);
            await decksCollection.deleteOne({ userId: userId, "data.id": entityId });
        }
        else if (entityType === entityTypes.CARD)
        {
            const cardsCollection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.CARDS_COLLECTION);
            await cardsCollection.deleteOne({ userId: userId, "data.id": entityId });
        }
        else if (entityType === entityTypes.STUDY_MATERIAL)
        {
            const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.STUDY_MATERIALS_COLLECTION);
            await collection.deleteOne({ userId: userId, "data.id": entityId });
        }
        else if (entityType === entityTypes.MOCK_TEST)
        {
            const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.MOCK_TESTS_COLLECTION);
            await collection.deleteOne({ userId: userId, "data.id": entityId });
        }
        else if (entityType === entityTypes.ASK_AI_POPUP_LINK)
        {
            const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.ASK_AI_POPUP_LINKS_COLLECTION);
            await collection.deleteOne({ userId: userId, "data.id": entityId });
        }
    }

    /**
     * Retrieves deletion records since the given timestamp for a user, sorted
     * by deletedAt ascending. When `limit` is given, at most that many are
     * fetched (the caller passes MAX + buffer + 1 to detect overflow and round
     * the chunk cut up to a whole same-timestamp group).
     * @param {string} userId - The id of the user.
     * @param {number} lastSyncTimestamp - Epoch milliseconds.
     * @param {number} [limit=0] - Max records to fetch; 0 = unbounded.
     * @returns {Promise<object[]>} Array of deletion records with entityId, entityType, and deletedAt.
     */
    static async getDeletionsSince(userId, lastSyncTimestamp, limit = 0)
    {
        const collection   = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.DELETIONS_COLLECTION);
        const lastSyncDate = new Date(lastSyncTimestamp);

        // Sort by deletedAt so the caller can chunk deterministically, and cap
        // the fetch when a limit is given so a user with tens of thousands of
        // tombstones doesn't materialise the whole collection into memory on
        // every pull cycle of a drain.
        let query = collection.find(
        {
            userId: userId,
            deletedAt: { $gt: lastSyncDate }
        }).sort({ deletedAt: 1 });

        if (limit > 0)
        {
            query = query.limit(limit);
        }

        const documents = await query.toArray();

        return documents.map((document) =>
        ({
            entityId:   document.entityId,
            entityType: document.entityType,
            deletedAt:  document.deletedAt
        }));
    }

    /**
     * Returns every deletion record for a user at an EXACT deletedAt timestamp.
     * Used by the pull's deletion chunking to fetch the remainder of a
     * same-timestamp group that overran the fetch buffer, so the chunk
     * watermark can advance past the whole group without splitting it. A split
     * would let the next pull's `deletedAt > lastSync` cutoff skip the unsent
     * tail (silent data loss) or stall the cursor when a single deletedAt
     * cluster exceeds the chunk cap.
     * @param {string} userId
     * @param {number} timestampMillis - Epoch milliseconds of the exact deletedAt.
     * @returns {Promise<object[]>}
     */
    static async getDeletionsAtTimestamp(userId, timestampMillis)
    {
        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.DELETIONS_COLLECTION);

        const documents = await collection.find(
        {
            userId:    userId,
            deletedAt: new Date(timestampMillis)
        }).toArray();

        return documents.map((document) =>
        ({
            entityId:   document.entityId,
            entityType: document.entityType,
            deletedAt:  document.deletedAt
        }));
    }

    /**
     * Bulk-upserts an array of entities into a collection using a single bulkWrite.
     * Each entity is only written if the incoming lifecycle.lastModified is newer than
     * the stored value (or the document does not yet exist).
     *
     * IMPORTANT: `serverUpdatedAt` is stamped with the Node process's
     * `new Date()` (the `writeTimestamp` argument) — NOT MongoDB's
     * `$$NOW`. The sync endpoint compares the response's `serverTime`
     * (also Node clock) against the stored `serverUpdatedAt` on every
     * subsequent pull; if those two values were drawn from different
     * clocks (Node vs. Mongo host) any skew between them re-pulls the
     * exact same documents on every cycle. Using one clock end-to-end
     * makes the pull cutoff deterministic.
     *
     * @param {string} userId
     * @param {Collection} collection - MongoDB collection instance.
     * @param {object[]} dataArray - Array of entity toJson() outputs.
     * @param {Date} writeTimestamp - The cycle-wide write timestamp the caller will also return as serverTime.
     * @returns {Promise<void>}
     */
    static async bulkUpsert(userId, collection, dataArray, writeTimestamp)
    {
        if (!dataArray.length) return;

        const writeDate = writeTimestamp instanceof Date ? writeTimestamp : new Date();

        const ops = dataArray.map((data) =>
        {
            const incomingDate = new Date(data.lifecycle.lastModified);

            return {
                updateOne:
                {
                    filter: { userId, "data.id": data.id },
                    update:
                    [
                        {
                            $set:
                            {
                                userId,
                                data:
                                {
                                    $cond:
                                    {
                                        // $lte (not $lt) so two devices writing in the same
                                        // millisecond don't silently drop one writer's
                                        // change. Last-arrival wins on ties, which matches
                                        // the rest of the sync model's "newer write wins"
                                        // semantics; a strict $lt would skip the upsert on
                                        // ties and leave the loser's pending push to fail
                                        // every retry until something else nudged the
                                        // server-side lifecycle past the local one.
                                        //
                                        // $literal protects every nested string in `data`
                                        // from being parsed as a field-path reference.
                                        // Without it, any user-content string starting with
                                        // `$` (currency values, LaTeX, regex snippets, etc.)
                                        // is interpreted as a path; if that path ends with
                                        // `.` the whole bulkWrite fails with "FieldPath must
                                        // not end with a '.'." See the LLM-emitted option
                                        // "$650,000... ." case.
                                        if:   { $lte: [{ $toDate: { $ifNull: ["$data.lifecycle.lastModified", null] } }, incomingDate] },
                                        then: { $literal: data },
                                        else: "$data"
                                    }
                                },
                                serverUpdatedAt:
                                {
                                    $cond:
                                    {
                                        // Bump serverUpdatedAt ONLY when this write both wins
                                        // the lastModified gate AND actually changes the stored
                                        // data. A byte-identical re-push (the client re-sending
                                        // a record it already pushed) must NOT advance the
                                        // cursor — otherwise the pull keeps re-finding it and a
                                        // re-push loop never converges (the runaway "Syncing X /
                                        // Y" climb). A genuine same-millisecond second-device
                                        // change has different `data`, so the documented tie
                                        // case still bumps. $literal protects user-content
                                        // strings starting with `$` / ending with `.` from the
                                        // 40353 field-path failure, same as the `data` block.
                                        if:
                                        {
                                            $and:
                                            [
                                                { $lte: [{ $toDate: { $ifNull: ["$data.lifecycle.lastModified", null] } }, incomingDate] },
                                                { $ne: [{ $literal: data }, "$data"] }
                                            ]
                                        },
                                        then: writeDate,
                                        else: "$serverUpdatedAt"
                                    }
                                }
                            }
                        }
                    ],
                    upsert: true
                }
            };
        });

        try
        {
            await collection.bulkWrite(ops, { ordered: false });
        }
        catch (bulkWriteError)
        {
            // Diagnostic: a single malformed key (trailing dot, empty
            // string, or other field-name rule violation) anywhere in
            // ONE incoming entity will fail the whole bulkWrite with
            // code 40353. Walk every doc that was sent on this batch
            // and surface the entity id + JSON path of the offending
            // key so we can fix the source. Always re-throw — this is
            // observation-only, the upstream behaviour is unchanged.
            const isBadFieldNameError =
                bulkWriteError?.code === 40353
                || /FieldPath must not end with a/.test(bulkWriteError?.errorResponse?.message || "")
                || /FieldPath must not end with a/.test(bulkWriteError?.message || "");

            if (isBadFieldNameError)
            {
                console.error(`[SyncQueryEngine.bulkUpsert] bulkWrite failed with bad-field-name error for collection ${collection.collectionName}. Scanning ${dataArray.length} doc(s) for offending key(s)...`);

                const offendingFindings = [];
                for (const data of dataArray)
                {
                    SyncQueryEngine.#findBadFieldNames(data, "data", offendingFindings, data?.id);
                }

                if (offendingFindings.length === 0)
                {
                    console.error("[SyncQueryEngine.bulkUpsert] No bad keys found by surface scan. Dumping every doc in this batch to a sidecar file for offline inspection:");

                    try
                    {
                        const fs = require("fs");
                        const path = require("path");
                        const dumpDir = path.join(__dirname, "..", "..", "..", "BadFieldNameDumps");
                        if (!fs.existsSync(dumpDir))
                        {
                            fs.mkdirSync(dumpDir, { recursive: true });
                        }
                        const dumpPath = path.join(dumpDir, `${collection.collectionName}-${Date.now()}.json`);
                        fs.writeFileSync(dumpPath, JSON.stringify(dataArray, null, 2));
                        console.error(`[SyncQueryEngine.bulkUpsert] Sidecar dump written: ${dumpPath}`);
                    }
                    catch (dumpError)
                    {
                        console.error(`[SyncQueryEngine.bulkUpsert] Sidecar dump failed: ${dumpError.message}. Falling back to stdout (truncated):`);
                        for (let docIndex = 0; docIndex < dataArray.length; docIndex++)
                        {
                            console.error(`  [doc ${docIndex}] id=${dataArray[docIndex]?.id}: ${JSON.stringify(dataArray[docIndex]).slice(0, 2000)}`);
                        }
                    }
                }
                else
                {
                    for (const finding of offendingFindings)
                    {
                        console.error(`  ⚠ entity id=${finding.entityId} path=${finding.path} key=${JSON.stringify(finding.key)} reason=${finding.reason}`);
                    }
                }
            }

            throw bulkWriteError;
        }
    }

    /**
     * Diagnostic walker for bulkUpsert. Recurses through a doc and
     * collects any property keys that MongoDB will reject as field
     * names: trailing dot, leading/embedded NUL, empty string, leading
     * `$`. Logs each finding with a JSON path so the source of the
     * offending key can be located in the client codebase.
     *
     * Plain bookkeeping — no mutation, no throw.
     */
    static #findBadFieldNames(value, currentPath, findings, entityId)
    {
        if (value === null || typeof value !== "object")
        {
            return;
        }

        if (Array.isArray(value))
        {
            for (let index = 0; index < value.length; index++)
            {
                SyncQueryEngine.#findBadFieldNames(value[index], `${currentPath}[${index}]`, findings, entityId);
            }
            return;
        }

        for (const key of Object.keys(value))
        {
            let reason = null;
            if (key.length === 0)
            {
                reason = "empty-key";
            }
            else if (key.endsWith("."))
            {
                reason = "trailing-dot";
            }
            else if (key.startsWith("$"))
            {
                reason = "dollar-prefix";
            }
            else if (key.includes("\0"))
            {
                reason = "embedded-null";
            }
            else if (key.includes("."))
            {
                // A dot anywhere in a key turns it into a dotted path under
                // aggregation-pipeline $set, which can synthesize a trailing
                // dot if the path interpretation breaks (e.g. `foo..bar` →
                // empty segment, `foo.` → trailing dot).
                reason = "embedded-dot";
            }

            if (reason !== null)
            {
                findings.push({ entityId, path: `${currentPath}.${JSON.stringify(key)}`, key, reason });
            }

            SyncQueryEngine.#findBadFieldNames(value[key], `${currentPath}.${key}`, findings, entityId);
        }
    }

    /**
     * Bulk-records deletions in the deletions collection and removes the entities
     * from their respective source collections using deleteMany per entity type.
     *
     * When a DECK is being deleted, this method also performs a server-side
     * cascade: it walks down the hierarchy, finding every descendant deck
     * (by `data.parent`) and every card / study material / mock test that
     * belongs to any deck in the deletion set (by `data.deckId`). Each
     * descendant is added to the deletion batch — so a single deck-delete
     * request fully removes the subtree even if the client only sent a
     * tombstone for the root, and orphans cannot survive a delete.
     *
     * The cascade is idempotent: re-running on an already-cleaned tree
     * finds no new descendants and is a no-op.
     *
     * @param {string} userId
     * @param {Db} db - MongoDB Db instance.
     * @param {object[]} deletionChanges - Array of change objects with entityId and entityType.
     * @returns {Promise<void>}
     */
    static async bulkRecordDeletions(userId, db, deletionChanges)
    {
        if (!deletionChanges.length) return;

        const deletionsCollection = db.collection(DatabaseConstants.DELETIONS_COLLECTION);

        const collectionMap =
        {
            [entityTypes.DECK]: DatabaseConstants.DECKS_COLLECTION,
            [entityTypes.CARD]: DatabaseConstants.CARDS_COLLECTION,
            [entityTypes.STUDY_MATERIAL]: DatabaseConstants.STUDY_MATERIALS_COLLECTION,
            [entityTypes.MOCK_TEST]: DatabaseConstants.MOCK_TESTS_COLLECTION,
            [entityTypes.ASK_AI_POPUP_LINK]: DatabaseConstants.ASK_AI_POPUP_LINKS_COLLECTION,
        };

        const buildDeletionKey = (entityId, entityType) => `${entityType}::${entityId}`;
        const seenDeletionKeys = new Set();
        const fullDeletionSet = [];

        for (const change of deletionChanges)
        {
            const deletionKey = buildDeletionKey(change.entityId, change.entityType);
            if (seenDeletionKeys.has(deletionKey))
            {
                continue;
            }
            seenDeletionKeys.add(deletionKey);
            fullDeletionSet.push({ entityId: change.entityId, entityType: change.entityType });
        }

        // ── Cascade descendants for any DECK deletions ────────────────────
        // Frontier holds the deck ids whose descendants we still need to
        // discover. Each iteration finds direct children (sub-decks +
        // cards / materials / mock tests / popup links) and feeds the
        // sub-deck ids into the next iteration. Terminates when no new
        // sub-decks are found (tree depth bound).
        //
        // Popup links MUST be cascaded — they live in their own collection
        // (askAiPopupLinks) and reference the deck only by data.deckId.
        // The legacy code below originally walked decks/cards/materials/
        // mock-tests but skipped popups, so deleting a deck left every
        // popup attached to it orphaned in the DB. They were never
        // tombstoned (so other devices never learned about the deletion)
        // and never garbage-collected (askAiPopupLinks has no TTL).
        let frontierDeckIds = fullDeletionSet
            .filter((deletion) => deletion.entityType === entityTypes.DECK)
            .map((deletion) => deletion.entityId);

        while (frontierDeckIds.length > 0)
        {
            const [childDecks, childCards, childStudyMaterials, childMockTests, childPopupLinks] = await Promise.all(
            [
                db.collection(DatabaseConstants.DECKS_COLLECTION)
                    .find({ userId: userId, "data.parent": { $in: frontierDeckIds } }, { projection: { "data.id": 1, _id: 0 } })
                    .toArray(),
                db.collection(DatabaseConstants.CARDS_COLLECTION)
                    .find({ userId: userId, "data.deckId": { $in: frontierDeckIds } }, { projection: { "data.id": 1, _id: 0 } })
                    .toArray(),
                db.collection(DatabaseConstants.STUDY_MATERIALS_COLLECTION)
                    .find({ userId: userId, "data.deckId": { $in: frontierDeckIds } }, { projection: { "data.id": 1, _id: 0 } })
                    .toArray(),
                db.collection(DatabaseConstants.MOCK_TESTS_COLLECTION)
                    .find({ userId: userId, "data.deckId": { $in: frontierDeckIds } }, { projection: { "data.id": 1, _id: 0 } })
                    .toArray(),
                db.collection(DatabaseConstants.ASK_AI_POPUP_LINKS_COLLECTION)
                    .find({ userId: userId, "data.deckId": { $in: frontierDeckIds } }, { projection: { "data.id": 1, _id: 0 } })
                    .toArray()
            ]);

            const nextFrontier = [];

            for (const document of childDecks)
            {
                const deletionKey = buildDeletionKey(document.data.id, entityTypes.DECK);
                if (seenDeletionKeys.has(deletionKey))
                {
                    continue;
                }
                seenDeletionKeys.add(deletionKey);
                fullDeletionSet.push({ entityId: document.data.id, entityType: entityTypes.DECK });
                nextFrontier.push(document.data.id);
            }

            for (const document of childCards)
            {
                const deletionKey = buildDeletionKey(document.data.id, entityTypes.CARD);
                if (seenDeletionKeys.has(deletionKey))
                {
                    continue;
                }
                seenDeletionKeys.add(deletionKey);
                fullDeletionSet.push({ entityId: document.data.id, entityType: entityTypes.CARD });
            }

            for (const document of childStudyMaterials)
            {
                const deletionKey = buildDeletionKey(document.data.id, entityTypes.STUDY_MATERIAL);
                if (seenDeletionKeys.has(deletionKey))
                {
                    continue;
                }
                seenDeletionKeys.add(deletionKey);
                fullDeletionSet.push({ entityId: document.data.id, entityType: entityTypes.STUDY_MATERIAL });
            }

            for (const document of childMockTests)
            {
                const deletionKey = buildDeletionKey(document.data.id, entityTypes.MOCK_TEST);
                if (seenDeletionKeys.has(deletionKey))
                {
                    continue;
                }
                seenDeletionKeys.add(deletionKey);
                fullDeletionSet.push({ entityId: document.data.id, entityType: entityTypes.MOCK_TEST });
            }

            // Popup-link tombstones: same pattern as cards/materials/mock-
            // tests. They get added to the deletion set (which drives both
            // the deletion-collection upsert below AND the per-collection
            // deleteMany sweep) so the next pull on every other device
            // applies the deletion locally and the askAiPopupLinks
            // collection on the server no longer hosts the orphan doc.
            for (const document of childPopupLinks)
            {
                const deletionKey = buildDeletionKey(document.data.id, entityTypes.ASK_AI_POPUP_LINK);
                if (seenDeletionKeys.has(deletionKey))
                {
                    continue;
                }
                seenDeletionKeys.add(deletionKey);
                fullDeletionSet.push({ entityId: document.data.id, entityType: entityTypes.ASK_AI_POPUP_LINK });
            }

            frontierDeckIds = nextFrontier;
        }

        const deletionOps = fullDeletionSet.map(({ entityId, entityType }) => (
        {
            updateOne:
            {
                filter: { userId, entityId },
                update: { $set: { userId, entityId, entityType, deletedAt: new Date() } },
                upsert: true
            }
        }));

        await deletionsCollection.bulkWrite(deletionOps, { ordered: false });

        const byType = {};

        for (const { entityId, entityType } of fullDeletionSet)
        {
            if (!byType[entityType]) byType[entityType] = [];
            byType[entityType].push(entityId);
        }

        for (const [entityType, ids] of Object.entries(byType))
        {
            const collectionName = collectionMap[entityType];
            if (!collectionName) continue;
            await db.collection(collectionName).deleteMany({ userId, "data.id": { $in: ids } });
        }
    }

    /**
     * Returns true if the user has at least one document in any of the
     * synced collections (decks, cards, study materials, mock tests).
     * Used by the sync endpoint to detect the asymmetric "server has
     * nothing for this user, but the client thinks it's already synced"
     * state that follows a server-side DB wipe.
     *
     * Implemented as four `findOne({ userId })` short-circuits — each
     * backed by the existing `{ userId: 1 }` indexes, so the worst case
     * is O(1) Mongo lookups per collection.
     *
     * @param {string} userId
     * @param {Db} db Optional handle, threaded by the caller to avoid an extra getDatabase() round-trip.
     * @returns {Promise<boolean>}
     */
    static async userHasAnyData(userId, db = null)
    {
        const database = db || (await DatabaseConnector.getDatabase());
        if (!database)
        {
            return false;
        }

        const collectionNames =
        [
            DatabaseConstants.DECKS_COLLECTION,
            DatabaseConstants.CARDS_COLLECTION,
            DatabaseConstants.STUDY_MATERIALS_COLLECTION,
            DatabaseConstants.MOCK_TESTS_COLLECTION,
            DatabaseConstants.ASK_AI_POPUP_LINKS_COLLECTION,
        ];

        for (const collectionName of collectionNames)
        {
            const oneDocument = await database
                .collection(collectionName)
                .findOne({ userId: userId }, { projection: { _id: 1 } });

            if (oneDocument)
            {
                return true;
            }
        }

        return false;
    }

    /**
     * Strips legacy fields that the client used to embed inside the
     * deck doc but no longer ships in toSyncJson:
     *
     *   - `data.studyMaterials` — study materials sync via their own
     *     collection now; embedding them was just dead weight that
     *     could bloat a deck doc past Mongo's 16 MB limit.
     *   - `data.additionalData.askAiPopupLinks` — popup records have
     *     their own collection (askAiPopupLinks) now; leaving the
     *     legacy map under additionalData would shadow the new
     *     channel and re-bloat the deck doc on every roundtrip.
     *
     * Cheap when no docs match — the `$or`/`$exists` filter is the
     * gate, and Mongo skips non-matching docs without rewriting them.
     * Idempotent after the first successful pass on each deck.
     *
     * @param {string} userId
     * @returns {Promise<number>} Count of docs touched.
     */
    static async pruneLegacyDeckFields(userId)
    {
        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.DECKS_COLLECTION);
        const result = await collection.updateMany(
            {
                userId: userId,
                $or:
                [
                    { "data.studyMaterials":                 { $exists: true } },
                    { "data.additionalData.askAiPopupLinks": { $exists: true } }
                ]
            },
            {
                $unset:
                {
                    "data.studyMaterials":                 "",
                    "data.additionalData.askAiPopupLinks": ""
                }
            }
        );
        if (result.modifiedCount > 0)
        {
            console.log(`[SyncQueryEngine] pruneLegacyDeckFields — cleaned ${result.modifiedCount} deck doc(s) for user ${userId}.`);
        }
        return result.modifiedCount;
    }

    /**
     * Updates the sync metadata record for a specific user and device pair.
     * @param {string} userId - The id of the user.
     * @param {string} deviceId - The id of the device.
     * @param {number} lastSyncTimestamp - The server timestamp at sync completion, in epoch milliseconds.
     * @returns {Promise<void>}
     */
    static async upsertSyncData(userId, deviceId, lastSyncTimestamp)
    {
        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.SYNC_DATA_COLLECTION);

        await collection.updateOne(
            { userId: userId, deviceId: deviceId },
            {
                $set:
                {
                    userId:            userId,
                    deviceId:          deviceId,
                    lastSyncTimestamp: new Date(lastSyncTimestamp)
                }
            },
            { upsert: true }
        );
    }
}

module.exports = SyncQueryEngine;