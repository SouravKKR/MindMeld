const { PacketronHandlerFlags, PacketronRequestMethod } = require("@gamiumgamers/packetron");
const { receiveCspReport } = require("./Security/ReceiveCspReport");
const { logAiGeneratedExportAttempt } = require("./Security/LogAiGeneratedExportAttempt");
const { ensureLogin } = require("./Plugins/EnsureLogin");


function handleSecurityEndpoints(server)
{
    // Content-Security-Policy violation sink. Unauthenticated by necessity — a
    // browser posts a violation report with no app context, and violations on
    // the pre-login shell are exactly as interesting as post-login ones. The
    // global per-identity rate limiter still applies.
    //
    // PLAIN_TEXT_BODY (not JSON_BODY) because browsers send the report as
    // `application/csp-report` or `application/reports+json`; the handler parses
    // the body itself.
    server.handle
    ({
        routePath: `/Security/CspReport`,
        handler: receiveCspReport,
        flags: PacketronHandlerFlags.PLAIN_TEXT_BODY,
        method: PacketronRequestMethod.POST,
        plugins: []
    });

    // Attempted export of an AI-generated deck. Authenticated — the record is
    // only meaningful when it names a user. See LogAiGeneratedExportAttempt for
    // why this is telemetry rather than a gate.
    server.handle
    ({
        routePath: `/Security/AiGeneratedExportAttempt`,
        handler: logAiGeneratedExportAttempt,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
    });
}

module.exports = { handleSecurityEndpoints };
