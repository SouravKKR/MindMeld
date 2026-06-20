const DatabaseConnector = require("./DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const ErrorCodes = require("../../Constants/ErrorCodes");
const PromoCode = require("../Credits/PromoCode");
const PromoCodeRedemption = require("../Credits/PromoCodeRedemption");

/**
 * PromoCodeQueryEngine
 *
 * Owns the promoCodes and promoCodeRedemptions collections. Two invariants are
 * enforced at the storage layer so concurrency can never break them:
 *
 *  - A unique index on promoCodes.codeString (stored normalized uppercase)
 *    makes a duplicate code impossible.
 *  - A unique compound index on promoCodeRedemptions.(promoCodeId, userId)
 *    makes a second redemption by the same user impossible.
 *
 * The redemption cap is enforced by an atomic guarded increment of usedCount
 * (claimRedemptionSlot) — the same idiom CreditLedger.charge uses for the
 * balance floor — so the cap can never be exceeded under concurrent redeems.
 */
class PromoCodeQueryEngine
{
    static #PROMO_CODES_COLLECTION = DatabaseConstants.PROMO_CODES_COLLECTION;
    static #REDEMPTIONS_COLLECTION = DatabaseConstants.PROMO_CODE_REDEMPTIONS_COLLECTION;
    static #DUPLICATE_KEY_ERROR_CODE = 11000;

    // A single base-create call may not mint more than this many codes at once,
    // bounding the request cost and the displayed table size.
    static MAX_BULK_CREATE_COUNT = 1000;

    static #indexesEnsured = false;

    static async #getDatabase()
    {
        return await DatabaseConnector.getDatabase();
    }

    static async #getPromoCodesCollection()
    {
        const database = await PromoCodeQueryEngine.#getDatabase();
        if (!database)
        {
            return null;
        }

        const collection = database.collection(PromoCodeQueryEngine.#PROMO_CODES_COLLECTION);
        await PromoCodeQueryEngine.#ensureIndexes(database);
        return collection;
    }

    static async #getRedemptionsCollection()
    {
        const database = await PromoCodeQueryEngine.#getDatabase();
        if (!database)
        {
            return null;
        }

        const collection = database.collection(PromoCodeQueryEngine.#REDEMPTIONS_COLLECTION);
        await PromoCodeQueryEngine.#ensureIndexes(database);
        return collection;
    }

    static async #ensureIndexes(database)
    {
        if (PromoCodeQueryEngine.#indexesEnsured)
        {
            return;
        }

        try
        {
            const promoCodesCollection = database.collection(PromoCodeQueryEngine.#PROMO_CODES_COLLECTION);
            await promoCodesCollection.createIndex({ codeString: 1 }, { unique: true });
            await promoCodesCollection.createIndex({ id: 1 }, { unique: true });
            await promoCodesCollection.createIndex({ createdAt: -1 });

            const redemptionsCollection = database.collection(PromoCodeQueryEngine.#REDEMPTIONS_COLLECTION);
            await redemptionsCollection.createIndex({ promoCodeId: 1, userId: 1 }, { unique: true });
            await redemptionsCollection.createIndex({ promoCodeId: 1, redeemedAt: -1 });
            await redemptionsCollection.createIndex({ userId: 1, redeemedAt: -1 });

            PromoCodeQueryEngine.#indexesEnsured = true;
        }
        catch (indexError)
        {
            console.error("[PromoCodeQueryEngine] Failed to ensure indexes:", indexError);
        }
    }

    /**
     * Creates a single promo code. Returns { success, promoCode } or
     * { success:false, reason } — a duplicate normalized code yields
     * PROMO_CODE_ALREADY_EXISTS (enforced by the unique index).
     */
    static async createPromoCode({ codeString, maxRedemptions, createdByUserId } = {})
    {
        const collection = await PromoCodeQueryEngine.#getPromoCodesCollection();
        if (!collection)
        {
            return { success: false, reason: ErrorCodes.DATABASE_UNAVAILABLE };
        }

        const promoCode = new PromoCode({ codeString, maxRedemptions, createdByUserId, createdAt: new Date() });
        if (promoCode.getCodeString().length === 0)
        {
            return { success: false, reason: ErrorCodes.INVALID_CODE };
        }

        try
        {
            await collection.insertOne(promoCode.toJson());
            return { success: true, promoCode: promoCode };
        }
        catch (insertError)
        {
            if (insertError && insertError.code === PromoCodeQueryEngine.#DUPLICATE_KEY_ERROR_CODE)
            {
                return { success: false, reason: ErrorCodes.PROMO_CODE_ALREADY_EXISTS };
            }
            throw insertError;
        }
    }

    /**
     * Creates many codes from a base string, appending 1..count with no
     * separator (base "LAUNCH", count 3 -> LAUNCH1, LAUNCH2, LAUNCH3). Codes
     * that collide with an existing code are skipped (reported), the rest are
     * inserted. Returns { success, created:[codeString], skipped:[codeString] }.
     */
    static async createPromoCodesBulk({ baseString, count, maxRedemptions, createdByUserId } = {})
    {
        const collection = await PromoCodeQueryEngine.#getPromoCodesCollection();
        if (!collection)
        {
            return { success: false, reason: ErrorCodes.DATABASE_UNAVAILABLE };
        }

        const normalizedBase = PromoCode.normalizeCodeString(baseString);
        if (normalizedBase.length === 0)
        {
            return { success: false, reason: ErrorCodes.INVALID_CODE };
        }

        const totalToCreate = parseInt(count, 10);
        if (isNaN(totalToCreate) || totalToCreate < 1 || totalToCreate > PromoCodeQueryEngine.MAX_BULK_CREATE_COUNT)
        {
            return { success: false, reason: ErrorCodes.INVALID_COUNT };
        }

        const candidatePromoCodes = [];
        for (let sequenceNumber = 1; sequenceNumber <= totalToCreate; sequenceNumber++)
        {
            candidatePromoCodes.push(new PromoCode
            ({
                codeString: `${normalizedBase}${sequenceNumber}`,
                maxRedemptions: maxRedemptions,
                createdByUserId: createdByUserId,
                createdAt: new Date()
            }));
        }

        const candidateCodeStrings = candidatePromoCodes.map(promoCode => promoCode.getCodeString());

        // Pre-check for collisions so the admin gets a clean per-code report.
        // The unique index remains the source of truth against concurrent
        // creators (residual duplicates fail insert and are reported as skips).
        const existingDocuments = await collection.find
        (
            { codeString: { $in: candidateCodeStrings } },
            { projection: { codeString: 1, _id: 0 } }
        ).toArray();
        const existingCodeStrings = new Set(existingDocuments.map(document => document.codeString));

        const skipped = [];
        const documentsToInsert = [];

        for (const promoCode of candidatePromoCodes)
        {
            if (existingCodeStrings.has(promoCode.getCodeString()))
            {
                skipped.push(promoCode.getCodeString());
            }
            else
            {
                documentsToInsert.push(promoCode.toJson());
            }
        }

        if (documentsToInsert.length > 0)
        {
            try
            {
                await collection.insertMany(documentsToInsert, { ordered: false });
            }
            catch (insertError)
            {
                // ordered:false inserts every non-colliding document and only
                // raises for the duplicate-key collisions (a concurrent creator
                // that beat the pre-check). Anything else is a real failure.
                if (!insertError || insertError.code !== PromoCodeQueryEngine.#DUPLICATE_KEY_ERROR_CODE)
                {
                    throw insertError;
                }
            }
        }

        // Reconcile against the database rather than parsing driver-specific
        // write-error shapes: a candidate that now carries THIS request's id was
        // inserted by us; any other candidate (pre-existing or lost a race) is a
        // skip.
        const insertedIdsByCodeString = new Map(documentsToInsert.map(document => [document.codeString, document.id]));
        const persistedDocuments = await collection.find
        (
            { codeString: { $in: Array.from(insertedIdsByCodeString.keys()) } },
            { projection: { codeString: 1, id: 1, _id: 0 } }
        ).toArray();

        const created = [];
        for (const document of persistedDocuments)
        {
            if (insertedIdsByCodeString.get(document.codeString) === document.id)
            {
                created.push(document.codeString);
            }
            else
            {
                skipped.push(document.codeString);
            }
        }

        // Any candidate we intended to insert but that is now absent (should not
        // happen) is reported as skipped so counts always add up.
        const createdSet = new Set(created);
        for (const codeString of insertedIdsByCodeString.keys())
        {
            if (!createdSet.has(codeString) && !skipped.includes(codeString))
            {
                skipped.push(codeString);
            }
        }

        return { success: true, created: created, skipped: skipped };
    }

    static async getByCodeString(codeString)
    {
        const collection = await PromoCodeQueryEngine.#getPromoCodesCollection();
        if (!collection)
        {
            return null;
        }

        const document = await collection.findOne({ codeString: PromoCode.normalizeCodeString(codeString) }, { projection: { _id: 0 } });
        return document ? PromoCode.fromJson(document) : null;
    }

    static async getById(promoCodeId)
    {
        const collection = await PromoCodeQueryEngine.#getPromoCodesCollection();
        if (!collection || typeof promoCodeId !== "string" || promoCodeId.length === 0)
        {
            return null;
        }

        const document = await collection.findOne({ id: promoCodeId }, { projection: { _id: 0 } });
        return document ? PromoCode.fromJson(document) : null;
    }

    /**
     * Atomically reserves one redemption slot: increments usedCount only while
     * the code is enabled and usedCount < maxRedemptions. Returns the updated
     * PromoCode on success, or null when the code is disabled / exhausted /
     * missing. This is the cap gate — never bypass it.
     */
    static async claimRedemptionSlot(promoCodeId)
    {
        const collection = await PromoCodeQueryEngine.#getPromoCodesCollection();
        if (!collection || typeof promoCodeId !== "string" || promoCodeId.length === 0)
        {
            return null;
        }

        const updateResult = await collection.findOneAndUpdate
        (
            { id: promoCodeId, enabled: true, $expr: { $lt: ["$usedCount", "$maxRedemptions"] } },
            { $inc: { usedCount: 1 } },
            { returnDocument: "after", projection: { _id: 0 } }
        );

        const updatedDocument = updateResult?.value || updateResult;
        return updatedDocument ? PromoCode.fromJson(updatedDocument) : null;
    }

    /**
     * Returns a slot reserved by claimRedemptionSlot when the downstream
     * redemption could not be completed (e.g. the user had already redeemed,
     * or the credit grant failed), keeping usedCount accurate.
     */
    static async releaseRedemptionSlot(promoCodeId)
    {
        const collection = await PromoCodeQueryEngine.#getPromoCodesCollection();
        if (!collection || typeof promoCodeId !== "string" || promoCodeId.length === 0)
        {
            return;
        }

        await collection.updateOne
        (
            { id: promoCodeId, usedCount: { $gt: 0 } },
            { $inc: { usedCount: -1 } }
        );
    }

    static async findRedemption(promoCodeId, userId)
    {
        const collection = await PromoCodeQueryEngine.#getRedemptionsCollection();
        if (!collection)
        {
            return null;
        }

        const document = await collection.findOne({ promoCodeId: promoCodeId, userId: userId }, { projection: { _id: 0 } });
        return document ? PromoCodeRedemption.fromJson(document) : null;
    }

    /**
     * Inserts a redemption row. Returns { inserted:true } on success or
     * { inserted:false, alreadyRedeemed:true } when the unique (promoCodeId,
     * userId) index rejects a concurrent second redemption by the same user.
     */
    static async insertRedemption(promoCodeRedemption)
    {
        const collection = await PromoCodeQueryEngine.#getRedemptionsCollection();
        if (!collection)
        {
            return { inserted: false, alreadyRedeemed: false, reason: ErrorCodes.DATABASE_UNAVAILABLE };
        }

        try
        {
            await collection.insertOne(promoCodeRedemption.toJson());
            return { inserted: true };
        }
        catch (insertError)
        {
            if (insertError && insertError.code === PromoCodeQueryEngine.#DUPLICATE_KEY_ERROR_CODE)
            {
                return { inserted: false, alreadyRedeemed: true };
            }
            throw insertError;
        }
    }

    static async deleteRedemption(promoCodeId, userId)
    {
        const collection = await PromoCodeQueryEngine.#getRedemptionsCollection();
        if (!collection)
        {
            return;
        }

        await collection.deleteOne({ promoCodeId: promoCodeId, userId: userId });
    }

    static async getRedemptionCountForCode(promoCodeId)
    {
        const collection = await PromoCodeQueryEngine.#getRedemptionsCollection();
        if (!collection || typeof promoCodeId !== "string" || promoCodeId.length === 0)
        {
            return 0;
        }

        return await collection.countDocuments({ promoCodeId: promoCodeId });
    }

    static async setEnabled(promoCodeId, enabled)
    {
        const collection = await PromoCodeQueryEngine.#getPromoCodesCollection();
        if (!collection || typeof promoCodeId !== "string" || promoCodeId.length === 0)
        {
            return { success: false, reason: ErrorCodes.DATABASE_UNAVAILABLE };
        }

        const updateResult = await collection.updateOne({ id: promoCodeId }, { $set: { enabled: Boolean(enabled) } });
        if ((updateResult.matchedCount || 0) === 0)
        {
            return { success: false, reason: ErrorCodes.PROMO_CODE_NOT_FOUND };
        }
        return { success: true };
    }

    /**
     * Deletes a promo code and all its redemption rows. The credits already
     * granted to past redeemers are intentionally NOT clawed back — deletion
     * only retires the code from future use and clears the audit rows.
     */
    static async deletePromoCode(promoCodeId)
    {
        const promoCodesCollection = await PromoCodeQueryEngine.#getPromoCodesCollection();
        const redemptionsCollection = await PromoCodeQueryEngine.#getRedemptionsCollection();
        if (!promoCodesCollection || !redemptionsCollection || typeof promoCodeId !== "string" || promoCodeId.length === 0)
        {
            return { success: false, reason: ErrorCodes.DATABASE_UNAVAILABLE };
        }

        const deleteResult = await promoCodesCollection.deleteOne({ id: promoCodeId });
        if ((deleteResult.deletedCount || 0) === 0)
        {
            return { success: false, reason: ErrorCodes.PROMO_CODE_NOT_FOUND };
        }

        await redemptionsCollection.deleteMany({ promoCodeId: promoCodeId });
        return { success: true };
    }
}

module.exports = PromoCodeQueryEngine;
