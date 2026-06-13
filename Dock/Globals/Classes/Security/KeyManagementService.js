const crypto = require("crypto");
const BSON = require("bson");
const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const LicenseConstants = require("../../Constants/LicenseConstants");
const GrantSources = require("../../Constants/GrantSources");
const DeckLicense = require("../../Model/DeckLicense");
const PaidDeckUserContentCloner = require("../PaidDeck/PaidDeckUserContentCloner");
const PaidDeckEntityTooLargeError = require("./PaidDeckEntityTooLargeError");
const { deckLicenseStatuses } = require("../../Enumerations/DeckLicenseStatuses");

class KeyManagementService
{
    static #masterKey = null;
    static #initialized = false;

    static #DECK_KEY_BYTES = 32;
    static #IV_BYTES = 12;
    static #ALGORITHM = "aes-256-gcm";

    // Flush a write batch once the accumulated plaintext reaches this many
    // bytes, so memory stays bounded no matter how large the deck is.
    static #MASTER_ENTITY_BATCH_BYTES = 12 * 1024 * 1024;
    // Hard per-document ceiling (Mongo's 16MB BSON limit, with headroom).
    static #MAX_ENTITY_DOCUMENT_BYTES = 15 * 1024 * 1024;

    // AES-256-GCM authentication tag length and the random salt length used
    // for paid-deck password derivation, in bytes.
    static #GCM_AUTH_TAG_BYTES = 16;
    static #PASSWORD_SALT_BYTES = 16;

    // HKDF/PBKDF2 salt + info labels. These are baked into every derived key
    // and verification hash, so the literal values must never change once any
    // paid deck has been encrypted.
    static #LICENSE_KEK_SALT_LABEL = "paid-deck-license";
    static #SERVER_KEK_SALT_PREFIX = "paid-deck-server-kek:";
    static #CONTENT_KEY_INFO_LABEL = "paid-deck-content-key";
    static #PASSWORD_VERIFY_SALT_PREFIX = "verify:";

