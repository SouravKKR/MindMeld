const crypto = require("crypto");
const IntellectualPropertyComplaintConstants = require("../Constants/IntellectualPropertyComplaintConstants");
const { intellectualPropertyComplaintStatus } = require("../Enumerations/IntellectualPropertyComplaintStatus");

/**
 * One complaint that content on the platform infringes somebody's intellectual
 * property.
 *
 * This is NOT a support report and deliberately does not reuse that model. A
 * support report is a user telling us something is broken; this is a legal
 * notice from a correspondent who usually has no account, it carries the
 * particulars Clause 19.4 of the Terms asks for, and it starts a clock the
 * platform has committed to in writing.
 *
 * ── The three timestamps, and why receivedAt is the one that counts ─────────
 *
 * `receivedAt` is stamped when the complaint reaches the database, before the
 * contact address has been confirmed. Every deadline is computed from it. The
 * confirmation code is a check on who is writing, not a condition of the
 * complaint having been made — a rightsholder who files at 09:00 and confirms
 * at 17:00 was still heard at 09:00, and Clause 19.4 says so out loud. Anchoring
 * the clock on confirmation instead would hand us a way to make every complaint
 * look punctual by being slow to send an email.
 *
 * `acknowledgedAt` records that the automatic acknowledgment actually went out,
 * so a complaint that was received but never written to is visible rather than
 * assumed.
 *
 * ── Why the status history is appended and never overwritten ────────────────
 *
 * The value of this record is that it can be produced later to show what was
 * done and when. A single `status` field answers "where is it now" and destroys
 * "what happened", which is the half a rightsholder, a court or a regulator
 * actually asks for. So status is a sequence of events, each stamped and
 * attributed, and the current status is derived from the last of them.
 *
 * ── bContactVerified and bRateLimitFlagged ─────────────────────────────────
 *
 * Neither one refuses a complaint. `bContactVerified` gates whether it enters
 * the actionable admin queue; `bRateLimitFlagged` records that it arrived from
 * a source that is over the limit, so a human can weigh it. An over-limit
 * complaint is still stored and still acknowledged, because a rightsholder
 * filing about thirty works in an afternoon is doing something legitimate that
 * is indistinguishable, at the rate limiter, from abuse.
 */
class IntellectualPropertyComplaint
{
    #id;
    #reference;
    #complainantName;
    #contactEmail;
    #capacityStatement;
    #workDescription;
    #locationDescription;
    #deckId;
    #paidDeckId;
    #studyMaterialId;
    #resolvedContentHashes;
    #bGoodFaithStatement;
    #bAccuracyStatement;
    #bContactVerified;
    #bRateLimitFlagged;
    #sourceIpAddress;
    #attachments;
    #evidenceUploadTokenHash;
    #evidenceUploadTokenExpiresAt;
    #receivedAt;
    #acknowledgedAt;
    #contactVerifiedAt;
    #statusEvents;

    constructor
    ({
        id = null,
        reference = null,
        complainantName = "",
        contactEmail = "",
        capacityStatement = "",
        workDescription = "",
        locationDescription = "",
        deckId = "",
        paidDeckId = "",
        studyMaterialId = "",
        resolvedContentHashes = [],
        bGoodFaithStatement = false,
        bAccuracyStatement = false,
        bContactVerified = false,
        bRateLimitFlagged = false,
        sourceIpAddress = "",
        attachments = [],
        evidenceUploadTokenHash = "",
        evidenceUploadTokenExpiresAt = null,
        receivedAt = Date.now(),
        acknowledgedAt = null,
        contactVerifiedAt = null,
        statusEvents = []
    } = {})
    {
        this.setId(id);
        this.setReference(reference);
        this.setComplainantName(complainantName);
        this.setContactEmail(contactEmail);
        this.setCapacityStatement(capacityStatement);
        this.setWorkDescription(workDescription);
        this.setLocationDescription(locationDescription);
        this.setDeckId(deckId);
        this.setPaidDeckId(paidDeckId);
        this.setStudyMaterialId(studyMaterialId);
        this.setResolvedContentHashes(resolvedContentHashes);
        this.setGoodFaithStatement(bGoodFaithStatement);
        this.setAccuracyStatement(bAccuracyStatement);
        this.setContactVerified(bContactVerified);
        this.setRateLimitFlagged(bRateLimitFlagged);
        this.setSourceIpAddress(sourceIpAddress);
        this.setAttachments(attachments);
        this.setEvidenceUploadTokenHash(evidenceUploadTokenHash);
        this.setEvidenceUploadTokenExpiresAt(evidenceUploadTokenExpiresAt);
        this.setReceivedAt(receivedAt);
        this.setAcknowledgedAt(acknowledgedAt);
        this.setContactVerifiedAt(contactVerifiedAt);
        this.setStatusEvents(statusEvents);
    }

