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
const { beautifyDeckShortNames } = require("./Admin/BeautifyDeckShortNames");
const { bulkUpdatePaidDecks } = require("./Admin/BulkUpdatePaidDecks");
const { listAdminEmails } = require("./Admin/AdminEmails/ListAdminEmails");
const { addAdminEmail } = require("./Admin/AdminEmails/AddAdminEmail");
const { removeAdminEmail } = require("./Admin/AdminEmails/RemoveAdminEmail");
const { createReleaseNote } = require("./Admin/ReleaseNotes/CreateReleaseNote");
const { updateReleaseNote } = require("./Admin/ReleaseNotes/UpdateReleaseNote");
const { deleteReleaseNote } = require("./Admin/ReleaseNotes/DeleteReleaseNote");
const { listReleaseNotesAdmin } = require("./Admin/ReleaseNotes/ListReleaseNotesAdmin");
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
const { ensureAdmin } = require("./Plugins/EnsureAdmin");

function handleAdminEndpoints(server)
{
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
        routePath: `/Admin/Decks/BeautifyShortNames`,
        handler: beautifyDeckShortNames,
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
}

module.exports = { handleAdminEndpoints };
