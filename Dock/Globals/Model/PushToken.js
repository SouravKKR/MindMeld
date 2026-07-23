const crypto = require("crypto");

/**
 * A single push-notification registration token for one user's device. One row
 * per (userId, token). The token is an opaque credential the platform's push
 * service (FCM — covering web, Android and iOS alike) issued to that device;
 * the backend sends to it via FirebaseMessagingClient. Tokens rotate and expire,
 * so invalid ones are pruned on send (see NotificationDispatcher).
 */
class PushToken
{
    #id;
    #userId;
    #token;
    #platform;
    #createdAt;
    #lastSeenAt;

    constructor({id = null, userId = "", token = "", platform = 0, createdAt = new Date(), lastSeenAt = new Date()} = {})
    {
        this.setId(id);
        this.setUserId(userId);
        this.setToken(token);
        this.setPlatform(platform);
        this.setCreatedAt(createdAt);
        this.setLastSeenAt(lastSeenAt);
    }

    getId()
    {
        return this.#id;
    }

    setId(value)
    {
        this.#id = (typeof value === "string" && value.length > 0) ? value : crypto.randomUUID();
    }

    getUserId()
    {
        return this.#userId;
    }

    setUserId(value)
    {
        this.#userId = String(value ?? "");
    }

    getToken()
    {
        return this.#token;
    }

    setToken(value)
    {
        this.#token = String(value ?? "").trim();
    }

    getPlatform()
    {
        return this.#platform;
    }

    setPlatform(value)
    {
        const parsedPlatform = Number(value);
        this.#platform = Number.isInteger(parsedPlatform) ? parsedPlatform : 0;
    }

    getCreatedAt()
    {
        return this.#createdAt;
    }

    setCreatedAt(value)
    {
        this.#createdAt = PushToken.#coerceDate(value);
    }

    getLastSeenAt()
    {
        return this.#lastSeenAt;
    }

    setLastSeenAt(value)
    {
        this.#lastSeenAt = PushToken.#coerceDate(value);
    }

    static #coerceDate(value)
    {
        if (value === null || value === undefined)
        {
            return new Date();
        }
        const coerced = value instanceof Date ? value : new Date(value);
        return isNaN(coerced.getTime()) ? new Date() : coerced;
    }

    toJson()
    {
        return {
            id: this.getId(),
            userId: this.getUserId(),
            token: this.getToken(),
            platform: this.getPlatform(),
            createdAt: this.getCreatedAt().toISOString(),
            lastSeenAt: this.getLastSeenAt().toISOString()
        };
    }

    static fromJson(json)
    {
        return new PushToken
        ({
            id: json?.id ?? null,
            userId: json?.userId ?? "",
            token: json?.token ?? "",
            platform: json?.platform ?? 0,
            createdAt: json?.createdAt != null ? new Date(json.createdAt) : new Date(),
            lastSeenAt: json?.lastSeenAt != null ? new Date(json.lastSeenAt) : new Date()
        });
    }
}

module.exports = PushToken;
