const OrganizationQueryEngine = require("./OrganizationQueryEngine");
const OrganizationCreditLedger = require("./OrganizationCreditLedger");
const OrganizationMemberQueryEngine = require("./OrganizationMemberQueryEngine");
const AuthenticationQueryEngine = require("../Database/AuthenticationQueryEngine");
const NotificationDispatcher = require("../Notifications/NotificationDispatcher");
const NotificationContent = require("../Notifications/NotificationContent");
const { notificationChannels } = require("../../Enumerations/NotificationChannels");
const { organizationDelegatePowers } = require("../../Enumerations/OrganizationDelegatePowers");


/**
 * OrganizationTermScheduler
 *
 * Watches the one thing about an organization that changes without anybody
 * doing anything: its contract term running out.
 *
 * At the end of a term the credit pool is FROZEN — distributions and recurring
 * grants stop — and nothing else changes. Members keep the credits they were
 * already given, keep the organization's decks, and keep their permissions.
 * Unused credits stay in the pool and become spendable again the moment the
 * term is renewed, so lapsing costs an institute a pause rather than their
 * money.
 *
 * It also warns before that happens, at 30, 7 and 1 days. Without warnings the
 * first sign of an expiry is a distribution silently refusing, which is the
 * worst possible moment to discover it.
 *
 * Every warning is recorded on the organization so the same threshold is never
 * announced twice, which is what makes a scheduler that ticks hourly safe to
 * run.
 */
class OrganizationTermScheduler
{
    static #TICK_INTERVAL_MILLISECONDS = 6 * 60 * 60 * 1000;
    static #MILLISECONDS_PER_DAY = 86_400_000;

    static WARNING_THRESHOLD_DAYS = [30, 7, 1];

    static #intervalHandle = null;

    static start()
    {
        if (OrganizationTermScheduler.#intervalHandle !== null)
        {
            return;
        }

        OrganizationTermScheduler.#intervalHandle = setInterval(OrganizationTermScheduler.#tick, OrganizationTermScheduler.#TICK_INTERVAL_MILLISECONDS);
    }

    static stop()
    {
        if (OrganizationTermScheduler.#intervalHandle === null)
        {
            return;
        }

        clearInterval(OrganizationTermScheduler.#intervalHandle);
        OrganizationTermScheduler.#intervalHandle = null;
    }

    static async #tick()
    {
        try
        {
            await OrganizationTermScheduler.sweep();
        }
        catch (sweepError)
        {
            console.error("[OrganizationTermScheduler] Sweep failed:", sweepError);
        }
    }

    /**
     * One full pass. Exposed so it can be run once at boot and exercised
     * directly by the verification harness.
     *
     * @param {Date} now injectable clock, so a test need not wait a month
     * @returns {Promise<{ frozen: number, warned: number }>}
     */
    static async sweep(now = new Date())
    {
        let frozenCount = 0;
        let warnedCount = 0;

        // ── Lapsed terms ──────────────────────────────────────────────────
        const lapsedOrganizations = await OrganizationQueryEngine.listOrganizationsWithLapsedTerm(now);
        for (const organization of lapsedOrganizations)
        {
            try
            {
                const pool = await OrganizationCreditLedger.getPool(organization.getId());
                if (pool && pool.getFrozen() === true)
                {
                    // Already handled on an earlier pass.
                    continue;
                }

                await OrganizationCreditLedger.setFrozen(organization.getId(), true);
                frozenCount = frozenCount + 1;

                await OrganizationTermScheduler.#notifyAdministrators
                (
                    organization,
                    NotificationContent.organizationTermExpired(organization.getName())
                );
            }
            catch (freezeError)
            {
                // One bad organization must not stop the sweep for the rest.
                console.error(`[OrganizationTermScheduler] Could not freeze ${organization.getId()}:`, freezeError);
            }
        }

        // ── Terms about to lapse ──────────────────────────────────────────
        for (const thresholdDays of OrganizationTermScheduler.WARNING_THRESHOLD_DAYS)
        {
            const windowEnd = new Date(now.getTime() + thresholdDays * OrganizationTermScheduler.#MILLISECONDS_PER_DAY);
            const approachingOrganizations = await OrganizationQueryEngine.listOrganizationsWithTermEndingBetween(now, windowEnd);

            for (const organization of approachingOrganizations)
            {
                try
                {
                    const announcedThresholds = Array.isArray(organization.getAdditionalData()?.announcedTermThresholds)
                        ? organization.getAdditionalData().announcedTermThresholds
                        : [];

                    if (announcedThresholds.includes(thresholdDays))
                    {
                        continue;
                    }

                    await OrganizationTermScheduler.#notifyAdministrators
                    (
                        organization,
                        NotificationContent.organizationTermEnding(organization.getName(), thresholdDays)
                    );

                    await OrganizationQueryEngine.recordAnnouncedTermThreshold(organization.getId(), thresholdDays);
                    warnedCount = warnedCount + 1;
                }
                catch (warnError)
                {
                    console.error(`[OrganizationTermScheduler] Could not warn ${organization.getId()}:`, warnError);
                }
            }
        }

        if (frozenCount > 0 || warnedCount > 0)
        {
            console.log(`[OrganizationTermScheduler] Froze ${frozenCount} pool(s); sent ${warnedCount} term warning(s).`);
        }

        return { frozen: frozenCount, warned: warnedCount };
    }

    /**
     * Delivers one notification to the owner and to every delegate who could
     * act on it — anyone holding DISTRIBUTE_CREDITS, since they are the people
     * whose work stops when the pool freezes.
     */
    static async #notifyAdministrators(organization, notification)
    {
        const recipientUserIds = new Set();

        if (organization.getAdminUserId() && organization.getAdminUserId().length > 0)
        {
            recipientUserIds.add(organization.getAdminUserId());
        }

        const members = await OrganizationMemberQueryEngine.listMembers(organization.getId());
        for (const member of members)
        {
            const heldPowers = Number.isInteger(member.getDelegatePowers()) ? member.getDelegatePowers() : 0;
            if ((heldPowers & organizationDelegatePowers.DISTRIBUTE_CREDITS) !== organizationDelegatePowers.DISTRIBUTE_CREDITS)
            {
                continue;
            }

            if (member.getUserId() && member.getUserId().length > 0)
            {
                recipientUserIds.add(member.getUserId());
                continue;
            }

            // A delegate appointed before their first login has no userId yet.
            const memberUser = await AuthenticationQueryEngine.getUserByEmail(member.getEmail());
            if (memberUser)
            {
                recipientUserIds.add(memberUser.getId());
            }
        }

        for (const recipientUserId of recipientUserIds)
        {
            try
            {
                await NotificationDispatcher.dispatch(recipientUserId, notification, notificationChannels.IN_APP | notificationChannels.PUSH);
            }
            catch (dispatchError)
            {
                console.warn(`[OrganizationTermScheduler] Notification failed for ${recipientUserId}: ${dispatchError.message}`);
            }
        }
    }
}

module.exports = OrganizationTermScheduler;
