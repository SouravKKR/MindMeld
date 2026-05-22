const { Packetron, PacketronRequestMethod } = require("@gamiumgamers/packetron");
const { handleGetLegalDocuments } = require("./Legal/GetLegalDocuments");


/**
 * Registers the legal-document endpoints on the server.
 *
 *   GET /LegalDocuments → list of {key, title, version, contentHtml}
 *
 * Backed by the `legalDocuments` collection which is seeded at boot
 * from Dock/SeedData/LegalDocuments.json.
 *
 * NOT gated by ensureLogin: the Terms of Service and Privacy Policy
 * are inherently public-facing — the homepage notice for logged-out
 * users lets them download these documents before deciding to log in.
 * Gating this
 * endpoint behind auth would silently break that pre-login flow with a
 * 401 and no visible feedback. The data served is operator-controlled
 * seed content; there is nothing user-specific to protect here.
 *
 * @param {Packetron} server
 */
function handleLegalEndpoints(server)
{
    server.handle
    ({
        routePath: `/LegalDocuments`,
        handler: handleGetLegalDocuments,
        method: PacketronRequestMethod.GET
    });
}

module.exports = { handleLegalEndpoints };
