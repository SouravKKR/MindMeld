const crypto = require("crypto");
const { supportTicketReportStatus } = require("../Enumerations/SupportTicketReportStatus");
const { supportTicketTypes } = require("../Enumerations/SupportTicketTypes");
const SupportTicketLimits = require("../Classes/Support/SupportTicketLimits");

/**
 * One user's submission through the Report Issue dialog.
 *
 * Reports are never merged away — the deduplication workflow only points them at
 * a shared SupportTicket. Keeping every submission intact is what makes "who do I
 * email", "who do I pay", and "show this reporter their own status" all answerable
 * without reconstructing anything.
 *
 * `userEmail` is snapshotted at submission time so a resolution mail still reaches
 * the person who reported the problem even if they later change their profile.
 *
 * `createdAt` doubles as the log-correlation anchor: the admin can pull this
 * reporter's server logs for the 24 hours preceding it.
 *
 * `notifiedAt` and `creditGrantedAt` make the resolution fan-out resumable — a
 * Dock restart mid-dispatch replays only the reports that were not reached.
 */
class SupportTicketReport
{
    #id;
    #ticketId;
    #userId;
    #userEmail;
    #issueType;
    #description;
    #attachments;
    #bNotifyOnResolution;
    #createdAt;
    #createdAtIsoString;
    #groupingStatus;
    #groupedAt;
    #notifiedAt;
    #creditGrantedAt;
    #creditAmount;

    constructor
    ({
        id = null,
        ticketId = null,
        userId = "",
        userEmail = "",
        issueType = supportTicketTypes.UNKNOWN,
        description = "",
        attachments = [],
        bNotifyOnResolution = false,
        createdAt = Date.now(),
        groupingStatus = supportTicketReportStatus.PENDING_GROUPING,
        groupedAt = null,
        notifiedAt = null,
        creditGrantedAt = null,
        creditAmount = 0
    } = {})
    {
        this.setId(id);
        this.setTicketId(ticketId);
        this.setUserId(userId);
        this.setUserEmail(userEmail);
        this.setIssueType(issueType);
        this.setDescription(description);
        this.setAttachments(attachments);
        this.setNotifyOnResolution(bNotifyOnResolution);
        this.setCreatedAt(createdAt);
        this.setGroupingStatus(groupingStatus);
        this.setGroupedAt(groupedAt);
        this.setNotifiedAt(notifiedAt);
        this.setCreditGrantedAt(creditGrantedAt);
        this.setCreditAmount(creditAmount);
    }

    getId()
    {
        return this.#id;
    }

    setId(value)
    {
        this.#id = (typeof value === "string" && value.length > 0) ? value : crypto.randomUUID();
    }

    getTicketId()
    {
        return this.#ticketId;
    }

    setTicketId(value)
    {
        this.#ticketId = (typeof value === "string" && value.length > 0) ? value : null;
    }

    getUserId()
    {
        return this.#userId;
    }

    setUserId(value)
    {
        this.#userId = String(value ?? "");
    }

    getUserEmail()
    {
        return this.#userEmail;
    }

    setUserEmail(value)
    {
        this.#userEmail = String(value ?? "");
    }

    getIssueType()
    {
        return this.#issueType;
    }

    setIssueType(value)
    {
        const parsedIssueType = Number(value);
        this.#issueType = Number.isInteger(parsedIssueType) ? parsedIssueType : supportTicketTypes.UNKNOWN;
    }

    getDescription()
    {
        return this.#description;
    }

    setDescription(value)
    {
        // The endpoint rejects an over-length body outright; this slice is only a
        // last-resort guard for documents read back from storage.
        this.#description = String(value ?? "").slice(0, SupportTicketLimits.MAXIMUM_DESCRIPTION_LENGTH);
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

    getNotifyOnResolution()
    {
        return this.#bNotifyOnResolution;
    }

    setNotifyOnResolution(value)
    {
        this.#bNotifyOnResolution = value === true || value === "true" || value === 1 || value === "1";
    }

    getCreatedAt()
    {
        return this.#createdAt;
    }

    setCreatedAt(value)
    {
        this.#createdAt = Number(value) || Date.now();
        this.#createdAtIsoString = new Date(this.#createdAt).toISOString();
    }

    getCreatedAtIsoString()
    {
        return this.#createdAtIsoString;
    }

    getGroupingStatus()
    {
        return this.#groupingStatus;
    }

    setGroupingStatus(value)
    {
        const parsedStatus = Number(value);
        this.#groupingStatus = Number.isInteger(parsedStatus) ? parsedStatus : supportTicketReportStatus.PENDING_GROUPING;
    }

    getGroupedAt()
    {
        return this.#groupedAt;
    }

    setGroupedAt(value)
    {
        this.#groupedAt = (value === null || value === undefined) ? null : (Number(value) || null);
    }

    getNotifiedAt()
    {
        return this.#notifiedAt;
    }

    setNotifiedAt(value)
    {
        this.#notifiedAt = (value === null || value === undefined) ? null : (Number(value) || null);
    }

    getCreditGrantedAt()
    {
        return this.#creditGrantedAt;
    }

    setCreditGrantedAt(value)
    {
        this.#creditGrantedAt = (value === null || value === undefined) ? null : (Number(value) || null);
    }

    getCreditAmount()
    {
        return this.#creditAmount;
    }

    setCreditAmount(value)
    {
        const parsedAmount = Number(value);
        this.#creditAmount = Number.isFinite(parsedAmount) && parsedAmount > 0 ? parsedAmount : 0;
    }

    toJson()
    {
        return {
            id: this.getId(),
            ticketId: this.getTicketId(),
            userId: this.getUserId(),
            userEmail: this.getUserEmail(),
            issueType: this.getIssueType(),
            description: this.getDescription(),
            attachments: this.getAttachments(),
            bNotifyOnResolution: this.getNotifyOnResolution(),
            createdAt: this.getCreatedAt(),
            createdAtIsoString: this.getCreatedAtIsoString(),
            groupingStatus: this.getGroupingStatus(),
            groupedAt: this.getGroupedAt(),
            notifiedAt: this.getNotifiedAt(),
            creditGrantedAt: this.getCreditGrantedAt(),
            creditAmount: this.getCreditAmount()
        };
    }

    static fromJson(json)
    {
        return new SupportTicketReport
        ({
            id: json?.id ?? null,
            ticketId: json?.ticketId ?? null,
            userId: json?.userId ?? "",
            userEmail: json?.userEmail ?? "",
            issueType: json?.issueType ?? supportTicketTypes.UNKNOWN,
            description: json?.description ?? "",
            attachments: json?.attachments ?? [],
            bNotifyOnResolution: json?.bNotifyOnResolution ?? false,
            createdAt: json?.createdAt ?? Date.now(),
            groupingStatus: json?.groupingStatus ?? supportTicketReportStatus.PENDING_GROUPING,
            groupedAt: json?.groupedAt ?? null,
            notifiedAt: json?.notifiedAt ?? null,
            creditGrantedAt: json?.creditGrantedAt ?? null,
            creditAmount: json?.creditAmount ?? 0
        });
    }
}

module.exports = SupportTicketReport;
