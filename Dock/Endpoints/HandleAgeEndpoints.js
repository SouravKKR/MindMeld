const { Packetron, PacketronRequestMethod, PacketronHandlerFlags } = require("@gamiumgamers/packetron");
const { handleGetAgeConsentState } = require("./Age/GetAgeConsentState");
const { handleDeclareAge } = require("./Age/DeclareAge");
const { handleRequestGuardianConsentCode } = require("./Age/RequestGuardianConsentCode");
const { handleVerifyGuardianConsentCode } = require("./Age/VerifyGuardianConsentCode");
const { ensureLogin } = require("./Plugins/EnsureLogin");
const { ensureOtpRateLimit } = require("./Plugins/EnsureOtpRateLimit");

/**
 * Registers the age-verification endpoints on the server.
 *
 *   GET  /Age/State                      → what this account still owes
 *   POST /Age/DeclareAge                 → record an age (write-once)
 *   POST /Age/GuardianConsent/RequestCode → email a guardian a consent code
 *   POST /Age/GuardianConsent/Verify      → confirm that code, recording consent
 *
 * All four are gated by ensureLogin — every one of them reads or writes the
 * caller's own account — and all four are allowlisted in the global
 * EnsureAgeConsent plugin, because an account blocked by that gate has to be
 * able to reach the endpoints that clear it.
 *
 * RequestCode additionally carries ensureOtpRateLimit, the same per-IP cap the
 * login OTP endpoints use. It sends an email on every call to an address the
 * caller chooses, which is the exact shape that plugin exists to bound — the
 * per-(email, purpose) cooldown inside OtpManager only limits repeats to ONE
 * address, not a client cycling through many.
 *
 * These are the only writers of age and guardian-consent state; the generic
 * /UpdateUserAdditionalData merge refuses those fields
 * (AgeVerificationService.isReservedAgeKey), so consent cannot be self-asserted
 * by a client.
 *
 * @param {Packetron} server
 */
function handleAgeEndpoints(server)
{
    server.handle
    ({
        routePath: `/Age/State`,
        handler: handleGetAgeConsentState,
        method: PacketronRequestMethod.GET,
        plugins: [ensureLogin]
    });

    server.handle
    ({
        routePath: `/Age/DeclareAge`,
        handler: handleDeclareAge,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
    });

    server.handle
    ({
        routePath: `/Age/GuardianConsent/RequestCode`,
        handler: handleRequestGuardianConsentCode,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin, ensureOtpRateLimit]
    });

    server.handle
    ({
        routePath: `/Age/GuardianConsent/Verify`,
        handler: handleVerifyGuardianConsentCode,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin, ensureOtpRateLimit]
    });
}

module.exports = { handleAgeEndpoints };