    getId()
    {
        return this.#id;
    }

    setId(value)
    {
        this.#id = (typeof value === "string" && value.length > 0) ? value : crypto.randomUUID();
    }

    /**
     * The short human-quotable handle for this complaint, e.g. "IP-3F9A2C41".
     *
     * It exists because a UUID is not something a rightsholder will retype into
     * an email, and the acknowledgment asks them to quote it. Derived from the
     * id so the two can never disagree.
     */
    getReference()
    {
        return this.#reference;
    }

    setReference(value)
    {
        if (typeof value === "string" && value.length > 0)
        {
            this.#reference = value;
            return;
        }

        this.#reference = `IP-${this.#id.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    }

    getComplainantName()
    {
        return this.#complainantName;
    }

    setComplainantName(value)
    {
        this.#complainantName = IntellectualPropertyComplaint.#clamp(value, IntellectualPropertyComplaintConstants.COMPLAINANT_NAME_MAXIMUM_LENGTH);
    }

    getContactEmail()
    {
        return this.#contactEmail;
    }

    setContactEmail(value)
    {
        // Lowercased on the way in, because every lookup — the rate limiter, the
        // confirmation, the admin's "everything from this complainant" query —
        // matches on it, and a stored mixed-case address would split one
        // correspondent's history in two.
        this.#contactEmail = IntellectualPropertyComplaint
            .#clamp(value, IntellectualPropertyComplaintConstants.CONTACT_EMAIL_MAXIMUM_LENGTH)
            .trim()
            .toLowerCase();
    }

    /**
     * Whether the complainant owns the right or acts for the owner, in their own
     * words. Free text rather than an enum on purpose: "I am the author",
     * "I am counsel for the publisher" and "I am the licensee for India" are all
     * different standings, and flattening them into a picklist would discard the
     * detail that decides whether the complaint can be acted on.
     */
    getCapacityStatement()
    {
        return this.#capacityStatement;
    }

    setCapacityStatement(value)
    {
        this.#capacityStatement = IntellectualPropertyComplaint.#clamp(value, IntellectualPropertyComplaintConstants.CAPACITY_STATEMENT_MAXIMUM_LENGTH);
    }

    getWorkDescription()
    {
        return this.#workDescription;
    }

    setWorkDescription(value)
    {
        this.#workDescription = IntellectualPropertyComplaint.#clamp(value, IntellectualPropertyComplaintConstants.WORK_DESCRIPTION_MAXIMUM_LENGTH);
    }

    getLocationDescription()
    {
        return this.#locationDescription;
    }

    setLocationDescription(value)
    {
        this.#locationDescription = IntellectualPropertyComplaint.#clamp(value, IntellectualPropertyComplaintConstants.LOCATION_DESCRIPTION_MAXIMUM_LENGTH);
    }

    getDeckId()
    {
        return this.#deckId;
    }

    setDeckId(value)
    {
        this.#deckId = IntellectualPropertyComplaint.#clamp(value, IntellectualPropertyComplaintConstants.ENTITY_REFERENCE_MAXIMUM_LENGTH);
    }

    getPaidDeckId()
    {
        return this.#paidDeckId;
    }

    setPaidDeckId(value)
    {
        this.#paidDeckId = IntellectualPropertyComplaint.#clamp(value, IntellectualPropertyComplaintConstants.ENTITY_REFERENCE_MAXIMUM_LENGTH);
    }

    getStudyMaterialId()
    {
        return this.#studyMaterialId;
    }

    setStudyMaterialId(value)
    {
        this.#studyMaterialId = IntellectualPropertyComplaint.#clamp(value, IntellectualPropertyComplaintConstants.ENTITY_REFERENCE_MAXIMUM_LENGTH);
    }

    /**
     * The sha512 content hashes an administrator resolved this complaint down to.
     *
     * Written by the admin console, never by the complainant — a rightsholder
     * cannot compute a content hash and should not be asked to. This is the
     * bridge to the takedown endpoint, which takes nothing else.
     */
    getResolvedContentHashes()
    {
        return this.#resolvedContentHashes;
    }

    setResolvedContentHashes(value)
    {
        const rawHashes = Array.isArray(value) ? value : [];
        this.#resolvedContentHashes = [...new Set(rawHashes.map(contentHash => String(contentHash ?? "")).filter(contentHash => contentHash.length > 0))];
    }

    getGoodFaithStatement()
    {
        return this.#bGoodFaithStatement;
    }

    setGoodFaithStatement(value)
    {
        this.#bGoodFaithStatement = IntellectualPropertyComplaint.#toBoolean(value);
    }

    getAccuracyStatement()
    {
        return this.#bAccuracyStatement;
    }

    setAccuracyStatement(value)
    {
        this.#bAccuracyStatement = IntellectualPropertyComplaint.#toBoolean(value);
    }

    getContactVerified()
    {
        return this.#bContactVerified;
    }

    setContactVerified(value)
    {
        this.#bContactVerified = IntellectualPropertyComplaint.#toBoolean(value);
    }

    getRateLimitFlagged()
    {
        return this.#bRateLimitFlagged;
    }

    setRateLimitFlagged(value)
    {
        this.#bRateLimitFlagged = IntellectualPropertyComplaint.#toBoolean(value);
    }

    /**
     * The address the complaint was submitted from. Kept because Clause 19.7
     * reserves the right to decline repeat bad-faith complaints, and that
     * judgement needs something to key on besides an email a sender can change
     * at will. Never shown to anyone but an administrator.
     */
    getSourceIpAddress()
    {
        return this.#sourceIpAddress;
    }

    setSourceIpAddress(value)
    {
        this.#sourceIpAddress = IntellectualPropertyComplaint.#clamp(value, 64);
    }

    getAttachments()
    {
        return this.#attachments;
    }

    setAttachments(value)
    {
        const rawAttachments = Array.isArray(value) ? value : [];

        this.#attachments = rawAttachments.map(attachment =>
        ({
            fileName: String(attachment?.fileName ?? ""),
            storagePath: String(attachment?.storagePath ?? ""),
            mimeType: String(attachment?.mimeType ?? ""),
            sizeBytes: Number(attachment?.sizeBytes) || 0
        }));
    }

