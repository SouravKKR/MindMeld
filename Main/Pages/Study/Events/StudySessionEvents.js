/**
 * StudySessionEvents
 *
 * Window-level events the active StudySession dispatches whenever the
 * currently-displayed entity changes. The bottom panel listens for
 * these so it can refresh per-entity state (e.g. the Mark-for-Review
 * toggle label for cards). Decoupling the panel from the session
 * lifecycle this way keeps the panel a drop-in component without a
 * direct session reference.
 */
class StudySessionEvents
{
    static CARD_CHANGED            = "study-session-card-changed";
    static STUDY_MATERIAL_CHANGED  = "study-session-study-material-changed";
}

export default StudySessionEvents;
