const crypto = require("crypto");
const DatabaseConnector = require("./DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const IntellectualPropertyComplaintConstants = require("../../Constants/IntellectualPropertyComplaintConstants");
const IntellectualPropertyComplaint = require("../../Model/IntellectualPropertyComplaint");
const { intellectualPropertyComplaintStatus } = require("../../Enumerations/IntellectualPropertyComplaintStatus");

/**
 * IntellectualPropertyComplaintQueryEngine — the durable record of every
 * infringement complaint the platform has received, and of what was done about
 * each one.
 *
 * Insert-and-append only. Status is added as events; the complaint's own text,
 * its complainant and its receipt time are written once and never rewritten.
 * There is no update method for the body and no delete method at all, and none
 * should be added. This posture is copied deliberately from
 * SourceLicenceDeclarationQueryEngine, for the same reason: the collection's
 * entire value is that it can be produced later to answer "what were we told,
 * when were we told it, and what did we do" — and a record that could be
 * revised afterwards answers none of those, it only appears to.
 *
 * WHY THERE IS NO TTL. Every other event-ish collection in DatabaseConstants
 * carries a retention window. This one deliberately does not, and
 * DatabaseConnector must never grow one for it. A complaint register that
 * expires is a register you cannot produce on the day someone asks about it,
 * which is the only day it matters — and the day it is asked for is often years
 * after the fact, in a dispute about content that was removed long ago.
 *
 * The same reasoning covers the evidence a complainant attaches: it is excluded
 * from EphemeralUploadRegistry, so resolving a complaint does not delete the
 * proof the complaint rested on.
 */
class IntellectualPropertyComplaintQueryEngine
{
    static async #getCollection()
    {
        const database = await DatabaseConnector.getDatabase();

        if (!database)
        {
            return null;
        }

        return database.collection(DatabaseConstants.INTELLECTUAL_PROPERTY_COMPLAINTS_COLLECTION);
    }

    /**
     * Stores a newly received complaint, with its first status event already in
     * place.
     *
     * The RECEIVED event is written here rather than by the caller so no
     * complaint can ever exist with an empty history — the derived
     * "current status" would otherwise be a guess for exactly the records that
     * failed part-way through being filed.
     *
     * @param {IntellectualPropertyComplaint} complaint
     * @returns {Promise<{saved: boolean}>}
     */
    static async insert(complaint)
    {
        const collection = await IntellectualPropertyComplaintQueryEngine.#getCollection();

        if (!collection)
        {
            return { saved: false };
        }

        if (complaint.getStatusEvents().length === 0)
        {
            complaint.setStatusEvents
            ([
                {
                    status: intellectualPropertyComplaintStatus.RECEIVED,
                    note: complaint.getRateLimitFlagged()
                        ? "Received. Flagged: the submitting source was over the rate limit."
                        : "Received through the public complaint channel.",
                    actorUserId: "",
                    actorEmail: "",
                    occurredAt: complaint.getReceivedAt()
                }
            ]);
        }

        try
        {
            await collection.insertOne(complaint.toJson());
            return { saved: true };
        }
        catch (insertError)
        {
            console.error(`[IntellectualPropertyComplaintQueryEngine] Could not store complaint ${complaint.getReference()}: ${insertError?.message || insertError}`);
            return { saved: false };
        }
    }

    /**
     * @param {string} complaintId
     * @returns {Promise<IntellectualPropertyComplaint|null>}
     */
    static async findById(complaintId)
    {
        if (typeof complaintId !== "string" || complaintId.length === 0)
        {
            return null;
        }

        const collection = await IntellectualPropertyComplaintQueryEngine.#getCollection();

        if (!collection)
        {
            return null;
        }

        const complaintDocument = await collection.findOne({ id: complaintId }, { projection: { _id: 0 } });
        return complaintDocument ? IntellectualPropertyComplaint.fromJson(complaintDocument) : null;
    }

    /**
     * The newest unverified complaint filed from one address.
     *
     * This is what the confirmation step resolves against: the complainant has
     * a code in their inbox and an email address, and nothing else — they were
     * never given an id to send back, and asking them for one would put a
     * secret in a URL that lands in a mail client. Newest-first because a
     * correspondent who filed twice is confirming the one they just submitted.
     *
     * @param {string} contactEmail
     * @returns {Promise<IntellectualPropertyComplaint|null>}
     */
    static async findLatestUnverifiedByContactEmail(contactEmail)
    {
        const normalisedEmail = String(contactEmail ?? "").trim().toLowerCase();

        if (normalisedEmail.length === 0)
        {
            return null;
        }

        const collection = await IntellectualPropertyComplaintQueryEngine.#getCollection();

        if (!collection)
        {
            return null;
        }

        const complaintDocument = await collection
            .find({ contactEmail: normalisedEmail, bContactVerified: false }, { projection: { _id: 0 } })
            .sort({ receivedAt: -1 })
            .limit(1)
            .next();

        return complaintDocument ? IntellectualPropertyComplaint.fromJson(complaintDocument) : null;
    }

    /**
     * Appends one status event. The complaint body is untouched.
     *
     * @param {string} complaintId
     * @param {{status: number, note: string, actorUserId: string, actorEmail: string}} statusEvent
     * @returns {Promise<boolean>}
     */
    static async appendStatusEvent(complaintId, statusEvent)
    {
        const collection = await IntellectualPropertyComplaintQueryEngine.#getCollection();

        if (!collection)
        {
            return false;
        }

        const eventToAppend =
        {
            status: Number(statusEvent?.status) || intellectualPropertyComplaintStatus.UNDER_REVIEW,
            note: String(statusEvent?.note ?? "").slice(0, IntellectualPropertyComplaintConstants.STATUS_NOTE_MAXIMUM_LENGTH),
            actorUserId: String(statusEvent?.actorUserId ?? ""),
            actorEmail: String(statusEvent?.actorEmail ?? ""),
            occurredAt: Date.now()
        };

        const updateResult = await collection.updateOne
        (
            { id: complaintId },
            { $push: { statusEvents: eventToAppend } }
        );

        return updateResult.matchedCount === 1;
    }

    /**
     * Marks the contact address confirmed, appends the event that says so, and
     * mints the short-lived credential the complainant uses to attach evidence.
     *
     * Guarded on `bContactVerified: false` so a replayed confirmation cannot
     * stamp a second verification time onto a complaint that was already
     * confirmed, which would make the record read as though the complainant had
     * been asked to prove themselves twice.
     *
     * The plaintext token is returned to the caller and never stored. Losing it
     * costs the complainant the ability to attach files for this window — an
     * inconvenience — where storing it would cost everyone the assurance that
     * only the confirmed party can attach them.
     *
     * @param {string} complaintId
     * @returns {Promise<{verified: boolean, evidenceUploadToken: string, evidenceUploadTokenExpiresAt: number|null}>}
     */
    static async markContactVerified(complaintId)
    {
        const collection = await IntellectualPropertyComplaintQueryEngine.#getCollection();

        if (!collection)
        {
            return { verified: false, evidenceUploadToken: "", evidenceUploadTokenExpiresAt: null };
        }

        const verifiedAt = Date.now();
        const evidenceUploadToken = crypto.randomBytes(32).toString("hex");
        const evidenceUploadTokenHash = crypto.createHash("sha256").update(evidenceUploadToken).digest("hex");
        const evidenceUploadTokenExpiresAt = verifiedAt + IntellectualPropertyComplaintConstants.EVIDENCE_UPLOAD_TOKEN_MINUTES * 60 * 1000;

        const updateResult = await collection.updateOne
        (
            { id: complaintId, bContactVerified: false },
            {
                $set:
                {
                    bContactVerified: true,
                    contactVerifiedAt: verifiedAt,
                    evidenceUploadTokenHash: evidenceUploadTokenHash,
                    evidenceUploadTokenExpiresAt: evidenceUploadTokenExpiresAt
                },
                $push:
                {
                    statusEvents:
                    {
                        status: intellectualPropertyComplaintStatus.CONTACT_VERIFIED,
                        note: "The complainant confirmed their contact address with a one-time code.",
                        actorUserId: "",
                        actorEmail: "",
                        occurredAt: verifiedAt
                    }
                }
            }
        );

        if (updateResult.modifiedCount !== 1)
        {
            return { verified: false, evidenceUploadToken: "", evidenceUploadTokenExpiresAt: null };
        }

        return {
            verified: true,
            evidenceUploadToken: evidenceUploadToken,
            evidenceUploadTokenExpiresAt: evidenceUploadTokenExpiresAt
        };
    }

    /**
     * Resolves a complaint from the credential minted at confirmation time.
     *
     * Compared as a hash, in constant time, against an unexpired token — the
     * same discipline any other bearer credential gets. Returns null on every
     * failure without saying which one, because a caller probing this endpoint
     * learns nothing from "wrong token" that they should not have to guess.
     *
     * @param {string} complaintId
     * @param {string} evidenceUploadToken
     * @returns {Promise<IntellectualPropertyComplaint|null>}
     */
    static async findByEvidenceUploadToken(complaintId, evidenceUploadToken)
    {
        if (typeof evidenceUploadToken !== "string" || evidenceUploadToken.length === 0)
        {
            return null;
        }

        const complaint = await IntellectualPropertyComplaintQueryEngine.findById(complaintId);

        if (!complaint || !complaint.getContactVerified())
        {
            return null;
        }

        const storedHash = complaint.getEvidenceUploadTokenHash();
        const expiresAt = complaint.getEvidenceUploadTokenExpiresAt();

        if (storedHash.length === 0 || expiresAt === null || expiresAt <= Date.now())
        {
            return null;
        }

        const submittedHash = crypto.createHash("sha256").update(evidenceUploadToken).digest("hex");
        const submittedBuffer = Buffer.from(submittedHash, "hex");
        const storedBuffer = Buffer.from(storedHash, "hex");

        if (submittedBuffer.length !== storedBuffer.length || !crypto.timingSafeEqual(submittedBuffer, storedBuffer))
        {
            return null;
        }

        return complaint;
    }

    /**
     * Records that the automatic acknowledgment was delivered.
     *
     * Separate from the RECEIVED event because "we stored it" and "we wrote to
     * them" are different promises with different deadlines, and only the second
     * one is the twenty-four-hour commitment in Clause 19.2.
     *
     * @param {string} complaintId
     * @returns {Promise<boolean>}
     */
    static async markAcknowledged(complaintId)
    {
        const collection = await IntellectualPropertyComplaintQueryEngine.#getCollection();

        if (!collection)
        {
            return false;
        }

        const updateResult = await collection.updateOne
        (
            { id: complaintId, acknowledgedAt: null },
            { $set: { acknowledgedAt: Date.now() } }
        );

        return updateResult.modifiedCount === 1;
    }

    /**
     * Attaches the evidence files, once the contact address has been confirmed.
     *
     * Guarded on `bContactVerified: true` in the query rather than checked by
     * the caller, so an unconfirmed submission cannot get bytes onto the
     * platform by racing the confirmation step.
     *
     * @param {string} complaintId
     * @param {Array<object>} attachments
     * @returns {Promise<boolean>}
     */
    static async attachEvidence(complaintId, attachments)
    {
        const collection = await IntellectualPropertyComplaintQueryEngine.#getCollection();

        if (!collection)
        {
            return false;
        }

        const updateResult = await collection.updateOne
        (
            { id: complaintId, bContactVerified: true },
            { $push: { attachments: { $each: Array.isArray(attachments) ? attachments : [] } } }
        );

        return updateResult.modifiedCount === 1;
    }

    /**
     * Records the content hashes an administrator resolved the complaint to.
     *
     * $addToSet, not $set: resolving a complaint is iterative — an admin finds
     * two documents today and a third next week — and replacing the array would
     * quietly drop the earlier findings that a takedown may already have been
     * actioned against.
     *
     * @param {string} complaintId
     * @param {string[]} contentHashes
     * @returns {Promise<boolean>}
     */
    static async addResolvedContentHashes(complaintId, contentHashes)
    {
        const collection = await IntellectualPropertyComplaintQueryEngine.#getCollection();

        if (!collection)
        {
            return false;
        }

        const cleanedHashes = (Array.isArray(contentHashes) ? contentHashes : [])
            .map(contentHash => String(contentHash ?? ""))
            .filter(contentHash => contentHash.length > 0);

        if (cleanedHashes.length === 0)
        {
            return false;
        }

        const updateResult = await collection.updateOne
        (
            { id: complaintId },
            { $addToSet: { resolvedContentHashes: { $each: cleanedHashes } } }
        );

        return updateResult.matchedCount === 1;
    }

    /**
     * The admin queue: complaints ordered by how soon they are due.
     *
     * `bIncludeUnverified` defaults to false so the working queue holds only
     * complaints someone has proved they can be written back to. The unverified
     * ones are not discarded and not hidden — an administrator can ask for them
     * — but they do not sit in the list that is worked top-down, because an
     * unconfirmed complaint is not yet actionable and would otherwise push a
     * real one down the page.
     *
     * @param {{bIncludeUnverified?: boolean, bOnlyOpen?: boolean, limit?: number, offset?: number}} options
     * @returns {Promise<{complaints: IntellectualPropertyComplaint[], totalCount: number}>}
     */
    static async listByDeadline({ bIncludeUnverified = false, bOnlyOpen = true, limit = 100, offset = 0 } = {})
    {
        const collection = await IntellectualPropertyComplaintQueryEngine.#getCollection();

        if (!collection)
        {
            return { complaints: [], totalCount: 0 };
        }

        const filter = {};

        if (!bIncludeUnverified)
        {
            filter.bContactVerified = true;
        }

        if (bOnlyOpen)
        {
            // "Open" is the absence of a terminal event rather than a stored
            // flag, so it stays true to the appended history: a complaint is
            // closed exactly when its last event says it is.
            filter.statusEvents = {
                $not:
                {
                    $elemMatch:
                    {
                        status: { $in: [intellectualPropertyComplaintStatus.ACTIONED, intellectualPropertyComplaintStatus.REJECTED, intellectualPropertyComplaintStatus.WITHDRAWN] }
                    }
                }
            };
        }

        const totalCount = await collection.countDocuments(filter);

        // Sorted by receipt, oldest first — which is the deadline order, because
        // every deadline is a fixed offset from receipt. Sorting on a stored
        // deadline field would be the same order with one more thing to keep in
        // step, which is why the model derives them instead.
        const complaintDocuments = await collection
            .find(filter, { projection: { _id: 0 } })
            .sort({ receivedAt: 1 })
            .skip(Math.max(0, Number(offset) || 0))
            .limit(Math.min(Math.max(Number(limit) || 100, 1), 500))
            .toArray();

        return {
            complaints: complaintDocuments.map(complaintDocument => IntellectualPropertyComplaint.fromJson(complaintDocument)),
            totalCount: totalCount
        };
    }

    /**
     * Complaints that are past a deadline and still open — what the sweeper
     * reads.
     *
     * @param {number} nowMilliseconds
     * @param {number} maximumRecords
     * @returns {Promise<IntellectualPropertyComplaint[]>}
     */
    static async findOpenReceivedBefore(nowMilliseconds, maximumRecords)
    {
        const collection = await IntellectualPropertyComplaintQueryEngine.#getCollection();

        if (!collection)
        {
            return [];
        }

        const complaintDocuments = await collection
            .find
            (
                {
                    receivedAt: { $lte: Number(nowMilliseconds) || Date.now() },
                    statusEvents:
                    {
                        $not:
                        {
                            $elemMatch:
                            {
                                status: { $in: [intellectualPropertyComplaintStatus.ACTIONED, intellectualPropertyComplaintStatus.REJECTED, intellectualPropertyComplaintStatus.WITHDRAWN] }
                            }
                        }
                    }
                },
                { projection: { _id: 0 } }
            )
            .sort({ receivedAt: 1 })
            .limit(Math.max(1, Number(maximumRecords) || 200))
            .toArray();

        return complaintDocuments.map(complaintDocument => IntellectualPropertyComplaint.fromJson(complaintDocument));
    }

    /**
     * How many complaints one address has filed since a given instant. Feeds the
     * rate-limit decision, which flags rather than refuses.
     *
     * @param {string} contactEmail
     * @param {number} sinceMilliseconds
     * @returns {Promise<number>}
     */
    static async countByContactEmailSince(contactEmail, sinceMilliseconds)
    {
        const collection = await IntellectualPropertyComplaintQueryEngine.#getCollection();
        const normalisedEmail = String(contactEmail ?? "").trim().toLowerCase();

        if (!collection || normalisedEmail.length === 0)
        {
            return 0;
        }

        return await collection.countDocuments({ contactEmail: normalisedEmail, receivedAt: { $gte: Number(sinceMilliseconds) || 0 } });
    }

    /**
     * The same count keyed on the submitting network address, so a complainant
     * who changes the email on every submission is still visible as one source.
     *
     * @param {string} sourceIpAddress
     * @param {number} sinceMilliseconds
     * @returns {Promise<number>}
     */
    static async countBySourceIpAddressSince(sourceIpAddress, sinceMilliseconds)
    {
        const collection = await IntellectualPropertyComplaintQueryEngine.#getCollection();
        const normalisedAddress = String(sourceIpAddress ?? "").trim();

        if (!collection || normalisedAddress.length === 0)
        {
            return 0;
        }

        return await collection.countDocuments({ sourceIpAddress: normalisedAddress, receivedAt: { $gte: Number(sinceMilliseconds) || 0 } });
    }
}

module.exports = IntellectualPropertyComplaintQueryEngine;
