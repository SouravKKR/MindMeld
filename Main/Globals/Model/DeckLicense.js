const crypto = require('crypto');

const { deckLicenseStatuses } = require('../Enumerations/DeckLicenseStatuses');

class DeckLicense
{
    // Epoch-zero sentinel meaning "never expires". Date members declared
    // with nullFallback "forever" coerce null / undefined / invalid values
    // to this instead of "now", so a missing expiry can never silently
    // become an already-expired timestamp.
    static FOREVER = new Date(0);

    #id;
    #userId;
    #deckId;
    #scopeKey;
    #status;
    #keyVersion;
    #wrappedKeyBlob;
    #issuedAt;
    #rotatedAt;
    #expiresAt;
    #grantSource;
    #downloadedContentVersion;
    #passwordHash;
    #passwordSalt;
    #passwordWrappedContentKeyBase64;
    #passwordWrappedIvBase64;
    #serverWrappedContentKeyBase64;
    #serverWrappedIvBase64;
    #contentKeyVersion;
    #additionalData;

    constructor({userId = null, deckId = null, scopeKey = '', status = 1, keyVersion = 1, wrappedKeyBlob = '', issuedAt = new Date(), rotatedAt = new Date(), expiresAt = new Date(0), grantSource = 'PURCHASE', downloadedContentVersion = 0, passwordHash = '', passwordSalt = '', passwordWrappedContentKeyBase64 = '', passwordWrappedIvBase64 = '', serverWrappedContentKeyBase64 = '', serverWrappedIvBase64 = '', contentKeyVersion = 0, additionalData = {}} = {})
    {
        this.#id = crypto.randomUUID();
        this.setUserId(userId);
        this.setDeckId(deckId);
        this.setScopeKey(scopeKey);
        this.setStatus(status);
        this.setKeyVersion(keyVersion);
        this.setWrappedKeyBlob(wrappedKeyBlob);
        this.setIssuedAt(issuedAt);
        this.setRotatedAt(rotatedAt);
        this.setExpiresAt(expiresAt);
        this.setGrantSource(grantSource);
        this.setDownloadedContentVersion(downloadedContentVersion);
        this.setPasswordHash(passwordHash);
        this.setPasswordSalt(passwordSalt);
        this.setPasswordWrappedContentKeyBase64(passwordWrappedContentKeyBase64);
        this.setPasswordWrappedIvBase64(passwordWrappedIvBase64);
        this.setServerWrappedContentKeyBase64(serverWrappedContentKeyBase64);
        this.setServerWrappedIvBase64(serverWrappedIvBase64);
        this.setContentKeyVersion(contentKeyVersion);
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

    getScopeKey()
    {
        return this.#scopeKey;
    }

    setScopeKey(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#scopeKey = value;
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
        this.#issuedAt = value;
    }

    getRotatedAt()
    {
        return this.#rotatedAt;
    }

    setRotatedAt(value)
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
        this.#rotatedAt = value;
    }

    getExpiresAt()
    {
        return this.#expiresAt;
    }

    setExpiresAt(value)
    {
        if (value !== null && value !== undefined)
        {
            value = value instanceof Date ? value : new Date(value);
            if (isNaN(value.getTime()))
            {
                value = DeckLicense.FOREVER;
            }
        }
        else
        {
            value = DeckLicense.FOREVER;
        }
        this.#expiresAt = value;
    }

    getGrantSource()
    {
        return this.#grantSource;
    }

    setGrantSource(value)
    {
        if (value !== null)
        {
            value = String(value);
            if (value.length > 64)
            {
                value = value.slice(0, 64);
            }
        }
        this.#grantSource = value;
    }

    getDownloadedContentVersion()
    {
        return this.#downloadedContentVersion;
    }

    setDownloadedContentVersion(value)
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
        this.#downloadedContentVersion = value;
    }

    getPasswordHash()
    {
        return this.#passwordHash;
    }

    setPasswordHash(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#passwordHash = value;
    }

    getPasswordSalt()
    {
        return this.#passwordSalt;
    }

    setPasswordSalt(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#passwordSalt = value;
    }

    getPasswordWrappedContentKeyBase64()
    {
        return this.#passwordWrappedContentKeyBase64;
    }

    setPasswordWrappedContentKeyBase64(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#passwordWrappedContentKeyBase64 = value;
    }

    getPasswordWrappedIvBase64()
    {
        return this.#passwordWrappedIvBase64;
    }

    setPasswordWrappedIvBase64(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#passwordWrappedIvBase64 = value;
    }

    getServerWrappedContentKeyBase64()
    {
        return this.#serverWrappedContentKeyBase64;
    }

    setServerWrappedContentKeyBase64(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#serverWrappedContentKeyBase64 = value;
    }

    getServerWrappedIvBase64()
    {
        return this.#serverWrappedIvBase64;
    }

    setServerWrappedIvBase64(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#serverWrappedIvBase64 = value;
    }

    getContentKeyVersion()
    {
        return this.#contentKeyVersion;
    }

    setContentKeyVersion(value)
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
        this.#contentKeyVersion = value;
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
            scopeKey: this.getScopeKey(),
            status: this.getStatus() !== null ? Number(this.getStatus()) : null,
            keyVersion: this.getKeyVersion(),
            wrappedKeyBlob: this.getWrappedKeyBlob(),
            issuedAt: this.getIssuedAt() !== null ? this.getIssuedAt().toISOString() : null,
            rotatedAt: this.getRotatedAt() !== null ? this.getRotatedAt().toISOString() : null,
            expiresAt: this.getExpiresAt() !== null ? this.getExpiresAt().toISOString() : null,
            grantSource: this.getGrantSource(),
            downloadedContentVersion: this.getDownloadedContentVersion(),
            passwordHash: this.getPasswordHash(),
            passwordSalt: this.getPasswordSalt(),
            passwordWrappedContentKeyBase64: this.getPasswordWrappedContentKeyBase64(),
            passwordWrappedIvBase64: this.getPasswordWrappedIvBase64(),
            serverWrappedContentKeyBase64: this.getServerWrappedContentKeyBase64(),
            serverWrappedIvBase64: this.getServerWrappedIvBase64(),
            contentKeyVersion: this.getContentKeyVersion(),
            additionalData: this.getAdditionalData(),
        };
    }

    static fromJson(json)
    {
        const instance = new DeckLicense({
            userId: json.userId ?? null,
            deckId: json.deckId ?? null,
            scopeKey: json.scopeKey ?? null,
            status: json.status ?? null,
            keyVersion: json.keyVersion ?? null,
            wrappedKeyBlob: json.wrappedKeyBlob ?? null,
            issuedAt: json.issuedAt != null ? new Date(json.issuedAt) : null,
            rotatedAt: json.rotatedAt != null ? new Date(json.rotatedAt) : null,
            expiresAt: json.expiresAt != null ? new Date(json.expiresAt) : null,
            grantSource: json.grantSource ?? null,
            downloadedContentVersion: json.downloadedContentVersion ?? null,
            passwordHash: json.passwordHash ?? null,
            passwordSalt: json.passwordSalt ?? null,
            passwordWrappedContentKeyBase64: json.passwordWrappedContentKeyBase64 ?? null,
            passwordWrappedIvBase64: json.passwordWrappedIvBase64 ?? null,
            serverWrappedContentKeyBase64: json.serverWrappedContentKeyBase64 ?? null,
            serverWrappedIvBase64: json.serverWrappedIvBase64 ?? null,
            contentKeyVersion: json.contentKeyVersion ?? null,
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
