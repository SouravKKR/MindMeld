// A single admin-issued promo code. Redeeming one grants the configured
// promo credit amount (CreditConfiguration.getPromoGrantAmount) to the
// redeeming user. `usedCount` is the atomic race gate that enforces
// `maxRedemptions`; the authoritative redeemer set lives in the
// promoCodeRedemptions collection (one row per user per code).

const crypto = require("crypto");

class PromoCode
{
    #id;
    #codeString;
    #maxRedemptions;
    #usedCount;
    #enabled;
    #createdByUserId;
    #createdAt;

    static DEFAULT_MAX_REDEMPTIONS = 1;

    constructor({ id = null, codeString = "", maxRedemptions = PromoCode.DEFAULT_MAX_REDEMPTIONS, usedCount = 0, enabled = true, createdByUserId = "", createdAt = null } = {})
    {
        this.setId(id);
        this.setCodeString(codeString);
        this.setMaxRedemptions(maxRedemptions);
        this.setUsedCount(usedCount);
        this.setEnabled(enabled);
        this.setCreatedByUserId(createdByUserId);
        this.setCreatedAt(createdAt);
    }

    // Codes are stored and compared in a single normalized form so the unique
    // index forbids case / whitespace variants of the same code.
    static normalizeCodeString(value)
    {
        return typeof value === "string" ? value.trim().toUpperCase() : String(value ?? "").trim().toUpperCase();
    }

    getId()
    {
        return this.#id;
    }

    setId(value)
    {
        this.#id = (value !== null && value !== undefined && value !== "") ? String(value) : crypto.randomUUID();
    }

    getCodeString()
    {
        return this.#codeString;
    }

    setCodeString(value)
    {
        this.#codeString = PromoCode.normalizeCodeString(value);
    }

    getMaxRedemptions()
    {
        return this.#maxRedemptions;
    }

    setMaxRedemptions(value)
    {
        value = parseInt(value, 10);
        if (isNaN(value) || value < 1)
        {
            value = 1;
        }
        this.#maxRedemptions = value;
    }

    getUsedCount()
    {
        return this.#usedCount;
    }

    setUsedCount(value)
    {
        value = parseInt(value, 10);
        if (isNaN(value) || value < 0)
        {
            value = 0;
        }
        this.#usedCount = value;
    }

    getEnabled()
    {
        return this.#enabled;
    }

    setEnabled(value)
    {
        this.#enabled = Boolean(value);
    }

    getCreatedByUserId()
    {
        return this.#createdByUserId;
    }

    setCreatedByUserId(value)
    {
        this.#createdByUserId = value !== null && value !== undefined ? String(value) : "";
    }

    getCreatedAt()
    {
        return this.#createdAt;
    }

    setCreatedAt(value)
    {
        if (value !== null && value !== undefined)
        {
            value = value instanceof Date ? value : new Date(value);
            if (isNaN(value.getTime()))
            {
                value = null;
            }
        }
        else
        {
            value = null;
        }
        this.#createdAt = value;
    }

    toJson()
    {
        return {
            id: this.getId(),
            codeString: this.getCodeString(),
            maxRedemptions: this.getMaxRedemptions(),
            usedCount: this.getUsedCount(),
            enabled: this.getEnabled(),
            createdByUserId: this.getCreatedByUserId(),
            createdAt: this.getCreatedAt(),
        };
    }

    static fromJson(json)
    {
        return new PromoCode({
            id: json?.id ?? null,
            codeString: json?.codeString ?? "",
            maxRedemptions: json?.maxRedemptions ?? PromoCode.DEFAULT_MAX_REDEMPTIONS,
            usedCount: json?.usedCount ?? 0,
            enabled: json?.enabled ?? true,
            createdByUserId: json?.createdByUserId ?? "",
            createdAt: json?.createdAt ?? null,
        });
    }
}

module.exports = PromoCode;