    /**
     * The SHA-256 of the one-shot credential handed back when the contact
     * address is confirmed, and the moment it stops working.
     *
     * The evidence-upload endpoint is unauthenticated — it has to be, because
     * the complainant has no account — so something has to stand in for a
     * session. The complaint id alone would be that something, but it is a
     * long-lived identifier that also appears in an administrator's console and
     * in correspondence, and anything that is both an identifier and a
     * credential eventually leaks in its identifier role. A separate, expiring
     * token that is only ever returned to whoever proved they can read the
     * complainant's inbox keeps the two jobs apart.
     *
     * Stored hashed for the same reason session material always is: a database
     * dump should not hand over the ability to attach files to other people's
     * complaints.
     */
    getEvidenceUploadTokenHash()
    {
        return this.#evidenceUploadTokenHash;
    }

    setEvidenceUploadTokenHash(value)
    {
        this.#evidenceUploadTokenHash = String(value ?? "");
    }

    getEvidenceUploadTokenExpiresAt()
    {
        return this.#evidenceUploadTokenExpiresAt;
    }

    setEvidenceUploadTokenExpiresAt(value)
    {
        this.#evidenceUploadTokenExpiresAt = (value === null || value === undefined) ? null : (Number(value) || null);
    }

    getReceivedAt()
    {
        return this.#receivedAt;
    }

    setReceivedAt(value)
    {
        this.#receivedAt = Number(value) || Date.now();
    }

    getAcknowledgedAt()
    {
        return this.#acknowledgedAt;
    }

