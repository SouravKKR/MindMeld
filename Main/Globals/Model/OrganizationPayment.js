const crypto = require('crypto');

const { organizationPaymentKinds } = require('../Enumerations/OrganizationPaymentKinds');
const { organizationPaymentStatuses } = require('../Enumerations/OrganizationPaymentStatuses');
const { paymentProviders } = require('../Enumerations/PaymentProviders');

class OrganizationPayment
{
    #id;
    #organizationId;
    #kind;
    #status;
    #paymentProvider;
    #providerOrderId;
    #providerPaymentId;
    #amountMinor;
    #currency;
    #additionalMembers;
    #createdAt;
    #capturedAt;
    #additionalData;

    constructor({organizationId = null, kind = 0, status = 0, paymentProvider = 0, providerOrderId = '', providerPaymentId = '', amountMinor = 0, currency = 'INR', additionalMembers = 0, createdAt = new Date(), capturedAt = new Date(), additionalData = {}} = {})
    {
        this.#id = crypto.randomUUID();
        this.setOrganizationId(organizationId);
        this.setKind(kind);
        this.setStatus(status);
        this.setPaymentProvider(paymentProvider);
        this.setProviderOrderId(providerOrderId);
        this.setProviderPaymentId(providerPaymentId);
        this.setAmountMinor(amountMinor);
        this.setCurrency(currency);
        this.setAdditionalMembers(additionalMembers);
        this.setCreatedAt(createdAt);
        this.setCapturedAt(capturedAt);
        this.setAdditionalData(additionalData);
    }

    getId()
    {
        return this.#id;
    }

    getOrganizationId()
    {
        return this.#organizationId;
    }

    setOrganizationId(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#organizationId = value;
    }

    getKind()
    {
        return this.#kind;
    }

    setKind(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(organizationPaymentKinds);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#kind = value;
    }

    getStatus()
    {
        return this.#status;
    }

    setStatus(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(organizationPaymentStatuses);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#status = value;
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

    getAdditionalMembers()
    {
        return this.#additionalMembers;
    }

    setAdditionalMembers(value)
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
        this.#additionalMembers = value;
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
                value = new Date();
            }
        }
        else
        {
            value = new Date();
        }
        this.#createdAt = value;
    }

    getCapturedAt()
    {
        return this.#capturedAt;
    }

    setCapturedAt(value)
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
        this.#capturedAt = value;
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
            organizationId: this.getOrganizationId(),
            kind: this.getKind() !== null ? Number(this.getKind()) : null,
            status: this.getStatus() !== null ? Number(this.getStatus()) : null,
            paymentProvider: this.getPaymentProvider() !== null ? Number(this.getPaymentProvider()) : null,
            providerOrderId: this.getProviderOrderId(),
            providerPaymentId: this.getProviderPaymentId(),
            amountMinor: this.getAmountMinor(),
            currency: this.getCurrency(),
            additionalMembers: this.getAdditionalMembers(),
            createdAt: this.getCreatedAt() !== null ? this.getCreatedAt().toISOString() : null,
            capturedAt: this.getCapturedAt() !== null ? this.getCapturedAt().toISOString() : null,
            additionalData: this.getAdditionalData(),
        };
    }

    static fromJson(json)
    {
        const instance = new OrganizationPayment({
            organizationId: json.organizationId ?? null,
            kind: json.kind ?? null,
            status: json.status ?? null,
            paymentProvider: json.paymentProvider ?? null,
            providerOrderId: json.providerOrderId ?? null,
            providerPaymentId: json.providerPaymentId ?? null,
            amountMinor: json.amountMinor ?? null,
            currency: json.currency ?? null,
            additionalMembers: json.additionalMembers ?? null,
            createdAt: json.createdAt != null ? new Date(json.createdAt) : null,
            capturedAt: json.capturedAt != null ? new Date(json.capturedAt) : null,
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

module.exports = OrganizationPayment;
