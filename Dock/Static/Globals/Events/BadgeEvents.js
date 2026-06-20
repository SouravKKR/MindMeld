/**
 * Event names for the login-streak / badge feature. ACHIEVED fires once per
 * newly-celebrated badge (detail: { badge, currentStreak }); STREAK_UPDATED
 * fires when the streak count itself changes (detail: { current, longest }).
 * Components that want to react to streak/badge changes (e.g. a future home
 * widget) listen for these rather than re-reading window["user"] directly.
 */
class BadgeEvents
{
    static ACHIEVED = "badge-achieved";
    static STREAK_UPDATED = "streak-updated";
}

export default BadgeEvents;
