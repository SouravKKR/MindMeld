// A purchasable credit pack: a fixed credit quantity sold at a percentage
// discount off the per-credit price. The discount applies whenever a buyer's
// requested quantity exactly equals the pack size, so clicking the pack
// button and typing the same number always charge the same amount.

class CreditPackOption
{
    #credits;
    #discountPercent;

    constructor({ credits = 0, discountPercent = 0 } = {})
    {
        this.setCredits(credits);
        this.setDiscountPercent(discountPercent);
    }

    getCredits()
    {
        return this.#credits;
    }

    setCredits(value)
    {
        value = parseInt(value, 10);
        if (isNaN(value) || value < 0)
        {
            value = 0;
        }
        this.#credits = value;
    }

    getDiscountPercent()
    {
        return this.#discountPercent;
    }

    setDiscountPercent(value)
    {
        value = parseFloat(value);
        if (isNaN(value))
        {
            value = 0;
        }
        if (value < 0)
        {
            value = 0;
        }
        if (value > 100)
        {
            value = 100;
        }
        this.#discountPercent = value;
    }

    toJson()
    {
        return {
            credits: this.getCredits(),
            discountPercent: this.getDiscountPercent(),
        };
    }

    static fromJson(json)
    {
        return new CreditPackOption({
            credits: json?.credits ?? 0,
            discountPercent: json?.discountPercent ?? 0,
        });
    }
}

module.exports = CreditPackOption;
