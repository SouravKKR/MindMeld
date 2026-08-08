const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const AuthenticationQueryEngine = require("../Database/AuthenticationQueryEngine");
const KeyManagementService = require("../Security/KeyManagementService");
const OrganizationQueryEngine = require("./OrganizationQueryEngine");
const OrganizationDeckPerkQueryEngine = require("./OrganizationDeckPerkQueryEngine");
const OrganizationMemberQueryEngine = require("./OrganizationMemberQueryEngine");
const Purchase = require("../../Model/Purchase");
const GrantSources = require("../../Constants/GrantSources");
const { organizationDeckPerkTypes } = require("../../Enumerations/OrganizationDeckPerkTypes");
const { paymentProviders } = require("../../Enumerations/PaymentProviders");
const { purchaseStatuses } = require("../../Enumerations/PurchaseStatuses");
const { deckLicenseStatuses } = require("../../Enumerations/DeckLicenseStatuses");


/**
 * OrganizationAutoAssigner
 *
 * Mints Purchase + DeckLicense rows for FREE perks so org members
 * don't have to click "purchase" before they can use the deck. The
 * deck shows up in their library automatically once they're tied to a
 * real user account (either at member-add time if the user already
 * exists, or at first login otherwise).
 *
 * Every entry point is idempotent — the per-user-per-deck uniqueness
 * on `purchases` (userId, deckId, providerOrderId) and `deckLicenses`
 * (userId, deckId) means re-running this on every login is safe.
 * FIXED_OVERRIDE and PERCENTAGE_DISCOUNT perks are explicitly NOT
 * auto-assigned — the user must still click purchase because they're
 * paying real money.
 */
class OrganizationAutoAssigner
{
    static #MILLISECONDS_PER_DAY = 86_400_000;

    /**
     * Called after a single or bulk add — for every FREE perk on this
     * org, mint Purchase + License for the supplied email IF the user
     * already exists. New emails (no user yet) are caught at first
     * login via applyFreePerksOnLogin.
     *
     * Best-effort: any unexpected error is logged and reported as
     * `{ granted: 0 }` rather than re-thrown, so a hiccup in
     * AuthenticationQueryEngine / OrganizationDeckPerkQueryEngine
     * cannot crash the calling endpoint after the member row has
     * already been inserted.
     */
    static async applyFreePerksForMember(organizationId, rawEmail)
    {
        try
        {
            const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
            if (email.length === 0)
            {
                return { granted: 0 };
            }

            const user = await AuthenticationQueryEngine.getUserByEmail(email);
            if (!user)
            {
                return { granted: 0 };
            }

            const organization = await OrganizationQueryEngine.getOrganizationById(organizationId);
            if (!organization)
            {
                return { granted: 0 };
            }

            const perks = await OrganizationDeckPerkQueryEngine.listPerksForOrganization(organizationId);
            const freePerks = perks.filter(perk => perk.getPerkType() === organizationDeckPerkTypes.FREE);

            let grantedCount = 0;
            for (const perk of freePerks)
            {
                const success = await OrganizationAutoAssigner.#grantOnce
                (
                    user.getId(),
                    perk.getDeckId(),
                    organization,
                    perk.getDurationDays()
                );
                if (success)
                {
                    grantedCount++;
                }
            }
            return { granted: grantedCount };
        }
        catch (applyError)
        {
            console.error(`[OrganizationAutoAssigner] applyFreePerksForMember failed for org=${organizationId} email=${rawEmail}: ${applyError.message}`);
            return { granted: 0 };
        }
    }

    /**
     * Called at login (after UserRoleReconciliator.reconcile + member
     * userId backfill). Walks every active membership AND every org
     * this user admins, mints FREE perks they don't yet have.
     *
     * Best-effort — login must NEVER fail because of an auto-assign
     * hiccup. The login-path callers also wrap this in try-catch as
     * defence in depth.
     */
    static async applyFreePerksOnLogin(user)
    {
        try
        {
            if (!user)
            {
                return { granted: 0 };
            }

            const email = (user.getAdditionalData()?.email || "").toLowerCase();
            let totalGranted = 0;

            if (email.length > 0)
            {
                const memberships = await OrganizationMemberQueryEngine.findActiveMembershipsByEmail(email);
                for (const membership of memberships)
                {
                    const perks = await OrganizationDeckPerkQueryEngine.listPerksForOrganization(membership.organizationId);
                    const freePerks = perks.filter(perk => perk.getPerkType() === organizationDeckPerkTypes.FREE);
                    for (const perk of freePerks)
                    {
                        const organization = await OrganizationQueryEngine.getOrganizationById(membership.organizationId);
                        if (!organization)
                        {
                            continue;
                        }
                        const success = await OrganizationAutoAssigner.#grantOnce
                        (
                            user.getId(),
                            perk.getDeckId(),
                            organization,
                            perk.getDurationDays()
                        );
                        if (success)
                        {
                            totalGranted++;
                        }
                    }
                }
            }

            const adminedOrgs = await OrganizationQueryEngine.listActiveOrganizationsByAdminUserId(user.getId());
            for (const organization of adminedOrgs)
            {
                const perks = await OrganizationDeckPerkQueryEngine.listPerksForOrganization(organization.getId());
                const freePerks = perks.filter(perk => perk.getPerkType() === organizationDeckPerkTypes.FREE);
                for (const perk of freePerks)
                {
                    const success = await OrganizationAutoAssigner.#grantOnce
                    (
                        user.getId(),
                        perk.getDeckId(),
                        organization,
                        perk.getDurationDays()
                    );
                    if (success)
                    {
                        totalGranted++;
                    }
                }
            }

            return { granted: totalGranted };
        }
        catch (loginAutoAssignError)
        {
            console.error(`[OrganizationAutoAssigner] applyFreePerksOnLogin failed for user=${user?.getId?.()}: ${loginAutoAssignError.message}`);
            return { granted: 0 };
        }
    }

