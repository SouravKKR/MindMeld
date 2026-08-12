const DatabaseConstants = require("../../Constants/DatabaseConstants");
const { accountMergeCollisionPolicies } = require("../../Enumerations/AccountMergeCollisionPolicies");

/**
 * AccountMergeCollectionPlan
 *
 * The authoritative, testable list of every userId-keyed Mongo collection
 * and how AccountMergeService must treat it when folding a loser account
 * into a survivor. Kept as data rather than scattered through the merge
 * loop so a new userId-scoped collection can be checked against this list —
 * Dock/VerifyAccountMerge.mjs asserts every userId-bearing index declared
 * in DatabaseConnector.js has an entry here, so a collection that forgets
 * to register itself fails a test instead of silently keeping its
 * loser-account rows orphaned forever.
 *
 * Every collection here is keyed by a plain `userId` field EXCEPT
 * userDailyActivity, whose key is `scopeKey` (personal scope embeds the
 * userId directly, e.g. "<userId>" or "<userId>::org:<id>") — that one is
 * handled by its own SPECIAL_DAILY_ACTIVITY_REKEY step, not the generic
 * userId-field repoint loop.
 *
 * REPOINT / DROP_LOSER_ON_COLLISION / DROP_LOSER_ROW are executed generically
 * by AccountMergeService's own small executor. The SPECIAL_* policies name a
 * collection that needs its own dedicated step (encryption, tree topology,
 * device/session pairing, or a non-userId key) — AccountMergeService calls
 * those explicitly and they are EXCLUDED from the generic loop.
 *
 * Deliberately NOT in this plan — audit-trail integrity. These should keep
 * naming the id that actually acted at the time, not be rewritten to match
 * a later merge: logEvents (accountId), adminAuditEvents (actorUserId),
 * rateLimitEvents (identityKey).
 */
