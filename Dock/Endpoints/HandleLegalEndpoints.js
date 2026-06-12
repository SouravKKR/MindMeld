const { Packetron, PacketronRequestMethod, PacketronHandlerFlags } = require("@gamiumgamers/packetron");
const { handleGetLegalDocuments } = require("./Legal/GetLegalDocuments");
const { handleAcceptLegalDocument } = require("./Legal/AcceptLegalDocument");
const { ensureLogin } = require("./Plugins/EnsureLogin");


/**
 * Registers the legal-document endpoints on the server.
 *
 *   GET  /LegalDocuments → list of {key, title, version, contentHtml}
 *   POST /Legal/Accept   → record the authenticated user's acceptance
 *                          of one document (server-validated version)
 *
 * Backed by the `legalDocuments` collection which is seeded at boot
 * from Dock/SeedData/LegalDocuments.json.
 *
 * GET /LegalDocuments is NOT gated by ensureLogin: the Terms of Service
 * and Privacy Policy are inherently public-facing — the homepage notice
 * for logged-out users lets them download these documents before deciding
 * to log in. Gating it behind auth would silently break that pre-login
 * flow with a 401 and no visible feedback. The data served is
 * operator-controlled seed content; there is nothing user-specific to
 * protect here.
 *
 * POST /Legal/Accept IS gated by ensureLogin: it writes consent onto the
 * caller's account. It is the only writer of consent state, and the global
 * EnsureLegalAcceptance gate keeps it reachable while a session is pending.
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

    server.handle
    ({
        routePath: `/Legal/Accept`,
        handler: handleAcceptLegalDocument,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
    });
}

module.exports = { handleLegalEndpoints };
