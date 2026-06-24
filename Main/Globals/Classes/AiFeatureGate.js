import DialogBox from "../../CommonComponents/DialogBox.js";

/**
 * AiFeatureGate
 *
 * Centralised allow-list check for AI features. Every server-cost-incurring
 * AI feature (Generate With AI, the weekly auto-analysis, curated-study
 * generation, etc.) routes through this class so the access policy lives in
 * exactly one place.
 *
 * The closed-test "AI is admin-only" lock has been lifted: now that the
 * credits system is live, AI features are open to every signed-in user and
 * affordability is enforced authoritatively by the credit preflight /
 * per-task charge on the backend (CreditPreflight + the Agent). This gate is
 * kept as the single switch — re-introduce a role restriction here and every
 * call site tightens with it.
 */
class AiFeatureGate
{
    static UNAUTHORIZED_TITLE   = "Sign in required";
    static UNAUTHORIZED_MESSAGE = "Please sign in to use AI features.";

    /**
     * True when there is a signed-in user who may use AI features. Cost is
     * gated separately by the credits system, so this only confirms the
     * user is authenticated.
     */
    static isAllowed()
    {
        const currentUser = window["user"];
        return Boolean(currentUser && typeof currentUser.getRole === "function");
    }

    /**
     * Returns true when the current user may use AI features. Otherwise pops
     * a standard dialog and returns false. Use this in user-initiated entry
     * points (button clicks, page loads, toggle changes). Do NOT use it in
     * background dispatchers — those should silently skip via isAllowed() to
     * avoid surprising the user with a dialog they didn't trigger.
     */
    static async ensureAllowedOrShowAlert()
    {
        if (AiFeatureGate.isAllowed())
        {
            return true;
        }

        await DialogBox.alert(AiFeatureGate.UNAUTHORIZED_TITLE, AiFeatureGate.UNAUTHORIZED_MESSAGE);
        return false;
    }
}

export default AiFeatureGate;