class AccountMergeCollectionPlan
{
    static PLAN =
    [
        { collectionName: DatabaseConstants.DECKS_COLLECTION,                          collisionPolicy: accountMergeCollisionPolicies.SPECIAL_DECK_TREE },
        { collectionName: DatabaseConstants.CARDS_COLLECTION,                          collisionPolicy: accountMergeCollisionPolicies.REPOINT },
        { collectionName: DatabaseConstants.STUDY_MATERIALS_COLLECTION,                collisionPolicy: accountMergeCollisionPolicies.REPOINT },
        { collectionName: DatabaseConstants.MOCK_TESTS_COLLECTION,                     collisionPolicy: accountMergeCollisionPolicies.REPOINT },
        { collectionName: DatabaseConstants.ASK_AI_POPUP_LINKS_COLLECTION,             collisionPolicy: accountMergeCollisionPolicies.REPOINT },
        { collectionName: DatabaseConstants.CONTENT_OVERLAYS_COLLECTION,               collisionPolicy: accountMergeCollisionPolicies.REPOINT },
        { collectionName: DatabaseConstants.DELETIONS_COLLECTION,                      collisionPolicy: accountMergeCollisionPolicies.DROP_LOSER_ON_COLLISION },
        { collectionName: DatabaseConstants.SYNC_DATA_COLLECTION,                      collisionPolicy: accountMergeCollisionPolicies.DROP_LOSER_ROW },
        { collectionName: DatabaseConstants.INFORMATION_SOURCES_COLLECTION,            collisionPolicy: accountMergeCollisionPolicies.SPECIAL_INFORMATION_SOURCE_DEDUP },
        { collectionName: DatabaseConstants.TEXT_EMBEDDINGS_COLLECTION,                collisionPolicy: accountMergeCollisionPolicies.REPOINT },
        { collectionName: DatabaseConstants.FIGURES_COLLECTION,                        collisionPolicy: accountMergeCollisionPolicies.REPOINT },
        { collectionName: DatabaseConstants.GENERATION_TEMPLATES_COLLECTION,           collisionPolicy: accountMergeCollisionPolicies.DROP_LOSER_ON_COLLISION },
        { collectionName: DatabaseConstants.PURCHASES_COLLECTION,                      collisionPolicy: accountMergeCollisionPolicies.REPOINT },
        { collectionName: DatabaseConstants.DECK_LICENSES_COLLECTION,                  collisionPolicy: accountMergeCollisionPolicies.SPECIAL_LICENSE_TRANSFER },
        { collectionName: DatabaseConstants.PAID_DECK_USER_CONTENT_COLLECTION,         collisionPolicy: accountMergeCollisionPolicies.SPECIAL_LICENSE_TRANSFER },
        { collectionName: DatabaseConstants.PAID_DECK_USER_CONTENT_ENTITIES_COLLECTION, collisionPolicy: accountMergeCollisionPolicies.SPECIAL_LICENSE_TRANSFER },
        { collectionName: DatabaseConstants.DEVICES_COLLECTION,                        collisionPolicy: accountMergeCollisionPolicies.SPECIAL_DEVICE_MERGE },
        { collectionName: DatabaseConstants.SESSIONS_COLLECTION,                       collisionPolicy: accountMergeCollisionPolicies.SPECIAL_SESSION_MIGRATE },
        { collectionName: DatabaseConstants.UPLOAD_QUOTAS_COLLECTION,                  collisionPolicy: accountMergeCollisionPolicies.DROP_LOSER_ON_COLLISION },
        { collectionName: DatabaseConstants.CREDIT_TRANSACTIONS_COLLECTION,            collisionPolicy: accountMergeCollisionPolicies.REPOINT },
        { collectionName: DatabaseConstants.TASK_STATES_COLLECTION,                    collisionPolicy: accountMergeCollisionPolicies.DROP_LOSER_ROW },
        { collectionName: DatabaseConstants.TASK_HISTORY_COLLECTION,                   collisionPolicy: accountMergeCollisionPolicies.REPOINT },
        { collectionName: DatabaseConstants.PUSH_TOKENS_COLLECTION,                    collisionPolicy: accountMergeCollisionPolicies.DROP_LOSER_ON_COLLISION },
        { collectionName: DatabaseConstants.NOTIFICATIONS_COLLECTION,                  collisionPolicy: accountMergeCollisionPolicies.REPOINT },
        { collectionName: DatabaseConstants.PROMO_CODE_REDEMPTIONS_COLLECTION,         collisionPolicy: accountMergeCollisionPolicies.DROP_LOSER_ON_COLLISION },
        { collectionName: DatabaseConstants.SCREENSHOT_EVENTS_COLLECTION,              collisionPolicy: accountMergeCollisionPolicies.REPOINT },
        { collectionName: DatabaseConstants.AI_GENERATED_EXPORT_EVENTS_COLLECTION,     collisionPolicy: accountMergeCollisionPolicies.REPOINT },
        { collectionName: DatabaseConstants.EPHEMERAL_UPLOADS_COLLECTION,              collisionPolicy: accountMergeCollisionPolicies.REPOINT },
        { collectionName: DatabaseConstants.SUPPORT_TICKET_REPORTS_COLLECTION,         collisionPolicy: accountMergeCollisionPolicies.REPOINT },
        { collectionName: DatabaseConstants.USER_SUBSCRIPTIONS_COLLECTION,             collisionPolicy: accountMergeCollisionPolicies.REPOINT },
    ];

    // Handled outside the collection loop entirely: userDailyActivity is
    // keyed by `scopeKey` (a string that EMBEDS the userId), not a plain
    // `userId` field.
    static DAILY_ACTIVITY_COLLECTION_NAME = DatabaseConstants.USER_DAILY_ACTIVITY_COLLECTION;

    static getGenericRepointEntries()
    {
        return AccountMergeCollectionPlan.PLAN.filter((entry) =>
            entry.collisionPolicy === accountMergeCollisionPolicies.REPOINT
            || entry.collisionPolicy === accountMergeCollisionPolicies.DROP_LOSER_ON_COLLISION
            || entry.collisionPolicy === accountMergeCollisionPolicies.DROP_LOSER_ROW);
    }

    static getSpecialCollectionNames()
    {
        return AccountMergeCollectionPlan.PLAN
            .filter((entry) => !AccountMergeCollectionPlan.getGenericRepointEntries().includes(entry))
            .map((entry) => entry.collectionName);
    }
}

module.exports = AccountMergeCollectionPlan;