    setAcknowledgedAt(value)
    {
        this.#acknowledgedAt = (value === null || value === undefined) ? null : (Number(value) || null);
    }

    getContactVerifiedAt()
    {
        return this.#contactVerifiedAt;
    }

    setContactVerifiedAt(value)
    {
        this.#contactVerifiedAt = (value === null || value === undefined) ? null : (Number(value) || null);
    }

    getStatusEvents()
    {
        return this.#statusEvents;
    }

    setStatusEvents(value)
    {
        const rawEvents = Array.isArray(value) ? value : [];

        this.#statusEvents = rawEvents.map(statusEvent =>
        ({
            status: Number(statusEvent?.status) || intellectualPropertyComplaintStatus.RECEIVED,
            note: IntellectualPropertyComplaint.#clamp(statusEvent?.note, IntellectualPropertyComplaintConstants.STATUS_NOTE_MAXIMUM_LENGTH),
            actorUserId: String(statusEvent?.actorUserId ?? ""),
            actorEmail: String(statusEvent?.actorEmail ?? ""),
            occurredAt: Number(statusEvent?.occurredAt) || 0
        }));
    }

    /**
     * The most recent status, or RECEIVED when the history is somehow empty.
     * Derived rather than stored — see the class comment.
     */
    getCurrentStatus()
    {
        if (this.#statusEvents.length === 0)
        {
            return intellectualPropertyComplaintStatus.RECEIVED;
        }

        return this.#statusEvents[this.#statusEvents.length - 1].status;
    }

    // ── The deadlines ──────────────────────────────────────────────────────
    //
    // Computed from receivedAt on every read rather than stored as fields. A
    // stored deadline is a second copy of a fact that can be edited out of step
    // with the fact it was derived from, and every one of these is a promise in
    // a published document — they should be re-derivable from the record alone.
    //
    // All of it is plain millisecond arithmetic on UTC instants. No calendar
    // maths, no local clock: 15 days is 15 × 24 hours from the moment of
    // receipt, which is both what the Terms say and the only reading that does
    // not shift with the reader's time zone or a daylight-saving boundary.

    getAcknowledgmentDeadline()
    {
        return this.#receivedAt + IntellectualPropertyComplaintConstants.ACKNOWLEDGMENT_HOURS * 60 * 60 * 1000;
    }

    getDisposalDeadline()
    {
        return this.#receivedAt + IntellectualPropertyComplaintConstants.DISPOSAL_DAYS * 24 * 60 * 60 * 1000;
    }

    getCourtOrderDeadline()
    {
        return this.#receivedAt + IntellectualPropertyComplaintConstants.COURT_ORDER_HOURS * 60 * 60 * 1000;
    }

    /**
     * When the Section 52(1)(c) block may lapse.
     *
     * Measured from RECEIPT of the complaint, not from the moment access was
     * disabled. Section 52(1)(c) of the Copyright Act read with Rule 75 of the
     * Copyright Rules gives the complainant twenty-one days from their complaint
     * to produce a court order — it is their window, and it starts when they
     * used it. Anchoring on the block instead would extend that window every
     * time the platform was slow to act, which is both wrong in law and a period
     * the platform could quietly lengthen at its own convenience. It is also
     * what Clause 19.5 of the Terms says out loud, and the record must not
     * compute a different date from the one that was published.
     *
     * Returns null until access has actually been disabled: there is no block to
     * expire before then, and reporting one would tell an administrator a window
     * was running that was not.
     */
    getBlockExpiryDeadline()
    {
        const bAccessDisabled = this.#statusEvents
            .some(statusEvent => statusEvent.status === intellectualPropertyComplaintStatus.ACCESS_DISABLED);

        if (!bAccessDisabled)
        {
            return null;
        }

        return this.#receivedAt + IntellectualPropertyComplaintConstants.BLOCK_PENDING_ORDER_DAYS * 24 * 60 * 60 * 1000;
    }

    toJson()
    {
        return {
            id: this.getId(),
            reference: this.getReference(),
            complainantName: this.getComplainantName(),
            contactEmail: this.getContactEmail(),
            capacityStatement: this.getCapacityStatement(),
            workDescription: this.getWorkDescription(),
            locationDescription: this.getLocationDescription(),
            deckId: this.getDeckId(),
            paidDeckId: this.getPaidDeckId(),
            studyMaterialId: this.getStudyMaterialId(),
            resolvedContentHashes: this.getResolvedContentHashes(),
            bGoodFaithStatement: this.getGoodFaithStatement(),
            bAccuracyStatement: this.getAccuracyStatement(),
            bContactVerified: this.getContactVerified(),
            bRateLimitFlagged: this.getRateLimitFlagged(),
            sourceIpAddress: this.getSourceIpAddress(),
            attachments: this.getAttachments(),
            evidenceUploadTokenHash: this.getEvidenceUploadTokenHash(),
            evidenceUploadTokenExpiresAt: this.getEvidenceUploadTokenExpiresAt(),
            receivedAt: this.getReceivedAt(),
            acknowledgedAt: this.getAcknowledgedAt(),
            contactVerifiedAt: this.getContactVerifiedAt(),
            statusEvents: this.getStatusEvents()
        };
    }

    /**
     * The shape an administrator sees. Adds the derived deadlines and the
     * current status so the console does not recompute either — the record and
     * the queue must agree on when something is late.
     *
     * The upload credential is stripped rather than merely hashed-and-shown: an
     * admin has no use for it, and the console's payload ends up in browser
     * caches and screenshots.
     */
    toAdminJson()
    {
        const adminJson = { ...this.toJson() };
        delete adminJson.evidenceUploadTokenHash;
        delete adminJson.evidenceUploadTokenExpiresAt;

        return {
            ...adminJson,
            currentStatus: this.getCurrentStatus(),
            acknowledgmentDeadline: this.getAcknowledgmentDeadline(),
            disposalDeadline: this.getDisposalDeadline(),
            courtOrderDeadline: this.getCourtOrderDeadline(),
            blockExpiryDeadline: this.getBlockExpiryDeadline()
        };
    }

    /**
     * What the complainant is told back. Deliberately narrow: it echoes only
     * the handle and the promised dates, never the stored text, the source
     * address or the admin's notes.
     */
    toComplainantJson()
    {
        return {
            reference: this.getReference(),
            receivedAt: this.getReceivedAt(),
            bContactVerified: this.getContactVerified(),
            disposalDeadline: this.getDisposalDeadline()
        };
    }

    static fromJson(json)
    {
        return new IntellectualPropertyComplaint
        ({
            id: json?.id ?? null,
            reference: json?.reference ?? null,
            complainantName: json?.complainantName ?? "",
            contactEmail: json?.contactEmail ?? "",
            capacityStatement: json?.capacityStatement ?? "",
            workDescription: json?.workDescription ?? "",
            locationDescription: json?.locationDescription ?? "",
            deckId: json?.deckId ?? "",
            paidDeckId: json?.paidDeckId ?? "",
            studyMaterialId: json?.studyMaterialId ?? "",
            resolvedContentHashes: json?.resolvedContentHashes ?? [],
            bGoodFaithStatement: json?.bGoodFaithStatement ?? false,
            bAccuracyStatement: json?.bAccuracyStatement ?? false,
            bContactVerified: json?.bContactVerified ?? false,
            bRateLimitFlagged: json?.bRateLimitFlagged ?? false,
            sourceIpAddress: json?.sourceIpAddress ?? "",
            attachments: json?.attachments ?? [],
            evidenceUploadTokenHash: json?.evidenceUploadTokenHash ?? "",
            evidenceUploadTokenExpiresAt: json?.evidenceUploadTokenExpiresAt ?? null,
            receivedAt: json?.receivedAt ?? Date.now(),
            acknowledgedAt: json?.acknowledgedAt ?? null,
            contactVerifiedAt: json?.contactVerifiedAt ?? null,
            statusEvents: json?.statusEvents ?? []
        });
    }

    static #clamp(value, maximumLength)
    {
        const stringValue = String(value ?? "");
        return stringValue.length > maximumLength ? stringValue.slice(0, maximumLength) : stringValue;
    }

    static #toBoolean(value)
    {
        return value === true || value === "true" || value === 1 || value === "1";
    }
}

module.exports = IntellectualPropertyComplaint;
