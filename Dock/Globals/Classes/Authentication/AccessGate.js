const App = require("../App");
const AdminEmailQueryEngine = require("../Database/AdminEmailQueryEngine");
const AllowedLoginEmailQueryEngine = require("../Database/AllowedLoginEmailQueryEngine");


/**
 * AccessGate
 *
 * Per-environment login allowlist enforcer. When the ACCESS_ALLOWLIST_ENABLED
 * flag is OFF (production — the default), every email may log in exactly as
 * before, so isEmailAllowed() short-circuits to true. When the flag is ON
 * (dev / test only), only "allowed" emails may sign in, where allowed is the
 * union of:
 *   1. The env ACCESS_ALLOWLIST_EMAILS comma-separated root list, PLUS
 *   2. The existing admin emails (AdminEmailQueryEngine.isAdminEmail), PLUS
 *   3. The allowedLoginEmails Mongo collection (managed in the admin panel).
 *
 * Being on the login allowlist does NOT grant the ADMIN role — it only
 * permits login. Admin role stays governed by the separate adminEmails
 * collection.
 *
 * Fails CLOSED: when the flag is enabled and the email is not matched by
 * any of the three sources, login is refused (returns false).
 */
class AccessGate
{
    static #normaliseEmail(email)
    {
        if (typeof email !== "string")
        {
            return "";
        }
        return email.trim().toLowerCase();
    }

    /**
     * Returns true when the supplied email is permitted to log in. When the
     * allowlist is disabled this is unconditionally true; otherwise the email
     * must match the env list, the admin allowlist, or the login allowlist.
     * @param {string} email
     * @returns {Promise<boolean>}
     */
    static async isEmailAllowed(email)
    {
        if (!App.isAccessAllowlistEnabled())
        {
            return true;
        }

        const normalisedEmail = AccessGate.#normaliseEmail(email);
        if (normalisedEmail.length === 0)
        {
            return false;
        }

        const envAllowlist = App.getAccessAllowlistEmails();
        if (envAllowlist.includes(normalisedEmail))
        {
            return true;
        }

        if (await AdminEmailQueryEngine.isAdminEmail(normalisedEmail))
        {
            return true;
        }

        if (await AllowedLoginEmailQueryEngine.isAllowedEmail(normalisedEmail))
        {
            return true;
        }

        return false;
    }
}

module.exports = AccessGate;
