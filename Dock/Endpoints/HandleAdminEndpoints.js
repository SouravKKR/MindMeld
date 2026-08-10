const { PacketronHandlerFlags, PacketronRequestMethod } = require("@gamiumgamers/packetron");
const { handleGetShadowStats } = require("./Admin/GetShadowStats");
const { uploadPaidDeck } = require("./Admin/UploadPaidDeck");
const { updatePaidDeck } = require("./Admin/UpdatePaidDeck");
const { setPaidDeckPricing } = require("./Admin/SetPaidDeckPricing");
const { setPaidDeckBundle } = require("./Admin/SetPaidDeckBundle");
const { rotatePaidDeckKey } = require("./Admin/RotatePaidDeckKey");
const { rotatePaidDeckContentKey } = require("./Admin/RotatePaidDeckContentKey");
const { getRevenueStats } = require("./Admin/GetRevenueStats");
const { listPaidDecks } = require("./Admin/ListPaidDecks");
const { downloadAuditTrail } = require("./Admin/PaidDecks/DownloadAuditTrail");
const { getGenerationProvenance } = require("./Admin/PaidDecks/GetGenerationProvenance");
const { resolveVerificationFlag } = require("./Admin/PaidDecks/ResolveVerificationFlag");
const { autoFixFlagProposal } = require("./Admin/PaidDecks/AutoFixFlagProposal");
const { autoFixFlagApply } = require("./Admin/PaidDecks/AutoFixFlagApply");
const { downloadRefinementProofSource } = require("./Admin/PaidDecks/DownloadRefinementProofSource");
const { downloadVerificationSource } = require("./Admin/PaidDecks/DownloadVerificationSource");
const {
    listVerificationSources,
    attachVerificationSource,
    updateVerificationSource,
    detachVerificationSource,
    runVerificationAgainstSources,
    getVerificationRunStatus,
} = require("./Admin/PaidDecks/VerificationSources");
const { setUserRole } = require("./Admin/SetUserRole");
const { setUserStreak } = require("./Admin/Streak/SetUserStreak");
const { bulkUpdatePaidDecks } = require("./Admin/BulkUpdatePaidDecks");
const { generatePaidDeckField } = require("./Admin/GeneratePaidDeckField");
const { listAdminEmails } = require("./Admin/AdminEmails/ListAdminEmails");
const { addAdminEmail } = require("./Admin/AdminEmails/AddAdminEmail");
const { removeAdminEmail } = require("./Admin/AdminEmails/RemoveAdminEmail");
const { listAllowedEmails } = require("./Admin/AllowedEmails/ListAllowedEmails");
const { addAllowedEmail } = require("./Admin/AllowedEmails/AddAllowedEmail");
const { removeAllowedEmail } = require("./Admin/AllowedEmails/RemoveAllowedEmail");
const { createReleaseNote } = require("./Admin/ReleaseNotes/CreateReleaseNote");
const { updateReleaseNote } = require("./Admin/ReleaseNotes/UpdateReleaseNote");
const { deleteReleaseNote } = require("./Admin/ReleaseNotes/DeleteReleaseNote");
const { listReleaseNotesAdmin } = require("./Admin/ReleaseNotes/ListReleaseNotesAdmin");
const { listMaintenanceWindows } = require("./Admin/Maintenance/ListMaintenanceWindows");
const { addMaintenanceWindow } = require("./Admin/Maintenance/AddMaintenanceWindow");
const { updateMaintenanceWindow } = require("./Admin/Maintenance/UpdateMaintenanceWindow");
const { removeMaintenanceWindow } = require("./Admin/Maintenance/RemoveMaintenanceWindow");
const { downloadLogs } = require("./Admin/Logs/DownloadLogs");
const { getSupportTicket } = require("./Admin/Support/GetSupportTicket");
const { resolveSupportTicket } = require("./Admin/Support/ResolveSupportTicket");
const { declineSupportTicket } = require("./Admin/Support/DeclineSupportTicket");
const { downloadSupportAttachment } = require("./Admin/Support/DownloadSupportAttachment");
const { downloadSupportReportLogs } = require("./Admin/Support/DownloadSupportReportLogs");
const { streamLogs } = require("./Admin/Logs/StreamLogs");
const { getLogConfiguration } = require("./Admin/Logs/GetLogConfiguration");
const { setLogConfiguration } = require("./Admin/Logs/SetLogConfiguration");
const { sendAdminVerificationOtp } = require("./Organization/SendAdminVerificationOtp");
const { verifyAdminVerificationOtp } = require("./Organization/VerifyAdminVerificationOtp");
const { createOrganization } = require("./Organization/CreateOrganization");
const { listOrganizations } = require("./Organization/ListOrganizations");
const { getOrganization } = require("./Organization/GetOrganization");
const { updateOrganizationPerks } = require("./Organization/UpdateOrganizationPerks");
const { deleteOrganization } = require("./Organization/DeleteOrganization");
const { listAlerts } = require("./Admin/Alerts/ListAlerts");
const { acknowledgeAlert } = require("./Admin/Alerts/AcknowledgeAlert");
const { deleteAlert } = require("./Admin/Alerts/DeleteAlert");
const { listReconciliations } = require("./Admin/Reconciliation/ListReconciliations");
const { recordAccountingTotals } = require("./Admin/Reconciliation/RecordAccountingTotals");
const { exportJournal } = require("./Admin/Reconciliation/ExportJournal");
const { listRateLimitEvents } = require("./Admin/RateLimits/ListRateLimitEvents");
const { listAdminAuditEvents } = require("./Admin/Audit/ListAdminAuditEvents");
const { takedownContent } = require("./Admin/Content/TakedownContent");
const { listContentTakedownNotices } = require("./Admin/Content/ListContentTakedownNotices");
const { listIntellectualPropertyComplaints } = require("./Admin/Legal/ListIntellectualPropertyComplaints");
const { resolveIntellectualPropertyComplaintTargets } = require("./Admin/Legal/ResolveIntellectualPropertyComplaintTargets");
const { updateIntellectualPropertyComplaintStatus } = require("./Admin/Legal/UpdateIntellectualPropertyComplaintStatus");
const { getCreditConfig } = require("./Admin/GetCreditConfig");
const { setCreditConfig } = require("./Admin/SetCreditConfig");
const { previewCreditGrant } = require("./Admin/PreviewCreditGrant");
const { applyCreditGrant } = require("./Admin/ApplyCreditGrant");
const { createPeriodicAssignment } = require("./Admin/Periodic/CreatePeriodicAssignment");
const { listPeriodicAssignments } = require("./Admin/Periodic/ListPeriodicAssignments");
const { terminatePeriodicAssignment } = require("./Admin/Periodic/TerminatePeriodicAssignment");
const { deletePeriodicAssignment } = require("./Admin/Periodic/DeletePeriodicAssignment");
const { getPeriodicAssignmentReport } = require("./Admin/Periodic/GetPeriodicAssignmentReport");
const { createDealPayment } = require("./Admin/Deals/CreateDealPayment");
const { createOrganizationCreditDeal } = require("./Admin/Deals/CreateOrganizationCreditDeal");
const { verifyDealPayment } = require("./Admin/Deals/VerifyDealPayment");
const { uploadDealInvoice } = require("./Admin/Deals/UploadDealInvoice");
const { downloadDealInvoice } = require("./Admin/Deals/DownloadDealInvoice");
const { listDealPayments } = require("./Admin/Deals/ListDealPayments");
const { renameOrganization } = require("./Organization/RenameOrganization");
const { setOrganizationMaxMembers } = require("./Organization/SetOrganizationMaxMembers");
const { setOrganizationEntitlementLimits } = require("./Organization/SetOrganizationEntitlementLimits");
const { setOrganizationTerm } = require("./Organization/SetOrganizationTerm");
const { retirePaidDeck } = require("./Admin/RetirePaidDeck");
const { deletePaidDeck } = require("./Admin/DeletePaidDeck");
const { createPromoCode } = require("./Admin/PromoCodes/CreatePromoCode");
const { createPromoCodesBulk } = require("./Admin/PromoCodes/CreatePromoCodesBulk");
const { setPromoCodeEnabled } = require("./Admin/PromoCodes/SetPromoCodeEnabled");
const { deletePromoCode } = require("./Admin/PromoCodes/DeletePromoCode");
const { createCoupon } = require("./Admin/Coupons/CreateCoupon");
const { createCouponsBulk } = require("./Admin/Coupons/CreateCouponsBulk");
const { setCouponEnabled } = require("./Admin/Coupons/SetCouponEnabled");
const { deleteCoupon } = require("./Admin/Coupons/DeleteCoupon");
const { getPlanFeatureConfig } = require("./Admin/Plans/GetPlanFeatureConfig");
const { setPlanFeatureConfig } = require("./Admin/Plans/SetPlanFeatureConfig");
const { getAdminListMetadata } = require("./Admin/Lists/GetAdminListMetadata");
const { queryAdminList } = require("./Admin/Lists/QueryAdminList");
const { ensureAdmin } = require("./Plugins/EnsureAdmin");

