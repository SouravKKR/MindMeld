const { Packetron, PacketronRequestMethod, PacketronHandlerFlags } = require("@gamiumgamers/packetron");
const { handleGetLegalDocuments } = require("./Legal/GetLegalDocuments");
const { handleAcceptLegalDocument } = require("./Legal/AcceptLegalDocument");
const { submitIntellectualPropertyComplaint } = require("./Legal/SubmitIntellectualPropertyComplaint");
const { verifyIntellectualPropertyComplaint } = require("./Legal/VerifyIntellectualPropertyComplaint");
const { attachIntellectualPropertyComplaintEvidence } = require("./Legal/AttachIntellectualPropertyComplaintEvidence");
const { ensureLogin } = require("./Plugins/EnsureLogin");
const { ensurePublicReportRateLimit } = require("./Plugins/EnsurePublicReportRateLimit");
const ComplaintEvidencePolicy = require("../Globals/Classes/Legal/ComplaintEvidencePolicy");
const IntellectualPropertyComplaintConstants = require("../Globals/Constants/IntellectualPropertyComplaintConstants");
const { httpStatus } = require("../Globals/Enumerations/HttpStatus");


/**
 * Registers the legal-document and intellectual-property complaint endpoints.
 *
 *   GET  /LegalDocuments                                → list of {key, title, version, contentHtml}
 *   POST /Legal/Accept                                  → record the authenticated user's acceptance
 *                                                         of one document (server-validated version)
 *   POST /Legal/IntellectualPropertyComplaint           → file an infringement complaint (public)
 *   POST /Legal/IntellectualPropertyComplaint/Verify    → confirm the complainant's contact address
 *   POST /Legal/IntellectualPropertyComplaint/Evidence  → attach evidence, once confirmed
 *
 * Backed by the `legalDocuments` collection, seeded at boot from
 * Dock/SeedData/LegalDocuments.json, and by the append-only
 * `intellectualPropertyComplaints` register.
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
 * The three complaint routes are deliberately UNAUTHENTICATED. Clause 19.3 of
 * the Terms commits to accepting a complaint from any rightsholder whether or
 * not they hold an account, and the person the channel exists for usually never
 * will. They carry the per-IP volumetric cap instead; attribution comes from the
 * one-time code sent to the address the complainant gave, not from a session.
 *
 * Flat route paths with no `:param` placeholders — packetron does not support
 * them, so identifiers travel in the body.
 *
 * @param {Packetron} server
 */
function handleLegalEndpoints(server)
{
    function wrapHandler(handlerFunction)
    {
        return async (request, response) =>
        {
            try
            {
                await handlerFunction(request, response);
            }
            catch (handlerError)
            {
                console.error(`Error in route: ${request.url}`);
                console.error(handlerError);
                response.sendStatusCode(httpStatus.INTERNAL_SERVER_ERROR);
            }
        };
    }

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

    server.handle
    ({
        routePath: `/Legal/IntellectualPropertyComplaint`,
        handler: wrapHandler(submitIntellectualPropertyComplaint),
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensurePublicReportRateLimit]
    });

    server.handle
    ({
        routePath: `/Legal/IntellectualPropertyComplaint/Verify`,
        handler: wrapHandler(verifyIntellectualPropertyComplaint),
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensurePublicReportRateLimit]
    });

    // MULTIPART_FORM_DATA rather than FILE_UPLOAD, matching /Support/Report/Submit:
    // this route needs the scalar fields in the body, several files under one
    // repeated "attachments" name, and enforced limits — and the FILE_UPLOAD
    // handler provides none of the three.
    //
    // maxFileSize sits deliberately ABOVE the policy cap. When busboy's own limit
    // trips, packetron unlinks the part and drops it from the file map entirely,
    // so the complainant would be told "no attachment" instead of "that file is
    // too large"; letting a moderately oversized file land means
    // ComplaintEvidencePolicy is the thing that speaks.
    server.handle
    ({
        routePath: `/Legal/IntellectualPropertyComplaint/Evidence`,
        handler: wrapHandler(attachIntellectualPropertyComplaintEvidence),
        flags: PacketronHandlerFlags.MULTIPART_FORM_DATA,
        method: PacketronRequestMethod.POST,
        plugins: [ensurePublicReportRateLimit],
        multipartOptions:
        {
            maxFileSize: ComplaintEvidencePolicy.MAXIMUM_FILE_BYTES * 2,
            maxFiles: ComplaintEvidencePolicy.MAXIMUM_ATTACHMENT_COUNT + 1,
            maxFields: 8,
            // Bytes, not characters. The longest field here is the upload token.
            maxFieldSize: IntellectualPropertyComplaintConstants.ENTITY_REFERENCE_MAXIMUM_LENGTH * 4
        }
    });
}

module.exports = { handleLegalEndpoints };
