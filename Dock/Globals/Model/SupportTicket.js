const crypto = require("crypto");
const { supportTicketStatus } = require("../Enumerations/SupportTicketStatus");
const { supportTicketTypes } = require("../Enumerations/SupportTicketTypes");
const SupportTicketLimits = require("../Classes/Support/SupportTicketLimits");

/**
 * One deduplicated problem, as opposed to one user's report of it.
 *
 * Several reporters hitting the same defect collapse onto a single ticket: the
 * Agent's deduplication workflow decides the match, folds any genuinely new
 * detail into `aspects`, and increments `reportCount`. That counter is what the
 * admin sees when deciding how large an incentive the fix warrants, and the
 * linked SupportTicketReport rows are who gets emailed and paid on resolution.
 *
 * `embedding` is the 768-dimension nomic-embed-text-v1 vector of the canonical
 * description, refreshed whenever a merge changes that text. Only ACTIVE tickets
 * are ever searched, so a closed ticket's vector is dead weight but harmless.
 *
 * Timestamps are UTC milliseconds. `createdAtIsoString` is a denormalised copy
 * kept purely so the admin list's DateRangeFilter can compare as an ISO string,
 * mirroring the timestamp / timestampIsoString pair on log events.
 */
class SupportTicket
{
    #id;
    #title;
    #description;
    #aspects;
    #issueType;
    #status;
    #reportCount;
    #embedding;
    #embeddingUpdatedAt;
    #createdAt;
    #createdAtIsoString;
    #updatedAt;
    #lastReportedAt;
    #resolvedAt;
    #resolvedByUserId;
    #resolutionMessage;
    #creditsPerReporter;
    #declinedAt;
    #declinedByUserId;
    #declineMessage;
    #dispatchState;

    constructor
    ({
        id = null,
        title = "",
        description = "",
        aspects = [],
        issueType = supportTicketTypes.UNKNOWN,
        status = supportTicketStatus.ACTIVE,
        reportCount = 0,
        embedding = [],
        embeddingUpdatedAt = 0,
        createdAt = Date.now(),
        updatedAt = Date.now(),
        lastReportedAt = Date.now(),
        resolvedAt = null,
        resolvedByUserId = "",
        resolutionMessage = "",
        creditsPerReporter = 0,
        declinedAt = null,
        declinedByUserId = "",
        declineMessage = "",
        dispatchState = null
    } = {})
    {
        this.setId(id);
        this.setTitle(title);
        this.setDescription(description);
        this.setAspects(aspects);
        this.setIssueType(issueType);
        this.setStatus(status);
        this.setReportCount(reportCount);
        this.setEmbedding(embedding);
        this.setEmbeddingUpdatedAt(embeddingUpdatedAt);
        this.setCreatedAt(createdAt);
        this.setUpdatedAt(updatedAt);
        this.setLastReportedAt(lastReportedAt);
        this.setResolvedAt(resolvedAt);
        this.setResolvedByUserId(resolvedByUserId);
        this.setResolutionMessage(resolutionMessage);
        this.setCreditsPerReporter(creditsPerReporter);
        this.setDeclinedAt(declinedAt);
        this.setDeclinedByUserId(declinedByUserId);
        this.setDeclineMessage(declineMessage);
        this.setDispatchState(dispatchState);
    }

    getId()
    {
        return this.#id;
    }

    setId(value)
    {
        this.#id = (typeof value === "string" && value.length > 0) ? value : crypto.randomUUID();
    }

    getTitle()
    {
        return this.#title;
    }

    setTitle(value)
    {
        this.#title = SupportTicketLimits.clampToWordBoundary(value, SupportTicketLimits.MAXIMUM_TITLE_LENGTH);
    }

    getDescription()
    {
        return this.#description;
    }

    setDescription(value)
    {
        this.#description = SupportTicketLimits.clampToWordBoundary(value, SupportTicketLimits.MAXIMUM_TICKET_DESCRIPTION_LENGTH);
    }

    getAspects()
    {
        return this.#aspects;
    }

