const { PacketronPlugin } = require("@gamiumgamers/packetron");
const PaymentRequestSchema = require("../../Globals/Classes/Payments/PaymentRequestSchema");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

/**
 * EnsurePaymentRequestSchema
 *
 * Refuses a payment request that carries fields its endpoint does not accept.
 *
 * Placed on the route rather than inside each handler so the guarantee cannot
 * be forgotten by a new endpoint author, and so the allowlist for every payment
 * route lives in one readable place (PaymentRequestSchema).
 *
 * The route path is taken from the REQUEST rather than passed in, so a route
 * registered with the wrong schema key simply has no schema and is not
 * silently validated against another endpoint's field list.
 */
const ensurePaymentRequestSchema = new PacketronPlugin
({
    handler: async (request, response) =>
    {
        const routePath = (typeof request.url === "string" ? request.url : "").split("?")[0];

        let body = null;
        try
        {
            body = await request.getBody();
        }
        catch (bodyError)
        {
            // An unparseable body is the handler's problem to report, not this
            // plugin's — it can produce a far more specific error than
            // "unexpected fields".
            return false;
        }

        const unexpectedFields = PaymentRequestSchema.findUnexpectedFields(routePath, body);
        if (unexpectedFields.length === 0)
        {
            return false;
        }

        console.warn(`[EnsurePaymentRequestSchema] Refused ${routePath}: unexpected field(s) ${unexpectedFields.join(", ")}.`);
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.UNEXPECTED_REQUEST_FIELDS, fields: unexpectedFields });
        return true;
    }
});

module.exports = { ensurePaymentRequestSchema };
