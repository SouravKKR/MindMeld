import DialogBox from "../../CommonComponents/DialogBox.js";
import { userRoles } from "../Enumerations/UserRoles.js";

/**
 * AiFeatureGate
 *
 * Centralised allow-list check for AI features during the closed-test
 * phase. Every server-cost-incurring AI feature (Generate With AI, the
 * weekly auto-analysis, curated-study generation, etc.) routes through
 * this class so the "AI is admin-only right now" policy lives in exactly
 * one place. Lift the gate by deleting this class — or by relaxing the
 * isAdmin() check — and every call site loosens with it.
 */
class AiFeatureGate
{
    static UNAUTHORIZED_TITLE   = "Feature restricted";
    static UNAUTHORIZED_MESSAGE = "This feature is currently restricted until beta testing is over.";

    static isAdmin()
    {
        const currentUser = window["user"];
        if (!currentUser || typeof currentUser.getRole !== "function")
        {
            return false;
        }
        return currentUser.getRole() === userRoles.ADMIN;
    }

    /**
     * Returns true when the current user is an admin. Otherwise pops the
     * standard "AI restricted" dialog and returns false. Use this in
     * user-initiated entry points (button clicks, page loads, toggle
     * changes). Do NOT use it in background dispatchers — those should
     * silently skip via isAdmin() to avoid surprising the user with a
     * dialog they didn't trigger.
     */
    static async ensureAdminOrShowAlert()
    {
        if (AiFeatureGate.isAdmin())
        {
            return true;
        }

        await DialogBox.alert(AiFeatureGate.UNAUTHORIZED_TITLE, AiFeatureGate.UNAUTHORIZED_MESSAGE);
        return false;
    }
}

export default AiFeatureGate;