    setAspects(value)
    {
        const rawAspects = Array.isArray(value) ? value : [];

        this.#aspects = rawAspects.slice(0, SupportTicketLimits.MAXIMUM_ASPECTS_PER_TICKET).map(aspect =>
        ({
            text: SupportTicketLimits.clampToWordBoundary(aspect?.text, SupportTicketLimits.MAXIMUM_ASPECT_LENGTH),
            addedAt: Number(aspect?.addedAt) || Date.now(),
            reportId: String(aspect?.reportId ?? "")
        }));
    }

    /**
     * True once the ticket has absorbed as many distinct aspects as it is allowed
     * to hold. Reporters still accumulate past this point — only the text stops
     * growing. The admin list surfaces it so an over-broad grouping can be split.
     *
     * @returns {boolean}
     */
    isAspectSaturated()
    {
        return this.#aspects.length >= SupportTicketLimits.MAXIMUM_ASPECTS_PER_TICKET;
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

    getStatus()
    {
        return this.#status;
    }

    setStatus(value)
    {
        const parsedStatus = Number(value);
        this.#status = Number.isInteger(parsedStatus) ? parsedStatus : supportTicketStatus.ACTIVE;
    }

    isActive()
    {
        return this.#status === supportTicketStatus.ACTIVE;
    }

    getReportCount()
    {
        return this.#reportCount;
    }

    setReportCount(value)
    {
        const parsedCount = Number(value);
        this.#reportCount = Number.isFinite(parsedCount) && parsedCount > 0 ? Math.floor(parsedCount) : 0;
    }

    getEmbedding()
    {
        return this.#embedding;
    }

    setEmbedding(value)
    {
        this.#embedding = Array.isArray(value) ? value.map(component => Number(component) || 0) : [];
    }

    getEmbeddingUpdatedAt()
    {
        return this.#embeddingUpdatedAt;
    }

    setEmbeddingUpdatedAt(value)
    {
        this.#embeddingUpdatedAt = Number(value) || 0;
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

    getUpdatedAt()
    {
        return this.#updatedAt;
    }

    setUpdatedAt(value)
    {
        this.#updatedAt = Number(value) || Date.now();
    }

    getLastReportedAt()
    {
        return this.#lastReportedAt;
    }

    setLastReportedAt(value)
    {
        this.#lastReportedAt = Number(value) || Date.now();
    }

    getResolvedAt()
    {
        return this.#resolvedAt;
    }

    setResolvedAt(value)
    {
        this.#resolvedAt = (value === null || value === undefined) ? null : (Number(value) || null);
    }

    getResolvedByUserId()
    {
        return this.#resolvedByUserId;
    }

    setResolvedByUserId(value)
    {
        this.#resolvedByUserId = String(value ?? "");
    }

    getResolutionMessage()
    {
        return this.#resolutionMessage;
    }

    setResolutionMessage(value)
    {
        this.#resolutionMessage = String(value ?? "").slice(0, SupportTicketLimits.MAXIMUM_RESOLUTION_MESSAGE_LENGTH);
    }

    getCreditsPerReporter()
    {
        return this.#creditsPerReporter;
    }

    setCreditsPerReporter(value)
    {
        const parsedAmount = Number(value);
        this.#creditsPerReporter = Number.isFinite(parsedAmount) && parsedAmount > 0 ? parsedAmount : 0;
    }

    getDeclinedAt()
    {
        return this.#declinedAt;
    }

    setDeclinedAt(value)
    {
        this.#declinedAt = (value === null || value === undefined) ? null : (Number(value) || null);
    }

    getDeclinedByUserId()
    {
        return this.#declinedByUserId;
    }

    setDeclinedByUserId(value)
    {
        this.#declinedByUserId = String(value ?? "");
    }

    getDeclineMessage()
    {
        return this.#declineMessage;
    }

    setDeclineMessage(value)
    {
        this.#declineMessage = String(value ?? "").slice(0, SupportTicketLimits.MAXIMUM_DECLINE_MESSAGE_LENGTH);
    }

    getDispatchState()
    {
        return this.#dispatchState;
    }

    setDispatchState(value)
    {
        if (value === null || value === undefined || typeof value !== "object")
        {
            this.#dispatchState = null;
            return;
        }

        this.#dispatchState =
        {
            startedAt: Number(value.startedAt) || 0,
            completedAt: (value.completedAt === null || value.completedAt === undefined) ? null : (Number(value.completedAt) || null),
            processedCount: Number(value.processedCount) || 0,
            totalCount: Number(value.totalCount) || 0
        };
    }

    toJson()
    {
        return {
            id: this.getId(),
            title: this.getTitle(),
            description: this.getDescription(),
            aspects: this.getAspects(),
            issueType: this.getIssueType(),
            status: this.getStatus(),
            reportCount: this.getReportCount(),
            embedding: this.getEmbedding(),
            embeddingUpdatedAt: this.getEmbeddingUpdatedAt(),
            createdAt: this.getCreatedAt(),
            createdAtIsoString: this.getCreatedAtIsoString(),
            updatedAt: this.getUpdatedAt(),
            lastReportedAt: this.getLastReportedAt(),
            resolvedAt: this.getResolvedAt(),
            resolvedByUserId: this.getResolvedByUserId(),
            resolutionMessage: this.getResolutionMessage(),
            creditsPerReporter: this.getCreditsPerReporter(),
            declinedAt: this.getDeclinedAt(),
            declinedByUserId: this.getDeclinedByUserId(),
            declineMessage: this.getDeclineMessage(),
            dispatchState: this.getDispatchState()
        };
    }

    /**
     * The client-safe projection: everything the admin panel renders, minus the
     * 768-float embedding (pure payload bloat over the wire).
     *
     * @returns {object}
     */
    toClientJson()
    {
        const json = this.toJson();
        delete json.embedding;
        delete json.embeddingUpdatedAt;
        json.bAspectSaturated = this.isAspectSaturated();
        return json;
    }

    static fromJson(json)
    {
        return new SupportTicket
        ({
            id: json?.id ?? null,
            title: json?.title ?? "",
            description: json?.description ?? "",
            aspects: json?.aspects ?? [],
            issueType: json?.issueType ?? supportTicketTypes.UNKNOWN,
            status: json?.status ?? supportTicketStatus.ACTIVE,
            reportCount: json?.reportCount ?? 0,
            embedding: json?.embedding ?? [],
            embeddingUpdatedAt: json?.embeddingUpdatedAt ?? 0,
            createdAt: json?.createdAt ?? Date.now(),
            updatedAt: json?.updatedAt ?? Date.now(),
            lastReportedAt: json?.lastReportedAt ?? Date.now(),
            resolvedAt: json?.resolvedAt ?? null,
            resolvedByUserId: json?.resolvedByUserId ?? "",
            resolutionMessage: json?.resolutionMessage ?? "",
            creditsPerReporter: json?.creditsPerReporter ?? 0,
            declinedAt: json?.declinedAt ?? null,
            declinedByUserId: json?.declinedByUserId ?? "",
            declineMessage: json?.declineMessage ?? "",
            dispatchState: json?.dispatchState ?? null
        });
    }
}

module.exports = SupportTicket;
