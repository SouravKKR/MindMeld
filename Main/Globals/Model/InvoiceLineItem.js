class InvoiceLineItem
{
    #label;
    #amountMinor;
    #currency;

    constructor({label = '', amountMinor = 0, currency = 'INR'} = {})
    {
        this.setLabel(label);
        this.setAmountMinor(amountMinor);
        this.setCurrency(currency);
    }

    getLabel()
    {
        return this.#label;
    }

    setLabel(value)
    {
        if (value !== null)
        {
            value = String(value);
            if (value.length > 256)
            {
                value = value.slice(0, 256);
            }
        }
        this.#label = value;
    }

    getAmountMinor()
    {
        return this.#amountMinor;
    }

    setAmountMinor(value)
    {
        if (value !== null)
        {
            value = parseInt(value, 10);
            if (isNaN(value))
            {
                value = 0;
            }
        }
        this.#amountMinor = value;
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

    toJson()
    {
        return {
            label: this.getLabel(),
            amountMinor: this.getAmountMinor(),
            currency: this.getCurrency(),
        };
    }

    static fromJson(json)
    {
        const instance = new InvoiceLineItem({
            label: json.label ?? null,
            amountMinor: json.amountMinor ?? null,
            currency: json.currency ?? null
        });
        return instance;
    }
}

export default InvoiceLineItem;