function handleAdminEndpoints(server)
{
    server.handle
    ({
        routePath: `/Admin/Streak/SetUserStreak`,
        handler: setUserStreak,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/ShadowStats`,
        handler: handleGetShadowStats,
        method: PacketronRequestMethod.GET,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/PaidDecks/List`,
        handler: listPaidDecks,
        method: PacketronRequestMethod.GET,
        plugins: [ensureAdmin]
    });

    // Content takedown — actions a rightsholder infringement notice against one
    // content-addressed upload, removing it for every tenant that shares it.
    server.handle
    ({
        routePath: `/Admin/Content/Takedown`,
        handler: takedownContent,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Content/TakedownNotices`,
        handler: listContentTakedownNotices,
        method: PacketronRequestMethod.GET,
        plugins: [ensureAdmin]
    });

    // ── Intellectual-property complaints ──────────────────────────────────
    //
    // The Grievance Officer's queue and the bridge from a complaint to the
    // takedown machinery above. Registered here rather than beside the public
    // complaint routes in HandleLegalEndpoints so they inherit ensureAdmin AND
    // the AdminActionAuditor coverage that plugin attaches — reading a
    // complainant's details is exactly the kind of access that should leave a
    // trace.
    server.handle
    ({
        routePath: `/Admin/Legal/ListIntellectualPropertyComplaints`,
        handler: listIntellectualPropertyComplaints,
        method: PacketronRequestMethod.GET,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Legal/ResolveIntellectualPropertyComplaintTargets`,
        handler: resolveIntellectualPropertyComplaintTargets,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Legal/UpdateIntellectualPropertyComplaintStatus`,
        handler: updateIntellectualPropertyComplaintStatus,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    // ── Paid-deck generation provenance (review gate + audit trail) ────────
    //
    // These three sit behind ensureAdmin, so AdminActionAuditor already records
    // every call — including the audit-trail download itself, which is exactly
    // the kind of access that should leave a trace.

    // The review gate's data source: the provenance record plus the current
    // publish decision, so the panel never re-implements the gate's rule.
    server.handle
    ({
        routePath: `/Admin/PaidDecks/Provenance`,
        handler: getGenerationProvenance,
        method: PacketronRequestMethod.GET,
        plugins: [ensureAdmin]
    });

    // The only way a blocking verification flag stops blocking. Appends a named,
    // timestamped decision beside the flag; never edits or removes the flag.
    server.handle
    ({
        routePath: `/Admin/PaidDecks/ResolveVerificationFlag`,
        handler: resolveVerificationFlag,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    // The audit-trail PDF. No filter parameter by design — the report is
    // all-or-nothing, because a selectively-filtered audit trail is not one.
    server.handle
    ({
        routePath: `/Admin/PaidDecks/AuditTrail`,
        handler: downloadAuditTrail,
        method: PacketronRequestMethod.GET,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/PaidDecks/Upload`,
        handler: uploadPaidDeck,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/PaidDecks/Update`,
        handler: updatePaidDeck,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/PaidDecks/GenerateField`,
        handler: generatePaidDeckField,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    // Verification auto-fix. Two steps on purpose: the first PROPOSES a
    // correction for one flag and writes nothing, the second applies what an
    // administrator approved. Neither clears the flag — resolving it stays a
    // separate decision through ResolveVerificationFlag below, which is what
    // keeps the review gate from answering itself.
    server.handle
    ({
        routePath: `/Admin/PaidDecks/AutoFixFlagProposal`,
        handler: autoFixFlagProposal,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/PaidDecks/AutoFixFlagApply`,
        handler: autoFixFlagApply,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    // The reference document a correction was made against, as recorded on the
    // refinement. Reached from the audit trail; the storage path is rebuilt from
    // the stored row and is never taken from the request.
    server.handle
    ({
        routePath: `/Admin/PaidDecks/RefinementProofSource`,
        handler: downloadRefinementProofSource,
        method: PacketronRequestMethod.GET,
        plugins: [ensureAdmin]
    });

    // The document a paid deck was checked against, or written from, as recorded
    // on its verification-source row. Same rule as above: the storage path is
    // rebuilt from the stored information-source row and never taken from the
    // request. Detached sources are still served — a source removed after a deck
    // was written from it is still what that deck was written from.
    server.handle
    ({
        routePath: `/Admin/PaidDecks/VerificationSource`,
        handler: downloadVerificationSource,
        method: PacketronRequestMethod.GET,
        plugins: [ensureAdmin]
    });

    // ── Declared sources (admin-declared documents and URLs for a paid deck) ──
    //
    // What each is used for is per source, and is its usageMode:
    // VERIFICATION_ONLY means the deck's content is only CHECKED against it,
    // by a pass that runs after content exists and can only raise flags;
    // CONTENT_AND_VERIFICATION means the content may also be WRITTEN from it,
    // which SourceUsageGate permits only under a licence recording a right to
    // create new material.
    //
    // The ordinary generation source list is unaffected — it still accepts a
    // curriculum or syllabus and nothing else.
    //
    // Attach, Update and Detach each write a permanent licence-declaration event
    // as well as touching the working set, so what a deck was checked against or
    // written from, on whose word and under what claimed licence, stays
    // answerable after the source is changed or removed.
    server.handle
    ({
        routePath: `/Admin/PaidDecks/VerificationSources/List`,
        handler: listVerificationSources,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/PaidDecks/VerificationSources/Attach`,
        handler: attachVerificationSource,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    // Revises the free-text note or the usage mode on an attached source. Both
    // are re-gated server-side against the STORED licence, so a source attached
    // for verification cannot be quietly promoted to a content source.
    server.handle
    ({
        routePath: `/Admin/PaidDecks/VerificationSources/Update`,
        handler: updateVerificationSource,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/PaidDecks/VerificationSources/Detach`,
        handler: detachVerificationSource,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    // Starts the pass and returns immediately — it takes minutes, so the dialog
    // polls Status below rather than holding the request open.
    server.handle
    ({
        routePath: `/Admin/PaidDecks/VerificationSources/Run`,
        handler: runVerificationAgainstSources,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/PaidDecks/VerificationSources/Status`,
        handler: getVerificationRunStatus,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/PaidDecks/Pricing`,
        handler: setPaidDeckPricing,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/PaidDecks/Bundle`,
        handler: setPaidDeckBundle,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/PaidDecks/Retire`,
        handler: retirePaidDeck,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    // Destroys the listing and its master content. Refused while anybody holds
    // an active licence — see PaidDeckRetirementService for why that is a hard
    // stop rather than a warning.
    server.handle
    ({
        routePath: `/Admin/PaidDecks/Delete`,
        handler: deletePaidDeck,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/PaidDecks/RotateKey`,
        handler: rotatePaidDeckKey,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/PaidDecks/RotateContentKey`,
        handler: rotatePaidDeckContentKey,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Stats/Revenue`,
        handler: getRevenueStats,
        method: PacketronRequestMethod.GET,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Users/SetRole`,
        handler: setUserRole,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/PaidDecks/BulkUpdate`,
        handler: bulkUpdatePaidDecks,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/AdminEmails`,
        handler: listAdminEmails,
        method: PacketronRequestMethod.GET,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/AdminEmails/Add`,
        handler: addAdminEmail,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/AdminEmails/Remove`,
        handler: removeAdminEmail,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    // ── Allowed login emails (per-environment login allowlist) ─────────────
    server.handle
    ({
        routePath: `/Admin/AllowedEmails`,
        handler: listAllowedEmails,
        method: PacketronRequestMethod.GET,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/AllowedEmails/Add`,
        handler: addAllowedEmail,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/AllowedEmails/Remove`,
        handler: removeAllowedEmail,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/ReleaseNotes/List`,
        handler: listReleaseNotesAdmin,
        method: PacketronRequestMethod.GET,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/ReleaseNotes/Create`,
        handler: createReleaseNote,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/ReleaseNotes/Update`,
        handler: updateReleaseNote,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/ReleaseNotes/Delete`,
        handler: deleteReleaseNote,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    // ── Scheduled maintenance windows ──────────────────────────────────────
    server.handle
    ({
        routePath: `/Admin/Maintenance/List`,
        handler: listMaintenanceWindows,
        method: PacketronRequestMethod.GET,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Maintenance/Add`,
        handler: addMaintenanceWindow,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Maintenance/Update`,
        handler: updateMaintenanceWindow,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Maintenance/Remove`,
        handler: removeMaintenanceWindow,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    // ── Organizations (B2B) ────────────────────────────────────────────────
    server.handle
    ({
        routePath: `/Admin/Organizations/SendAdminVerificationOtp`,
        handler: sendAdminVerificationOtp,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Organizations/VerifyAdminVerificationOtp`,
        handler: verifyAdminVerificationOtp,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Organizations/Create`,
        handler: createOrganization,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Organizations/List`,
        handler: listOrganizations,
        method: PacketronRequestMethod.GET,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Organizations/Get`,
        handler: getOrganization,
        method: PacketronRequestMethod.GET,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Organizations/UpdatePerks`,
        handler: updateOrganizationPerks,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Organizations/Delete`,
        handler: deleteOrganization,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Organizations/Rename`,
        handler: renameOrganization,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Organizations/SetMaxMembers`,
        handler: setOrganizationMaxMembers,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    // The platform's side of an organization's agreement: the ceilings every
    // rule it writes for itself is clamped to.
    server.handle
    ({
        routePath: `/Admin/Organizations/SetLimits`,
        handler: setOrganizationEntitlementLimits,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    // Renewing (or clearing) the contract term, and settling the credit pool's
    // frozen flag with it. Separate from selling credits: extending a term must
    // not require selling a block nobody asked for.
    server.handle
    ({
        routePath: `/Admin/Organizations/SetTerm`,
        handler: setOrganizationTerm,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    // ── Financial reconciliation (daily three-way match + accounting hop) ───
    server.handle
    ({
        routePath: `/Admin/Reconciliation/List`,
        handler: listReconciliations,
        method: PacketronRequestMethod.GET,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Reconciliation/RecordAccountingTotals`,
        handler: recordAccountingTotals,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Reconciliation/ExportJournal`,
        handler: exportJournal,
        method: PacketronRequestMethod.GET,
        plugins: [ensureAdmin]
    });

    // ── Alerts (operational alert log) ─────────────────────────────────────
    server.handle
    ({
        routePath: `/Admin/Alerts/List`,
        handler: listAlerts,
        method: PacketronRequestMethod.GET,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Alerts/Acknowledge`,
        handler: acknowledgeAlert,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Alerts/Delete`,
        handler: deleteAlert,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    // ── Rate limits (server-side 429 event log) ────────────────────────────
    server.handle
    ({
        routePath: `/Admin/RateLimits/List`,
        handler: listRateLimitEvents,
        method: PacketronRequestMethod.GET,
        plugins: [ensureAdmin]
    });

    // ── Audit log (persistent trail of privileged admin actions) ───────────
    server.handle
    ({
        routePath: `/Admin/Audit/List`,
        handler: listAdminAuditEvents,
        method: PacketronRequestMethod.GET,
        plugins: [ensureAdmin]
    });

    // ── Credits (spend-rule + storage + reward configuration) ──────────────
    server.handle
    ({
        routePath: `/Admin/Credits/Config`,
        handler: getCreditConfig,
        method: PacketronRequestMethod.GET,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Credits/Config/Save`,
        handler: setCreditConfig,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    // ── Logs (central application log) ─────────────────────────────────────
    // The filterable table view is served by the generic admin-list framework
    // (listKey LOGS). These endpoints add the date-range download (.log / .html,
    // optional split), the live Server-Sent-Events tail, and the settable
    // archival-interval configuration.
    server.handle
    ({
        routePath: `/Admin/Logs/Download`,
        handler: downloadLogs,
        method: PacketronRequestMethod.GET,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Logs/Stream`,
        handler: streamLogs,
        method: PacketronRequestMethod.GET,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Logs/Configuration`,
        handler: getLogConfiguration,
        method: PacketronRequestMethod.GET,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Logs/Configuration/Save`,
        handler: setLogConfiguration,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    // ── Credits (manual admin grants — B2B deals, known contacts) ──────────
    server.handle
    ({
        routePath: `/Admin/Credits/Grant/Preview`,
        handler: previewCreditGrant,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Credits/Grant/Apply`,
        handler: applyCreditGrant,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    // ── Credits (periodic / recurring assignments — lazily reconciled) ─────
    server.handle
    ({
        routePath: `/Admin/Credits/Periodic/Create`,
        handler: createPeriodicAssignment,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Credits/Periodic/List`,
        handler: listPeriodicAssignments,
        method: PacketronRequestMethod.GET,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Credits/Periodic/Terminate`,
        handler: terminatePeriodicAssignment,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Credits/Periodic/Delete`,
        handler: deletePeriodicAssignment,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Credits/Periodic/Report`,
        handler: getPeriodicAssignmentReport,
        method: PacketronRequestMethod.GET,
        plugins: [ensureAdmin]
    });

    // ── Credits (deal payments + invoices — bookkeeping, non-gating) ───────
    server.handle
    ({
        routePath: `/Admin/Credits/Deals/CreateForOrganization`,
        handler: createOrganizationCreditDeal,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Credits/Deals/Create`,
        handler: createDealPayment,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Credits/Deals/VerifyPayment`,
        handler: verifyDealPayment,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Credits/Deals/UploadInvoice`,
        handler: uploadDealInvoice,
        flags: PacketronHandlerFlags.FILE_UPLOAD,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Credits/Deals/Invoice`,
        handler: downloadDealInvoice,
        method: PacketronRequestMethod.GET,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Credits/Deals/List`,
        handler: listDealPayments,
        method: PacketronRequestMethod.GET,
        plugins: [ensureAdmin]
    });

    // ── Credits (promo codes — bounded welcome-credit distribution) ────────
    server.handle
    ({
        routePath: `/Admin/Credits/Promo/Create`,
        handler: createPromoCode,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Credits/Promo/CreateBulk`,
        handler: createPromoCodesBulk,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Credits/Promo/SetEnabled`,
        handler: setPromoCodeEnabled,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Credits/Promo/Delete`,
        handler: deletePromoCode,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    // ── Coupons (flexible, admin-configurable discounts / grants) ──────────
    server.handle
    ({
        routePath: `/Admin/Coupons/Create`,
        handler: createCoupon,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Coupons/CreateBulk`,
        handler: createCouponsBulk,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Coupons/SetEnabled`,
        handler: setCouponEnabled,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Coupons/Delete`,
        handler: deleteCoupon,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    // ── Plans (which tier unlocks which AI feature) ────────────────────────
    server.handle
    ({
        routePath: `/Admin/Plans/Features/Get`,
        handler: getPlanFeatureConfig,
        method: PacketronRequestMethod.GET,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Plans/Features/Save`,
        handler: setPlanFeatureConfig,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    // ── Generic admin list framework (paginated/filtered tables) ───────────
    server.handle
    ({
        routePath: `/Admin/Lists/Metadata`,
        handler: getAdminListMetadata,
        method: PacketronRequestMethod.GET,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Lists/Query`,
        handler: queryAdminList,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    // ── Support tickets (deduplicated issue reports) ───────────────────────
    // Registered here rather than in HandleSupportEndpoints.js so these routes
    // inherit ensureAdmin AND the AdminActionAuditor coverage it attaches —
    // resolving a ticket grants credits and emails users, which must be audited.
    server.handle
    ({
        routePath: `/Admin/Support/Ticket`,
        handler: getSupportTicket,
        method: PacketronRequestMethod.GET,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Support/Ticket/Resolve`,
        handler: resolveSupportTicket,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Support/Ticket/Decline`,
        handler: declineSupportTicket,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Support/Report/Attachment`,
        handler: downloadSupportAttachment,
        method: PacketronRequestMethod.GET,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Support/Report/Logs`,
        handler: downloadSupportReportLogs,
        method: PacketronRequestMethod.GET,
        plugins: [ensureAdmin]
    });
}

module.exports = { handleAdminEndpoints };
