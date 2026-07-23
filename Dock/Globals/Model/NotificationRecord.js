const crypto = require("crypto");

/**
 * A single in-app notification persisted for one user (the IN_APP delivery
 * channel). The client fetches these via /Notifications/List and marks them
 * read. The same logical notification may also be delivered as an FCM push
 * (the PUSH channel) — which channels fire is decided by the bitwise flags
 * passed to NotificationDispatcher.dispatch; this record is only written when
 * the IN_APP bit is set. `data` is an optional free-form string map echoed to
 * the client (and to the push payload) for deep-linking.
 */
class NotificationRecord
{
    #id;
    #userId;
    #type;
    #title;
    #body;
    #data;
    #createdAt;
    #readAt;

    constructor({id = null, userId = "", type = 0, title = "", body = "", data = {}, createdAt = new Date(), readAt = null} = {})
    {
        this.setId(id);
        this.setUserId(userId);
        this.setType(type);
        this.setTitle(title);
        this.setBody(body);
        this.setData(data);
        this.setCreatedAt(createdAt);
        this.setReadAt(readAt);
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

    getType()
    {
        return this.#type;
    }

    setType(value)
    {
        const parsedType = Number(value);
        this.#type = Number.isInteger(parsedType) ? parsedType : 0;
    }

    getTitle()
    {
        return this.#title;
    }

    setTitle(value)
    {
        this.#title = String(value ?? "").slice(0, 256);
    }

    getBody()
    {
        return this.#body;
    }

    setBody(value)
    {
        this.#body = String(value ?? "").slice(0, 2048);
    }

    getData()
    {
        return this.#data;
    }

    setData(value)
    {
        this.#data = (value !== null && typeof value === "object") ? value : {};
    }

    getCreatedAt()
    {
        return this.#createdAt;
    }

    setCreatedAt(value)
    {
        this.#createdAt = NotificationRecord.#coerceDate(value, false);
    }

    getReadAt()
    {
        return this.#readAt;
    }

    setReadAt(value)
    {
        // Nullable: null means unread. Only coerce when a value is present.
        this.#readAt = (value === null || value === undefined) ? null : NotificationRecord.#coerceDate(value, true);
    }

    isRead()
    {
        return this.#readAt !== null;
    }

    static #coerceDate(value, allowNull)
    {
        if (value === null || value === undefined)
        {
            return allowNull ? null : new Date();
        }
        const coerced = value instanceof Date ? value : new Date(value);
        if (isNaN(coerced.getTime()))
        {
            return allowNull ? null : new Date();
        }
        return coerced;
    }

    toJson()
    {
        return {
            id: this.getId(),
            userId: this.getUserId(),
            type: this.getType(),
            title: this.getTitle(),
            body: this.getBody(),
            data: this.getData(),
            createdAt: this.getCreatedAt().toISOString(),
            readAt: this.getReadAt() !== null ? this.getReadAt().toISOString() : null
        };
    }

    static fromJson(json)
    {
        return new NotificationRecord
        ({
            id: json?.id ?? null,
            userId: json?.userId ?? "",
            type: json?.type ?? 0,
            title: json?.title ?? "",
            body: json?.body ?? "",
            data: json?.data ?? {},
            createdAt: json?.createdAt != null ? new Date(json.createdAt) : new Date(),
            readAt: json?.readAt != null ? new Date(json.readAt) : null
        });
    }
}

module.exports = NotificationRecord;
