const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const KeyManagementService = require("../../Globals/Classes/Security/KeyManagementService");
const DeckLicense = require("../../Globals/Model/DeckLicense");
const { deckLicenseStatuses } = require("../../Globals/Enumerations/DeckLicenseStatuses");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

/**
 * POST /PaidDecks/ChangePassword
 *
 * Body: { oldPassword, newPassword }
 *
 * Server verifies the old password against any active license's hash,
 * then rewraps every active license's content key with a freshly
 * derived new-password KEK and updates the hash/salt across them. Also
 * bumps contentKeyVersion so all cached encrypted entities on the
 * client are forced to be re-fetched (defence-in-depth — same key
 * cipher, but the version flag drives a cache purge).
 */
async function changePaidDeckPassword(request, response)
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
    const oldPasswordString = body?.oldPassword;
    const newPasswordString = body?.newPassword;

    if (typeof oldPasswordString !== "string" || oldPasswordString.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_OLD_PASSWORD });
        return;
    }

    if (typeof newPasswordString !== "string" || newPasswordString.length < 6)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.NEW_PASSWORD_TOO_SHORT });
        return;
    }

    const userId = session.getUserId();
    const database = await DatabaseConnector.getDatabase();
    const licensesCollection = database.collection(DatabaseConstants.DECK_LICENSES_COLLECTION);

    const licenseDocuments = await licensesCollection
        .find({ userId: userId, status: deckLicenseStatuses.ACTIVE })
        .toArray();

    if (licenseDocuments.length === 0)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.NO_LICENSES });
        return;
    }

    const referenceLicenseDocument = licenseDocuments.find((licenseDocument) =>
    {
        return typeof licenseDocument.passwordHash === "string" && licenseDocument.passwordHash.length > 0;
    });

    if (!referenceLicenseDocument)
    {
        response.statusCode = httpStatus.CONFLICT;
        response.sendJson({ error: ErrorCodes.PASSWORD_NOT_SET });
        return;
    }

    const oldSaltBase64 = referenceLicenseDocument.passwordSalt;
    const expectedOldHashBase64 = referenceLicenseDocument.passwordHash;
    const submittedOldHashBase64 = KeyManagementService.computePaidDeckPasswordHash(oldPasswordString, oldSaltBase64);

    if (!KeyManagementService.safeEqualPaidDeckPasswordHash(submittedOldHashBase64, expectedOldHashBase64))
    {
        response.statusCode = httpStatus.UNAUTHORIZED;
        response.sendJson({ error: ErrorCodes.WRONG_OLD_PASSWORD });
        return;
    }

    const newPasswordSaltBase64 = KeyManagementService.generatePaidDeckPasswordSaltBase64();
    const newPasswordHashBase64 = KeyManagementService.computePaidDeckPasswordHash(newPasswordString, newPasswordSaltBase64);
    const newPasswordKekBuffer = KeyManagementService.derivePaidDeckPasswordKek(newPasswordString, newPasswordSaltBase64);

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

            const newPasswordWrap = KeyManagementService.wrapPaidDeckContentKeyWithPasswordKek(contentKeyBytes, newPasswordKekBuffer);
            contentKeyBytes.fill(0);

            license.setPasswordSalt(newPasswordSaltBase64);
            license.setPasswordHash(newPasswordHashBase64);
            license.setPasswordWrappedContentKeyBase64(newPasswordWrap.ciphertextBase64);
            license.setPasswordWrappedIvBase64(newPasswordWrap.ivBase64);
            license.setContentKeyVersion((license.getContentKeyVersion() || 0) + 1);
            license.setRotatedAt(new Date());

            await KeyManagementService.persistLicense(license);
        }
    }
    finally
    {
        newPasswordKekBuffer.fill(0);
    }

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, licensesUpdated: licenseDocuments.length });
}

module.exports = { changePaidDeckPassword };
