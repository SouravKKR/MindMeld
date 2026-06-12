/**
 * LicenseClientView
 *
 * Single chokepoint that produces a CLIENT-SAFE projection of a DeckLicense:
 * every field the browser legitimately needs (deckId, status, expiresAt,
 * grantSource, keyVersion, contentKeyVersion, downloadedContentVersion,
 * rotatedAt, …) with the secret key material stripped out.
 *
 * The browser never needs the password-wrapped / server-wrapped content keys,
 * the password salt, or the at-rest password hash: the study unlock path
 * re-fetches the wrapped key over the ephemeral ECDH channel
 * (PaidDeckSession.unlock → POST /PaidDecks/UnlockSession). Shipping those
 * fields in any license payload sent to the client — and the client persists
 * its licenses to IndexedDB / app-data — would let an attacker with the
 * browser's storage dump brute-force the paid-deck password offline (PBKDF2
 * salt + wrapped key in hand) and decrypt all synced content outside the app.
 *
 * Every endpoint that returns license rows to the browser routes through here
 * (PullLicenses, GetMyPurchases, VerifyPurchase, InitiatePurchase). Centralised
 * so a future secret field added to the model is denylisted in exactly one
 * place. The legitimate exception is /PaidDecks/UnlockSession, which returns
 * the wrapped key deliberately, encrypted end-to-end over ECDH and never
 * persisted — it does NOT use this view.
 */
class LicenseClientView
{
    // Secret key material that must never leave the server. Names match the
    // DeckLicense model members (Common/Classes/DeckLicense.json) exactly.
    static SECRET_FIELDS =
    [
        "wrappedKeyBlob",
        "passwordHash",
        "passwordSalt",
        "passwordWrappedContentKeyBase64",
        "passwordWrappedIvBase64",
        "serverWrappedContentKeyBase64",
        "serverWrappedIvBase64"
    ];

    /**
     * Returns a shallow copy of one license (a raw Mongo document or a
     * model.toJson() result) with the Mongo `_id` and every secret field
     * removed. Null-safe — non-objects pass through unchanged.
     *
     * @param {object} license
     * @returns {object}
     */
    static sanitize(license)
    {
        if (!license || typeof license !== "object")
        {
            return license;
        }

        const safeLicense = { ...license };
        delete safeLicense._id;

        for (const secretField of LicenseClientView.SECRET_FIELDS)
        {
            delete safeLicense[secretField];
        }

        return safeLicense;
    }

    /**
     * Maps sanitize over an array of licenses. Null-safe — a non-array yields
     * an empty array.
     *
     * @param {Array<object>} licenses
     * @returns {Array<object>}
     */
    static sanitizeMany(licenses)
    {
        if (!Array.isArray(licenses))
        {
            return [];
        }
        return licenses.map(license => LicenseClientView.sanitize(license));
    }
}

module.exports = LicenseClientView;
