const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const CreditDealPayment = require("../../Model/CreditDealPayment");
const { creditDealPaymentStatuses } = require("../../Enumerations/CreditDealPaymentStatuses");


/**
 * CreditDealPaymentQueryEngine
 *
 * Source of truth for the `creditDealPayments` collection — the standalone,
 * NON-GATING money record an admin attaches to a deal (a periodic assignment
 * or a one-time fixed grant). A deal can be paid on the spot via Razorpay or
 * recorded as an independent (offline) payment; an invoice file (PDF / image)
 * can be attached at creation OR uploaded later.
 *
 * Idempotency of the Razorpay capture mirrors
 * [OrganizationPaymentQueryEngine.markCaptured]: the unique-ish (sparse)
 * providerOrderId index plus an atomic CAS means a webhook + client-verify
 * race captures the row exactly once.
 */
class CreditDealPaymentQueryEngine
{
    static #COLLECTION_NAME = DatabaseConstants.CREDIT_DEAL_PAYMENTS_COLLECTION;

    static async #getCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return null;
        }
        return database.collection(CreditDealPaymentQueryEngine.#COLLECTION_NAME);
    }

    /**
     * @param {CreditDealPayment} deal
     * @returns {Promise<CreditDealPayment>}
     */
    static async createDeal(deal)
    {
        const collection = await CreditDealPaymentQueryEngine.#getCollection();
        if (!collection)
        {
            throw new Error("Database unavailable");
        }
        await collection.insertOne(deal.toJson());
        return deal;
    }

    static async getById(dealId)
    {
        if (typeof dealId !== "string" || dealId.length === 0)
        {
            return null;
        }
        const collection = await CreditDealPaymentQueryEngine.#getCollection();
        if (!collection)
        {
            return null;
        }
        const document = await collection.findOne({ id: dealId });
        return document ? CreditDealPayment.fromJson(document) : null;
    }

    static async findByOrderId(providerOrderId)
    {
        const collection = await CreditDealPaymentQueryEngine.#getCollection();
        if (!collection || typeof providerOrderId !== "string" || providerOrderId.length === 0)
        {
            return null;
        }
        const document = await collection.findOne({ providerOrderId: providerOrderId });
        return document ? CreditDealPayment.fromJson(document) : null;
    }

    /**
     * Every deal attached to a target, newest first. The report and the admin
     * list both call this.
     * @param {number} targetType — CreditDealTargetTypes value
     * @param {string} targetId
     * @returns {Promise<Array<CreditDealPayment>>}
     */
    static async listForTarget(targetType, targetId)
    {
        const collection = await CreditDealPaymentQueryEngine.#getCollection();
        if (!collection || typeof targetId !== "string" || targetId.length === 0)
        {
            return [];
        }
        const documents = await collection
            .find({ targetType: targetType, targetId: targetId }, { projection: { _id: 0 } })
            .sort({ createdAt: -1 })
            .toArray();
        return documents.map(document => CreditDealPayment.fromJson(document));
    }

    /**
     * Atomic CAS capture for an on-spot Razorpay deal — only the first caller
     * to observe status != CAPTURED transitions it. Idempotent across a
     * webhook + client-verify race.
     * @param {string} providerOrderId
     * @param {string} providerPaymentId
     * @returns {Promise<{ transitioned: boolean, deal: CreditDealPayment|null }>}
     */
    static async markCaptured(providerOrderId, providerPaymentId)
    {
        const collection = await CreditDealPaymentQueryEngine.#getCollection();
        if (!collection || typeof providerOrderId !== "string" || providerOrderId.length === 0)
        {
            return { transitioned: false, deal: null };
        }

        // Only a PENDING on-spot deal is eligible to capture — this is the
        // single legitimate pre-capture state, and the only kind that carries
        // a providerOrderId. A duplicate webhook / verify race finds the row
        // already CAPTURED, matches nothing, and reports transitioned=false.
        const captureResult = await collection.findOneAndUpdate
        (
            { providerOrderId: providerOrderId, status: creditDealPaymentStatuses.PENDING },
            {
                $set:
                {
                    status: creditDealPaymentStatuses.CAPTURED,
                    providerPaymentId: typeof providerPaymentId === "string" ? providerPaymentId : ""
                }
            },
            { returnDocument: "before" }
        );

        const previousDocument = captureResult && captureResult.value !== undefined ? captureResult.value : captureResult;

        if (!previousDocument)
        {
            const existing = await collection.findOne({ providerOrderId: providerOrderId });
            return { transitioned: false, deal: existing ? CreditDealPayment.fromJson(existing) : null };
        }

        const updated = await collection.findOne({ providerOrderId: providerOrderId });
        return { transitioned: true, deal: updated ? CreditDealPayment.fromJson(updated) : null };
    }

    /**
     * Attaches (or replaces) the stored invoice metadata for a deal — used by
     * the upload-later flow. The bytes live in the GCS bucket; this row only
     * carries the pointer + metadata.
     * @param {string} dealId
     * @param {{ fileName: string, mimeType: string, bucketPath: string, sizeBytes: number, now: Date }} invoice
     * @returns {Promise<boolean>} true if a row was updated
     */
    static async attachInvoice(dealId, invoice)
    {
        const collection = await CreditDealPaymentQueryEngine.#getCollection();
        if (!collection || typeof dealId !== "string" || dealId.length === 0)
        {
            return false;
        }

        const result = await collection.updateOne
        (
            { id: dealId },
            {
                $set:
                {
                    invoiceFileName: typeof invoice.fileName === "string" ? invoice.fileName : "",
                    invoiceMimeType: typeof invoice.mimeType === "string" ? invoice.mimeType : "",
                    invoiceBucketPath: typeof invoice.bucketPath === "string" ? invoice.bucketPath : "",
                    invoiceSizeBytes: Number.isFinite(invoice.sizeBytes) ? invoice.sizeBytes : 0,
                    invoiceUploadedAt: invoice.now instanceof Date ? invoice.now : new Date(),
                    hasInvoice: true
                }
            }
        );
        return result.matchedCount === 1;
    }
}

module.exports = CreditDealPaymentQueryEngine;
