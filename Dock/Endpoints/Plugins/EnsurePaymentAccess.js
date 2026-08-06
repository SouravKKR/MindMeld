const { PacketronPlugin } = require("@gamiumgamers/packetron");
const { getUser } = require("../Helpers/GetUser");
const PaymentAccessPolicy = require("../../Globals/Classes/Payments/PaymentAccessPolicy");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

/**
 * EnsurePaymentAccess
 *
 * Enforces PaymentAccessPolicy on every route that can move money: in
 * production anyone signed in may pay, and in every other environment only an
 * administrator may.
 *
 * Applied AFTER ensureLogin on each payment route, so the "not signed in" case
 * is already a clean 401 by the time this runs and this plugin only has to
 * answer the authorisation question. It still resolves the user itself rather
 * than trusting a field another plugin may or may not have set — an
 * authorisation gate that depends on plugin ordering is one refactor away from
 * being silently skipped.
 *
 * Returns 403 with a named error code rather than a bare status, because the
 * client needs to tell "you may not do this here" apart from "you may not do
 * this at all" in order to show something more useful than a generic failure.
 */
const ensurePaymentAccess = new PacketronPlugin
({
    handler: async (request, response) =>
    {
        const user = await getUser(request);

        if (!user)
        {
            response.sendStatusCode(httpStatus.UNAUTHORIZED);
            return true;
        }

        if (!PaymentAccessPolicy.isPaymentAllowedForUser(user))
        {
            console.warn(`[EnsurePaymentAccess] Refused a payment request from ${user.getId()} in the "${PaymentAccessPolicy.getEnvironmentName()}" environment.`);
            response.statusCode = httpStatus.FORBIDDEN;
            response.sendJson
            ({
                error: ErrorCodes.PAYMENTS_RESTRICTED_TO_ADMINISTRATORS,
                message: PaymentAccessPolicy.describeRestriction()
            });
            return true;
        }

        request.user = user;
        return false;
    }
});

module.exports = { ensurePaymentAccess };
