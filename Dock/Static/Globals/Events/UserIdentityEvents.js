/**
 * UserIdentityEvents
 *
 * - CHANGED : dispatched every time the current identity is (re)set, INCLUDING
 *             the first set after boot. Detail: { previousIdentity, currentIdentity }
 * - READY   : dispatched exactly once, the first time an identity is set
 *             after boot. Detail: { currentIdentity }
 *
 * Consumers that need to react to identity changes (Persistence-prefixed
 * loaders, SyncManager, etc.) listen for CHANGED. Anything that should
 * happen exactly once after the identity is first known listens for READY.
 */
class UserIdentityEvents
{
    static CHANGED = "user-identity-changed";
    static READY   = "user-identity-ready";
}

export default UserIdentityEvents;
