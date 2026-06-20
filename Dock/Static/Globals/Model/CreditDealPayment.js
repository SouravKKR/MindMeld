import { creditDealTargetTypes } from '../Enumerations/CreditDealTargetTypes.js';
import { creditDealPaymentModes } from '../Enumerations/CreditDealPaymentModes.js';
import { creditDealPaymentStatuses } from '../Enumerations/CreditDealPaymentStatuses.js';
import { paymentProviders } from '../Enumerations/PaymentProviders.js';

class CreditDealPayment
{
    #id;
    #targetType;
    #targetId;
    #label;
    #mode;
    #status;
    #amountMinor;
    #currency;
    #paymentProvider;
    #providerOrderId;
    #providerPaymentId;
    #invoiceFileName;
    #invoiceMimeType;
    #invoiceBucketPath;
    #invoiceSizeBytes;
    #invoiceUploadedAt;
    #hasInvoice;
    #createdByUserId;
    #createdAt;
    #additionalData;

    constructor({targetType = 0, targetId = '', label = '', mode = 0, status = 0, amountMinor = 0, currency = 'INR', paymentProvider = 0, providerOrderId = '', providerPaymentId = '', invoiceFileName = '', invoiceMimeType = '', invoiceBucketPath = '', invoiceSizeBytes = 0, invoiceUploadedAt = new Date(), hasInvoice = false, createdByUserId = '', createdAt = new Date(), additionalData = {}} = {})
    {
        this.#id = crypto.randomUUID();
        this.setTargetType(targetType);
        this.setTargetId(targetId);
        this.setLabel(label);
        this.setMode(mode);
        this.setStatus(status);
        this.setAmountMinor(amountMinor);
        this.setCurrency(currency);
        this.setPaymentProvider(paymentProvider);
        this.setProviderOrderId(providerOrderId);
        this.setProviderPaymentId(providerPaymentId);
        this.setInvoiceFileName(invoiceFileName);
        this.setInvoiceMimeType(invoiceMimeType);
        this.setInvoiceBucketPath(invoiceBucketPath);
        this.setInvoiceSizeBytes(invoiceSizeBytes);
        this.setInvoiceUploadedAt(invoiceUploadedAt);
        this.setHasInvoice(hasInvoice);
        this.setCreatedByUserId(createdByUserId);
        this.setCreatedAt(createdAt);
        this.setAdditionalData(additionalData);
    }

    getId()
    {
        return this.#id;
    }

    getTargetType()
    {
        return this.#targetType;
    }

    setTargetType(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(creditDealTargetTypes);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#targetType = value;
    }

    getTargetId()
    {
        return this.#targetId;
    }

    setTargetId(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#targetId = value;
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

    getMode()
    {
        return this.#mode;
    }

    setMode(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(creditDealPaymentModes);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#mode = value;
    }

    getStatus()
    {
        return this.#status;
    }

    setStatus(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(creditDealPaymentStatuses);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#status = value;
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

    getInvoiceFileName()
    {
        return this.#invoiceFileName;
    }

    setInvoiceFileName(value)
    {
        if (value !== null)
        {
            value = String(value);
            if (value.length > 512)
            {
                value = value.slice(0, 512);
            }
        }
        this.#invoiceFileName = value;
    }

    getInvoiceMimeType()
    {
        return this.#invoiceMimeType;
    }

    setInvoiceMimeType(value)
    {
        if (value !== null)
        {
            value = String(value);
            if (value.length > 128)
            {
                value = value.slice(0, 128);
            }
        }
        this.#invoiceMimeType = value;
    }

    getInvoiceBucketPath()
    {
        return this.#invoiceBucketPath;
    }

    setInvoiceBucketPath(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#invoiceBucketPath = value;
    }

    getInvoiceSizeBytes()
    {
        return this.#invoiceSizeBytes;
    }

    setInvoiceSizeBytes(value)
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
        this.#invoiceSizeBytes = value;
    }

    getInvoiceUploadedAt()
    {
        return this.#invoiceUploadedAt;
    }

    setInvoiceUploadedAt(value)
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
        this.#invoiceUploadedAt = value;
    }

    getHasInvoice()
    {
        return this.#hasInvoice;
    }

    setHasInvoice(value)
    {
        if (value !== null)
        {
            value = Boolean(value);
        }
        this.#hasInvoice = value;
    }

    getCreatedByUserId()
    {
        return this.#createdByUserId;
    }

    setCreatedByUserId(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#createdByUserId = value;
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
            targetType: this.getTargetType() !== null ? Number(this.getTargetType()) : null,
            targetId: this.getTargetId(),
            label: this.getLabel(),
            mode: this.getMode() !== null ? Number(this.getMode()) : null,
            status: this.getStatus() !== null ? Number(this.getStatus()) : null,
            amountMinor: this.getAmountMinor(),
            currency: this.getCurrency(),
            paymentProvider: this.getPaymentProvider() !== null ? Number(this.getPaymentProvider()) : null,
            providerOrderId: this.getProviderOrderId(),
            providerPaymentId: this.getProviderPaymentId(),
            invoiceFileName: this.getInvoiceFileName(),
            invoiceMimeType: this.getInvoiceMimeType(),
            invoiceBucketPath: this.getInvoiceBucketPath(),
            invoiceSizeBytes: this.getInvoiceSizeBytes(),
            invoiceUploadedAt: this.getInvoiceUploadedAt() !== null ? this.getInvoiceUploadedAt().toISOString() : null,
            hasInvoice: this.getHasInvoice(),
            createdByUserId: this.getCreatedByUserId(),
            createdAt: this.getCreatedAt() !== null ? this.getCreatedAt().toISOString() : null,
            additionalData: this.getAdditionalData(),
        };
    }

    static fromJson(json)
    {
        const instance = new CreditDealPayment({
            targetType: json.targetType ?? null,
            targetId: json.targetId ?? null,
            label: json.label ?? null,
            mode: json.mode ?? null,
            status: json.status ?? null,
            amountMinor: json.amountMinor ?? null,
            currency: json.currency ?? null,
            paymentProvider: json.paymentProvider ?? null,
            providerOrderId: json.providerOrderId ?? null,
            providerPaymentId: json.providerPaymentId ?? null,
            invoiceFileName: json.invoiceFileName ?? null,
            invoiceMimeType: json.invoiceMimeType ?? null,
            invoiceBucketPath: json.invoiceBucketPath ?? null,
            invoiceSizeBytes: json.invoiceSizeBytes ?? null,
            invoiceUploadedAt: json.invoiceUploadedAt != null ? new Date(json.invoiceUploadedAt) : null,
            hasInvoice: json.hasInvoice ?? null,
            createdByUserId: json.createdByUserId ?? null,
            createdAt: json.createdAt != null ? new Date(json.createdAt) : null,
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

export default CreditDealPayment;
