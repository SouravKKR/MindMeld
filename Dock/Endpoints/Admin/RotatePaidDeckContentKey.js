const KeyManagementService = require("../../Globals/Classes/Security/KeyManagementService");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

/**
 * POST /Admin/PaidDecks/RotateContentKey
 *
 * Body: { deckId, mode: "ALL_LICENSES" | "SINGLE_USER", userId? }
 *
 * Admin-triggered content-key rotation for a paid deck. Rotates the
 * per-user content key on every active license (or one specific user)
 * so a recently-leaked content key no longer decrypts entities the
 * affected buyer fetches from now on.
 *
 * Each rotation bumps contentKeyVersion on the license. The buyer's
 * next /PaidDecks/Manifest or /PaidDecks/Entities/Fetch will surface
 * the new version, the client purges its cache, and re-prompts the
 * password (the password-wrap was zeroed in the rotation step and
 * gets lazily refilled on the next UnlockSession).
 */
async function rotatePaidDeckContentKey(request, response)
{
    if (!KeyManagementService.isReady())
    {
        response.statusCode = httpStatus.SERVICE_UNAVAILABLE;
        response.sendJson({ error: "KEY_MANAGEMENT_NOT_READY" });
        return;
    }

    const body = await request.getBody();
    const deckId = body?.deckId;
    const mode = body?.mode || "ALL_LICENSES";
    const targetUserId = body?.userId;

    if (typeof deckId !== "string" || deckId.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "MISSING_DECK_ID" });
        return;
    }

    if (mode === "SINGLE_USER")
    {
        if (typeof targetUserId !== "string" || targetUserId.length === 0)
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ error: "MISSING_USER_ID" });
            return;
        }
        const license = await KeyManagementService.getLicense(targetUserId, deckId);
        if (!license)
        {
            response.statusCode = httpStatus.NOT_FOUND;
            response.sendJson({ error: "LICENSE_NOT_FOUND" });
            return;
        }
        await KeyManagementService.rotatePaidDeckContentKeyForLicense(license);
        response.statusCode = httpStatus.OK;
        response.sendJson({ success: true, licensesRotated: 1 });
        return;
    }

    if (mode === "ALL_LICENSES")
    {
        const rotationResults = await KeyManagementService.rotatePaidDeckContentKeyForAllLicensesOfDeck(deckId);
        const successCount = rotationResults.filter((rotationResult) => rotationResult.success).length;
        response.statusCode = httpStatus.OK;
        response.sendJson
        ({
            success: true,
            licensesRotated: successCount,
            failureCount: rotationResults.length - successCount,
            results: rotationResults
        });
        return;
    }

    response.statusCode = httpStatus.BAD_REQUEST;
    response.sendJson({ error: "UNSUPPORTED_MODE" });
}

module.exports = { rotatePaidDeckContentKey };
