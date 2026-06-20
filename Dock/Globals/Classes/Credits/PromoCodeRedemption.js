// One redemption of a promo code by a single user. A unique compound index on
// (promoCodeId, userId) makes a second redemption by the same user impossible,
// and the row set is the authoritative source for the displayed used-count and
// the "who redeemed this code" report.

const crypto = require("crypto");

class PromoCodeRedemption
{
    #id;
    #promoCodeId;
    #codeString;
    #userId;
    #email;
    #creditsGranted;
    #redeemedAt;

    constructor({ id = null, promoCodeId = "", codeString = "", userId = "", email = "", creditsGranted = 0, redeemedAt = null } = {})
    {
        this.setId(id);
        this.setPromoCodeId(promoCodeId);
        this.setCodeString(codeString);
        this.setUserId(userId);
        this.setEmail(email);
        this.setCreditsGranted(creditsGranted);
        this.setRedeemedAt(redeemedAt);
    }

    getId()
    {
        return this.#id;
    }

    setId(value)
    {
        this.#id = (value !== null && value !== undefined && value !== "") ? String(value) : crypto.randomUUID();
    }

    getPromoCodeId()
    {
        return this.#promoCodeId;
    }

    setPromoCodeId(value)
    {
        this.#promoCodeId = value !== null && value !== undefined ? String(value) : "";
    }

    getCodeString()
    {
        return this.#codeString;
    }

    setCodeString(value)
    {
        this.#codeString = value !== null && value !== undefined ? String(value) : "";
    }

    getUserId()
    {
        return this.#userId;
    }

    setUserId(value)
    {
        this.#userId = value !== null && value !== undefined ? String(value) : "";
    }

    getEmail()
    {
        return this.#email;
    }

    setEmail(value)
    {
        this.#email = value !== null && value !== undefined ? String(value) : "";
    }

    getCreditsGranted()
    {
        return this.#creditsGranted;
    }

    setCreditsGranted(value)
    {
        value = parseFloat(value);
        if (isNaN(value) || value < 0)
        {
            value = 0;
        }
        this.#creditsGranted = value;
    }

    getRedeemedAt()
    {
        return this.#redeemedAt;
    }

    setRedeemedAt(value)
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
        this.#redeemedAt = value;
    }

    toJson()
    {
        return {
            id: this.getId(),
            promoCodeId: this.getPromoCodeId(),
            codeString: this.getCodeString(),
            userId: this.getUserId(),
            email: this.getEmail(),
            creditsGranted: this.getCreditsGranted(),
            redeemedAt: this.getRedeemedAt(),
        };
    }

    static fromJson(json)
    {
        return new PromoCodeRedemption({
            id: json?.id ?? null,
            promoCodeId: json?.promoCodeId ?? "",
            codeString: json?.codeString ?? "",
            userId: json?.userId ?? "",
            email: json?.email ?? "",
            creditsGranted: json?.creditsGranted ?? 0,
            redeemedAt: json?.redeemedAt ?? null,
        });
    }
}

module.exports = PromoCodeRedemption;
