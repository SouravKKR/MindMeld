const crypto = require('crypto');

const { deckLicenseStatuses } = require('../Enumerations/DeckLicenseStatuses');

class DeckLicense
{
    #id;
    #userId;
    #deckId;
    #status;
    #keyVersion;
    #wrappedKeyBlob;
    #issuedAt;
    #rotatedAt;
    #additionalData;

    constructor({userId = null, deckId = null, status = 1, keyVersion = 1, wrappedKeyBlob = '', issuedAt = new Date(), rotatedAt = new Date(), additionalData = {}} = {})
    {
        this.#id = crypto.randomUUID();
        this.setUserId(userId);
        this.setDeckId(deckId);
        this.setStatus(status);
        this.setKeyVersion(keyVersion);
        this.setWrappedKeyBlob(wrappedKeyBlob);
        this.setIssuedAt(issuedAt);
        this.setRotatedAt(rotatedAt);
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

    getStatus()
    {
        return this.#status;
    }

    setStatus(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(deckLicenseStatuses);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#status = value;
    }

    getKeyVersion()
    {
        return this.#keyVersion;
    }

    setKeyVersion(value)
    {
        if (value !== null)
        {
            value = parseInt(value, 10);
            if (isNaN(value))
            {
                value = 1;
            }
            else
            {
                value = Math.max(value, 1);
            }
        }
        this.#keyVersion = value;
    }

    getWrappedKeyBlob()
    {
        return this.#wrappedKeyBlob;
    }

    setWrappedKeyBlob(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#wrappedKeyBlob = value;
    }

    getIssuedAt()
    {
        return this.#issuedAt;
    }

    setIssuedAt(value)
    {
        if (value !== null)
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
        this.#issuedAt = value;
    }

    getRotatedAt()
    {
        return this.#rotatedAt;
    }

    setRotatedAt(value)
    {
        if (value !== null)
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
        this.#rotatedAt = value;
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
            status: this.getStatus() !== null ? Number(this.getStatus()) : null,
            keyVersion: this.getKeyVersion(),
            wrappedKeyBlob: this.getWrappedKeyBlob(),
            issuedAt: this.getIssuedAt() !== null ? this.getIssuedAt().toISOString() : null,
            rotatedAt: this.getRotatedAt() !== null ? this.getRotatedAt().toISOString() : null,
            additionalData: this.getAdditionalData(),
        };
    }

    static fromJson(json)
    {
        const instance = new DeckLicense({
            userId: json.userId ?? null,
            deckId: json.deckId ?? null,
            status: json.status ?? null,
            keyVersion: json.keyVersion ?? null,
            wrappedKeyBlob: json.wrappedKeyBlob ?? null,
            issuedAt: json.issuedAt != null ? new Date(json.issuedAt) : null,
            rotatedAt: json.rotatedAt != null ? new Date(json.rotatedAt) : null,
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

module.exports = DeckLicense;
