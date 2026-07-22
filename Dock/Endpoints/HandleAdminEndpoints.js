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
const { streamLogs } = require("./Admin/Logs/StreamLogs");
const { getLogConfiguration } = require("./Admin/Logs/GetLogConfiguration");
const { setLogConfiguration } = require("./Admin/Logs/SetLogConfiguration");
const { sendAdminVerificationOtp } = require("./Organization/SendAdminVerificationOtp");
const { verifyAdminVerificationOtp } = require("./Organization/VerifyAdminVerificationOtp");
const { createOrganization } = require("./Organization/CreateOrganization");
const { verifyCreationPayment } = require("./Organization/VerifyCreationPayment");
const { listOrganizations } = require("./Organization/ListOrganizations");
const { getOrganization } = require("./Organization/GetOrganization");
const { updateOrganizationPerks } = require("./Organization/UpdateOrganizationPerks");
const { initiateOrganizationExpansion } = require("./Organization/InitiateOrganizationExpansion");
const { verifyOrganizationExpansionPayment } = require("./Organization/VerifyOrganizationExpansionPayment");
const { deleteOrganization } = require("./Organization/DeleteOrganization");
const { listAlerts } = require("./Admin/Alerts/ListAlerts");
const { acknowledgeAlert } = require("./Admin/Alerts/AcknowledgeAlert");
const { deleteAlert } = require("./Admin/Alerts/DeleteAlert");
const { listRateLimitEvents } = require("./Admin/RateLimits/ListRateLimitEvents");
const { listAdminAuditEvents } = require("./Admin/Audit/ListAdminAuditEvents");
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
const { verifyDealPayment } = require("./Admin/Deals/VerifyDealPayment");
const { uploadDealInvoice } = require("./Admin/Deals/UploadDealInvoice");
const { downloadDealInvoice } = require("./Admin/Deals/DownloadDealInvoice");
const { listDealPayments } = require("./Admin/Deals/ListDealPayments");
const { renameOrganization } = require("./Organization/RenameOrganization");
const { setOrganizationMaxMembers } = require("./Organization/SetOrganizationMaxMembers");
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
        routePath: `/Admin/Organizations/VerifyCreationPayment`,
        handler: verifyCreationPayment,
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
        routePath: `/Admin/Organizations/InitiateExpansion`,
        handler: initiateOrganizationExpansion,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureAdmin]
    });

    server.handle
    ({
        routePath: `/Admin/Organizations/VerifyExpansionPayment`,
        handler: verifyOrganizationExpansionPayment,
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
}

module.exports = { handleAdminEndpoints };
