/**
 * LicenseContentVersionResolver
 *
 * Answers "is there a newer version of this deck than the copy this buyer
 * holds?" — and, just as importantly, avoids answering "yes" to every existing
 * buyer the day the feature ships.
 *
 * ── Why keyVersion is the wrong signal ────────────────────────────────────
 *
 * A DeckLicense's keyVersion tracks the MASTER ASSET KEY, not the content. It
 * moves on a periodic key rotation (no content change at all) and does NOT move
 * when a publisher uploads new content (UploadPaidDeck touches no licenses). It
 * is wrong in both directions. paidDecks.contentSummary.contentVersion is the
 * field that actually tracks content, and DeckLicense.downloadedContentVersion
 * is where a buyer's seeded version is recorded.
 *
 * ── The legacy-zero problem ───────────────────────────────────────────────
 *
 * Every license issued before this feature has downloadedContentVersion 0,
 * while every published deck has contentVersion >= 1. A naive
 * `downloaded < available` therefore tells EVERY existing buyer that an update
 * is waiting — for content they already have, and accepting it would reset
 * their progress for nothing.
 *
 * So 0 (or absent) means "unknown, assume current": no update is offered, and
 * the caller backfills the stored value to the deck's current version on read.
 * That is idempotent, needs no migration script, and self-heals as buyers sync.
 */
class LicenseContentVersionResolver
{
    /**
     * Normalises a stored version to a positive integer, or 0 for
     * absent/invalid.
     */
    static normalizeVersion(rawVersion)
    {
        const parsedVersion = Number(rawVersion);
        return Number.isInteger(parsedVersion) && parsedVersion > 0 ? parsedVersion : 0;
    }

    /**
     * The version a specific copy was seeded from.
     *
     * Per-instance values win: a buyer can hold several copies of one deck and
     * update them independently, so the license-level field is only the
     * fallback for single-copy and legacy licenses.
     *
     * @param {object} licenseDocument the stored license
     * @param {string} instanceId the copy being asked about
     *
     * @returns {number} the seeded content version, or 0 when unknown
     */
    static resolveDownloadedVersion(licenseDocument, instanceId)
    {
        const instances = licenseDocument?.additionalData?.instances;
        if (Array.isArray(instances))
        {
            const matchingInstance = instances.find(instance => instance && instance.instanceId === instanceId);
            const instanceVersion = LicenseContentVersionResolver.normalizeVersion(matchingInstance?.contentVersion);
            if (instanceVersion > 0)
            {
                return instanceVersion;
            }
        }

        return LicenseContentVersionResolver.normalizeVersion(licenseDocument?.downloadedContentVersion);
    }

    /**
     * Whether to offer this copy an update.
     *
     * @param {object} licenseDocument the stored license
     * @param {string} instanceId the copy being asked about
     * @param {number} availableContentVersion the deck's current content version
     *
     * @returns {boolean} true only when the buyer's seeded version is KNOWN and
     *   older than what the publisher now offers
     */
    static isUpdateAvailable(licenseDocument, instanceId, availableContentVersion)
    {
        const downloadedVersion = LicenseContentVersionResolver.resolveDownloadedVersion(licenseDocument, instanceId);
        const availableVersion = LicenseContentVersionResolver.normalizeVersion(availableContentVersion);

        // Unknown seeded version -> assume current. Never nag a buyer whose
        // license predates version stamping.
        if (downloadedVersion === 0)
        {
            return false;
        }

        return availableVersion > downloadedVersion;
    }

    /**
     * Whether a license needs its unknown version backfilling to the deck's
     * current one, so the comparison becomes meaningful from now on.
     */
    static needsBackfill(licenseDocument, instanceId, availableContentVersion)
    {
        return LicenseContentVersionResolver.resolveDownloadedVersion(licenseDocument, instanceId) === 0
            && LicenseContentVersionResolver.normalizeVersion(availableContentVersion) > 0;
    }
}

module.exports = LicenseContentVersionResolver;
