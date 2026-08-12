const crypto = require("crypto");
const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const AccountMergeCollectionPlan = require("./AccountMergeCollectionPlan");
const AccountMergeLockQueryEngine = require("./AccountMergeLockQueryEngine");
const AuthenticationQueryEngine = require("../Database/AuthenticationQueryEngine");
const KeyManagementService = require("../Security/KeyManagementService");
const Logger = require("../Logger");
const LogTitles = require("../Logging/LogTitles");
const { logCategory } = require("../../Enumerations/LogCategory");
const { accountMergeCollisionPolicies } = require("../../Enumerations/AccountMergeCollisionPolicies");
const { deckLicenseStatuses } = require("../../Enumerations/DeckLicenseStatuses");

/**
 * AccountMergeService
 *
 * Folds a duplicate (loser) account into the canonical (survivor) account
 * when AccountIdentityResolver detects two accounts sharing one email — the
 * retroactive fix for a split that happened before that resolver existed.
 * Survivor selection (oldest joinDate wins) happens in the caller;
 * everything here assumes that decision is already made.
 *
 * Synchronous and idempotent: every step is safe to re-run (already-merged
 * rows are simply no-ops on retry), so a crash mid-merge is recoverable by
 * calling mergeAccounts again with the same two ids. Protected by
 * AccountMergeLockQueryEngine so two logins racing to merge the same pair
 * serialise instead of double-merging.
 *
 * The loser's `users` row is TOMBSTONED (additionalData.mergedIntoUserId),
 * never hard-deleted — that forwarding pointer is what lets a Google login
 * whose `sub` still resolves to the old row (via getUserById) redirect to
 * the survivor instead of silently reusing a dead identity.
 *
 * Money/collision policy (confirmed for this codebase, not a general
 * pattern to copy elsewhere): no auto-refund, no admin review queue.
 * Duplicate purchases/licenses/redemptions are resolved deterministically —
 * keep the more useful one, discard the other silently.
 */
class AccountMergeService
{
    static #DEFAULT_ROOT_DECK_ID = "0";
    static #HOLDING_DECK_SOURCE_KEY = "accountMergeSourceUserId";

    // Above this combined decks+cards estimate, a synchronous merge risks
    // blocking a login for an uncomfortably long time. Skip it for this
    // attempt (the caller falls back to Phase 1's single-session
    // resolution) — the very next login retries and merges once the
    // account is no longer this large, or an operator runs
    // Dock/Scripts/MergeDuplicateAccount.mjs directly.
    static SYNCHRONOUS_MERGE_ENTITY_CEILING = 20000;

    /**
     * @param {import("../../Model/User")} survivorUser
     * @param {import("../../Model/User")} loserUser
     * @param {{triggerContext?: string}} [context]
     * @returns {Promise<import("../../Model/User")|null>} the reloaded survivor, or null if skipped/failed
     */
    static async mergeAccounts(survivorUser, loserUser, context = {})
    {
        const survivorId = survivorUser.getId();
        const loserId = loserUser.getId();

        if (survivorId === loserId)
        {
            return survivorUser;
        }

        const loserAdditionalData = loserUser.getAdditionalData() || {};
        if (loserAdditionalData.mergedIntoUserId)
        {
            // Already resolved by a previous merge — nothing to do.
            return survivorUser;
        }

        const normalizedEmail = AccountMergeService.#normalizeEmail(
            survivorUser.getAdditionalData()?.email || loserUser.getAdditionalData()?.email || "");

        if (!normalizedEmail)
        {
            return null;
        }

        const database = await DatabaseConnector.getDatabase();

        const combinedEntityEstimate = await AccountMergeService.#estimateCombinedEntityCount(database, loserId);
        if (combinedEntityEstimate > AccountMergeService.SYNCHRONOUS_MERGE_ENTITY_CEILING)
        {
            console.warn(`[AccountMergeService] deferring merge of ${loserId} into ${survivorId} — ${combinedEntityEstimate} entities exceeds the synchronous ceiling; will retry on next login.`);
            return null;
        }

        const lockAcquired = await AccountMergeLockQueryEngine.acquireLock(normalizedEmail);
        if (!lockAcquired)
        {
            console.warn(`[AccountMergeService] merge for ${normalizedEmail} already in progress on another request — proceeding without merging this time.`);
            return null;
        }

