const { PacketronHandlerFlags, PacketronRequestMethod } = require("@gamiumgamers/packetron");
const { ensureLogin } = require("./Plugins/EnsureLogin");
const { noCache } = require("./Plugins/NoCache");
const { ensurePaymentAccess } = require("./Plugins/EnsurePaymentAccess");
const { ensurePaymentRequestSchema } = require("./Plugins/EnsurePaymentRequestSchema");
const { initiateSubscription } = require("./Subscription/InitiateSubscription");
const { verifySubscription } = require("./Subscription/VerifySubscription");
const { cancelSubscription } = require("./Subscription/CancelSubscription");
const { changeSubscriptionPlan } = require("./Subscription/ChangeSubscriptionPlan");

function handleSubscriptionEndpoints(server)
{
    server.handle
    ({
        routePath: `/Subscription/Initiate`,
        handler: initiateSubscription,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin, ensurePaymentAccess, ensurePaymentRequestSchema, noCache]
    });

    server.handle
    ({
        routePath: `/Subscription/Verify`,
        handler: verifySubscription,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin, ensurePaymentAccess, ensurePaymentRequestSchema, noCache]
    });

    server.handle
    ({
        routePath: `/Subscription/Cancel`,
        handler: cancelSubscription,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin, noCache]
    });

    server.handle
    ({
        routePath: `/Subscription/Change`,
        handler: changeSubscriptionPlan,
        flags: PacketronHandlerFlags.JSON_BODY,
        method: PacketronRequestMethod.POST,
        plugins: [ensureLogin, ensurePaymentAccess, ensurePaymentRequestSchema, noCache]
    });
}

module.exports = { handleSubscriptionEndpoints };
