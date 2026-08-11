import BrowserLlmDownloadConstants from "./BrowserLlmDownloadConstants.js";

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
    //
    // The on-device AI model's download record belongs here because the thing
    // it describes is not per-user: the weights sit in the browser's own
    // origin-wide store (WebLLM's IndexedDB / Cache backend), shared by every
    // identity on the device. Behind a per-user prefix the record was scoped
    // narrower than the asset — unreadable at boot before the session
    // resolves, and invisible after any identity change — so a model that was
    // already on disk reported itself missing and the tier picker asked for a
    // fresh ~880 MB download on every refresh.
    //
    // The DECLINED flag deliberately stays per-user: that one really is a
    // personal choice, not a fact about the device.
    // The tier choice belongs here for the same reason and with the same
    // symptom: it is hydrated when the dropdown mounts, which happens before
    // the session has resolved an identity, so the read went to
    // Users/anonymous/... while the write that followed the user's click went
    // to Users/<id>/... — and the selection silently reverted to BASIC on every
    // reload. Its own docstring already calls it device-local; this makes the
    // storage match. (The per-user story is ProfileSettingKeys
    // .PREFERRED_MODEL_TIER, a synced setting that is not wired up yet.)
    // The Ask AI language is here for the same reason as the tier, and its own
    // docstring already described it as "global, device-local" while the
    // storage said otherwise — hydrated when <language-select> mounts, read
    // under Users/anonymous, written under Users/<id>, silently back to
    // English on every reload.
    //
    // GRAPHICS_UNUSABLE records that this machine's GPU lost its device under
    // a real model load. That is a fact about the hardware, not the person, and
    // it has to outlive both the session and the identity or the next load
    // walks straight back into the same hang.
    static GLOBAL_KEYS = new Set([
        UserIdentityConstants.OFFLINE_SESSION_CACHE_PATH,
        BrowserLlmDownloadConstants.LOCAL_STATE_PERSISTENCE_KEY,
        BrowserLlmDownloadConstants.LOCAL_PREFERRED_TIER_PERSISTENCE_KEY,
        BrowserLlmDownloadConstants.LOCAL_ASK_AI_LANGUAGE_PERSISTENCE_KEY,
        BrowserLlmDownloadConstants.LOCAL_GRAPHICS_UNUSABLE_PERSISTENCE_KEY,
    ]);
}

export default UserIdentityConstants;
