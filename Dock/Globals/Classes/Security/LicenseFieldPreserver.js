/**
 * LicenseFieldPreserver
 *
 * Carries every buyer-scoped field from a stored DeckLicense onto a license
 * that a MASTER-key rotation has just reissued.
 *
 * Two independent key systems live on a DeckLicense, and only one of them is a
 * master-key concern:
 *
 *   • keyVersion + wrappedKeyBlob — the MASTER asset key, which encrypts the
 *     seller's master entities at rest. This is what
 *     KeyManagementService.rotateKeysForDeck rotates, and issueLicenseForUser
 *     rebuilds it correctly.
 *   • contentKeyVersion + serverWrapped* + passwordWrapped* — the PER-LICENSE
 *     content key, which encrypts paid content on the /Sync wire and at rest on
 *     the device. It has its own rotation path
 *     (rotatePaidDeckContentKeyForLicense, which correctly re-wraps under the
 *     server KEK and lets the next UnlockSession refill the password wrap). A
 *     master-key rotation must leave it completely alone.
 *
 * issueLicenseForUser constructs a brand-new DeckLicense, so every field of the
 * second system — plus the buyer's paid-deck password material, the content
 * version their copies were seeded from, and additionalData (which carries the
 * manage-copies instance registry) — comes back at its default. persistLicense
 * writes the whole document with `$set: license.toJson()`, and the codegen model
 * emits every field unconditionally, so persisting that reissue silently BLANKS
 * all of them. The observable damage: the buyer can no longer unlock the deck,
 * getPaidDeckContentKeyBufferForUser returns null so every paid entity is
 * withheld from their /Sync pull indefinitely, and their extra copies disappear
 * from the registry.
 *
 * The content key itself is untouched by a master-key rotation, so the stored
 * wraps stay valid verbatim — nothing here needs re-wrapping.
 *
 * Kept as its own pure class (no database, no clock) so the invariant is
 * unit-testable in isolation: this is the single place that decides what a
 * rotation is allowed to change.
 */
class LicenseFieldPreserver
{
    /**
     * Mutates reissuedLicense so every buyer-scoped field matches the stored
     * document. Absent fields fall back to the same defaults the model uses, so
     * a legacy license missing a field is left consistent rather than undefined.
     *
     * @param {object} reissuedLicense the freshly-built DeckLicense to repair
     * @param {object} storedLicenseDocument the license document read from Mongo
     *
     * @returns {object} the same reissuedLicense, for call-site chaining
     */
    static carryForwardBuyerScopedFields(reissuedLicense, storedLicenseDocument)
    {
        if (!reissuedLicense || !storedLicenseDocument)
        {
            return reissuedLicense;
        }

        // The per-license content key and both of its wraps.
        reissuedLicense.setServerWrappedContentKeyBase64(storedLicenseDocument.serverWrappedContentKeyBase64 || "");
        reissuedLicense.setServerWrappedIvBase64(storedLicenseDocument.serverWrappedIvBase64 || "");
        reissuedLicense.setPasswordWrappedContentKeyBase64(storedLicenseDocument.passwordWrappedContentKeyBase64 || "");
        reissuedLicense.setPasswordWrappedIvBase64(storedLicenseDocument.passwordWrappedIvBase64 || "");
        reissuedLicense.setContentKeyVersion(storedLicenseDocument.contentKeyVersion || 0);

        // The buyer's paid-deck password material.
        reissuedLicense.setPasswordHash(storedLicenseDocument.passwordHash || "");
        reissuedLicense.setPasswordSalt(storedLicenseDocument.passwordSalt || "");

        // Which content version this buyer's copies were seeded from.
        reissuedLicense.setDownloadedContentVersion(storedLicenseDocument.downloadedContentVersion || 0);

        // additionalData carries the manage-copies instance registry. A
        // non-object (or absent) value becomes an empty object rather than
        // propagating a malformed value into the persisted document.
        const storedAdditionalData = storedLicenseDocument.additionalData;
        const isUsableAdditionalData = storedAdditionalData !== null
            && typeof storedAdditionalData === "object"
            && !Array.isArray(storedAdditionalData);
        reissuedLicense.setAdditionalData(isUsableAdditionalData ? storedAdditionalData : {});

        // A rotation is not a new grant — the buyer acquired the deck when they
        // acquired it. rotatedAt is the field that records the rotation.
        if (storedLicenseDocument.issuedAt)
        {
            reissuedLicense.setIssuedAt(new Date(storedLicenseDocument.issuedAt));
        }

        return reissuedLicense;
    }
}

module.exports = LicenseFieldPreserver;
