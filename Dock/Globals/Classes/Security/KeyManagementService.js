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

    static issueLicenseForUser(userId, deckId, keyVersion, wrappedContentKeyIvBase64, wrappedContentKeyBase64)
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

        const license = new DeckLicense
        ({
            userId: userId,
            deckId: deckId,
            status: deckLicenseStatuses.ACTIVE,
            keyVersion: keyVersion,
            wrappedKeyBlob: wrappedKeyBlob,
            issuedAt: new Date(),
            rotatedAt: new Date(),
            additionalData: {}
        });

        return license;
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
            const reissued = KeyManagementService.issueLicenseForUser
            (
                licenseDocument.userId,
                deckId,
                newKeyVersion,
                reencrypted.wrappedContentKeyIvBase64,
                reencrypted.wrappedContentKeyBase64
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

    static async issueLicenseForDeck(userId, deckId)
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
            asset.wrappedContentKeyBase64
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
}

module.exports = KeyManagementService;
