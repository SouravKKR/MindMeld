class UserSetting
{
    #key;
    #value;
    #defaultValue;
    #flags;
    #additionalData;

    constructor({key = '', value = null, defaultValue = null, flags = 0, additionalData = {}} = {})
    {
        this.setKey(key);
        this.setValue(value);
        this.setDefaultValue(defaultValue);
        this.setFlags(flags);
        this.setAdditionalData(additionalData);
    }

    getKey()
    {
        return this.#key;
    }

    setKey(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#key = value;
    }

    getValue()
    {
        return this.#value;
    }

    setValue(value)
    {
        this.#value = value;
    }

    getDefaultValue()
    {
        return this.#defaultValue;
    }

    setDefaultValue(value)
    {
        this.#defaultValue = value;
    }

    getFlags()
    {
        return this.#flags;
    }

    setFlags(value)
    {
        if (value !== null)
        {
            value = parseInt(value, 10);
            if (isNaN(value))
            {
                value = 0;
            }
        }
        this.#flags = value;
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
            key: this.getKey(),
            value: this.getValue(),
            defaultValue: this.getDefaultValue(),
            flags: this.getFlags(),
            additionalData: this.getAdditionalData(),
        };
    }

    static fromJson(json)
    {
        const instance = new UserSetting({
            key: json.key ?? null,
            value: json.value ?? null,
            defaultValue: json.defaultValue ?? null,
            flags: json.flags ?? null,
            additionalData: json.additionalData ?? null
        });
        return instance;
    }
}

export default UserSetting;
