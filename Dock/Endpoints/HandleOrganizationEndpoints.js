const { PacketronHandlerFlags, PacketronRequestMethod } = require("@gamiumgamers/packetron");
const { listMyOrganizations } = require("./OrganizationAdmin/ListMyOrganizations");
const { getMyOrganization } = require("./OrganizationAdmin/GetMyOrganization");
const { listOrganizationMembers } = require("./OrganizationAdmin/ListOrganizationMembers");
const { addOrganizationMember } = require("./OrganizationAdmin/AddOrganizationMember");
const { bulkAddOrganizationMembers } = require("./OrganizationAdmin/BulkAddOrganizationMembers");
const { removeOrganizationMember } = require("./OrganizationAdmin/RemoveOrganizationMember");
const { bulkRemoveOrganizationMembers } = require("./OrganizationAdmin/BulkRemoveOrganizationMembers");
const { renameMyOrganization } = require("./OrganizationAdmin/RenameMyOrganization");
const { setMemberDelegatePowers } = require("./OrganizationAdmin/SetMemberDelegatePowers");
const { importOrganizationMembers } = require("./OrganizationAdmin/ImportOrganizationMembers");
const { removeOrganizationMembersByFilter } = require("./OrganizationAdmin/RemoveOrganizationMembersByFilter");
const { updateOrganizationMember } = require("./OrganizationAdmin/UpdateOrganizationMember");
const { bulkUpdateOrganizationMembers } = require("./OrganizationAdmin/BulkUpdateOrganizationMembers");
const { updateOrganizationMembersByFilter } = require("./OrganizationAdmin/UpdateOrganizationMembersByFilter");
const { listOrganizationMemberColumns } = require("./OrganizationAdmin/Columns/ListOrganizationMemberColumns");
const { setOrganizationMemberColumns } = require("./OrganizationAdmin/Columns/SetOrganizationMemberColumns");
const { deleteOrganizationMemberColumn } = require("./OrganizationAdmin/Columns/DeleteOrganizationMemberColumn");
const { renameOrganizationMemberColumn } = require("./OrganizationAdmin/Columns/RenameOrganizationMemberColumn");
const { getOrganizationListMetadata } = require("./OrganizationAdmin/GetOrganizationListMetadata");
const { queryOrganizationList } = require("./OrganizationAdmin/QueryOrganizationList");
const { getOrganizationCreditOverview } = require("./OrganizationAdmin/Credits/GetOrganizationCreditOverview");
const { previewOrganizationCreditDistribution } = require("./OrganizationAdmin/Credits/PreviewOrganizationCreditDistribution");
const { applyOrganizationCreditDistribution } = require("./OrganizationAdmin/Credits/ApplyOrganizationCreditDistribution");
const { verifyOrganizationCreditDeal } = require("./OrganizationAdmin/Credits/VerifyOrganizationCreditDeal");
const { createOrganizationPeriodicAssignment } = require("./OrganizationAdmin/Credits/CreateOrganizationPeriodicAssignment");
const { listOrganizationPeriodicAssignments } = require("./OrganizationAdmin/Credits/ListOrganizationPeriodicAssignments");
const { terminateOrganizationPeriodicAssignment } = require("./OrganizationAdmin/Credits/TerminateOrganizationPeriodicAssignment");
const { getOrganizationSpendReport } = require("./OrganizationAdmin/Credits/GetOrganizationSpendReport");
const { downloadEngagementReport } = require("./OrganizationAdmin/Reports/DownloadEngagementReport");
const { getOrganizationPermissionRules } = require("./OrganizationAdmin/GetOrganizationPermissionRules");
const { setOrganizationPermissionRules } = require("./OrganizationAdmin/SetOrganizationPermissionRules");
const { previewOrganizationPermissionRule } = require("./OrganizationAdmin/PreviewOrganizationPermissionRule");
const { uploadOrganizationDeck } = require("./OrganizationAdmin/Decks/UploadOrganizationDeck");
const { updateOrganizationDeck } = require("./OrganizationAdmin/Decks/UpdateOrganizationDeck");
const { withdrawOrganizationDeck } = require("./OrganizationAdmin/Decks/WithdrawOrganizationDeck");
const { listOrganizationDecks } = require("./OrganizationAdmin/Decks/ListOrganizationDecks");
const { getOrganizationDeckShelf } = require("./Organization/GetOrganizationDeckShelf");
const { addOrganizationDeck } = require("./Organization/AddOrganizationDeck");
const { removeOrganizationDeck } = require("./Organization/RemoveOrganizationDeck");
const { ensureLogin } = require("./Plugins/EnsureLogin");
const { ensureOrgAdmin } = require("./Plugins/EnsureOrgAdmin");
const { ensurePaymentAccess } = require("./Plugins/EnsurePaymentAccess");
const { ensurePaymentRequestSchema } = require("./Plugins/EnsurePaymentRequestSchema");


