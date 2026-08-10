import PlanMetadataConstants from "../../Constants/PlanMetadataConstants.js";
import { planTiers } from "../../Enumerations/PlanTiers.js";
import { userRoles } from "../../Enumerations/UserRoles.js";

/**
 * PlanViewRegistry
 *
 * The plan sandboxes an account may enter, and who may enter them.
 *
 * Deliberately NOT the shape of OrganizationContextRegistry, which caches what
 * the server said about the organizations a member belongs to. There is nothing
 * to cache here: the tier list is a compile-time constant shipped in
 * PlanMetadataConstants, identical for every account, so it needs no /GetUser
 * field, no IndexedDB record and no network — and therefore cannot go stale,
 * cannot disagree with the server, and works offline without a special case.
 *
 * Availability is the administrator role and nothing else. That check is UX
 * only: ViewScopeResolver re-authorises the same role on every request, so a
 * non-administrator who forged the header gets their own library back rather
 * than a simulation.
 */
class PlanViewRegistry
{
    /**
     * Every simulable tier, in the order the plans are presented everywhere else.
     *
     * @returns {Array<{tierName: string, tier: number, label: string}>}
     */
    static listTiers()
    {
        return PlanMetadataConstants.ORDER.map(tierName => (
        {
            tierName: tierName,
            tier: planTiers[tierName],
            label: PlanViewRegistry.getLabel(tierName),
        }));
    }

    /**
     * The human name of a tier, falling back to the raw name so an unknown value
     * renders as itself rather than as "undefined".
     */
    static getLabel(tierName)
    {
        const metadata = PlanMetadataConstants[tierName];
        return (metadata && metadata.label) ? metadata.label : String(tierName || "");
    }

    static isKnownTierName(tierName)
    {
        return typeof tierName === "string" && PlanMetadataConstants.ORDER.includes(tierName);
    }

    /**
     * True when the signed-in account may simulate a plan. Read live from the
     * session rather than cached, so an administrator who was demoted between
     * page loads stops being offered the entries at the next menu open.
     */
    static isAvailableToCurrentUser()
    {
        const currentUser = window["user"];
        return Boolean(currentUser && typeof currentUser.getRole === "function" && currentUser.getRole() === userRoles.ADMIN);
    }
}

export default PlanViewRegistry;
