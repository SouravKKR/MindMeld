const crypto = require('crypto');

const { logLevel } = require('../Enumerations/LogLevel');
const { logCategory } = require('../Enumerations/LogCategory');
const { logServiceOrigin } = require('../Enumerations/LogServiceOrigin');

class LogEntry
{
    #id;
    #level;
    #category;
    #title;
    #message;
    #service;
    #accountId;
    #errorCode;
    #errorReason;
    #additionalData;
    #timestamp;
    #timestampIsoString;
    #sequence;
    #environment;

    constructor({level = 1, category = 0, title = '', message = '', service = 0, accountId = '', errorCode = '', errorReason = '', additionalData = {}, timestamp = new Date(), timestampIsoString = '', sequence = 0, environment = ''} = {})
    {
        this.#id = crypto.randomUUID();
        this.setLevel(level);
        this.setCategory(category);
        this.setTitle(title);
        this.setMessage(message);
        this.setService(service);
        this.setAccountId(accountId);
        this.setErrorCode(errorCode);
        this.setErrorReason(errorReason);
        this.setAdditionalData(additionalData);
        this.setTimestamp(timestamp);
        this.setTimestampIsoString(timestampIsoString);
        this.setSequence(sequence);
        this.setEnvironment(environment);
    }

    getId()
    {
        return this.#id;
    }

    getLevel()
    {
        return this.#level;
    }

    setLevel(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(logLevel);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#level = value;
    }

    getCategory()
    {
        return this.#category;
    }

    setCategory(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(logCategory);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#category = value;
    }

    getTitle()
    {
        return this.#title;
    }

    setTitle(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#title = value;
    }

    getMessage()
    {
        return this.#message;
    }

    setMessage(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#message = value;
    }

    getService()
    {
        return this.#service;
    }

    setService(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(logServiceOrigin);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#service = value;
    }

    getAccountId()
    {
        return this.#accountId;
    }

    setAccountId(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#accountId = value;
    }

    getErrorCode()
    {
        return this.#errorCode;
    }

    setErrorCode(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#errorCode = value;
    }

    getErrorReason()
    {
        return this.#errorReason;
    }

    setErrorReason(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#errorReason = value;
    }

    getAdditionalData()
    {
        return this.#additionalData;
    }

    setAdditionalData(value)
    {
        this.#additionalData = value;
    }

    getTimestamp()
    {
        return this.#timestamp;
    }

    setTimestamp(value)
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
        this.#timestamp = value;
    }

    getTimestampIsoString()
    {
        return this.#timestampIsoString;
    }

    setTimestampIsoString(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#timestampIsoString = value;
    }

    getSequence()
    {
        return this.#sequence;
    }

    setSequence(value)
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
        this.#sequence = value;
    }

    getEnvironment()
    {
        return this.#environment;
    }

    setEnvironment(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#environment = value;
    }

    toJson()
    {
        return {
            id: this.getId(),
            level: this.getLevel() !== null ? Number(this.getLevel()) : null,
            category: this.getCategory() !== null ? Number(this.getCategory()) : null,
            title: this.getTitle(),
            message: this.getMessage(),
            service: this.getService() !== null ? Number(this.getService()) : null,
            accountId: this.getAccountId(),
            errorCode: this.getErrorCode(),
            errorReason: this.getErrorReason(),
            additionalData: this.getAdditionalData(),
            timestamp: this.getTimestamp() !== null ? this.getTimestamp().toISOString() : null,
            timestampIsoString: this.getTimestampIsoString(),
            sequence: this.getSequence(),
            environment: this.getEnvironment(),
        };
    }

    static fromJson(json)
    {
        const instance = new LogEntry({
            level: json.level ?? null,
            category: json.category ?? null,
            title: json.title ?? null,
            message: json.message ?? null,
            service: json.service ?? null,
            accountId: json.accountId ?? null,
            errorCode: json.errorCode ?? null,
            errorReason: json.errorReason ?? null,
            additionalData: json.additionalData ?? null,
            timestamp: json.timestamp != null ? new Date(json.timestamp) : null,
            timestampIsoString: json.timestampIsoString ?? null,
            sequence: json.sequence ?? null,
            environment: json.environment ?? null
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

module.exports = LogEntry;
