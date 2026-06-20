const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const KeyManagementService = require("../../Globals/Classes/Security/KeyManagementService");
const DeckLicense = require("../../Globals/Model/DeckLicense");
const { deckLicenseStatuses } = require("../../Globals/Enumerations/DeckLicenseStatuses");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

/**
 * POST /PaidDecks/SetPassword
 *
 * One-time setup of the buyer's paid-deck password. Called during the
 * first successful purchase (PaidDeckPurchaseFlow on the client checks
 * whether any prior license carries a password and prompts the buyer
 * when none does).
 *
 * Re-wraps every existing license's content key with the freshly
 * derived password-KEK so a single password unlocks every owned deck.
 * Refuses if a password is already set on any active license — use
 * /PaidDecks/ChangePassword for the rotation path.
 */
async function setPaidDeckPassword(request, response)
{
    if (!KeyManagementService.isReady())
    {
        response.statusCode = httpStatus.SERVICE_UNAVAILABLE;
        response.sendJson({ error: ErrorCodes.KEY_MANAGEMENT_NOT_READY });
        return;
    }

    const session = request.session;
    if (!session)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    const body = await request.getBody();
    const newPasswordString = body?.password;

    if (typeof newPasswordString !== "string" || newPasswordString.length < 6)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.PASSWORD_TOO_SHORT });
        return;
    }

    const userId = session.getUserId();
    const database = await DatabaseConnector.getDatabase();
    const licensesCollection = database.collection(DatabaseConstants.DECK_LICENSES_COLLECTION);

    const licenseDocuments = await licensesCollection
        .find({ userId: userId, status: deckLicenseStatuses.ACTIVE })
        .toArray();

    const alreadyHasPassword = licenseDocuments.some((licenseDocument) =>
    {
        return typeof licenseDocument.passwordHash === "string" && licenseDocument.passwordHash.length > 0;
    });

    if (alreadyHasPassword)
    {
        response.statusCode = httpStatus.CONFLICT;
        response.sendJson({ error: ErrorCodes.PASSWORD_ALREADY_SET });
        return;
    }

    const passwordSaltBase64 = KeyManagementService.generatePaidDeckPasswordSaltBase64();
    const passwordHashBase64 = KeyManagementService.computePaidDeckPasswordHash(newPasswordString, passwordSaltBase64);
    const passwordKekBuffer = KeyManagementService.derivePaidDeckPasswordKek(newPasswordString, passwordSaltBase64);

    try
    {
        for (const licenseDocument of licenseDocuments)
        {
            const license = DeckLicense.fromJson(licenseDocument);
            const contentKeyBytes = KeyManagementService.unwrapPaidDeckContentKeyWithServerKek
            (
                license.getServerWrappedIvBase64(),
                license.getServerWrappedContentKeyBase64(),
                license.getDeckId()
            );

            const passwordWrap = KeyManagementService.wrapPaidDeckContentKeyWithPasswordKek(contentKeyBytes, passwordKekBuffer);
            contentKeyBytes.fill(0);

            license.setPasswordSalt(passwordSaltBase64);
            license.setPasswordHash(passwordHashBase64);
            license.setPasswordWrappedContentKeyBase64(passwordWrap.ciphertextBase64);
            license.setPasswordWrappedIvBase64(passwordWrap.ivBase64);
            license.setRotatedAt(new Date());

            await KeyManagementService.persistLicense(license);
        }
    }
    finally
    {
        passwordKekBuffer.fill(0);
    }

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, licensesUpdated: licenseDocuments.length });
}

module.exports = { setPaidDeckPassword };
