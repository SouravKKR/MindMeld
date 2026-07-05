const crypto = require('crypto');

const { paymentProviders } = require('../Enumerations/PaymentProviders');
const { purchaseStatuses } = require('../Enumerations/PurchaseStatuses');

class Purchase
{
    #id;
    #userId;
    #deckId;
    #paymentProvider;
    #providerOrderId;
    #providerPaymentId;
    #amountMinor;
    #currency;
    #region;
    #purchaseDate;
    #refundedAt;
    #status;
    #additionalData;

    constructor({userId = null, deckId = null, paymentProvider = 0, providerOrderId = '', providerPaymentId = '', amountMinor = 0, currency = 'INR', region = 'GLOBAL', purchaseDate = new Date(), refundedAt = new Date(), status = 0, additionalData = {}} = {})
    {
        this.#id = crypto.randomUUID();
        this.setUserId(userId);
        this.setDeckId(deckId);
        this.setPaymentProvider(paymentProvider);
        this.setProviderOrderId(providerOrderId);
        this.setProviderPaymentId(providerPaymentId);
        this.setAmountMinor(amountMinor);
        this.setCurrency(currency);
        this.setRegion(region);
        this.setPurchaseDate(purchaseDate);
        this.setRefundedAt(refundedAt);
        this.setStatus(status);
        this.setAdditionalData(additionalData);
    }

    getId()
    {
        return this.#id;
    }

    getUserId()
    {
        return this.#userId;
    }

    setUserId(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#userId = value;
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

    getPaymentProvider()
    {
        return this.#paymentProvider;
    }

    setPaymentProvider(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(paymentProviders);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#paymentProvider = value;
    }

    getProviderOrderId()
    {
        return this.#providerOrderId;
    }

    setProviderOrderId(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#providerOrderId = value;
    }

    getProviderPaymentId()
    {
        return this.#providerPaymentId;
    }

    setProviderPaymentId(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#providerPaymentId = value;
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
            else
            {
                value = Math.max(value, 0);
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

    getPurchaseDate()
    {
        return this.#purchaseDate;
    }

    setPurchaseDate(value)
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
        this.#purchaseDate = value;
    }

    getRefundedAt()
    {
        return this.#refundedAt;
    }

    setRefundedAt(value)
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
        this.#refundedAt = value;
    }

    getStatus()
    {
        return this.#status;
    }

    setStatus(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(purchaseStatuses);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#status = value;
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
            userId: this.getUserId(),
            deckId: this.getDeckId(),
            paymentProvider: this.getPaymentProvider() !== null ? Number(this.getPaymentProvider()) : null,
            providerOrderId: this.getProviderOrderId(),
            providerPaymentId: this.getProviderPaymentId(),
            amountMinor: this.getAmountMinor(),
            currency: this.getCurrency(),
            region: this.getRegion(),
            purchaseDate: this.getPurchaseDate() !== null ? this.getPurchaseDate().toISOString() : null,
            refundedAt: this.getRefundedAt() !== null ? this.getRefundedAt().toISOString() : null,
            status: this.getStatus() !== null ? Number(this.getStatus()) : null,
            additionalData: this.getAdditionalData(),
        };
    }

    static fromJson(json)
    {
        const instance = new Purchase({
            userId: json.userId ?? null,
            deckId: json.deckId ?? null,
            paymentProvider: json.paymentProvider ?? null,
            providerOrderId: json.providerOrderId ?? null,
            providerPaymentId: json.providerPaymentId ?? null,
            amountMinor: json.amountMinor ?? null,
            currency: json.currency ?? null,
            region: json.region ?? null,
            purchaseDate: json.purchaseDate != null ? new Date(json.purchaseDate) : null,
            refundedAt: json.refundedAt != null ? new Date(json.refundedAt) : null,
            status: json.status ?? null,
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

module.exports = Purchase;