    /**
     * Called from UpdateOrganizationPerks when a perk transitions to
     * FREE. Fans out to every existing member of the org (and the
     * admin). Best-effort throughout — `#grantOnce` already catches
     * per-grant errors, and the outer try-catch handles DB hiccups in
     * the member-listing loop so a single bad row doesn't block the
     * caller's response.
     */
    static async propagateNewFreePerk(organizationId, deckId, durationDays)
    {
        try
        {
            const organization = await OrganizationQueryEngine.getOrganizationById(organizationId);
            if (!organization)
            {
                return { granted: 0 };
            }

            const members = await OrganizationMemberQueryEngine.listMembers(organizationId);
            let totalGranted = 0;

            for (const member of members)
            {
                const memberEmail = member.getEmail();
                if (!memberEmail || memberEmail.length === 0)
                {
                    continue;
                }
                const user = await AuthenticationQueryEngine.getUserByEmail(memberEmail);
                if (!user)
                {
                    continue;
                }
                const success = await OrganizationAutoAssigner.#grantOnce(user.getId(), deckId, organization, durationDays);
                if (success)
                {
                    totalGranted++;
                }
            }

            // Also grant to the org admin's account if it exists.
            if (organization.getAdminUserId() && organization.getAdminUserId().length > 0)
            {
                const adminUser = await AuthenticationQueryEngine.getUserById(organization.getAdminUserId());
                if (adminUser)
                {
                    const success = await OrganizationAutoAssigner.#grantOnce(adminUser.getId(), deckId, organization, durationDays);
                    if (success)
                    {
                        totalGranted++;
                    }
                }
            }

            return { granted: totalGranted };
        }
        catch (propagateError)
        {
            console.error(`[OrganizationAutoAssigner] propagateNewFreePerk failed for org=${organizationId} deck=${deckId}: ${propagateError.message}`);
            return { granted: 0 };
        }
    }

    /**
     * Idempotent grant: if the user already has a Purchase row for
     * this deck (any status) AND an ACTIVE license, skip. Otherwise
     * mint a $0 Purchase + license with expiresAt = grant + durationDays
     * (or epoch-zero sentinel for FOREVER perks).
     *
     * Wrapped in try-catch — failures here (e.g. KeyManagementService
     * not initialised because PAID_DECK_MASTER_KEY_BASE64 isn't set in
     * dev) must NOT crash the calling endpoint (member-add, login,
     * etc.). The user can retry; the operation is idempotent.
     */
    static async #grantOnce(userId, deckId, organization, durationDays)
    {
        // Same rule as a purchase, and checked before anything is written: a
        // standing perk pointing at a withdrawn deck stops minting rather than
        // quietly handing out content the catalogue no longer sells. Placed
        // first so a refusal cannot leave a completed purchase row behind with
        // no licence to match it.
        const PaidDeckAcquisitionGate = require("../PaidDeck/PaidDeckAcquisitionGate");
        const acquisitionDecision = await PaidDeckAcquisitionGate.evaluateById(deckId);
        if (!acquisitionDecision.allowed)
        {
            console.warn(`[OrganizationAutoAssigner] Skipped ${deckId}: ${acquisitionDecision.reason}`);
            return false;
        }

        try
        {
            const database = await DatabaseConnector.getDatabase();
            if (!database)
            {
                return false;
            }

            const existingPurchase = await database
                .collection(DatabaseConstants.PURCHASES_COLLECTION)
                .findOne({ userId: userId, deckId: deckId });

            const existingLicense = await database
                .collection(DatabaseConstants.DECK_LICENSES_COLLECTION)
                .findOne({ userId: userId, deckId: deckId });

            if (existingPurchase && existingLicense && existingLicense.status === deckLicenseStatuses.ACTIVE)
            {
                // Already owned (or already auto-assigned previously) AND still
                // ACTIVE. Skip — don't double-grant.
                return false;
            }

            const now = new Date();
            const expiresAt = (!Number.isInteger(durationDays) || durationDays <= 0)
                ? new Date(0) // FOREVER sentinel.
                : new Date(now.getTime() + durationDays * OrganizationAutoAssigner.#MILLISECONDS_PER_DAY);

            const purchase = new Purchase
            ({
                userId: userId,
                deckId: deckId,
                paymentProvider: paymentProviders.ORG_AUTO_ASSIGN,
                providerOrderId: `org_auto_${organization.getId()}`,
                providerPaymentId: "",
                amountMinor: 0,
                currency: organization.getCurrency() || "INR",
                region: "GLOBAL",
                purchaseDate: now,
                refundedAt: new Date(0),
                status: purchaseStatuses.COMPLETED,
                additionalData:
                {
                    organizationId: organization.getId(),
                    perkType: "FREE",
                    durationDays: durationDays
                }
            });

            await database
                .collection(DatabaseConstants.PURCHASES_COLLECTION)
                .updateOne
                (
                    { userId: userId, deckId: deckId, providerOrderId: purchase.getProviderOrderId() },
                    { $set: purchase.toJson() },
                    { upsert: true }
                );

            const licenseResult = await KeyManagementService.issueLicenseForDeck
            (
                userId,
                deckId,
                { expiresAt: expiresAt, grantSource: GrantSources.ORG_AUTO_ASSIGN }
            );

            return licenseResult.success === true;
        }
        catch (grantError)
        {
            console.error(`[OrganizationAutoAssigner] grantOnce failed for user=${userId} deck=${deckId}: ${grantError.message}`);
            return false;
        }
    }
}

module.exports = OrganizationAutoAssigner;