function handleOrganizationEndpoints(server)
{
    server.handle
    ({
        routePath: `/Organization/Mine/List`,
        handler: listMyOrganizations,
        method: PacketronRequestMethod.GET,
        plugins: [ensureOrgAdmin]
    });

    server.handle
    ({
        routePath: `/Organization/Get`,
        handler: getMyOrganization,
        method: PacketronRequestMethod.GET,
        plugins: [ensureOrgAdmin]
    });

    server.handle
    ({
        routePath: `/Organization/Members/List`,
        handler: listOrganizationMembers,
        method: PacketronRequestMethod.GET,
        plugins: [ensureOrgAdmin]
    });

    server.handle
    ({
        routePath: `/Organization/Members/Add`,
        handler: addOrganizationMember,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureOrgAdmin]
    });

    server.handle
    ({
        routePath: `/Organization/Members/BulkAdd`,
        handler: bulkAddOrganizationMembers,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureOrgAdmin]
    });

    server.handle
    ({
        routePath: `/Organization/Members/Remove`,
        handler: removeOrganizationMember,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureOrgAdmin]
    });

    server.handle
    ({
        routePath: `/Organization/Members/BulkRemove`,
        handler: bulkRemoveOrganizationMembers,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureOrgAdmin]
    });

    // Owner-only actions. The role floor is the plugin; the per-organization
    // check (owner vs delegate vs stranger) happens inside each handler through
    // OrganizationAuthorityResolver.
    server.handle
    ({
        routePath: `/Organization/Rename`,
        handler: renameMyOrganization,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureOrgAdmin]
    });

    server.handle
    ({
        routePath: `/Organization/Members/SetDelegatePowers`,
        handler: setMemberDelegatePowers,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureOrgAdmin]
    });

    // Roster import and filtered removal. Both need the MANAGE_MEMBERS power,
    // checked per organization inside the handler.
    server.handle
    ({
        routePath: `/Organization/Members/Import`,
        handler: importOrganizationMembers,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureOrgAdmin]
    });

    server.handle
    ({
        routePath: `/Organization/Members/RemoveByFilter`,
        handler: removeOrganizationMembersByFilter,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureOrgAdmin]
    });

    // Editing members in place — one person, a checked selection, or everyone a
    // filter matches. The three exist together because the roster list drops its
    // selection when the page turns, so without the filter-scoped route a large
    // cohort could only be edited a screenful at a time.
    server.handle
    ({
        routePath: `/Organization/Members/Update`,
        handler: updateOrganizationMember,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureOrgAdmin]
    });

    server.handle
    ({
        routePath: `/Organization/Members/BulkUpdate`,
        handler: bulkUpdateOrganizationMembers,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureOrgAdmin]
    });

    server.handle
    ({
        routePath: `/Organization/Members/UpdateByFilter`,
        handler: updateOrganizationMembersByFilter,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureOrgAdmin]
    });

    // The per-organization column schema. Reading it needs only standing —
    // knowing what the columns are called is part of reading the roster —
    // while changing one needs MANAGE_MEMBERS, checked inside each handler.
    server.handle
    ({
        routePath: `/Organization/Members/Columns/List`,
        handler: listOrganizationMemberColumns,
        method: PacketronRequestMethod.GET,
        plugins: [ensureOrgAdmin]
    });

    server.handle
    ({
        routePath: `/Organization/Members/Columns/Set`,
        handler: setOrganizationMemberColumns,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureOrgAdmin]
    });

    server.handle
    ({
        routePath: `/Organization/Members/Columns/Rename`,
        handler: renameOrganizationMemberColumn,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureOrgAdmin]
    });

    server.handle
    ({
        routePath: `/Organization/Members/Columns/Delete`,
        handler: deleteOrganizationMemberColumn,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureOrgAdmin]
    });

    // The member list, served through the shared admin-list framework but
    // scoped to the caller's own organization rather than by list key.
    server.handle
    ({
        routePath: `/Organization/Lists/Metadata`,
        handler: getOrganizationListMetadata,
        method: PacketronRequestMethod.GET,
        plugins: [ensureOrgAdmin]
    });

    server.handle
    ({
        routePath: `/Organization/Lists/Query`,
        handler: queryOrganizationList,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureOrgAdmin]
    });

    // ── Credits ───────────────────────────────────────────────────────────
    // Reading the pool needs standing only; spending it needs the
    // DISTRIBUTE_CREDITS power, checked per organization inside each handler.
    server.handle
    ({
        routePath: `/Organization/Credits/Overview`,
        handler: getOrganizationCreditOverview,
        method: PacketronRequestMethod.GET,
        plugins: [ensureOrgAdmin]
    });

    server.handle
    ({
        routePath: `/Organization/Credits/SpendReport`,
        handler: getOrganizationSpendReport,
        method: PacketronRequestMethod.GET,
        plugins: [ensureOrgAdmin]
    });

    // The engagement report — what members did, as opposed to what it cost.
    // Same standing requirement as the spend report above: reading what your
    // own members did needs standing, not a specific delegated power.
    server.handle
    ({
        routePath: `/Organization/Reports/Engagement`,
        handler: downloadEngagementReport,
        method: PacketronRequestMethod.GET,
        plugins: [ensureOrgAdmin]
    });

    server.handle
    ({
        routePath: `/Organization/Credits/Deals/Verify`,
        handler: verifyOrganizationCreditDeal,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureOrgAdmin, ensurePaymentAccess, ensurePaymentRequestSchema]
    });

    server.handle
    ({
        routePath: `/Organization/Credits/Distribute/Preview`,
        handler: previewOrganizationCreditDistribution,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureOrgAdmin]
    });

    server.handle
    ({
        routePath: `/Organization/Credits/Distribute/Apply`,
        handler: applyOrganizationCreditDistribution,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureOrgAdmin]
    });

    server.handle
    ({
        routePath: `/Organization/Credits/Periodic/Create`,
        handler: createOrganizationPeriodicAssignment,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureOrgAdmin]
    });

    server.handle
    ({
        routePath: `/Organization/Credits/Periodic/List`,
        handler: listOrganizationPeriodicAssignments,
        method: PacketronRequestMethod.GET,
        plugins: [ensureOrgAdmin]
    });

    server.handle
    ({
        routePath: `/Organization/Credits/Periodic/Terminate`,
        handler: terminateOrganizationPeriodicAssignment,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureOrgAdmin]
    });

    // ── Permissions ───────────────────────────────────────────────────────
    // Reading the rules needs standing; changing them needs SET_PERMISSIONS,
    // which is the heaviest delegate power because it decides what every member
    // can do inside the organization's view.
    server.handle
    ({
        routePath: `/Organization/Permissions`,
        handler: getOrganizationPermissionRules,
        method: PacketronRequestMethod.GET,
        plugins: [ensureOrgAdmin]
    });

    server.handle
    ({
        routePath: `/Organization/Permissions/Set`,
        handler: setOrganizationPermissionRules,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureOrgAdmin]
    });

    // Who a rule covers, before it is saved. A rule that can name columns as
    // well as tags is no longer readable at a glance, and the mistake that
    // hides is granting a paid feature to the whole roster.
    server.handle
    ({
        routePath: `/Organization/Permissions/PreviewRule`,
        handler: previewOrganizationPermissionRule,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureOrgAdmin]
    });

    // ── Publishing decks to the organization ──────────────────────────────
    // Behind ensureOrgAdmin, with PUBLISH_DECKS re-checked inside each handler
    // against the stored membership row. Listing is readable by anyone with
    // standing: seeing what your institute provides is not the same act as
    // changing it.
    server.handle
    ({
        routePath: `/Organization/PaidDecks/List`,
        handler: listOrganizationDecks,
        method: PacketronRequestMethod.GET,
        plugins: [ensureOrgAdmin]
    });

    server.handle
    ({
        routePath: `/Organization/PaidDecks/Upload`,
        handler: uploadOrganizationDeck,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureOrgAdmin]
    });

    server.handle
    ({
        routePath: `/Organization/PaidDecks/Update`,
        handler: updateOrganizationDeck,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureOrgAdmin]
    });

    server.handle
    ({
        routePath: `/Organization/PaidDecks/Withdraw`,
        handler: withdrawOrganizationDeck,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureOrgAdmin]
    });

    // ── The member's shelf ────────────────────────────────────────────────
    // ensureLogin, not ensureOrgAdmin: these are for every member, and each
    // handler re-checks membership of the named organization against the stored
    // roster rather than inferring it from a role.
    server.handle
    ({
        routePath: `/Organization/Decks/Shelf`,
        handler: getOrganizationDeckShelf,
        method: PacketronRequestMethod.GET,
        plugins: [ensureLogin]
    });

    server.handle
    ({
        routePath: `/Organization/Decks/Add`,
        handler: addOrganizationDeck,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
    });

    server.handle
    ({
        routePath: `/Organization/Decks/Remove`,
        handler: removeOrganizationDeck,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
    });
}

module.exports = { handleOrganizationEndpoints };
