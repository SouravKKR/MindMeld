const crypto = require('crypto');

const { devicePlatforms } = require('../Enumerations/DevicePlatforms');

class Device
{
    #id;
    #userId;
    #deviceName;
    #platform;
    #userAgent;
    #createdAt;
    #lastSeenDate;
    #lastSyncDate;
    #publicKeyFingerprint;
    #fingerprintHash;
    #additionalData;

    constructor({userId = null, deviceName = '', platform = 0, userAgent = '', createdAt = new Date(), lastSeenDate = new Date(), lastSyncDate = new Date(), publicKeyFingerprint = '', fingerprintHash = '', additionalData = {}} = {})
    {
        this.#id = crypto.randomUUID();
        this.setUserId(userId);
        this.setDeviceName(deviceName);
        this.setPlatform(platform);
        this.setUserAgent(userAgent);
        this.setCreatedAt(createdAt);
        this.setLastSeenDate(lastSeenDate);
        this.setLastSyncDate(lastSyncDate);
        this.setPublicKeyFingerprint(publicKeyFingerprint);
        this.setFingerprintHash(fingerprintHash);
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

    getDeviceName()
    {
        return this.#deviceName;
    }

    setDeviceName(value)
    {
        if (value !== null)
        {
            value = String(value);
            if (value.length > 256)
            {
                value = value.slice(0, 256);
            }
        }
        this.#deviceName = value;
    }

    getPlatform()
    {
        return this.#platform;
    }

    setPlatform(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(devicePlatforms);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#platform = value;
    }

    getUserAgent()
    {
        return this.#userAgent;
    }

    setUserAgent(value)
    {
        if (value !== null)
        {
            value = String(value);
            if (value.length > 1024)
            {
                value = value.slice(0, 1024);
            }
        }
        this.#userAgent = value;
    }

    getCreatedAt()
    {
        return this.#createdAt;
    }

    setCreatedAt(value)
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
        this.#createdAt = value;
    }

    getLastSeenDate()
    {
        return this.#lastSeenDate;
    }

    setLastSeenDate(value)
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
        this.#lastSeenDate = value;
    }

    getLastSyncDate()
    {
        return this.#lastSyncDate;
    }

    setLastSyncDate(value)
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
        this.#lastSyncDate = value;
    }

    getPublicKeyFingerprint()
    {
        return this.#publicKeyFingerprint;
    }

    setPublicKeyFingerprint(value)
    {
        if (value !== null)
        {
            value = String(value);
            if (value.length > 256)
            {
                value = value.slice(0, 256);
            }
        }
        this.#publicKeyFingerprint = value;
    }

    getFingerprintHash()
    {
        return this.#fingerprintHash;
    }

    setFingerprintHash(value)
    {
        if (value !== null)
        {
            value = String(value);
            if (value.length > 128)
            {
                value = value.slice(0, 128);
            }
        }
        this.#fingerprintHash = value;
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
            deviceName: this.getDeviceName(),
            platform: this.getPlatform() !== null ? Number(this.getPlatform()) : null,
            userAgent: this.getUserAgent(),
            createdAt: this.getCreatedAt() !== null ? this.getCreatedAt().toISOString() : null,
            lastSeenDate: this.getLastSeenDate() !== null ? this.getLastSeenDate().toISOString() : null,
            lastSyncDate: this.getLastSyncDate() !== null ? this.getLastSyncDate().toISOString() : null,
            publicKeyFingerprint: this.getPublicKeyFingerprint(),
            fingerprintHash: this.getFingerprintHash(),
            additionalData: this.getAdditionalData(),
        };
    }

    static fromJson(json)
    {
        const instance = new Device({
            userId: json.userId ?? null,
            deviceName: json.deviceName ?? null,
            platform: json.platform ?? null,
            userAgent: json.userAgent ?? null,
            createdAt: json.createdAt != null ? new Date(json.createdAt) : null,
            lastSeenDate: json.lastSeenDate != null ? new Date(json.lastSeenDate) : null,
            lastSyncDate: json.lastSyncDate != null ? new Date(json.lastSyncDate) : null,
            publicKeyFingerprint: json.publicKeyFingerprint ?? null,
            fingerprintHash: json.fingerprintHash ?? null,
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

module.exports = Device;
