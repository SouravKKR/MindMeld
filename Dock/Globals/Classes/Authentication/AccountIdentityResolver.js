const AuthenticationQueryEngine = require("../Database/AuthenticationQueryEngine");
const AccountMergeService = require("./AccountMergeService");
const Logger = require("../Logger");
const LogTitles = require("../Logging/LogTitles");
const { logCategory } = require("../../Enumerations/LogCategory");

/**
 * AccountIdentityResolver
 *
 * Shared account-lookup logic for every login provider, so a person who
 * uses both Google and Email+OTP always resolves to the same account.
 * Looks up by BOTH the provider-specific candidate id and the email on
 * every login, not just as a miss-only fallback — a lookup hit on one
 * identity space is no longer trusted without cross-checking the other,
 * which is what let a brand-new split form silently before.
 *
 * When more than one existing account is found for a single login attempt
 * (a split that already happened before this class existed), it picks the
 * most established one and hands both accounts to AccountMergeService to
 * fold the other one into it — synchronously, so this same login lands on
 * a fully consolidated account rather than merely a consistently-chosen
 * one. A merge that is skipped (locked by a concurrent request, or over
 * the synchronous size ceiling) still resolves this login to the
 * most-established account; the actual data consolidation simply retries
 * on the next login for that email.
 *
 * Every match is also resolved through any `mergedIntoUserId` forwarding
 * pointer a PREVIOUS merge left behind, so a Google `sub` or an email that
 * still names an already-merged-away id redirects to the real survivor
 * instead of reusing a dead identity.
 */
class AccountIdentityResolver
{
    // Guards against a forwarding chain ever looping — should never be hit
    // in practice, since a merge always tombstones INTO a never-before-merged
    // survivor, but a corrupted record must fail loudly rather than hang.
    static #MAX_FORWARDING_HOPS = 8;

    /**
     * Follows a chain of mergedIntoUserId forwarding pointers to the real,
     * never-merged account, or returns the user unchanged if it carries no
     * such pointer.
     * @param {import("../../Model/User")|null} user
     * @returns {Promise<import("../../Model/User")|null>}
     */
    static async resolveCanonicalUser(user)
    {
        let currentUser = user;
        let hopCount = 0;

        while (currentUser && currentUser.getAdditionalData()?.mergedIntoUserId)
        {
            hopCount = hopCount + 1;
            if (hopCount > AccountIdentityResolver.#MAX_FORWARDING_HOPS)
            {
                console.error(`[AccountIdentityResolver] mergedIntoUserId forwarding chain exceeded ${AccountIdentityResolver.#MAX_FORWARDING_HOPS} hops starting from ${user.getId()} — stopping to avoid an infinite loop.`);
                return currentUser;
            }

            const forwardedUser = await AuthenticationQueryEngine.getUserById(currentUser.getAdditionalData().mergedIntoUserId);
            if (!forwardedUser)
            {
                return currentUser;
            }
            currentUser = forwardedUser;
        }

        return currentUser;
    }

    /**
     * Finds every distinct existing (canonical, forwarding-resolved)
     * account that could plausibly be this login attempt's identity: the
     * provider-specific candidate id, and every account sharing the
     * candidate email.
     * @param {string} candidateId
     * @param {string} candidateEmail
     * @returns {Promise<import("../../Model/User")[]>}
     */
    static async resolveExistingAccountsForLogin(candidateId, candidateEmail)
    {
        const accountsById = new Map();

        if (candidateId)
        {
            const userMatchedById = await AccountIdentityResolver.resolveCanonicalUser(await AuthenticationQueryEngine.getUserById(candidateId));
            if (userMatchedById)
            {
                accountsById.set(userMatchedById.getId(), userMatchedById);
            }
        }

        if (candidateEmail)
        {
            const usersMatchedByEmail = await AuthenticationQueryEngine.getUsersByEmail(candidateEmail);
            for (const userMatchedByEmail of usersMatchedByEmail)
            {
                const canonicalUser = await AccountIdentityResolver.resolveCanonicalUser(userMatchedByEmail);
                if (canonicalUser)
                {
                    accountsById.set(canonicalUser.getId(), canonicalUser);
                }
            }
        }

        return Array.from(accountsById.values());
    }

    /**
     * Deterministically picks one account out of several matches for the
     * same login attempt: the one with the earliest joinDate. A missing
     * joinDate sorts last (treated as the least established), so a
     * malformed record can never win by accident. AccountMergeService uses
     * this same rule for survivor selection, so behaviour stays consistent
     * whether or not the merge itself succeeds this time.
     * @param {import("../../Model/User")[]} accounts
     * @returns {import("../../Model/User")}
     */
    static pickMostEstablishedAccount(accounts)
    {
        return accounts.reduce((mostEstablishedAccount, candidateAccount) =>
        {
            const mostEstablishedJoinDate = mostEstablishedAccount.getJoinDate();
            const candidateJoinDate = candidateAccount.getJoinDate();

            if (!mostEstablishedJoinDate)
            {
                return candidateJoinDate ? candidateAccount : mostEstablishedAccount;
            }

            if (!candidateJoinDate)
            {
                return mostEstablishedAccount;
            }

            return candidateJoinDate < mostEstablishedJoinDate ? candidateAccount : mostEstablishedAccount;
        });
    }

    /**
     * Resolves the single account a login attempt should use. Looks up by
     * id and email; if more than one distinct account is found, picks the
     * most established one, merges every other match into it, and returns
     * the merged (or, if the merge was skipped, the merely-chosen) account.
     * @param {string} candidateId
     * @param {string} candidateEmail
     * @param {number} provider — an AuthenticationProviders value, for logging only
     * @returns {Promise<import("../../Model/User")|null>} null when no existing account matches
     */
    static async resolveAccountForLogin(candidateId, candidateEmail, provider)
    {
        const existingAccounts = await AccountIdentityResolver.resolveExistingAccountsForLogin(candidateId, candidateEmail);

        if (existingAccounts.length === 0)
        {
            return null;
        }

        if (existingAccounts.length === 1)
        {
            return existingAccounts[0];
        }

        const survivorAccount = AccountIdentityResolver.pickMostEstablishedAccount(existingAccounts);
        const allAccountIds = existingAccounts.map((account) => account.getId());

        console.warn(`[AccountIdentityResolver] ${allAccountIds.length} accounts share one identity (candidateId=${candidateId}, email=${candidateEmail}) — merging into the most established: ${survivorAccount.getId()}.`);
        Logger.warning(logCategory.AUTHENTICATION, LogTitles.ACCOUNT_IDENTITY_SPLIT_DETECTED, "Login detected a split identity and is merging it into the most-established account",
        {
            accountId: survivorAccount.getId(),
            additionalData: { allAccountIds: allAccountIds, provider: provider }
        });

        let currentSurvivor = survivorAccount;
        for (const loserAccount of existingAccounts)
        {
            if (loserAccount.getId() === currentSurvivor.getId())
            {
                continue;
            }

            const mergedUser = await AccountMergeService.mergeAccounts(currentSurvivor, loserAccount, { triggerContext: `LOGIN_PROVIDER_${provider}` });
            if (mergedUser)
            {
                currentSurvivor = mergedUser;
            }
            // A skipped/failed merge (locked, over the size ceiling, or an
            // unexpected error) is not fatal to this login — it still
            // resolves to the chosen survivor, and the merge retries on the
            // next login for this email.
        }

        return currentSurvivor;
    }
}

module.exports = AccountIdentityResolver;
