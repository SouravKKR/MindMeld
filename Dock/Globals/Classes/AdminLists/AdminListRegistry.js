const AdminListDefinition = require("./AdminListDefinition");
const PaidDeckAcquisitionGate = require("../PaidDeck/PaidDeckAcquisitionGate");
const TextSearchFilter = require("../PaidDeckFilters/TextSearchFilter");
const NumberRangeFilter = require("../PaidDeckFilters/NumberRangeFilter");
const DateRangeFilter = require("../PaidDeckFilters/DateRangeFilter");
const MultiSelectFilter = require("../PaidDeckFilters/MultiSelectFilter");
const EnumFilter = require("../PaidDeckFilters/EnumFilter");
const BooleanFilter = require("../PaidDeckFilters/BooleanFilter");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const { adminListTypes } = require("../../Enumerations/AdminListTypes");
const { deckPurchaseGranularity } = require("../../Enumerations/DeckPurchaseGranularity");
const { organizationStatus } = require("../../Enumerations/OrganizationStatus");
const { organizationPaymentStatuses } = require("../../Enumerations/OrganizationPaymentStatuses");
const { purchaseStatuses } = require("../../Enumerations/PurchaseStatuses");
const OrganizationDeckPerkQueryEngine = require("../Organization/OrganizationDeckPerkQueryEngine");
const OrganizationPaymentQueryEngine = require("../Organization/OrganizationPaymentQueryEngine");
const { logLevel } = require("../../Enumerations/LogLevel");
const { logCategory } = require("../../Enumerations/LogCategory");
const { logServiceOrigin } = require("../../Enumerations/LogServiceOrigin");
const { couponBenefitTargets } = require("../../Enumerations/CouponBenefitTargets");
const { supportTicketStatus } = require("../../Enumerations/SupportTicketStatus");
const { supportTicketTypes } = require("../../Enumerations/SupportTicketTypes");
const { supportTicketReportStatus } = require("../../Enumerations/SupportTicketReportStatus");
const { sourceLicenceTypes } = require("../../Enumerations/SourceLicenceTypes");
const SupportTicketLimits = require("../Support/SupportTicketLimits");
const { supportTicketTypeDisplayName } = require("../../UtilityFunctions.js/SupportTicketTypeDisplayName");

const LOG_CATEGORY_NAME_BY_VALUE = Object.fromEntries(Object.entries(logCategory).map(([categoryName, categoryValue]) => [categoryValue, categoryName]));
const LOG_SERVICE_NAME_BY_VALUE = Object.fromEntries(Object.entries(logServiceOrigin).map(([serviceName, serviceValue]) => [serviceValue, serviceName]));

/**
 * AdminListRegistry
 *
 * The live set of admin-panel lists the generic list framework serves. Each
 * entry is an AdminListDefinition (collection-backed or custom). Mirrors the
 * PaidDeckFilterRegistry pattern: register once in the static block, look up
 * by listKey at request time. Adding a list is one register() call; the
 * client renders it purely from getMetadata() output.
 */
class AdminListRegistry
{
    static #definitionsByKey = new Map();

    /**
     * Human labels for the declared-licence values.
     *
     * Kept as a map rather than printing the enum name, because these appear in
     * a log an auditor reads: "CC BY" is a licence a reader recognises,
     * "CC_BY" is an identifier from our codebase. The audit-trail renderer keeps
     * its own copy for the same reason — it runs as a standalone Python script
     * with no access to this one.
     */
    static #SOURCE_LICENCE_LABELS =
    {
        [sourceLicenceTypes.UNSPECIFIED]: "Not specified",
        [sourceLicenceTypes.CC0]: "CC0",
        [sourceLicenceTypes.PUBLIC_DOMAIN]: "Public domain",
        [sourceLicenceTypes.CC_BY]: "CC BY",
        [sourceLicenceTypes.OWN_WORK]: "Own work",
        [sourceLicenceTypes.LICENSED_PERMISSION]: "Licensed / permission held",
        [sourceLicenceTypes.OTHER]: "Other (see note)",
    };

    static #ORGANIZATION_STATUS_LABELS =
    {
        [organizationStatus.PENDING_PAYMENT]: "Pending payment",
        [organizationStatus.ACTIVE]: "Active",
        [organizationStatus.SUSPENDED]: "Suspended"
    };

    static #PAYMENT_STATUS_LABELS =
    {
        [organizationPaymentStatuses.PENDING]: "Pending",
        [organizationPaymentStatuses.CAPTURED]: "Captured",
        [organizationPaymentStatuses.FAILED]: "Failed",
        [organizationPaymentStatuses.REFUNDED]: "Refunded"
    };

    static register(definition)
    {
        AdminListRegistry.#definitionsByKey.set(definition.getListKey(), definition);
    }

    static getByKey(listKey)
    {
        return AdminListRegistry.#definitionsByKey.get(listKey) || null;
    }

