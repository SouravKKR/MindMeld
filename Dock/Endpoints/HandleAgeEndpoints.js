const { Packetron, PacketronRequestMethod, PacketronHandlerFlags } = require("@gamiumgamers/packetron");
const { handleGetAgeConsentState } = require("./Age/GetAgeConsentState");
const { handleDeclareDateOfBirth } = require("./Age/DeclareDateOfBirth");
const { handleSubmitGuardianConsent } = require("./Age/SubmitGuardianConsent");
const { ensureLogin } = require("./Plugins/EnsureLogin");

/**
 * Registers the age-verification endpoints on the server.
 *
 *   GET  /Age/State              → what this account still owes
 *   POST /Age/DeclareDateOfBirth → record a date of birth (write-once)
 *   POST /Age/GuardianConsent    → record a guardian's consent for a Child
 *
 * All three are gated by ensureLogin — every one of them reads or writes the
 * caller's own account — and all three are allowlisted in the global
 * EnsureAgeConsent plugin, because an account blocked by that gate has to be
 * able to reach the endpoints that clear it.
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
        routePath: `/Age/DeclareDateOfBirth`,
        handler: handleDeclareDateOfBirth,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
    });

    server.handle
    ({
        routePath: `/Age/GuardianConsent`,
        handler: handleSubmitGuardianConsent,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin]
    });
}

module.exports = { handleAgeEndpoints };
