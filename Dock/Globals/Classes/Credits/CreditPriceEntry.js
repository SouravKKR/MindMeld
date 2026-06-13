// One explicit per-currency unit price for purchased credits: the cost of a
// single credit in `currency`, expressed in MAJOR units (e.g. 10 = INR 10.00).
// Entries live in CreditConfiguration.creditPricing as an ORDERED array whose
// first element is the base currency — every supported currency without an
// explicit entry is converted from that base at quote time.

class CreditPriceEntry
{
    #currency;
    #pricePerCredit;

    constructor({ currency = '', pricePerCredit = 0 } = {})
    {
        this.setCurrency(currency);
        this.setPricePerCredit(pricePerCredit);
    }

    getCurrency()
    {
        return this.#currency;
    }

    setCurrency(value)
    {
        this.#currency = typeof value === "string" ? value.trim().toUpperCase() : "";
    }

    getPricePerCredit()
    {
        return this.#pricePerCredit;
    }

    setPricePerCredit(value)
    {
        value = parseFloat(value);
        if (isNaN(value) || value < 0)
        {
            value = 0;
        }
        this.#pricePerCredit = value;
    }

    toJson()
    {
        return {
            currency: this.getCurrency(),
            pricePerCredit: this.getPricePerCredit(),
        };
    }

    static fromJson(json)
    {
        return new CreditPriceEntry({
            currency: json?.currency ?? '',
            pricePerCredit: json?.pricePerCredit ?? 0,
        });
    }
}

module.exports = CreditPriceEntry;
