const DatabaseConstants = require("../../Constants/DatabaseConstants");
const SyncQueryEngine = require("../Database/SyncQueryEngine");
const { entityTypes } = require("../../Enumerations/EntityTypes");
const { deckLicenseStatuses } = require("../../Enumerations/DeckLicenseStatuses");

/**
 * LapsedPaidDeckReaper
 *
 * Tears down the seeded rows of any paid deck whose license has lapsed — a
 * REVOKED license or a finite expiry now in the past — so a user can no longer
 * see or study content they no longer hold. Shared by two callers:
 *
 *   • /Sync (lazy, per-user): reaps at pull time so the same response carries
 *     the tombstones that make the client drop its now-unlicensed copy.
 *   • ExpiredLicenseSweeper (eager, server-wide): reaps on a schedule so the
 *     dead rows and the stale license record are cleaned up promptly instead of
 *     waiting for the user to happen to sync again.
 *
 * Every operation is idempotent: once a deck's rows are gone and its license is
 * marked EXPIRED, a later pass finds nothing to do.
 */
class LapsedPaidDeckReaper
{
    /**
     * True iff a raw deckLicenses document is currently usable — status ACTIVE
     * and either a FOREVER sentinel expiry (epoch-zero) or a future expiry.
     * Mirrors KeyManagementService.isLicenseActive but reads a stored document
     * directly (the reaper has no DeckLicense model instance handy).
     */
    static isLicenseDocumentActive(licenseDocument, nowMilliseconds = Date.now())
    {
        if (!licenseDocument || licenseDocument.status !== deckLicenseStatuses.ACTIVE)
        {
            return false;
        }
        const expiresAt = licenseDocument.expiresAt;
        if (!expiresAt)
        {
            return true;
        }
        const expiryTimestampMilliseconds = new Date(expiresAt).getTime();
        if (isNaN(expiryTimestampMilliseconds))
        {
            return true;
        }
        if (expiryTimestampMilliseconds <= 0)
        {
            return true; // FOREVER sentinel.
        }
        return expiryTimestampMilliseconds > nowMilliseconds;
    }

    /**
     * For each of the user's paid-deck licenses that EXISTS but is no longer
     * active, tombstone the deck's seeded rows still sitting in the server
     * collections so the client deletes its now-unlicensed copy. Deliberately
     * scoped to existing-inactive licenses ONLY — never a merely-absent license,
     * which can be a deck still mid-provision.
     *
     * @returns {Promise<number>} Count of lapsed paid-deck roots tombstoned.
     */
    static async reapForUser(database, userId, nowMilliseconds = Date.now())
    {
        const licenseDocuments = await database
            .collection(DatabaseConstants.DECK_LICENSES_COLLECTION)
            .find({ userId: userId })
            .toArray();

        const lapsedDeckIds = licenseDocuments
            .filter((licenseDocument) => !LapsedPaidDeckReaper.isLicenseDocumentActive(licenseDocument, nowMilliseconds))
            .map((licenseDocument) => licenseDocument.deckId)
            .filter((deckId) => typeof deckId === "string" && deckId.length > 0);

        if (lapsedDeckIds.length === 0)
        {
            return 0;
        }

        const lapsedDeckRows = await database
            .collection(DatabaseConstants.DECKS_COLLECTION)
            .find({ userId: userId, "data.additionalData.paidDeckId": { $in: lapsedDeckIds } }, { projection: { "data.id": 1, _id: 0 } })
            .toArray();

        const deletionChanges = lapsedDeckRows
            .filter((row) => row?.data?.id)
            .map((row) => ({ entityId: row.data.id, entityType: entityTypes.DECK }));

        if (deletionChanges.length > 0)
        {
            // bulkRecordDeletions cascades each instance root to its cards /
            // materials / mock tests / popups and both tombstones and deletes them.
            await SyncQueryEngine.bulkRecordDeletions(userId, database, deletionChanges);
            console.log(`[LapsedPaidDeckReaper] Tombstoned ${deletionChanges.length} lapsed paid-deck root(s) for user ${userId}.`);
        }

        return deletionChanges.length;
    }

    /**
     * Flips every ACTIVE license of this user whose FINITE expiry has now passed
     * to the terminal EXPIRED status. This stops the sweeper from reprocessing
     * the same dead licenses forever and makes the stored status reflect reality
     * (PullLicenses then delivers the EXPIRED status to every device). The
     * FOREVER sentinel (epoch-zero) is never touched. Compares ISO strings — the
     * stored expiresAt is an ISO-8601 string, which sorts chronologically.
     *
     * rotatedAt is bumped (as an ISO string, matching DeckLicense.toJson) so the
     * next /Sync/Licenses pull — which selects `rotatedAt > sinceTimestamp` and
     * would never match a BSON Date against a stored ISO string — re-delivers the
     * now-EXPIRED status to every device.
     *
     * @returns {Promise<number>} Count of licenses transitioned to EXPIRED.
     */
    static async markExpiredLicenses(database, userId, nowMilliseconds = Date.now())
    {
        const nowIsoString = new Date(nowMilliseconds).toISOString();
        const epochIsoString = new Date(0).toISOString();

        const result = await database
            .collection(DatabaseConstants.DECK_LICENSES_COLLECTION)
            .updateMany
            (
                {
                    userId: userId,
                    status: deckLicenseStatuses.ACTIVE,
                    // Finite (strictly after the epoch sentinel) AND already past.
                    expiresAt: { $gt: epochIsoString, $lte: nowIsoString }
                },
                { $set: { status: deckLicenseStatuses.EXPIRED, rotatedAt: nowIsoString } }
            );

        return result.modifiedCount || 0;
    }
}

module.exports = LapsedPaidDeckReaper;
