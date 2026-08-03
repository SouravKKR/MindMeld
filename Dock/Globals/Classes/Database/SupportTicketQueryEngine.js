const DatabaseConnector = require("./DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const SupportTicket = require("../../Model/SupportTicket");
const SupportTicketReport = require("../../Model/SupportTicketReport");
const { supportTicketStatus } = require("../../Enumerations/SupportTicketStatus");
const { supportTicketReportStatus } = require("../../Enumerations/SupportTicketReportStatus");

/**
 * Persistence for the support-ticket subsystem — both the deduplicated tickets
 * and the individual reports that roll up into them. Mirrors the static-method /
 * #getCollection / fail-soft style of the other query engines.
 *
 * Deliberately NOT symmetrical with the Agent-side engine of the same name: the
 * Agent owns the write path that groups a report onto a ticket (it is the only
 * service that can embed text), while this class owns submission, the reporter's
 * own status view, and the admin resolve / decline lifecycle.
 */
class SupportTicketQueryEngine
{
    static #TICKETS_COLLECTION_NAME = DatabaseConstants.SUPPORT_TICKETS_COLLECTION;
    static #REPORTS_COLLECTION_NAME = DatabaseConstants.SUPPORT_TICKET_REPORTS_COLLECTION;

    // Ceiling for the reporter-facing "Your reports" list. Well above the daily
    // submission quota, so a normal user always sees their whole history.
    static MAXIMUM_REPORTS_LISTED_FOR_USER = 100;

    static async #getTicketsCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return null;
        }
        return database.collection(SupportTicketQueryEngine.#TICKETS_COLLECTION_NAME);
    }

    static async #getReportsCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return null;
        }
        return database.collection(SupportTicketQueryEngine.#REPORTS_COLLECTION_NAME);
    }

    /**
     * Persists one newly submitted report. Returns { saved, report }.
     *
     * @param {SupportTicketReport} supportTicketReport
     * @returns {Promise<{saved: boolean, report: SupportTicketReport}>}
     */
    static async insertReport(supportTicketReport)
    {
        const collection = await SupportTicketQueryEngine.#getReportsCollection();
        if (!collection)
        {
            return { saved: false, report: supportTicketReport };
        }

        await collection.insertOne(supportTicketReport.toJson());
        return { saved: true, report: supportTicketReport };
    }

    /**
     * Counts a user's reports submitted at or after the given instant. Backs the
     * durable per-day submission quota — counted in Mongo rather than an in-memory
     * window so a Dock restart cannot hand a user a fresh allowance.
     *
     * @param {string} userId
     * @param {number} sinceUtcMilliseconds
     * @returns {Promise<number>}
     */
    static async countReportsForUserSince(userId, sinceUtcMilliseconds)
    {
        const normalisedUserId = String(userId ?? "");
        if (!normalisedUserId)
        {
            return 0;
        }

        const collection = await SupportTicketQueryEngine.#getReportsCollection();
        if (!collection)
        {
            return 0;
        }

        return await collection.countDocuments({ userId: normalisedUserId, createdAt: { $gte: Number(sinceUtcMilliseconds) || 0 } });
    }

    /**
     * The reporter's own history, newest first, each entry joined to the status of
     * the ticket it was grouped onto. This is what lets someone check whether their
     * issue was fixed even when they declined notifications.
     *
     * @param {string} userId
     * @returns {Promise<Array<object>>}
     */
    static async listReportsForUser(userId)
    {
        const normalisedUserId = String(userId ?? "");
        if (!normalisedUserId)
        {
            return [];
        }

        const collection = await SupportTicketQueryEngine.#getReportsCollection();
        if (!collection)
        {
            return [];
        }

        const reportDocuments = await collection
            .find({ userId: normalisedUserId }, { projection: { _id: 0 } })
            .sort({ createdAt: -1 })
            .limit(SupportTicketQueryEngine.MAXIMUM_REPORTS_LISTED_FOR_USER)
            .toArray();

        if (reportDocuments.length === 0)
        {
            return [];
        }

        const ticketIds = Array.from(new Set(reportDocuments.map(document => document.ticketId).filter(ticketId => typeof ticketId === "string" && ticketId.length > 0)));
        const ticketsById = await SupportTicketQueryEngine.#loadTicketsById(ticketIds);

        return reportDocuments.map(document =>
        {
            const report = SupportTicketReport.fromJson(document);
            const ticket = report.getTicketId() !== null ? ticketsById.get(report.getTicketId()) : null;

            return {
                reportId: report.getId(),
                issueType: report.getIssueType(),
                description: report.getDescription(),
                attachmentCount: report.getAttachments().length,
                bNotifyOnResolution: report.getNotifyOnResolution(),
                createdAt: report.getCreatedAt(),
                groupingStatus: report.getGroupingStatus(),
                creditAmount: report.getCreditAmount(),
                creditGrantedAt: report.getCreditGrantedAt(),

                // Ticket-derived status. A report that has not been grouped yet has
                // no ticket, and reads as "under review" on the client.
                ticketStatus: ticket !== null ? ticket.getStatus() : supportTicketStatus.ACTIVE,
                ticketTitle: ticket !== null ? ticket.getTitle() : "",
                resolutionMessage: ticket !== null ? ticket.getResolutionMessage() : "",
                declineMessage: ticket !== null ? ticket.getDeclineMessage() : "",
                resolvedAt: ticket !== null ? ticket.getResolvedAt() : null,
                declinedAt: ticket !== null ? ticket.getDeclinedAt() : null
            };
        });
    }

    /**
     * @param {Array<string>} ticketIds
     * @returns {Promise<Map<string, SupportTicket>>}
     */
    static async #loadTicketsById(ticketIds)
    {
        const ticketsById = new Map();

        if (!Array.isArray(ticketIds) || ticketIds.length === 0)
        {
            return ticketsById;
        }

        const collection = await SupportTicketQueryEngine.#getTicketsCollection();
        if (!collection)
        {
            return ticketsById;
        }

        // The embedding is never needed for a status read and is by far the largest
        // field on the document, so it is projected away.
        const documents = await collection.find({ id: { $in: ticketIds } }, { projection: { _id: 0, embedding: 0 } }).toArray();

        for (const document of documents)
        {
            ticketsById.set(document.id, SupportTicket.fromJson(document));
        }

        return ticketsById;
    }

    /**
     * @param {string} ticketId
     * @returns {Promise<SupportTicket|null>}
     */
    static async getTicket(ticketId)
    {
        const normalisedTicketId = String(ticketId ?? "");
        if (!normalisedTicketId)
        {
            return null;
        }

        const collection = await SupportTicketQueryEngine.#getTicketsCollection();
        if (!collection)
        {
            return null;
        }

        const document = await collection.findOne({ id: normalisedTicketId }, { projection: { _id: 0, embedding: 0 } });
        return document ? SupportTicket.fromJson(document) : null;
    }

    /**
     * @param {string} reportId
     * @returns {Promise<SupportTicketReport|null>}
     */
    static async getReport(reportId)
    {
        const normalisedReportId = String(reportId ?? "");
        if (!normalisedReportId)
        {
            return null;
        }

        const collection = await SupportTicketQueryEngine.#getReportsCollection();
        if (!collection)
        {
            return null;
        }

        const document = await collection.findOne({ id: normalisedReportId }, { projection: { _id: 0 } });
        return document ? SupportTicketReport.fromJson(document) : null;
    }

    /**
     * Every report grouped onto one ticket, oldest first (the order they were
     * reported in is the order an admin wants to read them).
     *
     * @param {string} ticketId
     * @returns {Promise<Array<SupportTicketReport>>}
     */
    static async listReportsForTicket(ticketId)
    {
        const normalisedTicketId = String(ticketId ?? "");
        if (!normalisedTicketId)
        {
            return [];
        }

        const collection = await SupportTicketQueryEngine.#getReportsCollection();
        if (!collection)
        {
            return [];
        }

        const documents = await collection
            .find({ ticketId: normalisedTicketId }, { projection: { _id: 0 } })
            .sort({ createdAt: 1 })
            .toArray();

        return documents.map(document => SupportTicketReport.fromJson(document));
    }

    /**
     * Claims an ACTIVE ticket and stamps the closing fields in one atomic step.
     *
     * The `status: ACTIVE` guard in the filter is what makes a double-clicked
     * Resolve button safe: the second call matches nothing and the caller responds
     * 409 rather than starting a second credit-granting fan-out.
     *
     * @param {string} ticketId
     * @param {object} closingFields
     * @returns {Promise<SupportTicket|null>} the updated ticket, or null when it was not ACTIVE
     */
    static async claimActiveTicket(ticketId, closingFields)
    {
        const normalisedTicketId = String(ticketId ?? "");
        if (!normalisedTicketId)
        {
            return null;
        }

        const collection = await SupportTicketQueryEngine.#getTicketsCollection();
        if (!collection)
        {
            return null;
        }

        const updatedDocument = await collection.findOneAndUpdate
        (
            { id: normalisedTicketId, status: supportTicketStatus.ACTIVE },
            { $set: { ...closingFields, updatedAt: Date.now() } },
            { returnDocument: "after", projection: { _id: 0, embedding: 0 } }
        );

        // The driver returns either the document itself or a { value } wrapper
        // depending on the version in use; handle both rather than pinning one.
        const document = updatedDocument && updatedDocument.value !== undefined ? updatedDocument.value : updatedDocument;
        return document ? SupportTicket.fromJson(document) : null;
    }

    /**
     * Reports on a ticket that the resolution fan-out has not reached yet, oldest
     * first. Returning only un-notified rows is what makes the dispatcher resumable
     * after a restart without re-emailing anyone.
     *
     * @param {string} ticketId
     * @param {number} batchSize
     * @returns {Promise<Array<SupportTicketReport>>}
     */
    static async listUndispatchedReports(ticketId, batchSize)
    {
        const normalisedTicketId = String(ticketId ?? "");
        if (!normalisedTicketId)
        {
            return [];
        }

        const collection = await SupportTicketQueryEngine.#getReportsCollection();
        if (!collection)
        {
            return [];
        }

        const cappedBatchSize = Number.isInteger(batchSize) && batchSize > 0 ? batchSize : 100;

        const documents = await collection
            .find({ ticketId: normalisedTicketId, notifiedAt: null }, { projection: { _id: 0 } })
            .sort({ createdAt: 1 })
            .limit(cappedBatchSize)
            .toArray();

        return documents.map(document => SupportTicketReport.fromJson(document));
    }

    /**
     * Records that one report has been fully handled by the fan-out (credit granted
     * where applicable, notification sent where requested).
     *
     * @param {string} reportId
     * @param {{creditAmount: number, bCreditGranted: boolean}} outcome
     * @returns {Promise<boolean>}
     */
    static async markReportDispatched(reportId, outcome)
    {
        const normalisedReportId = String(reportId ?? "");
        if (!normalisedReportId)
        {
            return false;
        }

        const collection = await SupportTicketQueryEngine.#getReportsCollection();
        if (!collection)
        {
            return false;
        }

        const now = Date.now();
        const fieldsToSet = { notifiedAt: now };

        if (outcome && outcome.bCreditGranted === true)
        {
            fieldsToSet.creditGrantedAt = now;
            fieldsToSet.creditAmount = Number(outcome.creditAmount) || 0;
        }

        const result = await collection.updateOne({ id: normalisedReportId }, { $set: fieldsToSet });
        return result.matchedCount > 0;
    }

    /**
     * @param {string} ticketId
     * @param {object} dispatchState
     * @returns {Promise<void>}
     */
    static async updateDispatchState(ticketId, dispatchState)
    {
        const normalisedTicketId = String(ticketId ?? "");
        if (!normalisedTicketId)
        {
            return;
        }

        const collection = await SupportTicketQueryEngine.#getTicketsCollection();
        if (!collection)
        {
            return;
        }

        await collection.updateOne({ id: normalisedTicketId }, { $set: { dispatchState: dispatchState } });
    }

    /**
     * Closed tickets whose resolution fan-out never finished — the input to the
     * boot reconciler. `closedBeforeUtcMilliseconds` keeps a dispatch that is
     * legitimately in flight right now from being picked up twice.
     *
     * @param {number} closedBeforeUtcMilliseconds
     * @param {number} limit
     * @returns {Promise<Array<SupportTicket>>}
     */
    static async listTicketsWithIncompleteDispatch(closedBeforeUtcMilliseconds, limit)
    {
        const collection = await SupportTicketQueryEngine.#getTicketsCollection();
        if (!collection)
        {
            return [];
        }

        const cappedLimit = Number.isInteger(limit) && limit > 0 ? limit : 50;

        const documents = await collection
            .find
            ({
                status: { $in: [supportTicketStatus.RESOLVED, supportTicketStatus.DECLINED] },
                updatedAt: { $lte: Number(closedBeforeUtcMilliseconds) || 0 },
                $or:
                [
                    { dispatchState: null },
                    { "dispatchState.completedAt": null }
                ]
            }, { projection: { _id: 0, embedding: 0 } })
            .limit(cappedLimit)
            .toArray();

        return documents.map(document => SupportTicket.fromJson(document));
    }

    /**
     * Counts reporters and notification opt-ins for a ticket in one pass. The admin
     * needs both before resolving: the reporter count sizes the incentive, the
     * opt-in count says how many people will actually be written to.
     *
     * Counts DISTINCT USERS, not report rows. The daily quota allows two
     * submissions and deduplication is specifically designed to merge them onto
     * one ticket, so one person can easily hold two rows here. Counting rows would
     * inflate the admin's "N reporters × X credits" projection and misrepresent
     * how many people the fix actually affected.
     *
     * `reportCount` on the ticket is the separate, deliberately different number:
     * how many times the problem was reported.
     *
     * @param {string} ticketId
     * @returns {Promise<{reporterCount: number, notifyOptInCount: number, reportRowCount: number}>}
     */
    static async summariseReporters(ticketId)
    {
        const normalisedTicketId = String(ticketId ?? "");
        if (!normalisedTicketId)
        {
            return { reporterCount: 0, notifyOptInCount: 0, reportRowCount: 0 };
        }

        const collection = await SupportTicketQueryEngine.#getReportsCollection();
        if (!collection)
        {
            return { reporterCount: 0, notifyOptInCount: 0, reportRowCount: 0 };
        }

        const [summary] = await collection.aggregate
        ([
            { $match: { ticketId: normalisedTicketId } },
            // Collapse to one row per user first. A user counts as an opt-in when
            // ANY of their reports asked to be notified.
            {
                $group:
                {
                    _id: "$userId",
                    bWantsNotification: { $max: { $cond: [{ $eq: ["$bNotifyOnResolution", true] }, 1, 0] } },
                    reportRowCount: { $sum: 1 }
                }
            },
            {
                $group:
                {
                    _id: null,
                    reporterCount: { $sum: 1 },
                    notifyOptInCount: { $sum: "$bWantsNotification" },
                    reportRowCount: { $sum: "$reportRowCount" }
                }
            }
        ]).toArray();

        return {
            reporterCount: summary?.reporterCount || 0,
            notifyOptInCount: summary?.notifyOptInCount || 0,
            reportRowCount: summary?.reportRowCount || 0
        };
    }

    /**
     * Marks a report as ungroupable so it surfaces to the admin instead of sitting
     * silently in the pending state forever.
     *
     * @param {string} reportId
     * @returns {Promise<void>}
     */
    static async markReportGroupingFailed(reportId)
    {
        const normalisedReportId = String(reportId ?? "");
        if (!normalisedReportId)
        {
            return;
        }

        const collection = await SupportTicketQueryEngine.#getReportsCollection();
        if (!collection)
        {
            return;
        }

        await collection.updateOne({ id: normalisedReportId }, { $set: { groupingStatus: supportTicketReportStatus.GROUPING_FAILED } });
    }
}

module.exports = SupportTicketQueryEngine;
