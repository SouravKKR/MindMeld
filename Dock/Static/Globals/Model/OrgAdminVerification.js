class OrgAdminVerification
{
    #id;
    #email;
    #codeHash;
    #attempts;
    #verificationToken;
    #createdAt;
    #expirationDate;

    constructor({email = null, codeHash = '', attempts = 0, verificationToken = '', createdAt = new Date(), expirationDate = new Date()} = {})
    {
        this.#id = crypto.randomUUID();
        this.setEmail(email);
        this.setCodeHash(codeHash);
        this.setAttempts(attempts);
        this.setVerificationToken(verificationToken);
        this.setCreatedAt(createdAt);
        this.setExpirationDate(expirationDate);
    }

    getId()
    {
        return this.#id;
    }

    getEmail()
    {
        return this.#email;
    }

    setEmail(value)
    {
        if (value !== null)
        {
            value = String(value);
            if (value.length > 320)
            {
                value = value.slice(0, 320);
            }
            if (value.length < 3)
            {
                value = null;
            }
        }
        this.#email = value;
    }

    getCodeHash()
    {
        return this.#codeHash;
    }

    setCodeHash(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#codeHash = value;
    }

    getAttempts()
    {
        return this.#attempts;
    }

    setAttempts(value)
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
        this.#attempts = value;
    }

    getVerificationToken()
    {
        return this.#verificationToken;
    }

    setVerificationToken(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#verificationToken = value;
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

    getExpirationDate()
    {
        return this.#expirationDate;
    }

    setExpirationDate(value)
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
        this.#expirationDate = value;
    }

    toJson()
    {
        return {
            id: this.getId(),
            email: this.getEmail(),
            codeHash: this.getCodeHash(),
            attempts: this.getAttempts(),
            verificationToken: this.getVerificationToken(),
            createdAt: this.getCreatedAt() !== null ? this.getCreatedAt().toISOString() : null,
            expirationDate: this.getExpirationDate() !== null ? this.getExpirationDate().toISOString() : null,
        };
    }

    static fromJson(json)
    {
        const instance = new OrgAdminVerification({
            email: json.email ?? null,
            codeHash: json.codeHash ?? null,
            attempts: json.attempts ?? null,
            verificationToken: json.verificationToken ?? null,
            createdAt: json.createdAt != null ? new Date(json.createdAt) : null,
            expirationDate: json.expirationDate != null ? new Date(json.expirationDate) : null
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

export default OrgAdminVerification;
