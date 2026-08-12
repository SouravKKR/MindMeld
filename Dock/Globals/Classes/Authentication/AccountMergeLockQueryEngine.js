const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");

/**
 * AccountMergeLockQueryEngine
 *
 * A single-document lease mutex, keyed on the normalized email two split
 * accounts share, serialising AccountMergeService.mergeAccounts against
 * itself. Without it, two logins racing to merge the same pair — Google on
 * one device and Email+OTP on another, arriving within milliseconds of each
 * other — could both see "not yet merged" and both attempt the merge.
 *
 * The TTL index on `expiresAt` is a crash backstop only: the real release
 * happens in AccountMergeService's finally block. A lease that outlives its
 * own expiry simply means a worst-case merge took longer than
 * DatabaseConstants.ACCOUNT_MERGE_LOCK_TTL_SECONDS, at which point a stuck
 * lock self-clears rather than wedging every future login for that email.
 */
class AccountMergeLockQueryEngine
{
    /**
     * Attempts to acquire the lease for normalizedEmail. Returns true on
     * success, false if another merge already holds it.
     * @param {string} normalizedEmail
     * @returns {Promise<boolean>}
     */
    static async acquireLock(normalizedEmail)
    {
        if (!normalizedEmail)
        {
            return false;
        }

        const collection = (await DatabaseConnector.getDatabase())
            .collection(DatabaseConstants.ACCOUNT_MERGE_LOCKS_COLLECTION);

        try
        {
            await collection.insertOne
            ({
                id: normalizedEmail,
                acquiredAt: new Date(),
                expiresAt: new Date(Date.now() + (DatabaseConstants.ACCOUNT_MERGE_LOCK_TTL_SECONDS * 1000))
            });
            return true;
        }
        catch (insertError)
        {
            if (insertError && insertError.code === 11000)
            {
                return false;
            }
            throw insertError;
        }
    }

    /**
     * Releases the lease for normalizedEmail. Safe to call even when no
     * lease is held (a merge that failed before acquiring one, or a retry).
     * @param {string} normalizedEmail
     */
    static async releaseLock(normalizedEmail)
    {
        if (!normalizedEmail)
        {
            return;
        }

        const collection = (await DatabaseConnector.getDatabase())
            .collection(DatabaseConstants.ACCOUNT_MERGE_LOCKS_COLLECTION);
        await collection.deleteOne({ id: normalizedEmail });
    }
}

module.exports = AccountMergeLockQueryEngine;
