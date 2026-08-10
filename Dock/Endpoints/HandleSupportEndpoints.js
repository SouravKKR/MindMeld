const { PacketronRequestMethod, PacketronHandlerFlags } = require("@gamiumgamers/packetron");
const { submitSupportReport } = require("./Support/SubmitSupportReport");
const { listMySupportReports } = require("./Support/ListMySupportReports");
const { ensureLogin } = require("./Plugins/EnsureLogin");
const { ensurePublicReportRateLimit } = require("./Plugins/EnsurePublicReportRateLimit");
const SupportAttachmentPolicy = require("../Globals/Classes/Support/SupportAttachmentPolicy");
const SupportTicketLimits = require("../Globals/Classes/Support/SupportTicketLimits");
const { httpStatus } = require("../Globals/Enumerations/HttpStatus");

/**
 * Registers the reporter-facing support endpoints.
 *
 * The submission route exists twice — login-gated at /Support/Report/Submit and
 * public at /Support/Report/SubmitPublic. The gated one is the norm: a report
 * has to be attributable for the daily quota, the resolution follow-up and the
 * credit reward to mean anything. The public one exists for the single case
 * where insisting on that would be absurd — an account-access report, whose
 * reporter is by definition unable to sign in.
 *
 * The admin side of the subsystem (view / resolve / decline / attachment + log
 * download) is registered in HandleAdminEndpoints.js instead, so those routes
 * inherit ensureAdmin AND the automatic AdminActionAuditor coverage that plugin
 * attaches — an admin route registered anywhere else would silently escape the
 * audit log.
 */
function handleSupportEndpoints(server)
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

    // MULTIPART_FORM_DATA, deliberately NOT the FILE_UPLOAD flag used by
    // /InformationSource/Upload. FILE_UPLOAD routes to a handler that ignores
    // multipart field events entirely (which is why that endpoint carries its
    // metadata in the query string), overwrites #files[fieldname] instead of
    // accumulating repeated names, and ignores multipartOptions. This route needs
    // all three behaviours: the scalar fields in the body, several files under one
    // repeated "attachments" name, and enforced limits.
    //
    // The limits are declared here rather than checked after parsing because
    // packetron's default maxFileSize is Infinity — a post-parse byte check would
    // only fire once an oversized file had already been written to disk in full.
    // maxFiles sits one above the policy ceiling so an overrun is still parsed and
    // answered with a precise error rather than a silently truncated body.
    server.handle
    ({
        routePath: `/Support/Report/Submit`,
        handler: wrapHandler(submitSupportReport),
        flags: PacketronHandlerFlags.MULTIPART_FORM_DATA,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin],
        multipartOptions:
        {
            // Deliberately ABOVE the 10 MB policy cap. When busboy's own file-size
            // limit trips, packetron unlinks the part and drops it from the file
            // map entirely — the reporter would get a baffling "no attachment"
            // instead of "that file is too large". Letting a moderately oversized
            // file land means SupportAttachmentPolicy is the thing that speaks;
            // this ceiling stays only as a DoS backstop against a huge upload.
            maxFileSize: SupportAttachmentPolicy.MAXIMUM_FILE_BYTES * 2,
            maxFiles: SupportAttachmentPolicy.MAXIMUM_ATTACHMENT_COUNT + 1,
            maxFields: 16,
            // Bytes, not characters — the description ceiling is in characters and
            // UTF-8 runs up to four bytes each.
            maxFieldSize: SupportTicketLimits.MAXIMUM_DESCRIPTION_LENGTH * 4
        }
    });

    // The same handler, without ensureLogin and with the per-IP cap instead.
    //
    // A second ROUTE rather than a second handler: the accept/reject rules,
    // the attachment handling and the grouping hand-off must be identical
    // whichever door a report came through, and the only reliable way to
    // guarantee that is for there to be one implementation. What differs is
    // exactly two things — who may call it, and what the handler is then
    // allowed to accept — and both are decided by PublicReportPolicy rather
    // than by which route was hit.
    //
    // An intellectual-property complaint is NOT filed here even though it is
    // public; it has its own endpoint under /Legal, and this handler refuses it
    // explicitly. See PublicReportPolicy.
    server.handle
    ({
        routePath: `/Support/Report/SubmitPublic`,
        handler: wrapHandler(submitSupportReport),
        flags: PacketronHandlerFlags.MULTIPART_FORM_DATA,
        method: PacketronRequestMethod.POST,
        plugins: [ensurePublicReportRateLimit],
        multipartOptions:
        {
            maxFileSize: SupportAttachmentPolicy.MAXIMUM_FILE_BYTES * 2,
            maxFiles: SupportAttachmentPolicy.MAXIMUM_ATTACHMENT_COUNT + 1,
            maxFields: 16,
            maxFieldSize: SupportTicketLimits.MAXIMUM_DESCRIPTION_LENGTH * 4
        }
    });

    server.handle
    ({
        routePath: `/Support/MyReports`,
        handler: wrapHandler(listMySupportReports),
        method: PacketronRequestMethod.GET,
        plugins: [ensureLogin]
    });
}

module.exports = { handleSupportEndpoints };