    static #escapeRegex(rawString)
    {
        return String(rawString).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    static
    {
        // ── Paid decks (admin view — drafts included) ──────────────────────
        AdminListRegistry.register(new AdminListDefinition
        ({
            listKey: adminListTypes.PAID_DECKS,
            collectionName: DatabaseConstants.PAID_DECKS_COLLECTION,
            searchableFields: ["title", "category", "id"],
            searchPlaceholder: "Search title, category or id…",
            filters:
            [
                new BooleanFilter({ key: "isPublished", label: "Published", field: "isPublished" }),
                new EnumFilter
                ({
                    key: "granularity",
                    label: "Purchase granularity",
                    field: "granularity",
                    options:
                    [
                        { value: deckPurchaseGranularity.INDIVIDUAL, label: "Individually buyable" },
                        { value: deckPurchaseGranularity.BUNDLE_ONLY, label: "Bundle only" }
                    ]
                }),
                new NumberRangeFilter({ key: "basePriceMinor", label: "Price (minor units)", field: "basePriceMinor", defaultMin: 0, defaultMax: 1000000, step: 100 }),
                new MultiSelectFilter
                ({
                    key: "category",
                    label: "Category",
                    field: "category",
                    dynamicSource: { collection: DatabaseConstants.PAID_DECKS_COLLECTION, field: "category", baseFilter: {} }
                }),
                new DateRangeFilter({ key: "publishedAt", label: "Published date", field: "publishedAt", compareAsIsoString: true })
            ],
            columns:
            [
                { key: "title", label: "Title" },
                { key: "category", label: "Category" },
                { key: "priceLabel", label: "Price" },
                { key: "keyVersion", label: "Key v" },
                { key: "publishedLabel", label: "Published" },
                { key: "subdeckCount", label: "Subdecks" }
            ],
            rowMapper: (document) =>
            ({
                // Spread the raw deck so the edit / apply-to-subdecks dialogs
                // receive every field they need; the display fields below are
                // what the table columns render.
                ...document,
                priceLabel: `${document.currency || "INR"} ${((document.basePriceMinor || 0) / 100).toFixed(2)}`,
                // Retired and draft are both "not published", and a blank cell
                // for each left an operator unable to tell a deck they withdrew
                // from one they never finished.
                publishedLabel: PaidDeckAcquisitionGate.isRetired(document)
                    ? "Retired"
                    : (document.isPublished ? "✓" : "Draft"),
                isPublished: !!document.isPublished,
                subdeckCount: Array.isArray(document.bundleChildIds) ? document.bundleChildIds.length : 0
            }),
            defaultSort: { field: "publishedAt", direction: -1 },
            sortableFields: ["publishedAt", "title", "basePriceMinor", "category"],
            rowIdField: "id"
        }));

        // ── Admin emails (allowlist) ───────────────────────────────────────
        AdminListRegistry.register(new AdminListDefinition
        ({
            listKey: adminListTypes.ADMIN_EMAILS,
            collectionName: DatabaseConstants.ADMIN_EMAILS_COLLECTION,
            searchableFields: ["email", "addedBy", "notes"],
            searchPlaceholder: "Search email or notes…",
            filters:
            [
                new DateRangeFilter({ key: "addedAt", label: "Added date", field: "addedAt" })
            ],
            columns:
            [
                { key: "email", label: "Email" },
                { key: "addedBy", label: "Added by" },
                { key: "addedAt", label: "Added at", format: "date" },
                { key: "notes", label: "Notes" }
            ],
            rowMapper: (document) =>
            ({
                email: document.email,
                addedBy: document.addedBy || "",
                addedAt: document.addedAt || null,
                notes: document.notes || ""
            }),
            defaultSort: { field: "addedAt", direction: 1 },
            sortableFields: ["addedAt", "email"],
            rowIdField: "email"
        }));

        // ── Allowed login emails (per-environment login allowlist) ─────────
        AdminListRegistry.register(new AdminListDefinition
        ({
            listKey: adminListTypes.ALLOWED_LOGIN_EMAILS,
            collectionName: DatabaseConstants.ALLOWED_LOGIN_EMAILS_COLLECTION,
            searchableFields: ["email", "addedBy", "notes"],
            searchPlaceholder: "Search email or notes…",
            filters:
            [
                new DateRangeFilter({ key: "addedAt", label: "Added date", field: "addedAt" })
            ],
            columns:
            [
                { key: "email", label: "Email" },
                { key: "addedBy", label: "Added by" },
                { key: "addedAt", label: "Added at", format: "date" },
                { key: "notes", label: "Notes" }
            ],
            rowMapper: (document) =>
            ({
                email: document.email,
                addedBy: document.addedBy || "",
                addedAt: document.addedAt || null,
                notes: document.notes || ""
            }),
            defaultSort: { field: "addedAt", direction: 1 },
            sortableFields: ["addedAt", "email"],
            rowIdField: "email"
        }));

        // ── Release notes ──────────────────────────────────────────────────
        AdminListRegistry.register(new AdminListDefinition
        ({
            listKey: adminListTypes.RELEASE_NOTES,
            collectionName: DatabaseConstants.RELEASE_NOTES_COLLECTION,
            searchableFields: ["version", "title"],
            searchPlaceholder: "Search version or title…",
            filters:
            [
                new BooleanFilter({ key: "test", label: "Admins-only (test)", field: "test" }),
                new DateRangeFilter({ key: "releaseDate", label: "Release date", field: "releaseDate", compareAsIsoString: true })
            ],
            columns:
            [
                { key: "version", label: "Version" },
                { key: "title", label: "Title" },
                { key: "releaseDate", label: "Release date", format: "date" },
                { key: "createdAt", label: "Created at", format: "date" },
                { key: "updatedAt", label: "Updated at", format: "date" },
                { key: "visibilityLabel", label: "Visibility" }
            ],
            rowMapper: (document) =>
            ({
                // Spread the raw note so the edit dialog has contentHtml etc.;
                // the columns render the display fields.
                ...document,
                visibilityLabel: document.test === true ? "Test (admins only)" : "Live",
                test: document.test === true
            }),
            defaultSort: { field: "versionSortKey", direction: -1 },
            sortableFields: ["versionSortKey", "releaseDate", "createdAt"],
            rowIdField: "id"
        }));

        // ── Alerts (operational alert log) ─────────────────────────────────
        AdminListRegistry.register(new AdminListDefinition
        ({
            listKey: adminListTypes.ALERTS,
            collectionName: DatabaseConstants.ALERTS_COLLECTION,
            searchableFields: ["source", "title", "message"],
            searchPlaceholder: "Search source, title or message…",
            filters:
            [
                new EnumFilter
                ({
                    key: "severity",
                    label: "Severity",
                    field: "severity",
                    options:
                    [
                        { value: 0, label: "Info" },
                        { value: 1, label: "Warning" },
                        { value: 2, label: "Error" }
                    ]
                }),
                new BooleanFilter({ key: "acknowledged", label: "Acknowledged", field: "acknowledged" }),
                new DateRangeFilter({ key: "lastSeenAt", label: "Last seen", field: "lastSeenAt", compareAsIsoString: true })
            ],
            columns:
            [
                { key: "severity", label: "Severity", badge: { 0: { label: "INFO", variant: "info" }, 1: { label: "WARN", variant: "warning" }, 2: { label: "ERROR", variant: "danger" } } },
                { key: "source", label: "Source" },
                { key: "title", label: "Title" },
                { key: "message", label: "Message" },
                { key: "occurrenceCount", label: "Count" },
                { key: "lastSeenAt", label: "Last seen", format: "dateTime" }
            ],
            rowMapper: (document) =>
            ({
                id: document.id,
                severity: typeof document.severity === "number" ? document.severity : 0,
                source: document.source || "",
                title: document.title || "",
                message: document.message || "",
                occurrenceCount: document.occurrenceCount || 1,
                acknowledged: !!document.acknowledged,
                lastSeenAt: document.lastSeenAt || null
            }),
            defaultSort: { field: "lastSeenAt", direction: -1 },
            sortableFields: ["lastSeenAt", "occurrenceCount", "severity"],
            rowIdField: "id"
        }));

        // ── Rate-limit events (read-only 429 log) ──────────────────────────
        AdminListRegistry.register(new AdminListDefinition
        ({
            listKey: adminListTypes.RATE_LIMIT_EVENTS,
            collectionName: DatabaseConstants.RATE_LIMIT_EVENTS_COLLECTION,
            searchableFields: ["endpoint", "identityKey", "ipAddress"],
            searchPlaceholder: "Search endpoint, identity or IP…",
            filters:
            [
                new EnumFilter
                ({
                    key: "scope",
                    label: "Scope",
                    field: "scope",
                    options:
                    [
                        { value: "PER_USER", label: "Per-user" },
                        { value: "OVERALL", label: "Overall" }
                    ]
                }),
                new DateRangeFilter({ key: "occurredAt", label: "When", field: "occurredAt" })
            ],
            columns:
            [
                { key: "occurredAt", label: "When", format: "dateTime" },
                { key: "scope", label: "Scope", badge: { "PER_USER": { label: "Per-user", variant: "info" }, "OVERALL": { label: "Overall", variant: "neutral" } } },
                { key: "endpoint", label: "Endpoint" },
                { key: "method", label: "Method" },
                { key: "identity", label: "Identity" },
                { key: "retryAfter", label: "Retry-After" }
            ],
            rowMapper: (document) =>
            {
                let identity = document.identityKey || "";
                if (document.userId)
                {
                    identity = `user ${document.userId}`;
                }
                else if (document.ipAddress)
                {
                    identity = `ip ${document.ipAddress}`;
                }

                return {
                    id: document.id,
                    occurredAt: document.occurredAt || null,
                    scope: document.scope || "",
                    endpoint: document.endpoint || "",
                    method: document.method || "",
                    identity: identity,
                    retryAfter: (document.retryAfterSeconds !== null && document.retryAfterSeconds !== undefined) ? `${document.retryAfterSeconds}s` : ""
                };
            },
            defaultSort: { field: "occurredAt", direction: -1 },
            sortableFields: ["occurredAt"],
            rowIdField: "id"
        }));

        // ── Admin audit events (read-only privileged-action trail) ─────────
        AdminListRegistry.register(new AdminListDefinition
        ({
            listKey: adminListTypes.ADMIN_AUDIT_EVENTS,
            collectionName: DatabaseConstants.ADMIN_AUDIT_EVENTS_COLLECTION,
            searchableFields: ["actorEmail", "endpoint", "ipAddress"],
            searchPlaceholder: "Search admin, endpoint or IP…",
            filters:
            [
                new DateRangeFilter({ key: "occurredAt", label: "When", field: "occurredAt" })
            ],
            columns:
            [
                { key: "occurredAt", label: "When", format: "dateTime" },
                { key: "outcome", label: "Outcome", badge: { "SUCCESS": { label: "Success", variant: "success" }, "FAILURE": { label: "Blocked / Error", variant: "danger" } } },
                { key: "actor", label: "Admin" },
                { key: "endpoint", label: "Action" },
                { key: "method", label: "Method" },
                { key: "statusCode", label: "Status" },
                { key: "ipAddress", label: "IP" }
            ],
            rowMapper: (document) =>
            {
                const statusCode = document.statusCode || 0;
                const outcome = (statusCode >= 200 && statusCode < 400) ? "SUCCESS" : "FAILURE";

                let actor = "anonymous";
                if (document.actorEmail)
                {
                    actor = document.actorEmail;
                }
                else if (document.actorUserId)
                {
                    actor = `user ${document.actorUserId}`;
                }

                return {
                    id: document.id,
                    occurredAt: document.occurredAt || null,
                    outcome: outcome,
                    actor: actor,
                    endpoint: document.endpoint || "",
                    method: document.method || "",
                    statusCode: statusCode || "",
                    ipAddress: document.ipAddress || ""
                };
            },
            defaultSort: { field: "occurredAt", direction: -1 },
            sortableFields: ["occurredAt", "statusCode"],
            rowIdField: "id"
        }));

        // ── Source licence declarations (permanent IPR log) ─────────────────
        //
        // Every declaration an administrator has made about a document used to
        // verify a paid deck. Browsable here as well as printed in each deck's
        // audit trail, because the question "what have we ever declared, and who
        // declared it" is asked across decks and not only about one.
        //
        // Read-only, like the audit-event list beside it — the collection is
        // insert-only by design and there is nothing here to edit.
        AdminListRegistry.register(new AdminListDefinition
        ({
            listKey: adminListTypes.SOURCE_LICENCE_DECLARATIONS,
            collectionName: DatabaseConstants.SOURCE_LICENCE_DECLARATIONS_COLLECTION,
            searchableFields: ["sourceName", "declaredByEmail", "deckId", "sourceUrl"],
            searchPlaceholder: "Search source, admin, deck or URL…",
            filters:
            [
                new EnumFilter
                ({
                    key: "event",
                    label: "Event",
                    field: "event",
                    options:
                    [
                        { value: "ATTACHED", label: "Attached" },
                        { value: "DETACHED", label: "Detached" }
                    ]
                }),
                new EnumFilter
                ({
                    key: "licenceType",
                    label: "Declared licence",
                    field: "licenceType",
                    options: Object.entries(sourceLicenceTypes).map(([licenceName, licenceValue]) => ({
                        value: licenceValue,
                        label: AdminListRegistry.#SOURCE_LICENCE_LABELS[licenceValue] || licenceName,
                    }))
                }),
                new DateRangeFilter({ key: "createdAt", label: "When", field: "createdAt" })
            ],
            columns:
            [
                { key: "createdAt", label: "When", format: "dateTime" },
                { key: "event", label: "Event", badge: { "ATTACHED": { label: "Attached", variant: "info" }, "DETACHED": { label: "Detached", variant: "neutral" } } },
                { key: "sourceName", label: "Source" },
                { key: "licence", label: "Declared licence" },
                { key: "declaredBy", label: "Declared by" },
                { key: "deckId", label: "Deck" },
                { key: "sourceUrl", label: "URL" }
            ],
            rowMapper: (document) =>
            {
                const licenceLabel = AdminListRegistry.#SOURCE_LICENCE_LABELS[document.licenceType] || "Unrecognised";
                const licenceNote = (document.licenceNote || "").trim();

                return {
                    id: document.declarationId,
                    createdAt: document.createdAt || null,
                    event: document.event || "ATTACHED",
                    sourceName: document.sourceName || "",
                    // The note is shown WITH the label rather than in a column of
                    // its own. For OTHER and LICENSED_PERMISSION the note is what
                    // the declaration actually says — a row reading only "Other"
                    // would show the shape of a declaration without its content.
                    licence: licenceNote ? `${licenceLabel} — ${licenceNote}` : licenceLabel,
                    declaredBy: document.declaredByEmail || (document.declaredByUserId ? `user ${document.declaredByUserId}` : ""),
                    deckId: document.deckId || "",
                    sourceUrl: document.sourceUrl || ""
                };
            },
            defaultSort: { field: "createdAt", direction: -1 },
            sortableFields: ["createdAt"],
            rowIdField: "id"
        }));

        // ── Maintenance windows ────────────────────────────────────────────
        AdminListRegistry.register(new AdminListDefinition
        ({
            listKey: adminListTypes.MAINTENANCE_WINDOWS,
            collectionName: DatabaseConstants.MAINTENANCE_WINDOWS_COLLECTION,
            searchableFields: ["title", "message"],
            searchPlaceholder: "Search title or message…",
            filters:
            [
                new DateRangeFilter({ key: "startDate", label: "Start date", field: "startDate", compareAsIsoString: true })
            ],
            columns:
            [
                { key: "title", label: "Title" },
                { key: "startDate", label: "Start", format: "dateTime" },
                { key: "endDate", label: "End", format: "dateTime" },
                { key: "statusLabel", label: "Status" }
            ],
            rowMapper: (document) =>
            {
                const startDate = document.startDate ? new Date(document.startDate) : null;
                const endDate = document.endDate ? new Date(document.endDate) : null;
                const now = new Date();

                let statusLabel = "Invalid";
                if (startDate && endDate && !isNaN(startDate.getTime()) && !isNaN(endDate.getTime()))
                {
                    if (now >= startDate && now < endDate)
                    {
                        statusLabel = "Active";
                    }
                    else if (now < startDate)
                    {
                        statusLabel = "Upcoming";
                    }
                    else
                    {
                        statusLabel = "Past";
                    }
                }

                return {
                    id: document.id,
                    title: document.title || "",
                    startDate: document.startDate || null,
                    endDate: document.endDate || null,
                    message: document.message || "",
                    statusLabel: statusLabel
                };
            },
            defaultSort: { field: "startDate", direction: 1 },
            sortableFields: ["startDate", "endDate"],
            rowIdField: "id"
        }));

        // ── Revenue by deck (aggregation over purchases) ───────────────────
        AdminListRegistry.register(new AdminListDefinition
        ({
            listKey: adminListTypes.REVENUE_BY_DECK,
            searchableFields: ["deckId"],
            searchPlaceholder: "Search deck id…",
            filters:
            [
                new DateRangeFilter({ key: "purchaseDate", label: "Purchase date", field: "purchaseDate" })
            ],
            columns:
            [
                { key: "deckId", label: "Deck ID" },
                { key: "purchaseCount", label: "Purchases" },
                { key: "totalMinor", label: "Total (minor units — e.g. 100 = 1.00)" }
            ],
            defaultSort: { field: "totalMinor", direction: -1 },
            sortableFields: ["totalMinor", "purchaseCount"],
            rowIdField: "deckId",
            customQueryBuilder: async (database, parameters) =>
            {
                // purchaseDate is stored as an ISO STRING (Purchase.toJson), so
                // the range must compare string-to-string, not Date-to-string.
                const dateRange = parameters.filters?.purchaseDate || {};
                const fromIso = dateRange.from ? new Date(dateRange.from).toISOString() : new Date(0).toISOString();
                const toIso = dateRange.to ? new Date(dateRange.to).toISOString() : new Date().toISOString();

                const matchStage = { status: purchaseStatuses.COMPLETED, purchaseDate: { $gte: fromIso, $lte: toIso } };
                if (typeof parameters.search === "string" && parameters.search.trim().length > 0)
                {
                    matchStage.deckId = { $regex: AdminListRegistry.#escapeRegex(parameters.search.trim()), $options: "i" };
                }

                const sortField = parameters.sort?.field === "purchaseCount" ? "purchaseCount" : "totalMinor";
                const sortDirection = parameters.sort?.direction === 1 ? 1 : -1;

                const pipeline =
                [
                    { $match: matchStage },
                    { $group: { _id: "$deckId", purchaseCount: { $sum: 1 }, totalMinor: { $sum: "$amountMinor" } } },
                    { $sort: { [sortField]: sortDirection } },
                    { $facet:
                        {
                            rows: [ { $skip: parameters.offset }, { $limit: parameters.limit } ],
                            total: [ { $count: "count" } ]
                        }
                    }
                ];

                const aggregated = await database.collection(DatabaseConstants.PURCHASES_COLLECTION).aggregate(pipeline).toArray();
                const facet = aggregated[0] || { rows: [], total: [] };
                const items = (facet.rows || []).map(row =>
                ({
                    deckId: row._id,
                    purchaseCount: row.purchaseCount,
                    totalMinor: row.totalMinor
                }));

                return { items: items, totalCount: facet.total?.[0]?.count || 0 };
            }
        }));

        // ── Organizations (enriched with perk count + last payment) ────────
        AdminListRegistry.register(new AdminListDefinition
        ({
            listKey: adminListTypes.ORGANIZATIONS,
            searchableFields: ["name", "adminEmail"],
            searchPlaceholder: "Search name or admin email…",
            filters:
            [
                new EnumFilter
                ({
                    key: "status",
                    label: "Status",
                    field: "status",
                    options:
                    [
                        { value: organizationStatus.PENDING_PAYMENT, label: "Pending payment" },
                        { value: organizationStatus.ACTIVE, label: "Active" },
                        { value: organizationStatus.SUSPENDED, label: "Suspended" }
                    ]
                }),
                new DateRangeFilter({ key: "creationDate", label: "Created", field: "creationDate" })
            ],
            columns:
            [
                { key: "name", label: "Name" },
                { key: "adminEmail", label: "Admin email" },
                { key: "statusLabel", label: "Status" },
                { key: "membersLabel", label: "Members" },
                { key: "creationDate", label: "Created", format: "date" },
                { key: "perkCount", label: "Perks" },
                { key: "lastPaymentLabel", label: "Last payment" }
            ],
            defaultSort: { field: "creationDate", direction: -1 },
            sortableFields: ["creationDate", "name"],
            rowIdField: "id",
            customQueryBuilder: async (database, parameters) =>
            {
                const collection = database.collection(DatabaseConstants.ORGANIZATIONS_COLLECTION);

                const queryParts = [];
                if (typeof parameters.search === "string" && parameters.search.trim().length > 0)
                {
                    const pattern = AdminListRegistry.#escapeRegex(parameters.search.trim());
                    queryParts.push({ $or: [ { name: { $regex: pattern, $options: "i" } }, { adminEmail: { $regex: pattern, $options: "i" } } ] });
                }

                const statusValue = parameters.filters?.status;
                if (statusValue !== undefined && statusValue !== null && statusValue !== "")
                {
                    queryParts.push({ status: statusValue });
                }

                const creationRange = parameters.filters?.creationDate;
                if (creationRange && (creationRange.from || creationRange.to))
                {
                    // Organization.creationDate is persisted as an ISO string, so
                    // the bounds must be compared string-to-string.
                    const rangeClause = {};
                    if (creationRange.from)
                    {
                        rangeClause.$gte = new Date(creationRange.from).toISOString();
                    }
                    if (creationRange.to)
                    {
                        rangeClause.$lte = new Date(creationRange.to).toISOString();
                    }
                    queryParts.push({ creationDate: rangeClause });
                }

                const mongoQuery = queryParts.length === 0 ? {} : { $and: queryParts };
                const sortField = parameters.sort?.field || "creationDate";
                const sortDirection = parameters.sort?.direction === 1 ? 1 : -1;

                const totalCount = await collection.countDocuments(mongoQuery);
                const documents = await collection.find(mongoQuery).sort({ [sortField]: sortDirection }).skip(parameters.offset).limit(parameters.limit).toArray();

                const items = [];
                for (const document of documents)
                {
                    delete document._id;
                    const perks = await OrganizationDeckPerkQueryEngine.listPerksForOrganization(document.id);
                    const payments = await OrganizationPaymentQueryEngine.listForOrganization(document.id);
                    const lastPaymentStatus = payments.length > 0 ? payments[0].getStatus() : null;

                    items.push
                    ({
                        id: document.id,
                        name: document.name,
                        adminEmail: document.adminEmail,
                        status: document.status,
                        statusLabel: AdminListRegistry.#ORGANIZATION_STATUS_LABELS[document.status] || String(document.status),
                        membersLabel: `${document.currentMemberCount || 0} / ${document.maxMembers || 0}`,
                        creationDate: document.creationDate || null,
                        perkCount: perks.length,
                        lastPaymentLabel: lastPaymentStatus !== null ? (AdminListRegistry.#PAYMENT_STATUS_LABELS[lastPaymentStatus] || String(lastPaymentStatus)) : ""
                    });
                }

                return { items: items, totalCount: totalCount };
            }
        }));

        // ── Promo codes ────────────────────────────────────────────────────
        // Collection-backed: the displayed used count is the stored usedCount
        // field — the very counter claimRedemptionSlot enforces the cap against
        // — so the table's "Used / Remaining" always agrees with whether a code
        // can still be redeemed. createdAt is a BSON Date (default range mode).
        AdminListRegistry.register(new AdminListDefinition
        ({
            listKey: adminListTypes.PROMO_CODES,
            collectionName: DatabaseConstants.PROMO_CODES_COLLECTION,
            searchableFields: ["codeString"],
            searchPlaceholder: "Search code…",
            filters:
            [
                new BooleanFilter({ key: "enabled", label: "Enabled", field: "enabled" }),
                new DateRangeFilter({ key: "createdAt", label: "Created", field: "createdAt" })
            ],
            columns:
            [
                { key: "codeString", label: "Code" },
                { key: "maxRedemptions", label: "Max redemptions" },
                { key: "usedCount", label: "Used" },
                { key: "remaining", label: "Remaining" },
                { key: "statusLabel", label: "Status" },
                { key: "createdAt", label: "Created", format: "date" }
            ],
            rowMapper: (document) =>
            {
                const usedCount = document.usedCount || 0;
                const maxRedemptions = document.maxRedemptions || 0;
                return {
                    id: document.id,
                    codeString: document.codeString,
                    maxRedemptions: maxRedemptions,
                    usedCount: usedCount,
                    remaining: Math.max(maxRedemptions - usedCount, 0),
                    enabled: !!document.enabled,
                    statusLabel: document.enabled ? "Enabled" : "Disabled",
                    createdAt: document.createdAt || null
                };
            },
            defaultSort: { field: "createdAt", direction: -1 },
            sortableFields: ["createdAt", "usedCount"],
            rowIdField: "id"
        }));

        // ── Promo-code redeemers (scoped to one code via context) ──────────
        AdminListRegistry.register(new AdminListDefinition
        ({
            listKey: adminListTypes.PROMO_CODE_REDEEMERS,
            searchableFields: ["email", "userId"],
            searchPlaceholder: "Search email or user id…",
            filters:
            [
                new DateRangeFilter({ key: "redeemedAt", label: "Redeemed", field: "redeemedAt" })
            ],
            columns:
            [
                { key: "email", label: "Email" },
                { key: "userId", label: "User ID" },
                { key: "creditsGranted", label: "Credits" },
                { key: "redeemedAt", label: "Redeemed", format: "dateTime" }
            ],
            rowIdField: "id",
            customQueryBuilder: async (database, parameters) =>
            {
                const promoCodeId = parameters.context?.promoCodeId;
                if (typeof promoCodeId !== "string" || promoCodeId.length === 0)
                {
                    return { items: [], totalCount: 0 };
                }

                const collection = database.collection(DatabaseConstants.PROMO_CODE_REDEMPTIONS_COLLECTION);
                const queryParts = [ { promoCodeId: promoCodeId } ];

                if (typeof parameters.search === "string" && parameters.search.trim().length > 0)
                {
                    const pattern = AdminListRegistry.#escapeRegex(parameters.search.trim());
                    queryParts.push({ $or: [ { email: { $regex: pattern, $options: "i" } }, { userId: { $regex: pattern, $options: "i" } } ] });
                }

                const redeemedRange = parameters.filters?.redeemedAt;
                if (redeemedRange && (redeemedRange.from || redeemedRange.to))
                {
                    const rangeClause = {};
                    if (redeemedRange.from)
                    {
                        rangeClause.$gte = new Date(redeemedRange.from);
                    }
                    if (redeemedRange.to)
                    {
                        rangeClause.$lte = new Date(redeemedRange.to);
                    }
                    queryParts.push({ redeemedAt: rangeClause });
                }

                const mongoQuery = { $and: queryParts };
                const totalCount = await collection.countDocuments(mongoQuery);
                const documents = await collection.find(mongoQuery).sort({ redeemedAt: -1 }).skip(parameters.offset).limit(parameters.limit).toArray();

                const items = documents.map(document =>
                ({
                    id: document.id,
                    email: document.email || "",
                    userId: document.userId || "",
                    creditsGranted: document.creditsGranted || 0,
                    redeemedAt: document.redeemedAt || null
                }));

                return { items: items, totalCount: totalCount };
            }
        }));

        // ── Coupons ────────────────────────────────────────────────────────
        // Collection-backed; the displayed used count is the stored usedCount
        // field claimRedemptionSlot enforces the cap against, so "Used /
        // Remaining" always agrees with whether a coupon can still be redeemed.
        AdminListRegistry.register(new AdminListDefinition
        ({
            listKey: adminListTypes.COUPONS,
            collectionName: DatabaseConstants.COUPONS_COLLECTION,
            searchableFields: ["codeString"],
            searchPlaceholder: "Search code…",
            filters:
            [
                new BooleanFilter({ key: "enabled", label: "Enabled", field: "enabled" }),
                new DateRangeFilter({ key: "createdAt", label: "Created", field: "createdAt" })
            ],
            columns:
            [
                { key: "codeString", label: "Code" },
                { key: "benefitLabel", label: "Benefit" },
                { key: "maxRedemptions", label: "Max redemptions" },
                { key: "usedCount", label: "Used" },
                { key: "remaining", label: "Remaining" },
                { key: "statusLabel", label: "Status" },
                { key: "createdAt", label: "Created", format: "date" }
            ],
            rowMapper: (document) =>
            {
                const usedCount = document.usedCount || 0;
                const maxRedemptions = document.maxRedemptions || 0;
                const benefitTargetLabels =
                {
                    [couponBenefitTargets.CREDIT_PURCHASE_DISCOUNT]: "Credit-purchase discount",
                    [couponBenefitTargets.PLAN_DISCOUNT]: "Plan discount",
                    [couponBenefitTargets.GRANT_CREDITS]: "Grant credits",
                    [couponBenefitTargets.GRANT_FREE_PLAN]: "Free plan",
                    [couponBenefitTargets.GRANT_FREE_DECK]: "Free deck"
                };
                return {
                    id: document.id,
                    codeString: document.codeString,
                    benefitLabel: benefitTargetLabels[document.benefitTarget] || "—",
                    maxRedemptions: maxRedemptions,
                    usedCount: usedCount,
                    remaining: Math.max(maxRedemptions - usedCount, 0),
                    enabled: !!document.enabled,
                    statusLabel: document.enabled ? "Enabled" : "Disabled",
                    createdAt: document.createdAt || null
                };
            },
            defaultSort: { field: "createdAt", direction: -1 },
            sortableFields: ["createdAt", "usedCount"],
            rowIdField: "id"
        }));

        // ── Coupon redeemers (scoped to one coupon via context) ────────────
        AdminListRegistry.register(new AdminListDefinition
        ({
            listKey: adminListTypes.COUPON_REDEEMERS,
            searchableFields: ["email", "userId"],
            searchPlaceholder: "Search email or user id…",
            filters:
            [
                new DateRangeFilter({ key: "redeemedAt", label: "Redeemed", field: "redeemedAt" })
            ],
            columns:
            [
                { key: "email", label: "Email" },
                { key: "userId", label: "User ID" },
                { key: "grantedSummary", label: "Granted" },
                { key: "redeemedAt", label: "Redeemed", format: "dateTime" }
            ],
            rowIdField: "id",
            customQueryBuilder: async (database, parameters) =>
            {
                const couponId = parameters.context?.couponId;
                if (typeof couponId !== "string" || couponId.length === 0)
                {
                    return { items: [], totalCount: 0 };
                }

                const collection = database.collection(DatabaseConstants.COUPON_REDEMPTIONS_COLLECTION);
                const queryParts = [ { couponId: couponId } ];

                if (typeof parameters.search === "string" && parameters.search.trim().length > 0)
                {
                    const pattern = AdminListRegistry.#escapeRegex(parameters.search.trim());
                    queryParts.push({ $or: [ { email: { $regex: pattern, $options: "i" } }, { userId: { $regex: pattern, $options: "i" } } ] });
                }

                const redeemedRange = parameters.filters?.redeemedAt;
                if (redeemedRange && (redeemedRange.from || redeemedRange.to))
                {
                    const rangeClause = {};
                    if (redeemedRange.from)
                    {
                        rangeClause.$gte = new Date(redeemedRange.from);
                    }
                    if (redeemedRange.to)
                    {
                        rangeClause.$lte = new Date(redeemedRange.to);
                    }
                    queryParts.push({ redeemedAt: rangeClause });
                }

                const mongoQuery = { $and: queryParts };
                const totalCount = await collection.countDocuments(mongoQuery);
                const documents = await collection.find(mongoQuery).sort({ redeemedAt: -1 }).skip(parameters.offset).limit(parameters.limit).toArray();

                const items = documents.map(document =>
                ({
                    id: document.id,
                    email: document.email || "",
                    userId: document.userId || "",
                    grantedSummary: document.grantedSummary || "",
                    redeemedAt: document.redeemedAt || null
                }));

                return { items: items, totalCount: totalCount };
            }
        }));

        // ── Logs (central application log) ──────────────────────────────────
        // Backed directly by the logEvents collection. Requirement 5's "filter
        // one or more log levels" is a MultiSelectFilter (→ level $in); the date
        // range and category are the other two filters. timestamp is a BSON Date
        // so DateRangeFilter compares natively.
        AdminListRegistry.register(new AdminListDefinition
        ({
            listKey: adminListTypes.LOGS,
            collectionName: DatabaseConstants.LOG_EVENTS_COLLECTION,
            searchableFields: ["title", "message", "accountId", "errorCode"],
            searchPlaceholder: "Search title, message, account or error code…",
            filters:
            [
                new MultiSelectFilter
                ({
                    key: "level",
                    label: "Level",
                    field: "level",
                    options:
                    [
                        { value: logLevel.DEBUG, label: "Debug" },
                        { value: logLevel.INFO, label: "Info" },
                        { value: logLevel.WARNING, label: "Warning" },
                        { value: logLevel.ERROR, label: "Error" }
                    ]
                }),
                new EnumFilter
                ({
                    key: "category",
                    label: "Category",
                    field: "category",
                    options:
                    [
                        { value: logCategory.SYSTEM, label: "System" },
                        { value: logCategory.AUTHENTICATION, label: "Authentication" },
                        { value: logCategory.AI_REQUEST, label: "AI request" },
                        { value: logCategory.PURCHASE, label: "Purchase" },
                        { value: logCategory.EVENT, label: "Event" },
                        { value: logCategory.ERROR, label: "Error" }
                    ]
                }),
                new DateRangeFilter({ key: "timestamp", label: "When", field: "timestamp" })
            ],
            columns:
            [
                { key: "timestamp", label: "When", format: "dateTime" },
                { key: "level", label: "Level", badge:
                    {
                        [logLevel.DEBUG]: { label: "DEBUG", variant: "neutral" },
                        [logLevel.INFO]: { label: "INFO", variant: "info" },
                        [logLevel.WARNING]: { label: "WARNING", variant: "warning" },
                        [logLevel.ERROR]: { label: "ERROR", variant: "danger" }
                    }
                },
                { key: "category", label: "Category" },
                { key: "service", label: "Service" },
                { key: "title", label: "Title" },
                { key: "accountId", label: "Account" },
                { key: "message", label: "Message" },
                { key: "errorCode", label: "Error" }
            ],
            rowMapper: (document) =>
            {
                const rawMessage = typeof document.message === "string" ? document.message : "";
                return {
                    id: document.id,
                    timestamp: document.timestamp || null,
                    level: document.level,
                    category: LOG_CATEGORY_NAME_BY_VALUE[document.category] || "",
                    service: LOG_SERVICE_NAME_BY_VALUE[document.service] || "",
                    title: document.title || "",
                    accountId: document.accountId || "",
                    message: rawMessage.length > 200 ? `${rawMessage.slice(0, 200)}…` : rawMessage,
                    errorCode: document.errorCode || ""
                };
            },
            defaultSort: { field: "timestamp", direction: -1 },
            sortableFields: ["timestamp", "level"],
            rowIdField: "id"
        }));

        // ── Support tickets (deduplicated issue reports) ─────────────────────
        // Sorted by reportCount descending by default: the whole point of
        // deduplicating reports is that the row at the top is the problem hurting
        // the most users, which is the one worth fixing first. createdAtIsoString
        // is the denormalised copy of createdAt (stored as UTC milliseconds) that
        // lets DateRangeFilter compare as a string.
        AdminListRegistry.register(new AdminListDefinition
        ({
            listKey: adminListTypes.SUPPORT_TICKETS,
            collectionName: DatabaseConstants.SUPPORT_TICKETS_COLLECTION,
            searchableFields: ["title", "description", "id"],
            searchPlaceholder: "Search title, description or id…",
            filters:
            [
                new EnumFilter
                ({
                    key: "status",
                    label: "Status",
                    field: "status",
                    options:
                    [
                        { value: supportTicketStatus.ACTIVE, label: "Active" },
                        { value: supportTicketStatus.RESOLVED, label: "Resolved" },
                        { value: supportTicketStatus.DECLINED, label: "Declined" }
                    ]
                }),
                new EnumFilter
                ({
                    key: "issueType",
                    label: "Issue type",
                    field: "issueType",
                    options: Object.values(supportTicketTypes)
                        .filter(typeValue => typeValue !== supportTicketTypes.UNKNOWN)
                        .map(typeValue => ({ value: typeValue, label: supportTicketTypeDisplayName(typeValue) }))
                }),
                new NumberRangeFilter({ key: "reportCount", label: "Reporters", field: "reportCount", defaultMin: 0, defaultMax: 500, step: 1 }),
                new DateRangeFilter({ key: "createdAt", label: "First reported", field: "createdAtIsoString", compareAsIsoString: true })
            ],
            columns:
            [
                { key: "title", label: "Issue" },
                { key: "issueTypeLabel", label: "Type" },
                { key: "status", label: "Status", badge:
                    {
                        [supportTicketStatus.ACTIVE]: { label: "ACTIVE", variant: "warning" },
                        [supportTicketStatus.RESOLVED]: { label: "RESOLVED", variant: "info" },
                        [supportTicketStatus.DECLINED]: { label: "DECLINED", variant: "neutral" }
                    }
                },
                { key: "reportCount", label: "Reporters" },
                { key: "createdAt", label: "First reported", format: "dateTime" },
                { key: "lastReportedAt", label: "Last reported", format: "dateTime" }
            ],
            rowMapper: (document) =>
            {
                const aspectCount = Array.isArray(document.aspects) ? document.aspects.length : 0;
                const rawTitle = typeof document.title === "string" && document.title.length > 0 ? document.title : "(untitled)";

                return {
                    id: document.id,
                    // Saturation is surfaced in the title rather than a separate
                    // column: it means the grouping has stopped absorbing detail
                    // and wants a human split, which an admin should notice while
                    // scanning rather than have to go looking for.
                    title: aspectCount >= SupportTicketLimits.MAXIMUM_ASPECTS_PER_TICKET ? `${rawTitle} ⚠` : rawTitle,
                    issueTypeLabel: supportTicketTypeDisplayName(document.issueType),
                    issueType: document.issueType,
                    status: document.status,
                    reportCount: document.reportCount || 0,
                    createdAt: document.createdAt ? new Date(document.createdAt) : null,
                    lastReportedAt: document.lastReportedAt ? new Date(document.lastReportedAt) : null
                };
            },
            defaultSort: { field: "reportCount", direction: -1 },
            sortableFields: ["reportCount", "createdAt", "lastReportedAt"],
            rowIdField: "id"
        }));

        // ── Ungrouped support reports ────────────────────────────────────────
        // Reports that never reached a ticket: the deduplication task failed, the
        // queue was unavailable, or the workflow could not take the dedup lock.
        // Without this list such a report is durable in Mongo but visible to
        // nobody except its reporter, who would see "Under review" forever. This
        // is the surface that makes a grouping failure recoverable rather than
        // merely survivable. Backed by the (groupingStatus, createdAt) index.
        AdminListRegistry.register(new AdminListDefinition
        ({
            listKey: adminListTypes.SUPPORT_UNGROUPED_REPORTS,
            searchPlaceholder: "Search description, reporter or id…",
            searchableFields: ["description"],
            filters:
            [
                new EnumFilter
                ({
                    key: "groupingStatus",
                    label: "Grouping",
                    field: "groupingStatus",
                    options:
                    [
                        { value: supportTicketReportStatus.PENDING_GROUPING, label: "Still pending" },
                        { value: supportTicketReportStatus.GROUPING_FAILED, label: "Failed" }
                    ]
                })
            ],
            columns:
            [
                { key: "createdAt", label: "Reported", format: "dateTime" },
                { key: "userEmail", label: "Reporter" },
                { key: "issueTypeLabel", label: "Type" },
                { key: "groupingStatusLabel", label: "Grouping" },
                { key: "description", label: "What they said" },
                { key: "attachmentCount", label: "Files" }
            ],
            // A custom builder rather than a collection-backed definition because
            // this list needs a permanent base predicate ("not attached to any
            // ticket"), which the collection-backed mode has no way to express —
            // there is no baseFilter option, and without one the list would
            // silently show every report ever submitted.
            customQueryBuilder: async (database, parameters) =>
            {
                const collection = database.collection(DatabaseConstants.SUPPORT_TICKET_REPORTS_COLLECTION);

                const queryParts =
                [
                    { $or: [ { ticketId: null }, { groupingStatus: supportTicketReportStatus.GROUPING_FAILED } ] }
                ];

                if (typeof parameters.search === "string" && parameters.search.trim().length > 0)
                {
                    const pattern = AdminListRegistry.#escapeRegex(parameters.search.trim());
                    queryParts.push({ $or: [ { description: { $regex: pattern, $options: "i" } }, { userEmail: { $regex: pattern, $options: "i" } }, { id: pattern } ] });
                }

                const groupingStatusValue = parameters.filters?.groupingStatus;
                if (groupingStatusValue !== undefined && groupingStatusValue !== null && groupingStatusValue !== "")
                {
                    queryParts.push({ groupingStatus: Number(groupingStatusValue) });
                }

                const mongoQuery = { $and: queryParts };
                const sortDirection = parameters.sort?.direction === 1 ? 1 : -1;

                const totalCount = await collection.countDocuments(mongoQuery);
                const documents = await collection.find(mongoQuery, { projection: { _id: 0 } })
                    .sort({ createdAt: sortDirection })
                    .skip(parameters.offset)
                    .limit(parameters.limit)
                    .toArray();

                const items = documents.map((document) =>
                {
                    const rawDescription = typeof document.description === "string" ? document.description : "";

                    return {
                        id: document.id,
                        createdAt: document.createdAt ? new Date(document.createdAt) : null,
                        userEmail: document.userEmail || document.userId || "",
                        issueTypeLabel: supportTicketTypeDisplayName(document.issueType),
                        groupingStatusLabel: document.groupingStatus === supportTicketReportStatus.GROUPING_FAILED ? "Failed" : "Pending",
                        description: rawDescription.length > 200 ? `${rawDescription.slice(0, 200)}…` : rawDescription,
                        attachmentCount: Array.isArray(document.attachments) ? document.attachments.length : 0
                    };
                });

                return { items: items, totalCount: totalCount };
            },
            defaultSort: { field: "createdAt", direction: -1 },
            sortableFields: ["createdAt"],
            rowIdField: "id"
        }));
    }
}

module.exports = AdminListRegistry;
