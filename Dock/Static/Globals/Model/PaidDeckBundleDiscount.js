class PaidDeckBundleDiscount
{
    #id;
    #bundleDeckId;
    #includedDeckId;
    #discountPercentWhenIncluded;

    constructor({bundleDeckId = null, includedDeckId = null, discountPercentWhenIncluded = 100} = {})
    {
        this.#id = crypto.randomUUID();
        this.setBundleDeckId(bundleDeckId);
        this.setIncludedDeckId(includedDeckId);
        this.setDiscountPercentWhenIncluded(discountPercentWhenIncluded);
    }

    getId()
    {
        return this.#id;
    }

    getBundleDeckId()
    {
        return this.#bundleDeckId;
    }

    setBundleDeckId(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#bundleDeckId = value;
    }

    getIncludedDeckId()
    {
        return this.#includedDeckId;
    }

    setIncludedDeckId(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#includedDeckId = value;
    }

    getDiscountPercentWhenIncluded()
    {
        return this.#discountPercentWhenIncluded;
    }

    setDiscountPercentWhenIncluded(value)
    {
        if (value !== null)
        {
            value = parseFloat(value);
            if (isNaN(value))
            {
                value = 100;
            }
            else
            {
                value = Math.min(Math.max(value, 0), 100);
            }
        }
        this.#discountPercentWhenIncluded = value;
    }

    toJson()
    {
        return {
            id: this.getId(),
            bundleDeckId: this.getBundleDeckId(),
            includedDeckId: this.getIncludedDeckId(),
            discountPercentWhenIncluded: this.getDiscountPercentWhenIncluded(),
        };
    }

    static fromJson(json)
    {
        const instance = new PaidDeckBundleDiscount({
            bundleDeckId: json.bundleDeckId ?? null,
            includedDeckId: json.includedDeckId ?? null,
            discountPercentWhenIncluded: json.discountPercentWhenIncluded ?? null
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

export default PaidDeckBundleDiscount;
