import ErrorCodes from "../../Constants/ErrorCodes.js";

/**
 * OrganizationErrorMessages
 *
 * Turns the server's machine-readable error codes into sentences an
 * administrator can act on.
 *
 * Every organization surface used to render `responseJson.error` directly, so a
 * failed save showed the raw token — "ORG_NOT_ACTIVE", "INVALID_PERK_VALUE" —
 * with no indication of what to do about it. Worse, a code with no message at
 * all rendered as nothing, which is indistinguishable from the save having
 * quietly worked.
 *
 * Unknown codes fall back to the code itself rather than a generic apology:
 * support needs the token, and a made-up sentence would hide it.
 */
class OrganizationErrorMessages
{
    static #MESSAGE_BY_ERROR_CODE =
    {
        [ErrorCodes.ORG_NOT_FOUND]: "That organization no longer exists. Refresh the list and try again.",
        [ErrorCodes.ORG_NOT_ACTIVE]: "This organization is suspended, so it can't be edited. Reactivate it first.",
        [ErrorCodes.NOT_ORG_ADMIN]: "You don't have permission to do this for this organization.",
        [ErrorCodes.MISSING_ORGANIZATION_ID]: "No organization was selected. Reopen this screen and try again.",
        [ErrorCodes.MISSING_FIELDS]: "Some required details are missing. Fill every field and try again.",
        [ErrorCodes.INVALID_NAME]: "Enter a name between 1 and 256 characters.",
        [ErrorCodes.INVALID_ADMIN_EMAIL]: "Enter a valid admin email address.",
        [ErrorCodes.INVALID_EMAIL]: "Enter a valid email address.",
        [ErrorCodes.INVALID_CODE]: "Enter the 6-digit verification code.",
        [ErrorCodes.INVALID_VERIFICATION_TOKEN]: "That verification has expired. Send a new code and verify again.",
        [ErrorCodes.RATE_LIMITED]: "A code was sent very recently. Wait a moment before requesting another.",
        [ErrorCodes.INVALID_MAX_MEMBERS]: "Member capacity must be a whole number greater than zero.",
        [ErrorCodes.MAX_MEMBERS_BELOW_CURRENT]: "Capacity can't be lower than the number of members already in this organization. Remove members first.",
        [ErrorCodes.CAP_REACHED]: "This organization is at its member capacity. Raise the capacity or remove members first.",
        [ErrorCodes.CAP_OR_STATE_REJECTED]: "This organization is at its member capacity, or is not active. Check both and try again.",
        [ErrorCodes.INVALID_FEATURE_SELECTION]: "One of the ticked features isn't recognised. Reload this screen and set them again.",
        [ErrorCodes.INVALID_PERK]: "One of the deck perks isn't valid. Check its type, value and duration.",
        [ErrorCodes.INVALID_PERK_TYPE]: "Pick a perk type for every deck perk.",
        [ErrorCodes.INVALID_PERK_VALUE]: "Perk value must be a whole number of zero or more (0–100 for a percentage discount).",
        [ErrorCodes.INVALID_DECK_ID]: "One of the deck perks points at no deck. Choose a deck for every perk.",
        [ErrorCodes.PERCENTAGE_OUT_OF_RANGE]: "A percentage discount must be between 0 and 100.",
        [ErrorCodes.INVALID_DURATION_DAYS]: "Duration must be a whole number of days, or 0 for forever.",
        [ErrorCodes.MISSING_EMAILS]: "Add at least one email address.",
        [ErrorCodes.MISSING_MEMBER_IDS]: "Select at least one member.",
        [ErrorCodes.ADD_MEMBER_FAILED]: "That member couldn't be added. Try again in a moment.",
        [ErrorCodes.BULK_ADD_FAILED]: "The members couldn't be added. Try again in a moment.",
        [ErrorCodes.DATABASE_UNAVAILABLE]: "The database is unavailable right now. Try again in a moment."
    };

    /**
     * @param {string} errorCode the server's error token, if any
     * @param {number} statusCode the HTTP status, used when the body carried no code
     * @returns {string} a sentence to show the administrator
     */
    static describe(errorCode, statusCode)
    {
        if (typeof errorCode === "string" && OrganizationErrorMessages.#MESSAGE_BY_ERROR_CODE[errorCode])
        {
            return OrganizationErrorMessages.#MESSAGE_BY_ERROR_CODE[errorCode];
        }

        if (typeof errorCode === "string" && errorCode.length > 0)
        {
            return errorCode;
        }

        if (statusCode === 403)
        {
            return "You don't have permission to do this.";
        }

        return `Something went wrong (HTTP ${statusCode}).`;
    }
}

export default OrganizationErrorMessages;
