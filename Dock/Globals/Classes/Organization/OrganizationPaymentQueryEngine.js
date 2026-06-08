const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const OrganizationPayment = require("../../Model/OrganizationPayment");
const { organizationPaymentStatuses } = require("../../Enumerations/OrganizationPaymentStatuses");


/**
 * OrganizationPaymentQueryEngine
 *
 * Audit log of Razorpay charges tied to an org — creation fees and
 * member-cap expansions. Idempotency relies on the unique
 * providerOrderId index, which the Razorpay webhook uses to recognise
 * duplicate deliveries.
 */
class OrganizationPaymentQueryEngine
{
    static #COLLECTION_NAME = DatabaseConstants.ORGANIZATION_PAYMENTS_COLLECTION;

    static async #getCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return null;
        }
        return database.collection(OrganizationPaymentQueryEngine.#COLLECTION_NAME);
    }

    static async createPayment(payment)
    {
        const collection = await OrganizationPaymentQueryEngine.#getCollection();
        if (!collection)
        {
            throw new Error("Database unavailable");
        }

        // Constructor auto-generates UUID id.
        await collection.insertOne(payment.toJson());
        return payment;
    }

    static async findByOrderId(providerOrderId)
    {
        const collection = await OrganizationPaymentQueryEngine.#getCollection();
        if (!collection || typeof providerOrderId !== "string" || providerOrderId.length === 0)
        {
            return null;
        }
        const document = await collection.findOne({ providerOrderId: providerOrderId });
        return document ? OrganizationPayment.fromJson(document) : null;
    }

    static async listForOrganization(organizationId)
    {
        const collection = await OrganizationPaymentQueryEngine.#getCollection();
        if (!collection)
        {
            return [];
        }
        const documents = await collection
            .find({ organizationId: organizationId }, { projection: { _id: 0 } })
            .sort({ createdAt: -1 })
            .toArray();
        return documents.map(document => OrganizationPayment.fromJson(document));
    }

    /**
     * Atomic CAS: only the FIRST caller to observe status != CAPTURED
     * transitions the row; concurrent callers (webhook + client-verify
     * race) see transitioned=false. Idempotent. The findOneAndUpdate
     * filter `{ providerOrderId, status: { $ne: CAPTURED } }` is the
     * race guard — two simultaneous calls can both find the row but
     * only one matches the filter once the first call's $set lands.
     */
    static async markCaptured(providerOrderId, providerPaymentId)
    {
        const collection = await OrganizationPaymentQueryEngine.#getCollection();
        if (!collection)
        {
            return { transitioned: false, previousStatus: null };
        }

        const captureResult = await collection.findOneAndUpdate
        (
            { providerOrderId: providerOrderId, status: { $ne: organizationPaymentStatuses.CAPTURED } },
            {
                $set:
                {
                    status: organizationPaymentStatuses.CAPTURED,
                    providerPaymentId: typeof providerPaymentId === "string" ? providerPaymentId : "",
                    capturedAt: new Date()
                }
            },
            { returnDocument: "before" }
        );

        // Driver 6+ returns the document directly (or null); older
        // drivers wrap it as { value: doc | null }. Normalise.
        const previousDocument = captureResult && captureResult.value !== undefined ? captureResult.value : captureResult;

        if (!previousDocument)
        {
            // Either the row doesn't exist OR another caller already
            // captured it. The two cases differ only for diagnostics —
            // both should ack 200 from the webhook standpoint.
            const existing = await collection.findOne({ providerOrderId: providerOrderId });
            return {
                transitioned: false,
                previousStatus: existing ? existing.status : null,
                payment: existing ? OrganizationPayment.fromJson(existing) : null
            };
        }

        const updated = await collection.findOne({ providerOrderId: providerOrderId });
        return { transitioned: true, previousStatus: previousDocument.status, payment: OrganizationPayment.fromJson(updated) };
    }

    static async markFailed(providerOrderId)
    {
        const collection = await OrganizationPaymentQueryEngine.#getCollection();
        if (!collection)
        {
            return;
        }
        await collection.updateOne
        (
            { providerOrderId: providerOrderId },
            { $set: { status: organizationPaymentStatuses.FAILED } }
        );
    }
}

module.exports = OrganizationPaymentQueryEngine;
