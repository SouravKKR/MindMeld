const { userRoles } = require("../../Enumerations/UserRoles");

/**
 * PaymentAccessPolicy
 *
 * Who may spend money, in which environment.
 *
 * Production is the only environment where an ordinary user may reach a
 * checkout. Everywhere else — local, development, testing — payment features
 * are restricted to administrators.
 *
 * ── Why restrict a test environment at all ────────────────────────────────
 *
 * The reflex is that a non-production environment runs on test keys, so nobody
 * can be charged and the restriction is theatre. Three things make that wrong:
 *
 *   1. The premise is the thing most likely to be false. A test key in
 *      production and a live key outside it are the two failure modes
 *      PaymentEnvironmentValidator exists to catch, and this policy is the
 *      second layer under it — if an env file is ever mis-copied, the blast
 *      radius is administrators rather than every user who happened to be
 *      pointed at that environment.
 *   2. Test environments accumulate real accounts. Staging URLs get shared,
 *      tutorials get walked, seeded users linger. A checkout that "works"
 *      against test keys still grants real credits and real deck licences in
 *      that environment's database, which then has to be cleaned up by hand.
 *   3. Card testing does not care which key mode you are in. An exposed
 *      non-production checkout is an unauthenticated-ish surface for probing
 *      stolen cards against the provider, and the fraud consequences land on
 *      the same merchant account.
 *
 * ── Why the decision lives here and not in the plugin ─────────────────────
 *
 * The plugin (EnsurePaymentAccess) enforces; this class decides. Keeping them
 * apart means the rule can be exercised directly by a harness with no HTTP
 * involved, which is what makes a security control like this testable rather
 * than merely written down. It mirrors PaymentEnvironmentValidator, which
 * returns a verdict and leaves the process-exit decision to index.js.
 */
class PaymentAccessPolicy
{
    // The single environment in which payments are open to everyone. Compared
    // case-insensitively against the resolved environment name, which is the
    // same value index.js uses to pick the env file.
    static UNRESTRICTED_ENVIRONMENT_NAME = "production";

    // Set once at boot from the resolved environment name. Read rather than
    // re-derived per request, because re-reading process.env on every payment
    // call would let a later mutation change the policy mid-process.
    static #environmentName = null;

    /**
     * Records the environment this process is running as. Called once during
     * boot, before any endpoint is registered.
     * @param {string} environmentName
     */
    static configure(environmentName)
    {
        PaymentAccessPolicy.#environmentName = String(environmentName || "").toLowerCase();
    }

    /**
     * @returns {string} the configured environment name, or "" before configure() runs
     */
    static getEnvironmentName()
    {
        return PaymentAccessPolicy.#environmentName || "";
    }

    /**
     * Whether configure() has run. An unconfigured policy means the process
     * cannot say which environment it is, and that is strictly worse than
     * knowing it is a development one.
     * @returns {boolean}
     */
    static isConfigured()
    {
        return typeof PaymentAccessPolicy.#environmentName === "string" && PaymentAccessPolicy.#environmentName.length > 0;
    }

    /**
     * Whether this environment opens payments to every logged-in user.
     *
     * Fails CLOSED: an unconfigured policy is never unrestricted. Getting this
     * backwards would mean a boot-order mistake silently opened payments
     * everywhere, which is exactly the outcome the class exists to prevent.
     *
     * Matching is exact after lower-casing, so a near-miss name like
     * "preproduction" or "production-staging" stays restricted. A prefix or
     * substring match here would quietly open every environment whose name
     * happened to contain the word.
     *
     * @returns {boolean}
     */
    static isUnrestrictedEnvironment()
    {
        return PaymentAccessPolicy.#environmentName === PaymentAccessPolicy.UNRESTRICTED_ENVIRONMENT_NAME;
    }

    /**
     * Whether a given user may use payment features here.
     *
     * @param {object|null} user — the resolved User, or null when unauthenticated
     * @returns {boolean}
     */
    static isPaymentAllowedForUser(user)
    {
        if (!user)
        {
            return false;
        }

        // Refuse EVERYONE, administrators included, until the environment is
        // known. Allowing admins through here would be the tempting middle
        // ground and the wrong one: admin flows would keep working, so a boot
        // ordering mistake that left the policy unconfigured would go unnoticed
        // until an ordinary user hit it in whichever environment that was.
        if (!PaymentAccessPolicy.isConfigured())
        {
            return false;
        }

        if (PaymentAccessPolicy.isUnrestrictedEnvironment())
        {
            return true;
        }

        return user.getRole() === userRoles.ADMIN;
    }

    /**
     * A short, non-alarming explanation for a blocked caller. Names the
     * environment so a developer who hits it knows immediately why, rather than
     * assuming their account or the provider is broken.
     * @returns {string}
     */
    static describeRestriction()
    {
        return `Payment features are restricted to administrators in the "${PaymentAccessPolicy.getEnvironmentName() || "unknown"}" environment.`;
    }
}

module.exports = PaymentAccessPolicy;
