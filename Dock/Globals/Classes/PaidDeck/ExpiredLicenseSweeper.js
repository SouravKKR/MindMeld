const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const LapsedPaidDeckReaper = require("./LapsedPaidDeckReaper");
const { deckLicenseStatuses } = require("../../Enumerations/DeckLicenseStatuses");

/**
 * ExpiredLicenseSweeper
 *
 * A periodic, server-wide sweep that eagerly cleans up licenses whose FINITE
 * expiry has passed, instead of waiting for the affected user to happen to sync
 * (the lazy tombstone-on-lapse path in /Sync). For every user with at least one
 * expired-but-still-ACTIVE license it:
 *
 *   1. Tombstones the seeded rows of every lapsed paid deck (so a device that
 *      does sync afterwards drops the now-unlicensed copy), and
 *   2. Transitions each expired license to the terminal EXPIRED status, so the
 *      record stops being reprocessed on the next sweep and no longer sits on
 *      the server as ACTIVE-but-dead data.
 *
 * Mirrors the KeyRotationScheduler lifecycle (start / stop / #tick with a fixed
 * interval). Every step is idempotent, so a crash mid-sweep simply reprocesses
 * the remaining users on the next tick.
 */
class ExpiredLicenseSweeper
{
    static #SWEEP_INTERVAL_MILLISECONDS = 6 * 60 * 60 * 1000;
    static #intervalHandle = null;

    static start()
    {
        if (ExpiredLicenseSweeper.#intervalHandle !== null)
        {
            return;
        }

        ExpiredLicenseSweeper.#intervalHandle = setInterval
        (
            ExpiredLicenseSweeper.#tick,
            ExpiredLicenseSweeper.#SWEEP_INTERVAL_MILLISECONDS
        );
    }

    static stop()
    {
        if (ExpiredLicenseSweeper.#intervalHandle === null)
        {
            return;
        }

        clearInterval(ExpiredLicenseSweeper.#intervalHandle);
        ExpiredLicenseSweeper.#intervalHandle = null;
    }

    static async #tick()
    {
        try
        {
            await ExpiredLicenseSweeper.sweep();
        }
        catch (sweepError)
        {
            console.error("[ExpiredLicenseSweeper] Periodic sweep failed:", sweepError);
        }
    }

    /**
     * Runs one full sweep. Exposed (not #private) so it can be invoked directly
     * — e.g. once at boot — and unit-exercised against a live database.
     * @returns {Promise<{ usersProcessed: number, licensesExpired: number, rootsTombstoned: number }>}
     */
    static async sweep()
    {
        const database = await DatabaseConnector.getDatabase();
        const nowMilliseconds = Date.now();
        const nowIsoString = new Date(nowMilliseconds).toISOString();
        const epochIsoString = new Date(0).toISOString();

        // Finite (strictly after the FOREVER epoch sentinel) AND already past.
        // expiresAt is stored as an ISO-8601 string, which sorts chronologically,
        // so the string range comparison is exact.
        const expiredLicenseDocuments = await database
            .collection(DatabaseConstants.DECK_LICENSES_COLLECTION)
            .find
            (
                {
                    status: deckLicenseStatuses.ACTIVE,
                    expiresAt: { $gt: epochIsoString, $lte: nowIsoString }
                },
                { projection: { userId: 1, _id: 0 } }
            )
            .toArray();

        const affectedUserIds = new Set();
        for (const licenseDocument of expiredLicenseDocuments)
        {
            if (typeof licenseDocument.userId === "string" && licenseDocument.userId.length > 0)
            {
                affectedUserIds.add(licenseDocument.userId);
            }
        }

        let licensesExpired = 0;
        let rootsTombstoned = 0;

        for (const userId of affectedUserIds)
        {
            try
            {
                rootsTombstoned += await LapsedPaidDeckReaper.reapForUser(database, userId, nowMilliseconds);
                licensesExpired += await LapsedPaidDeckReaper.markExpiredLicenses(database, userId, nowMilliseconds);
            }
            catch (userSweepError)
            {
                // One bad user must not stop the sweep for everyone else.
                console.error(`[ExpiredLicenseSweeper] Failed to sweep user ${userId}:`, userSweepError);
            }
        }

        if (affectedUserIds.size > 0)
        {
            console.log(`[ExpiredLicenseSweeper] Swept ${affectedUserIds.size} user(s): expired ${licensesExpired} license(s), tombstoned ${rootsTombstoned} paid-deck root(s).`);
        }

        return { usersProcessed: affectedUserIds.size, licensesExpired: licensesExpired, rootsTombstoned: rootsTombstoned };
    }
}

module.exports = ExpiredLicenseSweeper;
