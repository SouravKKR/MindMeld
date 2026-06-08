const crypto = require("crypto");
const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const LicenseConstants = require("../../Constants/LicenseConstants");
const DeckLicense = require("../../Model/DeckLicense");
const { deckLicenseStatuses } = require("../../Enumerations/DeckLicenseStatuses");

class KeyManagementService
{
    static #masterKey = null;
    static #initialized = false;

    static #DECK_KEY_BYTES = 32;
    static #IV_BYTES = 12;
    static #ALGORITHM = "aes-256-gcm";

    static initialize()
    {
        if (KeyManagementService.#initialized)
        {
            return;
        }

        const masterKeyBase64 = process.env.PAID_DECK_MASTER_KEY_BASE64 || "";

        if (!masterKeyBase64)
        {
            console.error("[KeyManagementService] PAID_DECK_MASTER_KEY_BASE64 not set. Paid deck features will be unavailable.");
            return;
        }

        const decoded = Buffer.from(masterKeyBase64, "base64");

        if (decoded.length !== KeyManagementService.#DECK_KEY_BYTES)
        {
            console.error(`[KeyManagementService] PAID_DECK_MASTER_KEY_BASE64 must decode to ${KeyManagementService.#DECK_KEY_BYTES} bytes. Got ${decoded.length}.`);
            return;
        }

        KeyManagementService.#masterKey = decoded;
        KeyManagementService.#initialized = true;
    }

    static isReady()
    {
        return KeyManagementService.#initialized;
    }

    static #ensureReady()
    {
        if (!KeyManagementService.#initialized)
        {
            KeyManagementService.initialize();
        }

        if (!KeyManagementService.#initialized)
        {
            throw new Error("KeyManagementService not initialized — missing master key");
        }
    }

    static #generateDeckKey()
    {
        return crypto.randomBytes(KeyManagementService.#DECK_KEY_BYTES);
    }

    static #encryptBuffer(keyBuffer, plaintextBuffer)
    {
        const initializationVector = crypto.randomBytes(KeyManagementService.#IV_BYTES);
        const cipher = crypto.createCipheriv(KeyManagementService.#ALGORITHM, keyBuffer, initializationVector);
        const ciphertext = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);
        const authenticationTag = cipher.getAuthTag();

        return {
            ivBase64: initializationVector.toString("base64"),
            ciphertextBase64: Buffer.concat([ciphertext, authenticationTag]).toString("base64")
        };
    }

    static #decryptBuffer(keyBuffer, ivBase64, ciphertextBase64)
    {
        const initializationVector = Buffer.from(ivBase64, "base64");
        const combined = Buffer.from(ciphertextBase64, "base64");
        const authenticationTag = combined.slice(combined.length - 16);
        const ciphertext = combined.slice(0, combined.length - 16);

        const decipher = crypto.createDecipheriv(KeyManagementService.#ALGORITHM, keyBuffer, initializationVector);
        decipher.setAuthTag(authenticationTag);

        return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    }

    static #deriveUserKek(userId, keyVersion)
    {
        KeyManagementService.#ensureReady();

        const salt = Buffer.from(`${userId}:${keyVersion}`, "utf8");
        const derived = crypto.hkdfSync("sha256", KeyManagementService.#masterKey, salt, Buffer.from("paid-deck-license"), 32);
        return Buffer.from(derived);
    }

    static encryptDeckPayload(plaintextJson)
    {
        KeyManagementService.#ensureReady();

        const contentKey = KeyManagementService.#generateDeckKey();
        const plaintextBuffer = Buffer.from(JSON.stringify(plaintextJson), "utf8");
        const encrypted = KeyManagementService.#encryptBuffer(contentKey, plaintextBuffer);

        const wrappedContentKey = KeyManagementService.#encryptBuffer(KeyManagementService.#masterKey, contentKey);

        contentKey.fill(0);

        return {
            ivBase64: encrypted.ivBase64,
            ciphertextBase64: encrypted.ciphertextBase64,
            wrappedContentKeyIvBase64: wrappedContentKey.ivBase64,
            wrappedContentKeyBase64: wrappedContentKey.ciphertextBase64
        };
    }

    static #unwrapContentKey(wrappedContentKeyIvBase64, wrappedContentKeyBase64)
    {
        KeyManagementService.#ensureReady();
        return KeyManagementService.#decryptBuffer
        (
            KeyManagementService.#masterKey,
            wrappedContentKeyIvBase64,
            wrappedContentKeyBase64
        );
    }

    static issueLicenseForUser(userId, deckId, keyVersion, wrappedContentKeyIvBase64, wrappedContentKeyBase64, options = {})
    {
        KeyManagementService.#ensureReady();

        const contentKey = KeyManagementService.#unwrapContentKey(wrappedContentKeyIvBase64, wrappedContentKeyBase64);
        const userKek = KeyManagementService.#deriveUserKek(userId, keyVersion);
        const wrappedForUser = KeyManagementService.#encryptBuffer(userKek, contentKey);

        contentKey.fill(0);
        userKek.fill(0);

        const wrappedKeyBlob = JSON.stringify
        ({
            ivBase64: wrappedForUser.ivBase64,
            ciphertextBase64: wrappedForUser.ciphertextBase64
        });

        // options.expiresAt is either a future Date for finite licenses
        // (org-perk grants with a durationDays window) or null / undefined
        // / new Date(0) for the "forever" sentinel. The codegen's
        // DeckLicense setExpiresAt coerces null → new Date(), so callers
        // who want forever must pass new Date(0) explicitly. Anything
        // <= epoch zero is treated as "never expires" by isLicenseActive.
        const expiresAt = options.expiresAt instanceof Date
            ? options.expiresAt
            : new Date(0);

        const grantSource = typeof options.grantSource === "string" && options.grantSource.length > 0
            ? options.grantSource
            : "PURCHASE";

        const license = new DeckLicense
        ({
            userId: userId,
            deckId: deckId,
            status: deckLicenseStatuses.ACTIVE,
            keyVersion: keyVersion,
            wrappedKeyBlob: wrappedKeyBlob,
            issuedAt: new Date(),
            rotatedAt: new Date(),
            expiresAt: expiresAt,
            grantSource: grantSource,
            additionalData: {}
        });

        return license;
    }

    /**
     * Returns true iff the license is currently usable — status ACTIVE
     * AND either has no expiry (epoch-zero sentinel) or expiry is in the
     * future. Use this anywhere license eligibility is checked instead
     * of duplicating the expiry logic.
     * @param {DeckLicense} license
     * @returns {boolean}
     */
    static isLicenseActive(license)
    {
        if (!license)
        {
            return false;
        }
        if (license.getStatus() !== deckLicenseStatuses.ACTIVE)
        {
            return false;
        }
        const expirationDate = license.getExpiresAt();
        if (!(expirationDate instanceof Date))
        {
            return true;
        }
        const expirationTimestampMs = expirationDate.getTime();
        if (expirationTimestampMs <= 0)
        {
            return true; // FOREVER sentinel.
        }
        return expirationTimestampMs > Date.now();
    }

    static async persistLicense(license)
    {
        const database = await DatabaseConnector.getDatabase();
        await database
            .collection(DatabaseConstants.DECK_LICENSES_COLLECTION)
            .updateOne
            (
                { userId: license.getUserId(), deckId: license.getDeckId() },
                { $set: license.toJson() },
                { upsert: true }
            );
    }

    static async getLicensesForUser(userId)
    {
        if (!userId)
        {
            return [];
        }

        const documents = await (await DatabaseConnector.getDatabase())
            .collection(DatabaseConstants.DECK_LICENSES_COLLECTION)
            .find({ userId: userId })
            .toArray();

        return documents.map(document => DeckLicense.fromJson(document));
    }

    static async getLicense(userId, deckId)
    {
        if (!userId || !deckId)
        {
            return null;
        }

        const document = await (await DatabaseConnector.getDatabase())
            .collection(DatabaseConstants.DECK_LICENSES_COLLECTION)
            .findOne({ userId: userId, deckId: deckId });

        return document ? DeckLicense.fromJson(document) : null;
    }

    static async storeAsset(deckId, encryptedPayload)
    {
        const database = await DatabaseConnector.getDatabase();
        await database
            .collection(DatabaseConstants.PAID_DECK_ASSETS_COLLECTION)
            .updateOne
            (
                { deckId: deckId, keyVersion: encryptedPayload.keyVersion },
                { $set: { deckId: deckId, ...encryptedPayload, updatedAt: new Date() } },
                { upsert: true }
            );
    }

    static async getAsset(deckId, keyVersion)
    {
        return await (await DatabaseConnector.getDatabase())
            .collection(DatabaseConstants.PAID_DECK_ASSETS_COLLECTION)
            .findOne({ deckId: deckId, keyVersion: keyVersion });
    }

    static async rotateKeysForDeck(deckId)
    {
        KeyManagementService.#ensureReady();

        const database = await DatabaseConnector.getDatabase();
        const paidDecksCollection = database.collection(DatabaseConstants.PAID_DECKS_COLLECTION);
        const deckDocument = await paidDecksCollection.findOne({ id: deckId });

        if (!deckDocument)
        {
            return { success: false, reason: "DECK_NOT_FOUND" };
        }

        const currentKeyVersion = deckDocument.keyVersion || 1;
        const newKeyVersion = currentKeyVersion + 1;

        const previousAsset = await KeyManagementService.getAsset(deckId, currentKeyVersion);

        if (!previousAsset)
        {
            return { success: false, reason: "PREVIOUS_ASSET_NOT_FOUND" };
        }

        const previousContentKey = KeyManagementService.#unwrapContentKey
        (
            previousAsset.wrappedContentKeyIvBase64,
            previousAsset.wrappedContentKeyBase64
        );

        const plaintextBuffer = KeyManagementService.#decryptBuffer
        (
            previousContentKey,
            previousAsset.ivBase64,
            previousAsset.ciphertextBase64
        );

        previousContentKey.fill(0);

        const plaintextJson = JSON.parse(plaintextBuffer.toString("utf8"));
        const reencrypted = KeyManagementService.encryptDeckPayload(plaintextJson);

        plaintextBuffer.fill(0);

        await KeyManagementService.storeAsset
        (
            deckId,
            { ...reencrypted, keyVersion: newKeyVersion }
        );

        await paidDecksCollection.updateOne
        (
            { id: deckId },
            { $set: { keyVersion: newKeyVersion } }
        );

        const licensesCollection = database.collection(DatabaseConstants.DECK_LICENSES_COLLECTION);
        const activeLicenseDocuments = await licensesCollection
            .find({ deckId: deckId, status: deckLicenseStatuses.ACTIVE })
            .toArray();

        for (const licenseDocument of activeLicenseDocuments)
        {
            // Preserve expiresAt and grantSource from the original
            // license so an org-perk-issued time-limited license keeps
            // its expiry through a key rotation. Without this, the
            // reissued license would default back to the FOREVER
            // sentinel (new Date(0)) and effectively unlock the deck
            // forever.
            const preservedExpiresAt = licenseDocument.expiresAt
                ? new Date(licenseDocument.expiresAt)
                : new Date(0);
            const preservedGrantSource = typeof licenseDocument.grantSource === "string" && licenseDocument.grantSource.length > 0
                ? licenseDocument.grantSource
                : "PURCHASE";

            const reissued = KeyManagementService.issueLicenseForUser
            (
                licenseDocument.userId,
                deckId,
                newKeyVersion,
                reencrypted.wrappedContentKeyIvBase64,
                reencrypted.wrappedContentKeyBase64,
                { expiresAt: preservedExpiresAt, grantSource: preservedGrantSource }
            );

            await KeyManagementService.persistLicense(reissued);
        }

        return { success: true, keyVersion: newKeyVersion, licensesRotated: activeLicenseDocuments.length };
    }

    static async rotateAllOverdueKeys()
    {
        const database = await DatabaseConnector.getDatabase();
        const cutoffMilliseconds = Date.now() - LicenseConstants.KEY_ROTATION_INTERVAL_DAYS * 24 * 60 * 60 * 1000;

        const overdueDeckDocuments = await database
            .collection(DatabaseConstants.PAID_DECKS_COLLECTION)
            .find
            ({
                $or:
                [
                    { lastKeyRotationAt: { $exists: false } },
                    { lastKeyRotationAt: { $lt: new Date(cutoffMilliseconds) } }
                ],
                isPublished: true
            })
            .toArray();

        const results = [];

        for (const document of overdueDeckDocuments)
        {
            try
            {
                const result = await KeyManagementService.rotateKeysForDeck(document.id);

                await database
                    .collection(DatabaseConstants.PAID_DECKS_COLLECTION)
                    .updateOne({ id: document.id }, { $set: { lastKeyRotationAt: new Date() } });

                results.push({ deckId: document.id, ...result });
            }
            catch (rotationError)
            {
                console.error(`[KeyManagementService] Failed to rotate keys for deck ${document.id}:`, rotationError);
                results.push({ deckId: document.id, success: false, reason: "EXCEPTION" });
            }
        }

        return results;
    }

    static async issueLicenseForDeck(userId, deckId, options = {})
    {
        const database = await DatabaseConnector.getDatabase();
        const deckDocument = await database
            .collection(DatabaseConstants.PAID_DECKS_COLLECTION)
            .findOne({ id: deckId });

        if (!deckDocument)
        {
            return { success: false, reason: "DECK_NOT_FOUND" };
        }

        const asset = await KeyManagementService.getAsset(deckId, deckDocument.keyVersion);

        if (!asset)
        {
            return { success: false, reason: "ASSET_NOT_FOUND" };
        }

        const license = KeyManagementService.issueLicenseForUser
        (
            userId,
            deckId,
            deckDocument.keyVersion,
            asset.wrappedContentKeyIvBase64,
            asset.wrappedContentKeyBase64,
            options
        );

        await KeyManagementService.persistLicense(license);

        return { success: true, license: license };
    }

    static async revokeLicense(userId, deckId)
    {
        const database = await DatabaseConnector.getDatabase();
        await database
            .collection(DatabaseConstants.DECK_LICENSES_COLLECTION)
            .updateOne
            (
                { userId: userId, deckId: deckId },
                { $set: { status: deckLicenseStatuses.REVOKED, rotatedAt: new Date() } }
            );
    }

    /**
     * Decrypts the master encrypted asset for a paid deck at a given
     * key version. Used by VerifyPurchase to seed a buyer's per-user
     * editable copy (paidDeckUserContent) — the master itself stays
     * encrypted in paidDeckAssets; only the decrypted plaintext is
     * cloned to the buyer's row.
     *
     * Returns the parsed deck-payload JSON or null when the asset
     * cannot be found / decrypted.
     */
    static async decryptPaidDeckMasterPayload(deckId, keyVersion)
    {
        KeyManagementService.#ensureReady();

        const asset = await KeyManagementService.getAsset(deckId, keyVersion);
        if (!asset)
        {
            return null;
        }

        const contentKeyBytes = KeyManagementService.#unwrapContentKey
        (
            asset.wrappedContentKeyIvBase64,
            asset.wrappedContentKeyBase64
        );

        const plaintextBuffer = KeyManagementService.#decryptBuffer
        (
            contentKeyBytes,
            asset.ivBase64,
            asset.ciphertextBase64
        );

        contentKeyBytes.fill(0);

        try
        {
            return JSON.parse(plaintextBuffer.toString("utf8"));
        }
        finally
        {
            plaintextBuffer.fill(0);
        }
    }

    // ── Paid-deck content-key flow (per-deck server-derived KEK +
    //    per-user password-derived KEK). Used by /PaidDecks/UnlockSession,
    //    /PaidDecks/SetPassword, /PaidDecks/ChangePassword, the rotation
    //    scheduler, and the verify-purchase clone step. ───────────────────

    static #derivePaidDeckServerKek(deckId)
    {
        KeyManagementService.#ensureReady();
        const salt = Buffer.from(`paid-deck-server-kek:${deckId}`, "utf8");
        const info = Buffer.from("paid-deck-content-key", "utf8");
        const derivedBytes = crypto.hkdfSync("sha256", KeyManagementService.#masterKey, salt, info, KeyManagementService.#DECK_KEY_BYTES);
        return Buffer.from(derivedBytes);
    }

    static derivePaidDeckPasswordKek(passwordString, passwordSaltBase64)
    {
        const saltBuffer = Buffer.from(passwordSaltBase64, "base64");
        return crypto.pbkdf2Sync
        (
            passwordString,
            saltBuffer,
            LicenseConstants.PAID_DECK_PASSWORD_PBKDF2_ITERATIONS,
            KeyManagementService.#DECK_KEY_BYTES,
            "sha256"
        );
    }

    static computePaidDeckPasswordHash(passwordString, passwordSaltBase64)
    {
        // Verification hash uses a salt prefixed with "verify:" so it
        // never collides with the KEK derivation above, even though both
        // share the same iteration count + algorithm.
        const verificationSalt = Buffer.from(`verify:${passwordSaltBase64}`, "utf8");
        const hashBytes = crypto.pbkdf2Sync
        (
            passwordString,
            verificationSalt,
            LicenseConstants.PAID_DECK_PASSWORD_PBKDF2_ITERATIONS,
            KeyManagementService.#DECK_KEY_BYTES,
            "sha256"
        );
        return hashBytes.toString("base64");
    }

    static generatePaidDeckPasswordSaltBase64()
    {
        return crypto.randomBytes(16).toString("base64");
    }

    static generatePaidDeckContentKey()
    {
        return crypto.randomBytes(KeyManagementService.#DECK_KEY_BYTES);
    }

    static wrapPaidDeckContentKeyWithServerKek(contentKeyBuffer, deckId)
    {
        const serverKek = KeyManagementService.#derivePaidDeckServerKek(deckId);
        const wrapped = KeyManagementService.#encryptBuffer(serverKek, contentKeyBuffer);
        serverKek.fill(0);
        return wrapped;
    }

    static unwrapPaidDeckContentKeyWithServerKek(serverWrappedIvBase64, serverWrappedContentKeyBase64, deckId)
    {
        const serverKek = KeyManagementService.#derivePaidDeckServerKek(deckId);
        const contentKeyBytes = KeyManagementService.#decryptBuffer(serverKek, serverWrappedIvBase64, serverWrappedContentKeyBase64);
        serverKek.fill(0);
        return contentKeyBytes;
    }

    static wrapPaidDeckContentKeyWithPasswordKek(contentKeyBuffer, passwordKekBuffer)
    {
        return KeyManagementService.#encryptBuffer(passwordKekBuffer, contentKeyBuffer);
    }

    static encryptPaidDeckEntityPlaintext(plaintextJson, contentKeyBuffer)
    {
        const plaintextBuffer = Buffer.from(JSON.stringify(plaintextJson), "utf8");
        const encrypted = KeyManagementService.#encryptBuffer(contentKeyBuffer, plaintextBuffer);
        plaintextBuffer.fill(0);
        return encrypted;
    }

    /**
     * Rotates the content key on a single license. Generates a new
     * content key, re-wraps under the server-derived KEK, and zeroes
     * out the password-wrap (the next /PaidDecks/UnlockSession refills
     * it lazily using the password the user supplies in that request).
     * Bumps contentKeyVersion so the client knows to purge any cached
     * entities that were encrypted under the old key.
     *
     * @param {DeckLicense} license
     */
    static async rotatePaidDeckContentKeyForLicense(license)
    {
        KeyManagementService.#ensureReady();

        const newContentKeyBytes = KeyManagementService.generatePaidDeckContentKey();
        const serverWrap = KeyManagementService.wrapPaidDeckContentKeyWithServerKek(newContentKeyBytes, license.getDeckId());

        license.setServerWrappedIvBase64(serverWrap.ivBase64);
        license.setServerWrappedContentKeyBase64(serverWrap.ciphertextBase64);
        license.setPasswordWrappedContentKeyBase64("");
        license.setPasswordWrappedIvBase64("");
        license.setContentKeyVersion((license.getContentKeyVersion() || 0) + 1);
        license.setRotatedAt(new Date());

        newContentKeyBytes.fill(0);

        await KeyManagementService.persistLicense(license);
        return license;
    }

    static async rotatePaidDeckContentKeyForAllLicensesOfDeck(deckId)
    {
        const database = await DatabaseConnector.getDatabase();
        const licenseDocuments = await database
            .collection(DatabaseConstants.DECK_LICENSES_COLLECTION)
            .find({ deckId: deckId, status: deckLicenseStatuses.ACTIVE })
            .toArray();

        const rotationResults = [];
        for (const licenseDocument of licenseDocuments)
        {
            const license = DeckLicense.fromJson(licenseDocument);
            try
            {
                await KeyManagementService.rotatePaidDeckContentKeyForLicense(license);
                rotationResults.push({ userId: license.getUserId(), success: true });
            }
            catch (rotationError)
            {
                console.error(`[KeyManagementService] Failed to rotate content key for user ${license.getUserId()} on deck ${deckId}:`, rotationError);
                rotationResults.push({ userId: license.getUserId(), success: false, reason: "EXCEPTION" });
            }
        }
        return rotationResults;
    }

    static async rotateAllOverduePaidDeckContentKeys()
    {
        const database = await DatabaseConnector.getDatabase();
        const cutoffDate = new Date(Date.now() - LicenseConstants.PAID_DECK_CONTENT_KEY_ROTATION_INTERVAL_DAYS * 24 * 60 * 60 * 1000);

        const overdueLicenseDocuments = await database
            .collection(DatabaseConstants.DECK_LICENSES_COLLECTION)
            .find
            ({
                status: deckLicenseStatuses.ACTIVE,
                $or:
                [
                    { rotatedAt: { $lt: cutoffDate } },
                    { rotatedAt: { $exists: false } }
                ]
            })
            .limit(500)
            .toArray();

        const rotationResults = [];
        for (const licenseDocument of overdueLicenseDocuments)
        {
            const license = DeckLicense.fromJson(licenseDocument);
            try
            {
                await KeyManagementService.rotatePaidDeckContentKeyForLicense(license);
                rotationResults.push({ userId: license.getUserId(), deckId: license.getDeckId(), success: true });
            }
            catch (rotationError)
            {
                console.error(`[KeyManagementService] Overdue rotation failed for license ${license.getId()}:`, rotationError);
                rotationResults.push({ userId: license.getUserId(), deckId: license.getDeckId(), success: false });
            }
        }
        return rotationResults;
    }
}

module.exports = KeyManagementService;
