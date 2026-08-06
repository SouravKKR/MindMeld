const crypto = require('crypto');

class OrganizationMember
{
    #id;
    #organizationId;
    #email;
    #userId;
    #addedBy;
    #delegatePowers;
    #tags;
    #attributes;
    #attributesNormalised;
    #attributesComparable;
    #addedAt;

    constructor({organizationId = null, email = null, userId = '', addedBy = '', delegatePowers = 0, tags = [], attributes = {}, attributesNormalised = {}, attributesComparable = {}, addedAt = new Date()} = {})
    {
        this.#id = crypto.randomUUID();
        this.setOrganizationId(organizationId);
        this.setEmail(email);
        this.setUserId(userId);
        this.setAddedBy(addedBy);
        this.setDelegatePowers(delegatePowers);
        this.setTags(tags);
        this.setAttributes(attributes);
        this.setAttributesNormalised(attributesNormalised);
        this.setAttributesComparable(attributesComparable);
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

    getDelegatePowers()
    {
        return this.#delegatePowers;
    }

    setDelegatePowers(value)
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
        this.#delegatePowers = value;
    }

    getTags()
    {
        return this.#tags;
    }

    setTags(value)
    {
        if (value !== null)
        {
            if (!Array.isArray(value))
            {
                value = null;
            }
        }
        this.#tags = value;
    }

    getAttributes()
    {
        return this.#attributes;
    }

    setAttributes(value)
    {
        this.#attributes = value;
    }

    getAttributesNormalised()
    {
        return this.#attributesNormalised;
    }

    setAttributesNormalised(value)
    {
        this.#attributesNormalised = value;
    }

    getAttributesComparable()
    {
        return this.#attributesComparable;
    }

    setAttributesComparable(value)
    {
        this.#attributesComparable = value;
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
            delegatePowers: this.getDelegatePowers(),
            tags: this.getTags(),
            attributes: this.getAttributes(),
            attributesNormalised: this.getAttributesNormalised(),
            attributesComparable: this.getAttributesComparable(),
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
            delegatePowers: json.delegatePowers ?? null,
            tags: json.tags ?? null,
            attributes: json.attributes ?? null,
            attributesNormalised: json.attributesNormalised ?? null,
            attributesComparable: json.attributesComparable ?? null,
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

module.exports = OrganizationMember;
