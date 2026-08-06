const CreditLedger = require("./CreditLedger");
const CreditGrantExecutor = require("./CreditGrantExecutor");
const PeriodicAssignmentQueryEngine = require("./PeriodicAssignmentQueryEngine");
const PeriodicAssignmentRecipientStore = require("./PeriodicAssignmentRecipientStore");
const PeriodicSchedule = require("./PeriodicSchedule");
const OrganizationMemberQueryEngine = require("../Organization/OrganizationMemberQueryEngine");
const OrganizationQueryEngine = require("../Organization/OrganizationQueryEngine");
const OrganizationCreditLedger = require("../Organization/OrganizationCreditLedger");
const CreditGrantTargetResolver = require("./CreditGrantTargetResolver");
const AuthenticationQueryEngine = require("../Database/AuthenticationQueryEngine");
const NotificationDispatcher = require("../Notifications/NotificationDispatcher");
const NotificationContent = require("../Notifications/NotificationContent");
const { notificationChannels } = require("../../Enumerations/NotificationChannels");
const { creditTransactionTypes } = require("../../Enumerations/CreditTransactionTypes");
const { periodicScopeTypes } = require("../../Enumerations/PeriodicScopeTypes");
const { periodicOnJoinModes } = require("../../Enumerations/PeriodicOnJoinModes");
const { tagMatchModes } = require("../../Enumerations/TagMatchModes");


/**
 * PeriodicCreditReconciler
 *
 * The lazy, pull-based engine that materialises periodic credit assignments.
 * There is NO scheduler — instead this runs for the acting user whenever they
 * (a) query their credits (GetUser / settings refresh) or (b) use a metered AI
 * feature (via CreditPreflight). At that moment it grants every installment
 * that has become due since the user was last reconciled.
 *
 * Idempotency & anti-exploit are anchored on two invariants:
 *
 *   1. Every grant goes through CreditLedger.grant under a deterministic
 *      referenceKey — `periodic:{assignmentId}:{email}:{periodKey}` for an
 *      installment and `periodic:{assignmentId}:{email}:onjoin` for the
 *      one-time on-join bonus. The unique referenceKey index makes a replay or
 *      a concurrent reconcile a no-op, so two simultaneous requests for the
 *      same user can never double-grant.
 *
 *   2. Accumulation of missed periods is CLAMPED to the window the user was
 *      genuinely eligible. The lower bound is the latest of the assignment
 *      start, the member's CURRENT organization-membership addedAt (so a
 *      leave/rejoin gap is never back-paid — rejoin creates a newer row), and
 *      the recipient's last-granted cursor. The upper bound is min(now,
 *      validUntil). The on-join key carries no period/membership component, so
 *      it is granted exactly once per email ever, surviving a rejoin.
 */
class PeriodicCreditReconciler
{
    static #normaliseEmail(email)
    {
        if (typeof email !== "string")
        {
            return "";
        }
        return email.trim().toLowerCase();
    }

