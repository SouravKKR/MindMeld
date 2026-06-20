const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");

// Computes a user's standing on the composite-XP world leaderboard. Rank is a
// single indexed count query (users with a strictly higher score); the total
// user count is cached briefly so the hot path is one count per request.

class LeaderboardService
{
    static #TOP_RANK_LIMIT = 1000;
    static #TOTAL_USERS_CACHE_TTL_MILLISECONDS = 60 * 1000;

    static #cachedTotalUsers = null;
    static #cachedAtMilliseconds = 0;

    static async #getTotalUserCount(usersCollection)
    {
        const now = Date.now();
        if (LeaderboardService.#cachedTotalUsers !== null
            && (now - LeaderboardService.#cachedAtMilliseconds) < LeaderboardService.#TOTAL_USERS_CACHE_TTL_MILLISECONDS)
        {
            return LeaderboardService.#cachedTotalUsers;
        }

        const count = await usersCollection.countDocuments({});
        LeaderboardService.#cachedTotalUsers = count;
        LeaderboardService.#cachedAtMilliseconds = now;
        return count;
    }

    /**
     * @param {object} user — the requesting User
     * @returns {Promise<{score:number, rank:number|null, totalUsers:number, topPercent:number, inTopThousand:boolean}>}
     */
    static async getRankFor(user)
    {
        const score = Math.max(0, Math.floor(user.getAdditionalData()?.metrics?.leaderboardScore || 0));

        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return { score, rank: null, totalUsers: 0, topPercent: 100, inTopThousand: false };
        }

        const usersCollection = database.collection(DatabaseConstants.USERS_COLLECTION);

        const totalUsers = await LeaderboardService.#getTotalUserCount(usersCollection);
        const usersAhead = await usersCollection.countDocuments({ "additionalData.metrics.leaderboardScore": { $gt: score } });

        const rank = usersAhead + 1;
        const topPercent = totalUsers > 0 ? Math.max(1, Math.ceil((rank / totalUsers) * 100)) : 100;
        const inTopThousand = rank <= LeaderboardService.#TOP_RANK_LIMIT;

        return { score, rank, totalUsers, topPercent, inTopThousand };
    }
}

module.exports = LeaderboardService;