        try
        {
            await AccountMergeService.#mergeDeckTree(database, survivorId, loserId);
            await AccountMergeService.#mergeLicensesAndPaidContent(database, survivorId, loserId);
            const deviceIdRemap = await AccountMergeService.#mergeDevices(database, survivorId, loserId);
            await AccountMergeService.#mergeSessions(database, survivorId, loserId, deviceIdRemap);
            await AccountMergeService.#mergeDailyActivity(database, survivorId, loserId);
            await AccountMergeService.#runGenericCollectionPlan(database, survivorId, loserId);
            await AccountMergeService.#mergeCredits(database, survivorId, loserId);
            await AccountMergeService.#tombstoneLoserUser(database, survivorId, loserId);

            console.log(`[AccountMergeService] merged ${loserId} into ${survivorId} (${normalizedEmail}, trigger=${context.triggerContext || "UNKNOWN"}).`);
            Logger.info(logCategory.AUTHENTICATION, LogTitles.ACCOUNT_MERGE_COMPLETED, "Merged a duplicate account into its canonical survivor",
            {
                accountId: survivorId,
                additionalData: { loserId: loserId, normalizedEmail: normalizedEmail, triggerContext: context.triggerContext || "UNKNOWN" }
            });

            return await AuthenticationQueryEngine.getUserById(survivorId);
        }
        catch (mergeError)
        {
            console.error(`[AccountMergeService] merge of ${loserId} into ${survivorId} failed: ${mergeError.message}`);
            Logger.error(logCategory.AUTHENTICATION, LogTitles.ACCOUNT_MERGE_FAILED, "Account merge failed",
            {
                accountId: survivorId,
                additionalData: { loserId: loserId, normalizedEmail: normalizedEmail, error: mergeError.message }
            });
            return null;
        }
        finally
        {
            await AccountMergeLockQueryEngine.releaseLock(normalizedEmail);
        }
    }

    static #normalizeEmail(email)
    {
        return typeof email === "string" ? email.trim().toLowerCase() : "";
    }

    static async #estimateCombinedEntityCount(database, loserId)
    {
        const [deckCount, cardCount] = await Promise.all
        ([
            database.collection(DatabaseConstants.DECKS_COLLECTION).countDocuments({ userId: loserId }),
            database.collection(DatabaseConstants.CARDS_COLLECTION).countDocuments({ userId: loserId })
        ]);
        return deckCount + cardCount;
    }

    // ── Deck tree ────────────────────────────────────────────────────────

    /**
     * Every account's decks collection has exactly one row with
     * data.id === "0" (root), unique per {userId, "data.id"} — a blind
     * repoint of the loser's decks would collide on that row every time.
     * Redirects anything that pointed at the loser's own root onto a new
     * holding deck under the survivor's real root instead, then repoints
     * the rest (including the holding deck itself) normally.
     */
    static async #mergeDeckTree(database, survivorId, loserId)
    {
        const decksCollection = database.collection(DatabaseConstants.DECKS_COLLECTION);

        const loserDeckCount = await decksCollection.countDocuments({ userId: loserId });
        if (loserDeckCount === 0)
        {
            return;
        }

        let holdingDeckDocument = await decksCollection.findOne
        ({
            userId: survivorId,
            [`data.additionalData.${AccountMergeService.#HOLDING_DECK_SOURCE_KEY}`]: loserId
        });

        if (!holdingDeckDocument)
        {
            const now = new Date();
            holdingDeckDocument =
            {
                userId: survivorId,
                serverUpdatedAt: now,
                data:
                {
                    id: crypto.randomUUID(),
                    name: `Merged from other account (${now.toISOString().slice(0, 10)})`,
                    shortName: "Merged",
                    tags: [],
                    parent: AccountMergeService.#DEFAULT_ROOT_DECK_ID,
                    lifecycle: { lastModified: now.toISOString() },
                    additionalData: { [AccountMergeService.#HOLDING_DECK_SOURCE_KEY]: loserId }
                }
            };
            await decksCollection.insertOne(holdingDeckDocument);
        }

        const holdingDeckId = holdingDeckDocument.data.id;

        await decksCollection.updateMany
        (
            {
                userId: loserId,
                "data.id": { $ne: AccountMergeService.#DEFAULT_ROOT_DECK_ID },
                "data.parent": { $in: [AccountMergeService.#DEFAULT_ROOT_DECK_ID, null] }
            },
            { $set: { "data.parent": holdingDeckId } }
        );

        const rootChildEntityCollections =
        [
            DatabaseConstants.CARDS_COLLECTION,
            DatabaseConstants.STUDY_MATERIALS_COLLECTION,
            DatabaseConstants.MOCK_TESTS_COLLECTION,
            DatabaseConstants.ASK_AI_POPUP_LINKS_COLLECTION,
            DatabaseConstants.CONTENT_OVERLAYS_COLLECTION
        ];
        for (const collectionName of rootChildEntityCollections)
        {
            await database.collection(collectionName).updateMany
            (
                { userId: loserId, "data.deckId": AccountMergeService.#DEFAULT_ROOT_DECK_ID },
                { $set: { "data.deckId": holdingDeckId } }
            );
        }

        await decksCollection.deleteOne({ userId: loserId, "data.id": AccountMergeService.#DEFAULT_ROOT_DECK_ID });

        // Defensive: every real deck id is a UUID, so a collision between two
        // accounts' non-root decks is not expected. Abort loudly rather than
        // let a blind repoint silently overwrite a survivor deck if it ever
        // happens (e.g. legacy data with a non-UUID id scheme).
        const [remainingLoserDeckIds, survivorDeckIds] = await Promise.all
        ([
            decksCollection.find({ userId: loserId }).project({ "data.id": 1 }).toArray(),
            decksCollection.find({ userId: survivorId }).project({ "data.id": 1 }).toArray()
        ]);
        const survivorDeckIdSet = new Set(survivorDeckIds.map((document) => document.data.id));
        const collidingDeckIds = remainingLoserDeckIds
            .map((document) => document.data.id)
            .filter((deckId) => survivorDeckIdSet.has(deckId));

        if (collidingDeckIds.length > 0)
        {
            throw new Error(`deck id collision between survivor ${survivorId} and loser ${loserId}: ${collidingDeckIds.join(", ")}`);
        }

        await decksCollection.updateMany({ userId: loserId }, { $set: { userId: survivorId } });
    }

    // ── Paid-deck licenses + the buyer's editable clone ────────────────────

    // Public (not #-private) specifically so Dock/VerifyAccountMerge.mjs can
    // unit-test the collision-resolution decision in isolation, with no
    // database involved.
    static isMorePermissiveLicense(candidateDocument, otherDocument)
    {
        const isCandidateActive = candidateDocument.status === deckLicenseStatuses.ACTIVE;
        const isOtherActive = otherDocument.status === deckLicenseStatuses.ACTIVE;
        if (isCandidateActive !== isOtherActive)
        {
            return isCandidateActive;
        }

        const candidateExpiresAt = candidateDocument.expiresAt ? new Date(candidateDocument.expiresAt).getTime() : 0;
        const otherExpiresAt = otherDocument.expiresAt ? new Date(otherDocument.expiresAt).getTime() : 0;
        const isCandidateForever = candidateExpiresAt <= 0;
        const isOtherForever = otherExpiresAt <= 0;
        if (isCandidateForever !== isOtherForever)
        {
            return isCandidateForever;
        }

        return candidateExpiresAt >= otherExpiresAt;
    }

    static async #mergeLicensesAndPaidContent(database, survivorId, loserId)
    {
        const licensesCollection = database.collection(DatabaseConstants.DECK_LICENSES_COLLECTION);
        const paidContentCollection = database.collection(DatabaseConstants.PAID_DECK_USER_CONTENT_COLLECTION);
        const paidContentEntitiesCollection = database.collection(DatabaseConstants.PAID_DECK_USER_CONTENT_ENTITIES_COLLECTION);

        const loserLicenseDocuments = await licensesCollection.find({ userId: loserId }).toArray();

        for (const loserLicenseDocument of loserLicenseDocuments)
        {
            const deckId = loserLicenseDocument.deckId;
            const survivorLicenseDocument = await licensesCollection.findOne({ userId: survivorId, deckId: deckId });

            if (!survivorLicenseDocument)
            {
                const transferResult = await KeyManagementService.transferLicenseOwnership(loserLicenseDocument, survivorId);
                if (!transferResult.success)
                {
                    console.warn(`[AccountMergeService] license transfer skipped for deck ${deckId} (${transferResult.reason}) — left under the merged-away account.`);
                    continue;
                }
                await paidContentCollection.updateMany({ userId: loserId, deckId: deckId }, { $set: { userId: survivorId } });
                await paidContentEntitiesCollection.updateMany({ userId: loserId, deckId: deckId }, { $set: { userId: survivorId } });
                continue;
            }

            // Collision: both accounts held a license for the same deck.
            const keepSurvivorsExisting = AccountMergeService.isMorePermissiveLicense(survivorLicenseDocument, loserLicenseDocument);

            if (keepSurvivorsExisting)
            {
                await licensesCollection.deleteOne({ userId: loserId, deckId: deckId });
                await paidContentCollection.deleteMany({ userId: loserId, deckId: deckId });
                await paidContentEntitiesCollection.deleteMany({ userId: loserId, deckId: deckId });
            }
            else
            {
                const transferResult = await KeyManagementService.transferLicenseOwnership(loserLicenseDocument, survivorId);
                if (transferResult.success)
                {
                    await paidContentCollection.deleteMany({ userId: survivorId, deckId: deckId });
                    await paidContentEntitiesCollection.deleteMany({ userId: survivorId, deckId: deckId });
                    await paidContentCollection.updateMany({ userId: loserId, deckId: deckId }, { $set: { userId: survivorId } });
                    await paidContentEntitiesCollection.updateMany({ userId: loserId, deckId: deckId }, { $set: { userId: survivorId } });
                }
                else
                {
                    console.warn(`[AccountMergeService] license transfer skipped for deck ${deckId} (${transferResult.reason}) — kept the survivor's existing (weaker) license instead.`);
                    await licensesCollection.deleteOne({ userId: loserId, deckId: deckId });
                    await paidContentCollection.deleteMany({ userId: loserId, deckId: deckId });
                    await paidContentEntitiesCollection.deleteMany({ userId: loserId, deckId: deckId });
                }
            }
        }
    }

    // ── Devices + sessions ─────────────────────────────────────────────────

    /**
     * @returns {Promise<Map<string,string>>} discarded deviceId -> kept deviceId
     */
    static async #mergeDevices(database, survivorId, loserId)
    {
        const devicesCollection = database.collection(DatabaseConstants.DEVICES_COLLECTION);
        const loserDeviceDocuments = await devicesCollection.find({ userId: loserId }).toArray();
        const deviceIdRemap = new Map();

        for (const loserDeviceDocument of loserDeviceDocuments)
        {
            const fingerprintHash = loserDeviceDocument.fingerprintHash;
            const survivorDeviceDocument = fingerprintHash
                ? await devicesCollection.findOne({ userId: survivorId, fingerprintHash: fingerprintHash })
                : null;

            if (!survivorDeviceDocument)
            {
                await devicesCollection.updateOne({ id: loserDeviceDocument.id }, { $set: { userId: survivorId } });
                continue;
            }

            // Same physical machine registered under both accounts — exactly
            // how this bug family shows up on a desktop. Keep whichever row
            // was seen more recently.
            const loserLastSeenAt = loserDeviceDocument.lastSeenDate ? new Date(loserDeviceDocument.lastSeenDate).getTime() : 0;
            const survivorLastSeenAt = survivorDeviceDocument.lastSeenDate ? new Date(survivorDeviceDocument.lastSeenDate).getTime() : 0;

            if (loserLastSeenAt > survivorLastSeenAt)
            {
                // Delete the survivor's row FIRST — updating the loser's row
                // to userId=survivorId while the survivor's own row still
                // holds that exact {userId, fingerprintHash} pair would
                // collide with this collection's own unique index.
                await devicesCollection.deleteOne({ id: survivorDeviceDocument.id });
                await devicesCollection.updateOne({ id: loserDeviceDocument.id }, { $set: { userId: survivorId } });
                deviceIdRemap.set(survivorDeviceDocument.id, loserDeviceDocument.id);
            }
            else
            {
                await devicesCollection.deleteOne({ id: loserDeviceDocument.id });
                deviceIdRemap.set(loserDeviceDocument.id, survivorDeviceDocument.id);
            }
        }

        return deviceIdRemap;
    }

    /**
     * Migrates sessions in place (never invalidates) — GetUser resolves
     * every request's session fresh, so an already-open device
     * transparently sees the merged account on its very next request.
     */
    static async #mergeSessions(database, survivorId, loserId, deviceIdRemap)
    {
        const sessionsCollection = database.collection(DatabaseConstants.SESSIONS_COLLECTION);

        for (const [discardedDeviceId, keptDeviceId] of deviceIdRemap.entries())
        {
            await sessionsCollection.updateMany({ deviceId: discardedDeviceId }, { $set: { deviceId: keptDeviceId } });
        }

        await sessionsCollection.updateMany({ userId: loserId }, { $set: { userId: survivorId } });
    }

    // ── Daily activity (keyed by scopeKey, which embeds the userId) ────────

    static async #mergeDailyActivity(database, survivorId, loserId)
    {
        const collection = database.collection(AccountMergeCollectionPlan.DAILY_ACTIVITY_COLLECTION_NAME);
        const escapedLoserId = loserId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const loserRowDocuments = await collection.find({ scopeKey: { $regex: `^${escapedLoserId}(::org:.*)?$` } }).toArray();

        for (const loserRowDocument of loserRowDocuments)
        {
            const survivorScopeKey = survivorId + loserRowDocument.scopeKey.slice(loserId.length);
            const existingSurvivorRowDocument = await collection.findOne({ scopeKey: survivorScopeKey, dayUtc: loserRowDocument.dayUtc });

            if (!existingSurvivorRowDocument)
            {
                await collection.updateOne
                (
                    { scopeKey: loserRowDocument.scopeKey, dayUtc: loserRowDocument.dayUtc },
                    { $set: { scopeKey: survivorScopeKey, accountUserId: survivorId } }
                );
                continue;
            }

            // Both accounts logged activity on the same UTC day — sum the
            // per-counter usage. This is pure metrics, not billing, so
            // combining is unambiguously correct (unlike credits, where
            // summing was a deliberate policy call rather than an obvious one).
            const counterIncrements = {};
            for (const counterName of Object.keys(loserRowDocument.counters || {}))
            {
                const counterValue = Number(loserRowDocument.counters[counterName]) || 0;
                if (counterValue > 0)
                {
                    counterIncrements[`counters.${counterName}`] = counterValue;
                }
            }
            if (Object.keys(counterIncrements).length > 0)
            {
                await collection.updateOne({ scopeKey: survivorScopeKey, dayUtc: loserRowDocument.dayUtc }, { $inc: counterIncrements });
            }
            await collection.deleteOne({ scopeKey: loserRowDocument.scopeKey, dayUtc: loserRowDocument.dayUtc });
        }
    }

    // ── Every remaining userId-keyed collection ─────────────────────────────

    static async #runGenericCollectionPlan(database, survivorId, loserId)
    {
        for (const entry of AccountMergeCollectionPlan.getGenericRepointEntries())
        {
            const collection = database.collection(entry.collectionName);

            if (entry.collisionPolicy === accountMergeCollisionPolicies.DROP_LOSER_ROW)
            {
                await collection.deleteMany({ userId: loserId });
                continue;
            }

            if (entry.collisionPolicy === accountMergeCollisionPolicies.DROP_LOSER_ON_COLLISION)
            {
                const loserDocuments = await collection.find({ userId: loserId }).toArray();
                for (const loserDocument of loserDocuments)
                {
                    try
                    {
                        await collection.updateOne({ _id: loserDocument._id }, { $set: { userId: survivorId } });
                    }
                    catch (updateError)
                    {
                        if (updateError && updateError.code === 11000)
                        {
                            await collection.deleteOne({ _id: loserDocument._id });
                            continue;
                        }
                        throw updateError;
                    }
                }
                continue;
            }

            await collection.updateMany({ userId: loserId }, { $set: { userId: survivorId } });
        }
    }

    // ── Credits ──────────────────────────────────────────────────────────

    static async #mergeCredits(database, survivorId, loserId)
    {
        const usersCollection = database.collection(DatabaseConstants.USERS_COLLECTION);
        const loserUserDocument = await usersCollection.findOne({ id: loserId });

        const loserCredits = Number(loserUserDocument?.additionalData?.credits) || 0;
        const loserLifetimeCreditsSpent = Number(loserUserDocument?.additionalData?.lifetimeCreditsSpent) || 0;

        if (loserCredits === 0 && loserLifetimeCreditsSpent === 0)
        {
            return;
        }

        await usersCollection.updateOne
        (
            { id: survivorId },
            { $inc: { "additionalData.credits": loserCredits, "additionalData.lifetimeCreditsSpent": loserLifetimeCreditsSpent } }
        );
    }

    // ── Tombstone ────────────────────────────────────────────────────────

    static async #tombstoneLoserUser(database, survivorId, loserId)
    {
        await database.collection(DatabaseConstants.USERS_COLLECTION).updateOne
        (
            { id: loserId },
            { $set: { "additionalData.mergedIntoUserId": survivorId, "additionalData.mergedAt": new Date().toISOString() } }
        );
    }
}

module.exports = AccountMergeService;