    /**
     * Reconciles every active assignment that applies to this user.
     * @param {string} userId
     * @param {string} rawEmail
     * @param {Date} [now]
     * @returns {Promise<{ creditsGranted: number }>}
     */
    static async reconcileForUser(userId, rawEmail, now = new Date())
    {
        const email = PeriodicCreditReconciler.#normaliseEmail(rawEmail);
        if (typeof userId !== "string" || userId.length === 0 || email.length === 0)
        {
            return { creditsGranted: 0 };
        }

        let totalCreditsGranted = 0;

        // Candidate list — each entry pairs an active assignment with the
        // membership addedAt anchor (null for people-set scope).
        const candidates = [];

        try
        {
            const peopleSetAssignments = await PeriodicAssignmentQueryEngine.listActiveNamingEmail(email);
            for (const assignment of peopleSetAssignments)
            {
                candidates.push({ assignment: assignment, membershipAddedAt: null });
            }

            const memberships = await OrganizationMemberQueryEngine.findActiveMembershipsByEmail(email);
            for (const membership of memberships)
            {
                const organizationAssignments = await PeriodicAssignmentQueryEngine.listActiveByOrganizationId(membership.organizationId);
                for (const assignment of organizationAssignments)
                {
                    // An organization-scoped assignment may target part of the
                    // roster rather than all of it. The tag test happens here,
                    // at gathering time, so a member the tags do not cover never
                    // reaches the grant path at all.
                    if (!await PeriodicCreditReconciler.#memberMatchesAssignmentTags(assignment, membership.organizationId, email))
                    {
                        continue;
                    }
                    candidates.push({ assignment: assignment, membershipAddedAt: membership.addedAt });
                }
            }
        }
        catch (gatherError)
        {
            // A failure gathering candidates should never break the calling
            // request (GetUser / preflight) — report nothing granted.
            console.warn(`[PeriodicCreditReconciler] Failed to gather candidates for ${userId}: ${gatherError?.message || gatherError}`);
            return { creditsGranted: totalCreditsGranted };
        }

        for (const candidate of candidates)
        {
            try
            {
                totalCreditsGranted += await PeriodicCreditReconciler.#reconcileOne(candidate.assignment, userId, email, now, candidate.membershipAddedAt);
            }
            catch (reconcileError)
            {
                // One bad assignment must not stop the others.
                console.warn(`[PeriodicCreditReconciler] Failed to reconcile assignment ${candidate.assignment?.getId?.()} for ${userId}: ${reconcileError?.message || reconcileError}`);
            }
        }

        // Recurring credits actually arrived this reconcile — notify once with
        // the total, in-app + push. This runs lazily inside a GetUser / preflight
        // call, so it must never throw into that request.
        if (totalCreditsGranted > 0)
        {
            try
            {
                await NotificationDispatcher.dispatch(userId, NotificationContent.recurringCreditsGranted(totalCreditsGranted), notificationChannels.IN_APP | notificationChannels.PUSH);
            }
            catch (notifyError)
            {
                console.warn(`[PeriodicCreditReconciler] Failed to dispatch recurring-credits notification for ${userId}: ${notifyError.message}`);
            }
        }

        return { creditsGranted: totalCreditsGranted };
    }

    /**
     * Convenience wrapper for hook callers that hold only a userId. Resolves
     * the email from the user document, then defers to reconcileForUser.
     * @param {string} userId
     * @param {Date} [now]
     * @returns {Promise<{ creditsGranted: number }>}
     */
    static async reconcileForUserId(userId, now = new Date())
    {
        if (typeof userId !== "string" || userId.length === 0)
        {
            return { creditsGranted: 0 };
        }

        let email = "";
        try
        {
            const user = await AuthenticationQueryEngine.getUserById(userId);
            email = user?.getAdditionalData?.()?.email || "";
        }
        catch (lookupError)
        {
            return { creditsGranted: 0 };
        }

        if (email.length === 0)
        {
            return { creditsGranted: 0 };
        }
        return await PeriodicCreditReconciler.reconcileForUser(userId, email, now);
    }

    /**
     * Per-user-amount for a single installment. ORG scope is always PER_USER
     * (the UI forbids TOTAL_SPLIT for dynamic membership); PEOPLE_SET may
     * split one pot across the fixed recipient list.
     */
    /**
     * Whether one member is covered by an assignment's tag selection.
     *
     * Decided through CreditGrantTargetResolver.filterMembersByTags — the same
     * predicate the one-off distribution and its preview use — so a recurring
     * plan and an ad-hoc grant written with identical tags reach identical
     * people. Two implementations of "who does this tag mean" would drift.
     */
    static async #memberMatchesAssignmentTags(assignment, organizationId, email)
    {
        const tagFilter = typeof assignment.getTagFilter === "function" ? assignment.getTagFilter() : [];
        const tagMatchMode = typeof assignment.getTagMatchMode === "function" ? assignment.getTagMatchMode() : tagMatchModes.EVERYONE;

        if (tagMatchMode === tagMatchModes.EVERYONE || !Array.isArray(tagFilter) || tagFilter.length === 0)
        {
            return true;
        }

        const member = await OrganizationMemberQueryEngine.findMemberByUserIdOrEmail(organizationId, "", email);
        if (!member)
        {
            return false;
        }

        return CreditGrantTargetResolver.filterMembersByTags([member], tagFilter, tagMatchMode).length === 1;
    }

    /**
     * Takes one installment's credits out of the organization's pool before the
     * member is credited.
     *
     * A people-set assignment has no organization behind it and is not funded
     * this way — it is a super-admin gift, not an institute spending what it
     * bought — so it passes straight through.
     *
     * The debit shares the installment's reference key, so a replayed reconcile
     * is a no-op on the pool exactly as it is on the member's balance. A pool
     * that cannot cover the installment refuses it, which is what stops an
     * organization from handing out credits it never paid for.
     */
    static async #fundFromOrganizationPool(assignment, referenceKey, amount, email)
    {
        const organizationId = assignment.getOrganizationId();
        if (assignment.getScopeType() !== periodicScopeTypes.ORGANIZATION || !organizationId || organizationId.length === 0)
        {
            return { ok: true, funded: false };
        }

        const debitResult = await OrganizationCreditLedger.debit
        (
            organizationId,
            amount,
            OrganizationCreditLedger.TRANSACTION_TYPE_DISTRIBUTION,
            `poolFor:${referenceKey}`,
            {
                kind: "periodic",
                periodicAssignmentId: assignment.getId(),
                assignmentName: assignment.getName(),
                recipientEmail: email
            }
        );

        if (debitResult.applied || debitResult.alreadyApplied)
        {
            return { ok: true, funded: true, balanceAfter: debitResult.balanceAfter };
        }

        return { ok: false, funded: false, reason: debitResult.reason, balanceAfter: debitResult.balanceAfter };
    }

    /**
     * Tells the organization a cycle was skipped for want of funds. Announced
     * once per pool state rather than once per member, because a dry pool
     * affects every recipient at the same moment and one notification per
     * student would be a flood describing a single fact.
     *
     * A missed cycle is never back-paid: the next one runs normally once the
     * pool is topped up.
     */
    static async #reportSkippedCycle(assignment, requiredAmount, funding)
    {
        try
        {
            const organizationId = assignment.getOrganizationId();
            const organization = await OrganizationQueryEngine.getOrganizationById(organizationId);
            if (!organization || !organization.getAdminUserId())
            {
                return;
            }

            await NotificationDispatcher.dispatch
            (
                organization.getAdminUserId(),
                NotificationContent.organizationPoolEmpty(organization.getName(), requiredAmount, funding.balanceAfter ?? 0),
                notificationChannels.IN_APP | notificationChannels.PUSH
            );
        }
        catch (reportError)
        {
            console.warn(`[PeriodicCreditReconciler] Could not report a skipped cycle: ${reportError?.message || reportError}`);
        }
    }

    static #perUserAmount(assignment)
    {
        const denominator = assignment.getScopeType() === periodicScopeTypes.PEOPLE_SET
            ? (Array.isArray(assignment.getPeopleEmails()) ? assignment.getPeopleEmails().length : 0)
            : 1;
        return CreditGrantExecutor.computePerUserAmount(assignment.getAmount(), assignment.getAmountMode(), denominator);
    }

    static async #reconcileOne(assignment, userId, email, now, membershipAddedAt)
    {
        const assignmentId = assignment.getId();
        let creditsGranted = 0;

        // The base eligibility start — the earliest a grant can ever be owed
        // under the CURRENT membership span (or the assignment start for
        // people-set). A rejoin supplies a newer membershipAddedAt, so the
        // leave/rejoin gap is excluded here.
        const startAtTime = assignment.getStartAt().getTime();
        const membershipTime = membershipAddedAt instanceof Date ? membershipAddedAt.getTime() : startAtTime;
        const baseLowerBoundTime = Math.max(startAtTime, membershipTime);

        const upperBoundTime = assignment.getHasValidUntil()
            ? Math.min(now.getTime(), assignment.getValidUntil().getTime())
            : now.getTime();

        // Nothing is due yet (start in the future, or already past validUntil).
        if (baseLowerBoundTime > upperBoundTime)
        {
            return 0;
        }

        // On-join applies to BOTH scopes. For an org it fires when a new member
        // joins; for a people-set it grants an immediate bonus the first time
        // each listed person is reconciled. The grant is keyed `:onjoin` (no
        // period/membership component) so it lands exactly once per email ever.
        const onJoinMode = assignment.getOnJoinMode();
        const grantsOnJoin = onJoinMode === periodicOnJoinModes.ON_JOIN_PLUS_PERIODIC
            || onJoinMode === periodicOnJoinModes.ON_JOIN_PLUS_PERIODIC_SKIP_FIRST;

        const perUserAmount = PeriodicCreditReconciler.#perUserAmount(assignment);

        // ── On-join one-time bonus ─────────────────────────────────────────
        if (grantsOnJoin && perUserAmount > 0)
        {
            const onJoinReferenceKey = `periodic:${assignmentId}:${email}:onjoin`;

            const onJoinFunding = await PeriodicCreditReconciler.#fundFromOrganizationPool(assignment, onJoinReferenceKey, perUserAmount, email);
            if (!onJoinFunding.ok)
            {
                await PeriodicCreditReconciler.#reportSkippedCycle(assignment, perUserAmount, onJoinFunding);
                return creditsGranted;
            }

            const onJoinOutcome = await CreditLedger.grant
            (
                userId,
                perUserAmount,
                creditTransactionTypes.ADMIN_ADJUSTMENT,
                onJoinReferenceKey,
                {
                    kind: "periodicOnJoin",
                    periodicAssignmentId: assignmentId,
                    assignmentName: assignment.getName(),
                    scopeType: assignment.getScopeType(),
                    organizationId: assignment.getOrganizationId()
                }
            );
            if (onJoinOutcome.applied === true)
            {
                await PeriodicAssignmentRecipientStore.recordGrant(assignmentId, email, userId, perUserAmount, { isOnJoin: true, periodKey: null, periodStartAt: null }, now);
                creditsGranted += perUserAmount;
            }
        }

        // ── Periodic accumulation ──────────────────────────────────────────
        // Advance the lower bound past the last-granted period so we only
        // enumerate genuinely-new installments (the ledger still guards
        // against any double grant if the cursor is stale).
        const recipient = await PeriodicAssignmentRecipientStore.getRecipient(assignmentId, email);
        let enumerationLowerBoundTime = baseLowerBoundTime;
        if (recipient && recipient.lastGrantedPeriodStartAt instanceof Date)
        {
            enumerationLowerBoundTime = Math.max(enumerationLowerBoundTime, recipient.lastGrantedPeriodStartAt.getTime() + 1);
        }

        if (enumerationLowerBoundTime > upperBoundTime)
        {
            return creditsGranted;
        }

        if (perUserAmount <= 0)
        {
            return creditsGranted;
        }

        const periods = PeriodicSchedule.enumeratePeriods(assignment, new Date(enumerationLowerBoundTime), new Date(upperBoundTime));

        // Skip-first: the very FIRST installment this recipient would ever
        // receive is suppressed, so the on-join bonus is not effectively paid
        // twice at the start. It targets the first ENUMERATED installment (not
        // the calendar period containing the join date — that period may
        // precede the first due installment). A persistent flag plus the
        // advanced cursor make it consume exactly once, ever.
        const shouldSkipFirstInstallment = onJoinMode === periodicOnJoinModes.ON_JOIN_PLUS_PERIODIC_SKIP_FIRST
            && (!recipient || (recipient.skipFirstConsumed !== true && !(recipient.lastGrantedPeriodStartAt instanceof Date)));
        const skipInstallmentIndex = shouldSkipFirstInstallment ? 0 : -1;

        for (let periodIndex = 0; periodIndex < periods.length; periodIndex++)
        {
            const period = periods[periodIndex];

            if (periodIndex === skipInstallmentIndex)
            {
                // Suppress this installment, but advance the cursor and mark
                // the skip consumed so no future reconcile re-examines or
                // re-skips it.
                await PeriodicAssignmentRecipientStore.markSkipFirstConsumed(assignmentId, email);
                await PeriodicAssignmentRecipientStore.advanceCursor(assignmentId, email, period.periodKey, period.periodStartAt);
                continue;
            }

            const referenceKey = `periodic:${assignmentId}:${email}:${period.periodKey}`;

            // An organization-scoped installment is paid FROM that
            // organization's pool. The pool is debited first: if it cannot
            // cover the installment the member is not credited at all, rather
            // than the organization handing out credits it never bought. The
            // debit shares the installment's reference key, so a replay is a
            // no-op on both sides.
            const funding = await PeriodicCreditReconciler.#fundFromOrganizationPool(assignment, referenceKey, perUserAmount, email);
            if (!funding.ok)
            {
                await PeriodicCreditReconciler.#reportSkippedCycle(assignment, perUserAmount, funding);
                break;
            }

            const outcome = await CreditLedger.grant
            (
                userId,
                perUserAmount,
                creditTransactionTypes.ADMIN_ADJUSTMENT,
                referenceKey,
                {
                    kind: "periodic",
                    periodicAssignmentId: assignmentId,
                    assignmentName: assignment.getName(),
                    periodKey: period.periodKey,
                    scopeType: assignment.getScopeType(),
                    organizationId: assignment.getOrganizationId()
                }
            );

            if (outcome.applied === true)
            {
                await PeriodicAssignmentRecipientStore.recordGrant(assignmentId, email, userId, perUserAmount, { isOnJoin: false, periodKey: period.periodKey, periodStartAt: period.periodStartAt }, now);
                creditsGranted += perUserAmount;
            }
            else if (outcome.alreadyApplied === true)
            {
                await PeriodicAssignmentRecipientStore.advanceCursor(assignmentId, email, period.periodKey, period.periodStartAt);
            }
        }

        return creditsGranted;
    }
}

module.exports = PeriodicCreditReconciler;
