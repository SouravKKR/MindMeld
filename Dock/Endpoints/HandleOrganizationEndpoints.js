const { PacketronHandlerFlags, PacketronRequestMethod } = require("@gamiumgamers/packetron");
const { listMyOrganizations } = require("./OrganizationAdmin/ListMyOrganizations");
const { getMyOrganization } = require("./OrganizationAdmin/GetMyOrganization");
const { listOrganizationMembers } = require("./OrganizationAdmin/ListOrganizationMembers");
const { addOrganizationMember } = require("./OrganizationAdmin/AddOrganizationMember");
const { bulkAddOrganizationMembers } = require("./OrganizationAdmin/BulkAddOrganizationMembers");
const { removeOrganizationMember } = require("./OrganizationAdmin/RemoveOrganizationMember");
const { bulkRemoveOrganizationMembers } = require("./OrganizationAdmin/BulkRemoveOrganizationMembers");
const { ensureOrgAdmin } = require("./Plugins/EnsureOrgAdmin");


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
}

module.exports = { handleOrganizationEndpoints };
