class UserSession
{
    #userId;
    #id;
    #provider;
    #deviceId;
    #creationDate;
    #lastRefreshDate;
    #expirationDate;

    static #expirationTime = 30 * 24 * 60 * 60 * 1000;

    // A user may hold at most this many concurrent sessions. When a new
    // session pushes the count past the cap, the least-recently-refreshed
    // sessions are evicted (see AuthenticationQueryEngine.createSession).
    static MAX_ACTIVE_SESSIONS_PER_USER = 4;

    // Sliding-expiry throttle. Each authenticated request slides the session's
    // expirationDate forward (inactivity-based expiry), but the persisting
    // write is skipped unless the session is at least this stale — so an active
    // user costs at most one session write per day, not one per request
    // (see SlideSessionExpiry).
    static REFRESH_THROTTLE_MILLISECONDS = 24 * 60 * 60 * 1000;

    static getExpirationTime() { return UserSession.#expirationTime; }

    static fromJson(json)
    {
        return new UserSession
        (
            json.id,
            json.userId,
            json.provider,
            json.deviceId || "",
            json.creationDate || new Date(),
            json.lastRefreshDate || json.creationDate,
            json.expirationDate || new Date(Date.now() + UserSession.#expirationTime)
        );
    }

    constructor(id, userId, provider, deviceId, creationDate, lastRefreshDate, expirationDate)
    {
        this.#id = id;
        this.#userId = userId;
        this.#provider = provider;
        this.#deviceId = deviceId || "";
        this.#creationDate = new Date(creationDate);
        this.#lastRefreshDate = new Date(lastRefreshDate);
        this.#expirationDate = new Date(expirationDate);
    }

    isValid()
    {
        let bDataValid = true;

        bDataValid = (this.#userId && this.#id && this.#provider && this.#creationDate && this.#lastRefreshDate && this.#expirationDate) || false;
        bDataValid = this.#expirationDate > new Date() || false;

        return bDataValid;
    }

    getId() { return this.#id; }
    getUserId() { return this.#userId; }
    getProvider() { return this.#provider; }
    getDeviceId() { return this.#deviceId; }
    setDeviceId(deviceId) { this.#deviceId = deviceId || ""; }
    getLastRefreshDate() { return this.#lastRefreshDate; }
    getExpirationDate() { return this.#expirationDate; }

    refresh()
    {
        this.#lastRefreshDate = new Date();
        this.#expirationDate = new Date(this.#lastRefreshDate.getTime() + UserSession.#expirationTime);
    }

    async logout()
    {
    }

    toJson()
    {
        return {
            id: this.#id,
            userId: this.#userId,
            provider: this.#provider,
            deviceId: this.#deviceId,
            creationDate: this.#creationDate,
            lastRefreshDate: this.#lastRefreshDate,
            expirationDate: this.#expirationDate
        };
    }
}

module.exports = UserSession;
