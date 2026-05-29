const { PacketronHandlerFlags, PacketronRequestMethod } = require("@gamiumgamers/packetron");
const { handleGetShadowStats } = require("./Admin/GetShadowStats");
const { uploadPaidDeck } = require("./Admin/UploadPaidDeck");
const { updatePaidDeck } = require("./Admin/UpdatePaidDeck");
const { setPaidDeckPricing } = require("./Admin/SetPaidDeckPricing");
const { setPaidDeckBundle } = require("./Admin/SetPaidDeckBundle");
const { rotatePaidDeckKey } = require("./Admin/RotatePaidDeckKey");
const { getRevenueStats } = require("./Admin/GetRevenueStats");
const { listPaidDecks } = require("./Admin/ListPaidDecks");
const { setUserRole } = require("./Admin/SetUserRole");
const { bulkUpdatePaidDecks } = require("./Admin/BulkUpdatePaidDecks");
const { listAdminEmails } = require("./Admin/AdminEmails/ListAdminEmails");
const { addAdminEmail } = require("./Admin/AdminEmails/AddAdminEmail");
const { removeAdminEmail } = require("./Admin/AdminEmails/RemoveAdminEmail");
const { createReleaseNote } = require("./Admin/ReleaseNotes/CreateReleaseNote");
const { updateReleaseNote } = require("./Admin/ReleaseNotes/UpdateReleaseNote");
const { deleteReleaseNote } = require("./Admin/ReleaseNotes/DeleteReleaseNote");
const { listReleaseNotesAdmin } = require("./Admin/ReleaseNotes/ListReleaseNotesAdmin");
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
}

module.exports = { handleAdminEndpoints };
