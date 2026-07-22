const DatabaseConnector = require("./DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const ErrorCodes = require("../../Constants/ErrorCodes");
const Coupon = require("../Coupons/Coupon");
const CouponRedemption = require("../Coupons/CouponRedemption");

/**
 * CouponQueryEngine
 *
 * Owns the coupons and couponRedemptions collections. The concurrency
 * invariants mirror PromoCodeQueryEngine exactly:
 *
 *  - unique index on coupons.codeString (normalized uppercase) → no duplicate.
 *  - unique compound index on couponRedemptions.(couponId, userId) → no second
 *    redemption by the same user.
 *  - claimRedemptionSlot atomically increments usedCount only while enabled and
 *    under maxRedemptions → the cap can never be exceeded under concurrency.
 */
class CouponQueryEngine
{
    static #COUPONS_COLLECTION = DatabaseConstants.COUPONS_COLLECTION;
    static #REDEMPTIONS_COLLECTION = DatabaseConstants.COUPON_REDEMPTIONS_COLLECTION;
    static #DUPLICATE_KEY_ERROR_CODE = 11000;

    static MAX_BULK_CREATE_COUNT = 1000;

    static #indexesEnsured = false;

    static async #getCouponsCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return null;
        }
        const collection = database.collection(CouponQueryEngine.#COUPONS_COLLECTION);
        await CouponQueryEngine.#ensureIndexes(database);
        return collection;
    }

    static async #getRedemptionsCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return null;
        }
        const collection = database.collection(CouponQueryEngine.#REDEMPTIONS_COLLECTION);
        await CouponQueryEngine.#ensureIndexes(database);
        return collection;
    }

    static async #ensureIndexes(database)
    {
        if (CouponQueryEngine.#indexesEnsured)
        {
            return;
        }
        try
        {
            const couponsCollection = database.collection(CouponQueryEngine.#COUPONS_COLLECTION);
            await couponsCollection.createIndex({ codeString: 1 }, { unique: true });
            await couponsCollection.createIndex({ id: 1 }, { unique: true });
            await couponsCollection.createIndex({ createdAt: -1 });

            const redemptionsCollection = database.collection(CouponQueryEngine.#REDEMPTIONS_COLLECTION);
            await redemptionsCollection.createIndex({ couponId: 1, userId: 1 }, { unique: true });
            await redemptionsCollection.createIndex({ couponId: 1, redeemedAt: -1 });
            await redemptionsCollection.createIndex({ userId: 1, redeemedAt: -1 });

            CouponQueryEngine.#indexesEnsured = true;
        }
        catch (indexError)
        {
            console.error("[CouponQueryEngine] Failed to ensure indexes:", indexError);
        }
    }

    /**
     * Inserts a fully-built Coupon. Returns { success, coupon } or
     * { success:false, reason }. A duplicate normalized code yields
     * COUPON_ALREADY_EXISTS via the unique index.
     * @param {Coupon} coupon
     */
    static async createCoupon(coupon)
    {
        const collection = await CouponQueryEngine.#getCouponsCollection();
        if (!collection)
        {
            return { success: false, reason: ErrorCodes.DATABASE_UNAVAILABLE };
        }
        if (coupon.getCodeString().length === 0)
        {
            return { success: false, reason: ErrorCodes.INVALID_CODE };
        }

        try
        {
            await collection.insertOne(coupon.toJson());
            return { success: true, coupon: coupon };
        }
        catch (insertError)
        {
            if (insertError && insertError.code === CouponQueryEngine.#DUPLICATE_KEY_ERROR_CODE)
            {
                return { success: false, reason: ErrorCodes.COUPON_ALREADY_EXISTS };
            }
            throw insertError;
        }
    }

    /**
     * Creates many codes from a base string (base "SALE", count 3 → SALE1,
     * SALE2, SALE3), each sharing the same benefit template. Collisions are
     * skipped and reported. Returns { success, created:[], skipped:[] }.
     * @param {{baseString: string, count: number, template: object}} options
     */
    static async createCouponsBulk({ baseString, count, template } = {})
    {
        const collection = await CouponQueryEngine.#getCouponsCollection();
        if (!collection)
        {
            return { success: false, reason: ErrorCodes.DATABASE_UNAVAILABLE };
        }

        const normalizedBase = Coupon.normalizeCodeString(baseString);
        if (normalizedBase.length === 0)
        {
            return { success: false, reason: ErrorCodes.INVALID_CODE };
        }

        const totalToCreate = parseInt(count, 10);
        if (isNaN(totalToCreate) || totalToCreate < 1 || totalToCreate > CouponQueryEngine.MAX_BULK_CREATE_COUNT)
        {
            return { success: false, reason: ErrorCodes.INVALID_COUNT };
        }

        const candidateCoupons = [];
        for (let sequenceNumber = 1; sequenceNumber <= totalToCreate; sequenceNumber++)
        {
            candidateCoupons.push(new Coupon({ ...template, codeString: `${normalizedBase}${sequenceNumber}` }));
        }

        const candidateCodeStrings = candidateCoupons.map(coupon => coupon.getCodeString());

        const existingDocuments = await collection.find
        (
            { codeString: { $in: candidateCodeStrings } },
            { projection: { codeString: 1, _id: 0 } }
        ).toArray();
        const existingCodeStrings = new Set(existingDocuments.map(document => document.codeString));

        const skipped = [];
        const documentsToInsert = [];
        for (const coupon of candidateCoupons)
        {
            if (existingCodeStrings.has(coupon.getCodeString()))
            {
                skipped.push(coupon.getCodeString());
            }
            else
            {
                documentsToInsert.push(coupon.toJson());
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
                if (!insertError || insertError.code !== CouponQueryEngine.#DUPLICATE_KEY_ERROR_CODE)
                {
                    throw insertError;
                }
            }
        }

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
        const collection = await CouponQueryEngine.#getCouponsCollection();
        if (!collection)
        {
            return null;
        }
        const document = await collection.findOne({ codeString: Coupon.normalizeCodeString(codeString) }, { projection: { _id: 0 } });
        return document ? Coupon.fromJson(document) : null;
    }

    static async getById(couponId)
    {
        const collection = await CouponQueryEngine.#getCouponsCollection();
        if (!collection || typeof couponId !== "string" || couponId.length === 0)
        {
            return null;
        }
        const document = await collection.findOne({ id: couponId }, { projection: { _id: 0 } });
        return document ? Coupon.fromJson(document) : null;
    }

    /**
     * Atomically reserves one redemption slot: increments usedCount only while
     * enabled and usedCount < maxRedemptions. Returns the updated Coupon, or
     * null when disabled / exhausted / missing. The cap gate — never bypass.
     */
    static async claimRedemptionSlot(couponId)
    {
        const collection = await CouponQueryEngine.#getCouponsCollection();
        if (!collection || typeof couponId !== "string" || couponId.length === 0)
        {
            return null;
        }

        const updateResult = await collection.findOneAndUpdate
        (
            { id: couponId, enabled: true, $expr: { $lt: ["$usedCount", "$maxRedemptions"] } },
            { $inc: { usedCount: 1 } },
            { returnDocument: "after", projection: { _id: 0 } }
        );

        const updatedDocument = updateResult?.value || updateResult;
        return updatedDocument ? Coupon.fromJson(updatedDocument) : null;
    }

    static async releaseRedemptionSlot(couponId)
    {
        const collection = await CouponQueryEngine.#getCouponsCollection();
        if (!collection || typeof couponId !== "string" || couponId.length === 0)
        {
            return;
        }
        await collection.updateOne({ id: couponId, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } });
    }

    static async findRedemption(couponId, userId)
    {
        const collection = await CouponQueryEngine.#getRedemptionsCollection();
        if (!collection)
        {
            return null;
        }
        const document = await collection.findOne({ couponId: couponId, userId: userId }, { projection: { _id: 0 } });
        return document ? CouponRedemption.fromJson(document) : null;
    }

    /**
     * Inserts a redemption row. Returns { inserted:true } or { inserted:false,
     * alreadyRedeemed:true } when the unique (couponId, userId) index rejects a
     * concurrent second redemption by the same user.
     * @param {CouponRedemption} couponRedemption
     */
    static async insertRedemption(couponRedemption)
    {
        const collection = await CouponQueryEngine.#getRedemptionsCollection();
        if (!collection)
        {
            return { inserted: false, alreadyRedeemed: false, reason: ErrorCodes.DATABASE_UNAVAILABLE };
        }
        try
        {
            await collection.insertOne(couponRedemption.toJson());
            return { inserted: true };
        }
        catch (insertError)
        {
            if (insertError && insertError.code === CouponQueryEngine.#DUPLICATE_KEY_ERROR_CODE)
            {
                return { inserted: false, alreadyRedeemed: true };
            }
            throw insertError;
        }
    }

    static async deleteRedemption(couponId, userId)
    {
        const collection = await CouponQueryEngine.#getRedemptionsCollection();
        if (!collection)
        {
            return;
        }
        await collection.deleteOne({ couponId: couponId, userId: userId });
    }

    /**
     * Backfills grant-result fields onto an already-inserted redemption row —
     * used for details known only after the grant (e.g. the deck license id).
     * @param {string} couponId
     * @param {string} userId
     * @param {{grantedCredits?: number, grantedPlanTier?: number, grantedDeckLicenseId?: string|null, benefitExpiresAt?: number|null, grantedSummary?: string}} patch
     */
    static async updateRedemptionGrantResult(couponId, userId, patch)
    {
        const collection = await CouponQueryEngine.#getRedemptionsCollection();
        if (!collection)
        {
            return;
        }
        const setFields = {};
        if (patch.grantedCredits !== undefined) { setFields.grantedCredits = patch.grantedCredits; }
        if (patch.grantedPlanTier !== undefined) { setFields.grantedPlanTier = patch.grantedPlanTier; }
        if (patch.grantedDeckLicenseId !== undefined) { setFields.grantedDeckLicenseId = patch.grantedDeckLicenseId; }
        if (patch.benefitExpiresAt !== undefined) { setFields.benefitExpiresAt = patch.benefitExpiresAt; }
        if (patch.grantedSummary !== undefined) { setFields.grantedSummary = patch.grantedSummary; }
        if (Object.keys(setFields).length === 0)
        {
            return;
        }
        await collection.updateOne({ couponId: couponId, userId: userId }, { $set: setFields });
    }

    static async setEnabled(couponId, enabled)
    {
        const collection = await CouponQueryEngine.#getCouponsCollection();
        if (!collection || typeof couponId !== "string" || couponId.length === 0)
        {
            return { success: false, reason: ErrorCodes.DATABASE_UNAVAILABLE };
        }
        const updateResult = await collection.updateOne({ id: couponId }, { $set: { enabled: Boolean(enabled) } });
        if ((updateResult.matchedCount || 0) === 0)
        {
            return { success: false, reason: ErrorCodes.COUPON_NOT_FOUND };
        }
        return { success: true };
    }

    /**
     * Deletes a coupon and all its redemption rows. Benefits already granted to
     * past redeemers are intentionally NOT clawed back — deletion only retires
     * the code and clears the audit rows.
     */
    static async deleteCoupon(couponId)
    {
        const couponsCollection = await CouponQueryEngine.#getCouponsCollection();
        const redemptionsCollection = await CouponQueryEngine.#getRedemptionsCollection();
        if (!couponsCollection || !redemptionsCollection || typeof couponId !== "string" || couponId.length === 0)
        {
            return { success: false, reason: ErrorCodes.DATABASE_UNAVAILABLE };
        }
        const deleteResult = await couponsCollection.deleteOne({ id: couponId });
        if ((deleteResult.deletedCount || 0) === 0)
        {
            return { success: false, reason: ErrorCodes.COUPON_NOT_FOUND };
        }
        await redemptionsCollection.deleteMany({ couponId: couponId });
        return { success: true };
    }
}

module.exports = CouponQueryEngine;
