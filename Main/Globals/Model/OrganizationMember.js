class OrganizationMember
{
    #id;
    #organizationId;
    #email;
    #userId;
    #addedBy;
    #addedAt;

    constructor({organizationId = null, email = null, userId = '', addedBy = '', addedAt = new Date()} = {})
    {
        this.#id = crypto.randomUUID();
        this.setOrganizationId(organizationId);
        this.setEmail(email);
        this.setUserId(userId);
        this.setAddedBy(addedBy);
        this.setAddedAt(addedAt);
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

    getAddedBy()
    {
        return this.#addedBy;
    }

    setAddedBy(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#addedBy = value;
    }

    getAddedAt()
    {
        return this.#addedAt;
    }

    setAddedAt(value)
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
        this.#addedAt = value;
    }

    toJson()
    {
        return {
            id: this.getId(),
            organizationId: this.getOrganizationId(),
            email: this.getEmail(),
            userId: this.getUserId(),
            addedBy: this.getAddedBy(),
            addedAt: this.getAddedAt() !== null ? this.getAddedAt().toISOString() : null,
        };
    }

    static fromJson(json)
    {
        const instance = new OrganizationMember({
            organizationId: json.organizationId ?? null,
            email: json.email ?? null,
            userId: json.userId ?? null,
            addedBy: json.addedBy ?? null,
            addedAt: json.addedAt != null ? new Date(json.addedAt) : null
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

export default OrganizationMember;
