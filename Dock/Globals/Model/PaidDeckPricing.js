const crypto = require('crypto');

class PaidDeckPricing
{
    #id;
    #deckId;
    #region;
    #priceMinor;
    #currency;
    #discountPercent;
    #durationDays;
    #isPerpetual;
    #effectiveFrom;
    #effectiveUntil;
    #additionalData;

    constructor({deckId = null, region = 'GLOBAL', priceMinor = 0, currency = 'INR', discountPercent = 0, durationDays = 0, isPerpetual = false, effectiveFrom = new Date(), effectiveUntil = new Date(), additionalData = {}} = {})
    {
        this.#id = crypto.randomUUID();
        this.setDeckId(deckId);
        this.setRegion(region);
        this.setPriceMinor(priceMinor);
        this.setCurrency(currency);
        this.setDiscountPercent(discountPercent);
        this.setDurationDays(durationDays);
        this.setIsPerpetual(isPerpetual);
        this.setEffectiveFrom(effectiveFrom);
        this.setEffectiveUntil(effectiveUntil);
        this.setAdditionalData(additionalData);
    }

    getId()
    {
        return this.#id;
    }

    getDeckId()
    {
        return this.#deckId;
    }

    setDeckId(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#deckId = value;
    }

    getRegion()
    {
        return this.#region;
    }

    setRegion(value)
    {
        if (value !== null)
        {
            value = String(value);
            if (value.length > 16)
            {
                value = value.slice(0, 16);
            }
        }
        this.#region = value;
    }

    getPriceMinor()
    {
        return this.#priceMinor;
    }

    setPriceMinor(value)
    {
        if (value !== null)
        {
            value = parseInt(value, 10);
            if (isNaN(value))
            {
                value = 0;
            }
            else
            {
                value = Math.max(value, 0);
            }
        }
        this.#priceMinor = value;
    }

    getCurrency()
    {
        return this.#currency;
    }

    setCurrency(value)
    {
        if (value !== null)
        {
            value = String(value);
            if (value.length > 8)
            {
                value = value.slice(0, 8);
            }
        }
        this.#currency = value;
    }

    getDiscountPercent()
    {
        return this.#discountPercent;
    }

    setDiscountPercent(value)
    {
        if (value !== null)
        {
            value = parseFloat(value);
            if (isNaN(value))
            {
                value = 0;
            }
            else
            {
                value = Math.min(Math.max(value, 0), 100);
            }
        }
        this.#discountPercent = value;
    }

    getDurationDays()
    {
        return this.#durationDays;
    }

    setDurationDays(value)
    {
        if (value !== null)
        {
            value = parseInt(value, 10);
            if (isNaN(value))
            {
                value = 0;
            }
            else
            {
                value = Math.max(value, 0);
            }
        }
        this.#durationDays = value;
    }

    getIsPerpetual()
    {
        return this.#isPerpetual;
    }

    setIsPerpetual(value)
    {
        if (value !== null)
        {
            value = Boolean(value);
        }
        this.#isPerpetual = value;
    }

    getEffectiveFrom()
    {
        return this.#effectiveFrom;
    }

    setEffectiveFrom(value)
    {
        if (value !== null && value !== undefined)
        {
            value = value instanceof Date ? value : new Date(value);
            if (isNaN(value.getTime()))
            {
                value = new Date();
            }
        }
        else
        {
            value = new Date();
        }
        this.#effectiveFrom = value;
    }

    getEffectiveUntil()
    {
        return this.#effectiveUntil;
    }

    setEffectiveUntil(value)
    {
        if (value !== null && value !== undefined)
        {
            value = value instanceof Date ? value : new Date(value);
            if (isNaN(value.getTime()))
            {
                value = new Date();
            }
        }
        else
        {
            value = new Date();
        }
        this.#effectiveUntil = value;
    }

    getAdditionalData()
    {
        return this.#additionalData;
    }

    setAdditionalData(value)
    {
        this.#additionalData = value;
    }

    toJson()
    {
        return {
            id: this.getId(),
            deckId: this.getDeckId(),
            region: this.getRegion(),
            priceMinor: this.getPriceMinor(),
            currency: this.getCurrency(),
            discountPercent: this.getDiscountPercent(),
            durationDays: this.getDurationDays(),
            isPerpetual: this.getIsPerpetual(),
            effectiveFrom: this.getEffectiveFrom() !== null ? this.getEffectiveFrom().toISOString() : null,
            effectiveUntil: this.getEffectiveUntil() !== null ? this.getEffectiveUntil().toISOString() : null,
            additionalData: this.getAdditionalData(),
        };
    }

    static fromJson(json)
    {
        const instance = new PaidDeckPricing({
            deckId: json.deckId ?? null,
            region: json.region ?? null,
            priceMinor: json.priceMinor ?? null,
            currency: json.currency ?? null,
            discountPercent: json.discountPercent ?? null,
            durationDays: json.durationDays ?? null,
            isPerpetual: json.isPerpetual ?? null,
            effectiveFrom: json.effectiveFrom != null ? new Date(json.effectiveFrom) : null,
            effectiveUntil: json.effectiveUntil != null ? new Date(json.effectiveUntil) : null,
            additionalData: json.additionalData ?? null
        });
        instance._restoreId_id(json.id);
        return instance;
    }

    _restoreId_id(storedId)
    {
        if (storedId !== undefined && storedId !== null)
        {
            this.#id = storedId;
        }
    }
}

module.exports = PaidDeckPricing;
