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

    // The offline "last logged-in user" snapshot (written by
    // OfflineSessionManager). It MUST be readable at boot before any
    // identity is known — it is precisely what tells us who the last user
    // was, so it cannot itself live behind a per-user prefix. Stored
    // unprefixed via GLOBAL_KEYS below.
    static OFFLINE_SESSION_CACHE_PATH = "Session/Cache.json";

    // Persistence paths in this set bypass the per-identity prefix — for
    // data that must survive (and be readable across) identity changes.
    static GLOBAL_KEYS = new Set([UserIdentityConstants.OFFLINE_SESSION_CACHE_PATH]);
}

export default UserIdentityConstants;
