/**
 * UserIdentityConstants
 *
 * Centralises the keys/strings used by the user-identity scoping layer.
 * Persistence reads, writes and deletes are namespaced under
 * STORAGE_ROOT_PREFIX/<identity>/... unless the raw path is on the
 * GLOBAL_KEYS allowlist (e.g. things that must survive identity changes).
 */
class UserIdentityConstants
{
    static ANONYMOUS_IDENTITY = "anonymous";

    static STORAGE_ROOT_PREFIX = "Users";

    // Persistence paths in this set bypass the per-identity prefix.
    // Empty for now — keep here so future global keys (cross-account
    // device preferences, etc.) have an obvious home.
    static GLOBAL_KEYS = new Set();
}

export default UserIdentityConstants;