    // Internal result codes returned by the rotation / license-issue flows.
    static #REASON_DECK_NOT_FOUND = "DECK_NOT_FOUND";
    static #REASON_PREVIOUS_ASSET_NOT_FOUND = "PREVIOUS_ASSET_NOT_FOUND";
    static #REASON_ASSET_NOT_FOUND = "ASSET_NOT_FOUND";
    static #REASON_EXCEPTION = "EXCEPTION";

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
        const authenticationTag = combined.slice(combined.length - KeyManagementService.#GCM_AUTH_TAG_BYTES);
        const ciphertext = combined.slice(0, combined.length - KeyManagementService.#GCM_AUTH_TAG_BYTES);

        const decipher = crypto.createDecipheriv(KeyManagementService.#ALGORITHM, keyBuffer, initializationVector);
        decipher.setAuthTag(authenticationTag);

        return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    }

    static #deriveUserKek(userId, keyVersion)
    {
        KeyManagementService.#ensureReady();

        const salt = Buffer.from(`${userId}:${keyVersion}`, "utf8");
        const derived = crypto.hkdfSync("sha256", KeyManagementService.#masterKey, salt, Buffer.from(KeyManagementService.#LICENSE_KEK_SALT_LABEL), 32);
        return Buffer.from(derived);
    }

    /**
     * Splits a flat entity list into byte-bounded batches (an async iterable),
     * so the streaming writer never holds the whole deck in memory. Used for
     * the upload path where the source is the in-memory cloner output.
     */
    static *#chunkEntitiesByBytes(entities)
    {
        let batch = [];
        let batchBytes = 0;
        for (const entity of entities)
        {
            const entityBytes = Buffer.byteLength(JSON.stringify(entity.plaintext ?? null), "utf8");
            if (batch.length > 0 && (batchBytes + entityBytes) > KeyManagementService.#MASTER_ENTITY_BATCH_BYTES)
            {
                yield batch;
                batch = [];
                batchBytes = 0;
            }
            batch.push(entity);
            batchBytes += entityBytes;
        }
        if (batch.length > 0)
        {
            yield batch;
        }
    }

    /**
     * Writes a paid deck's master copy (per-entity, encrypted at rest) by
     * streaming `batchIterable` — anything async-iterable yielding arrays of
     * { entityId, entityType, parentDeckId, plaintext }. A fresh deck content
     * key encrypts every entity; each entity doc is size-checked against the
     * 16MB ceiling (throws PaidDeckEntityTooLargeError naming the entity). The
     * meta doc (wrapped key + manifest) is written LAST, so "meta exists ⇒
     * fully written". Returns the wrapped content key for license issuance.
     */
    static async storeMasterEntitiesFromBatches(deckId, keyVersion, manifest, batchIterable)
    {
        KeyManagementService.#ensureReady();
        const database = await DatabaseConnector.getDatabase();
        const masterEntitiesCollection = database.collection(DatabaseConstants.PAID_DECK_MASTER_ENTITIES_COLLECTION);

        const contentKey = KeyManagementService.#generateDeckKey();
        const wrappedContentKey = KeyManagementService.#encryptBuffer(KeyManagementService.#masterKey, contentKey);

        // Replace any prior content at this (deckId, keyVersion) before streaming
        // so an upload retry never leaves orphaned entities behind.
        await masterEntitiesCollection.deleteMany({ deckId: deckId, keyVersion: keyVersion });

        const writeTimestamp = new Date();
        let entityCount = 0;
        try
        {
            for await (const entityBatch of batchIterable)
            {
                const entityDocuments = entityBatch.map((entity) =>
                {
                    const encrypted = KeyManagementService.encryptPaidDeckEntityPlaintext(entity.plaintext, contentKey);
                    return {
                        deckId: deckId,
                        keyVersion: keyVersion,
                        entityId: entity.entityId,
                        entityType: entity.entityType,
                        parentDeckId: entity.parentDeckId ?? null,
                        ivBase64: encrypted.ivBase64,
                        ciphertextBase64: encrypted.ciphertextBase64,
                        updatedAt: writeTimestamp
                    };
                });

                KeyManagementService.#assertEntityDocumentsWithinLimit(entityDocuments);

                if (entityDocuments.length > 0)
                {
                    await masterEntitiesCollection.insertMany(entityDocuments, { ordered: false });
                    entityCount += entityDocuments.length;
                }
            }
        }
        finally
        {
            contentKey.fill(0);
        }

        await database.collection(DatabaseConstants.PAID_DECK_ASSETS_COLLECTION).updateOne
        (
            { deckId: deckId, keyVersion: keyVersion },
            {
                $set:
                {
                    deckId: deckId,
                    keyVersion: keyVersion,
                    wrappedContentKeyIvBase64: wrappedContentKey.ivBase64,
                    wrappedContentKeyBase64: wrappedContentKey.ciphertextBase64,
                    manifest: manifest,
                    rootDeckId: manifest?.rootDeckId || "",
                    entityCount: entityCount,
                    updatedAt: writeTimestamp
                },
                // Drop legacy monolithic fields if this doc predates per-entity.
                $unset: { ivBase64: "", ciphertextBase64: "" }
            },
            { upsert: true }
        );

        return {
            wrappedContentKeyIvBase64: wrappedContentKey.ivBase64,
            wrappedContentKeyBase64: wrappedContentKey.ciphertextBase64,
            entityCount: entityCount
        };
    }

    /**
     * Throws PaidDeckEntityTooLargeError if any document exceeds the 16MB
     * per-document ceiling — the one limit per-entity storage can't get under
     * (a normal deck hits the same wall for such an entity). Naming the entity
     * lets the upload endpoint surface a clear message instead of a raw BSON
     * ERR_OUT_OF_RANGE.
     */
    static #assertEntityDocumentsWithinLimit(entityDocuments)
    {
        for (const entityDocument of entityDocuments)
        {
            const documentBytes = BSON.calculateObjectSize(entityDocument);
            if (documentBytes > KeyManagementService.#MAX_ENTITY_DOCUMENT_BYTES)
            {
                throw new PaidDeckEntityTooLargeError(entityDocument.entityId, documentBytes);
            }
        }
    }

    /**
     * Stores a paid deck's master copy from a deck export payload. Reuses
     * PaidDeckUserContentCloner to walk the payload into a manifest + per-entity
     * plaintext map, then streams it in byte-bounded batches.
     */
    static async storePaidDeckMaster(deckId, keyVersion, deckPayload)
    {
        const cloned = PaidDeckUserContentCloner.clone(deckPayload);
        const entities = Object.entries(cloned.contentByEntityId).map(([entityId, record]) =>
        ({
            entityId: entityId,
            entityType: record.entityType,
            parentDeckId: record.parentDeckId ?? null,
            plaintext: record.plaintext
        }));
        return await KeyManagementService.storeMasterEntitiesFromBatches
        (
            deckId,
            keyVersion,
            cloned.manifest,
            KeyManagementService.#chunkEntitiesByBytes(entities)
        );
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
        // / DeckLicense.FOREVER for the "forever" sentinel. DeckLicense's
        // setExpiresAt also coerces null / undefined to FOREVER, so a
        // missing expiry can never silently become an already-expired
        // license. Anything <= epoch zero is treated as "never expires"
        // by isLicenseActive.
        const expiresAt = options.expiresAt instanceof Date
            ? options.expiresAt
            : DeckLicense.FOREVER;

        const grantSource = typeof options.grantSource === "string" && options.grantSource.length > 0
            ? options.grantSource
            : GrantSources.PURCHASE;

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

    /**
     * Reads the small master meta doc (wrapped deck content key + manifest)
     * for a (deckId, keyVersion). The actual content lives per-entity in
     * paidDeckMasterEntities.
     */
    static async getMasterMeta(deckId, keyVersion)
    {
        return await (await DatabaseConnector.getDatabase())
            .collection(DatabaseConstants.PAID_DECK_ASSETS_COLLECTION)
            .findOne({ deckId: deckId, keyVersion: keyVersion });
    }

    /**
     * Returns just the master manifest for (deckId, keyVersion), or null when
     * absent. Per-entity decks read it straight off the meta doc; a LEGACY
     * monolithic asset is decrypted + walked to reproduce it.
     */
    static async getMasterManifest(deckId, keyVersion)
    {
        const meta = await KeyManagementService.getMasterMeta(deckId, keyVersion);
        if (!meta)
        {
            return null;
        }
        if (meta.manifest && !meta.ciphertextBase64)
        {
            return meta.manifest;
        }
        if (meta.ciphertextBase64)
        {
            KeyManagementService.#ensureReady();
            const legacyContentKey = KeyManagementService.#unwrapContentKey(meta.wrappedContentKeyIvBase64, meta.wrappedContentKeyBase64);
            const plaintextBuffer = KeyManagementService.#decryptBuffer(legacyContentKey, meta.ivBase64, meta.ciphertextBase64);
            legacyContentKey.fill(0);
            try
            {
                return PaidDeckUserContentCloner.clone(JSON.parse(plaintextBuffer.toString("utf8"))).manifest;
            }
            finally
            {
                plaintextBuffer.fill(0);
            }
        }
        return meta.manifest || { rootDeckId: meta.rootDeckId || "", entries: [] };
    }

    /**
     * Async generator that streams a master copy's entities in byte-bounded
     * batches of { entityId, entityType, parentDeckId, plaintext }, so a caller
     * (purchase-clone, key rotation) never holds the whole deck in memory.
     * Yields nothing when the deck has no meta.
     *
     * Per-entity decks stream via a Mongo cursor. A LEGACY monolithic asset is
     * decrypted whole (always <16MB by definition) then walked + yielded in
     * byte-sized chunks, so callers don't need to special-case it.
     */
    static async *iterateMasterEntitiesDecrypted(deckId, keyVersion)
    {
        KeyManagementService.#ensureReady();
        const database = await DatabaseConnector.getDatabase();

        const meta = await KeyManagementService.getMasterMeta(deckId, keyVersion);
        if (!meta)
        {
            return;
        }

        // Legacy monolithic asset — decrypt whole, walk, yield in chunks.
        if (meta.ciphertextBase64)
        {
            const legacyContentKey = KeyManagementService.#unwrapContentKey(meta.wrappedContentKeyIvBase64, meta.wrappedContentKeyBase64);
            const plaintextBuffer = KeyManagementService.#decryptBuffer(legacyContentKey, meta.ivBase64, meta.ciphertextBase64);
            legacyContentKey.fill(0);

            let payloadJson;
            try
            {
                payloadJson = JSON.parse(plaintextBuffer.toString("utf8"));
            }
            finally
            {
                plaintextBuffer.fill(0);
            }

            const cloned = PaidDeckUserContentCloner.clone(payloadJson);
            const legacyEntities = Object.entries(cloned.contentByEntityId).map(([entityId, record]) =>
            ({
                entityId: entityId,
                entityType: record.entityType,
                parentDeckId: record.parentDeckId ?? null,
                plaintext: record.plaintext
            }));
            yield* KeyManagementService.#chunkEntitiesByBytes(legacyEntities);
            return;
        }

        const contentKey = KeyManagementService.#unwrapContentKey(meta.wrappedContentKeyIvBase64, meta.wrappedContentKeyBase64);
        try
        {
            const cursor = database
                .collection(DatabaseConstants.PAID_DECK_MASTER_ENTITIES_COLLECTION)
                .find({ deckId: deckId, keyVersion: keyVersion });

            let batch = [];
            let batchBytes = 0;
            for await (const entityDocument of cursor)
            {
                const plaintextBuffer = KeyManagementService.#decryptBuffer(contentKey, entityDocument.ivBase64, entityDocument.ciphertextBase64);
                let plaintext;
                try
                {
                    plaintext = JSON.parse(plaintextBuffer.toString("utf8"));
                }
                finally
                {
                    plaintextBuffer.fill(0);
                }

                batch.push
                ({
                    entityId: entityDocument.entityId,
                    entityType: entityDocument.entityType,
                    parentDeckId: entityDocument.parentDeckId ?? null,
                    plaintext: plaintext
                });
                batchBytes += Buffer.byteLength(JSON.stringify(plaintext ?? null), "utf8");

                if (batchBytes > KeyManagementService.#MASTER_ENTITY_BATCH_BYTES)
                {
                    yield batch;
                    batch = [];
                    batchBytes = 0;
                }
            }

            if (batch.length > 0)
            {
                yield batch;
            }
        }
        finally
        {
            contentKey.fill(0);
        }
    }

    static async rotateKeysForDeck(deckId)
    {
        KeyManagementService.#ensureReady();

        const database = await DatabaseConnector.getDatabase();
        const paidDecksCollection = database.collection(DatabaseConstants.PAID_DECKS_COLLECTION);
        const deckDocument = await paidDecksCollection.findOne({ id: deckId });

        if (!deckDocument)
        {
            return { success: false, reason: KeyManagementService.#REASON_DECK_NOT_FOUND };
        }

        const currentKeyVersion = deckDocument.keyVersion || 1;
        const newKeyVersion = currentKeyVersion + 1;

        // Stream the master at the current version (per-entity, or a legacy
        // monolithic asset) straight into a fresh content key at the new
        // version — never holding the whole deck in memory.
        const previousManifest = await KeyManagementService.getMasterManifest(deckId, currentKeyVersion);

        if (!previousManifest)
        {
            return { success: false, reason: KeyManagementService.#REASON_PREVIOUS_ASSET_NOT_FOUND };
        }

        const writeResult = await KeyManagementService.storeMasterEntitiesFromBatches
        (
            deckId,
            newKeyVersion,
            previousManifest,
            KeyManagementService.iterateMasterEntitiesDecrypted(deckId, currentKeyVersion)
        );

        await paidDecksCollection.updateOne
        (
            { id: deckId },
            { $set: { keyVersion: newKeyVersion } }
        );

        // Tear down the previous version's per-entity docs + meta.
        await database
            .collection(DatabaseConstants.PAID_DECK_MASTER_ENTITIES_COLLECTION)
            .deleteMany({ deckId: deckId, keyVersion: currentKeyVersion });
        await database
            .collection(DatabaseConstants.PAID_DECK_ASSETS_COLLECTION)
            .deleteOne({ deckId: deckId, keyVersion: currentKeyVersion });

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
            // sentinel and effectively unlock the deck forever.
            const preservedExpiresAt = licenseDocument.expiresAt
                ? new Date(licenseDocument.expiresAt)
                : DeckLicense.FOREVER;
            const preservedGrantSource = typeof licenseDocument.grantSource === "string" && licenseDocument.grantSource.length > 0
                ? licenseDocument.grantSource
                : GrantSources.PURCHASE;

            const reissued = KeyManagementService.issueLicenseForUser
            (
                licenseDocument.userId,
                deckId,
                newKeyVersion,
                writeResult.wrappedContentKeyIvBase64,
                writeResult.wrappedContentKeyBase64,
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
                results.push({ deckId: document.id, success: false, reason: KeyManagementService.#REASON_EXCEPTION });
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
            return { success: false, reason: KeyManagementService.#REASON_DECK_NOT_FOUND };
        }

        const meta = await KeyManagementService.getMasterMeta(deckId, deckDocument.keyVersion);

        if (!meta)
        {
            return { success: false, reason: KeyManagementService.#REASON_ASSET_NOT_FOUND };
        }

        const license = KeyManagementService.issueLicenseForUser
        (
            userId,
            deckId,
            deckDocument.keyVersion,
            meta.wrappedContentKeyIvBase64,
            meta.wrappedContentKeyBase64,
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

    // ── Paid-deck content-key flow (per-deck server-derived KEK +
    //    per-user password-derived KEK). Used by /PaidDecks/UnlockSession,
    //    /PaidDecks/SetPassword, /PaidDecks/ChangePassword, the rotation
    //    scheduler, and the verify-purchase clone step. ───────────────────

    static #derivePaidDeckServerKek(deckId)
    {
        KeyManagementService.#ensureReady();
        const salt = Buffer.from(`${KeyManagementService.#SERVER_KEK_SALT_PREFIX}${deckId}`, "utf8");
        const info = Buffer.from(KeyManagementService.#CONTENT_KEY_INFO_LABEL, "utf8");
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
        const verificationSalt = Buffer.from(`${KeyManagementService.#PASSWORD_VERIFY_SALT_PREFIX}${passwordSaltBase64}`, "utf8");
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

    /**
     * Constant-time comparison of two base64-encoded password hashes. Decoding
     * to buffers and comparing with crypto.timingSafeEqual avoids the early-exit
     * timing leak of a plain "===" on the strings. A length mismatch (which
     * timingSafeEqual would throw on) is treated as a non-match without ever
     * touching the bytes — the decoded hash length is fixed by the algorithm, so
     * a mismatch only ever means malformed/forged input.
     */
    static safeEqualPaidDeckPasswordHash(submittedHashBase64, storedHashBase64)
    {
        if (typeof submittedHashBase64 !== "string" || typeof storedHashBase64 !== "string")
        {
            return false;
        }

        const submittedBuffer = Buffer.from(submittedHashBase64, "base64");
        const storedBuffer = Buffer.from(storedHashBase64, "base64");

        if (submittedBuffer.length !== storedBuffer.length || storedBuffer.length === 0)
        {
            return false;
        }

        return crypto.timingSafeEqual(submittedBuffer, storedBuffer);
    }

    static generatePaidDeckPasswordSaltBase64()
    {
        return crypto.randomBytes(KeyManagementService.#PASSWORD_SALT_BYTES).toString("base64");
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
     * Per-FIELD string encryption for the unified sync model: encrypts a single
     * content string (Card.question, StudyMaterial HTML, a MockTest question
     * field, ...) into a { ivBase64, ciphertextBase64 } envelope. The byte
     * layout (12-byte IV, ciphertext||16-byte GCM tag, base64) is identical to
     * the client's PaidDeckSession.encryptString, so a field encrypted here in
     * the /Sync pull response decrypts on the client unchanged.
     */
    static encryptPaidDeckFieldString(plaintextString, contentKeyBuffer)
    {
        const plaintextBuffer = Buffer.from(String(plaintextString ?? ""), "utf8");
        const encrypted = KeyManagementService.#encryptBuffer(contentKeyBuffer, plaintextBuffer);
        plaintextBuffer.fill(0);
        return encrypted;
    }

    /**
     * Resolves the raw content-key buffer for (userId, deckId) from the user's
     * ACTIVE license via the server-KEK unwrap — the key the /Sync pull uses to
     * encrypt paid content on the wire. Returns null when the user holds no
     * active license for the deck (so the caller skips/blocks delivery).
     * Caller MUST zero the returned buffer after use.
     */
    static async getPaidDeckContentKeyBufferForUser(userId, deckId)
    {
        const license = await KeyManagementService.getLicense(userId, deckId);
        if (!KeyManagementService.isLicenseActive(license))
        {
            return null;
        }
        const serverWrappedIvBase64 = license.getServerWrappedIvBase64();
        const serverWrappedContentKeyBase64 = license.getServerWrappedContentKeyBase64();
        if (!serverWrappedIvBase64 || !serverWrappedContentKeyBase64)
        {
            return null;
        }
        return KeyManagementService.unwrapPaidDeckContentKeyWithServerKek(serverWrappedIvBase64, serverWrappedContentKeyBase64, deckId);
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
