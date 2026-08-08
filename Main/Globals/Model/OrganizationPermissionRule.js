const crypto = require('crypto');

const { tagMatchModes } = require('../Enumerations/TagMatchModes');
const { planFeatures } = require('../Enumerations/PlanFeatures');

class OrganizationPermissionRule
{
    #id;
    #organizationId;
    #name;
    #tagFilter;
    #matchMode;
    #attributeConditions;
    #allowedFeatures;
    #storageGrantBytes;
    #createdAt;

    constructor({organizationId = null, name = null, tagFilter = [], matchMode = 0, attributeConditions = [], allowedFeatures = [], storageGrantBytes = 0, createdAt = new Date()} = {})
    {
        this.#id = crypto.randomUUID();
        this.setOrganizationId(organizationId);
        this.setName(name);
        this.setTagFilter(tagFilter);
        this.setMatchMode(matchMode);
        this.setAttributeConditions(attributeConditions);
        this.setAllowedFeatures(allowedFeatures);
        this.setStorageGrantBytes(storageGrantBytes);
        this.setCreatedAt(createdAt);
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

    getName()
    {
        return this.#name;
    }

    setName(value)
    {
        if (value !== null)
        {
            value = String(value);
            if (value.length > 256)
            {
                value = value.slice(0, 256);
            }
            if (value.length < 1)
            {
                value = null;
            }
        }
        this.#name = value;
    }

    getTagFilter()
    {
        return this.#tagFilter;
    }

    setTagFilter(value)
    {
        if (value !== null)
        {
            if (!Array.isArray(value))
            {
                value = null;
            }
        }
        this.#tagFilter = value;
    }

    getMatchMode()
    {
        return this.#matchMode;
    }

    setMatchMode(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(tagMatchModes);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#matchMode = value;
    }

    getAttributeConditions()
    {
        return this.#attributeConditions;
    }

    setAttributeConditions(value)
    {
        if (value !== null)
        {
            if (!Array.isArray(value))
            {
                value = null;
            }
        }
        this.#attributeConditions = value;
    }

    getAllowedFeatures()
    {
        return this.#allowedFeatures;
    }

    setAllowedFeatures(value)
    {
        if (value !== null)
        {
            if (!Array.isArray(value))
            {
                value = null;
            }
        }
        this.#allowedFeatures = value;
    }

    getStorageGrantBytes()
    {
        return this.#storageGrantBytes;
    }

    setStorageGrantBytes(value)
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
        this.#storageGrantBytes = value;
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

    toJson()
    {
        return {
            id: this.getId(),
            organizationId: this.getOrganizationId(),
            name: this.getName(),
            tagFilter: this.getTagFilter(),
            matchMode: this.getMatchMode() !== null ? Number(this.getMatchMode()) : null,
            attributeConditions: this.getAttributeConditions(),
            allowedFeatures: this.getAllowedFeatures() !== null ? this.getAllowedFeatures().map(item => Number(item)) : null,
            storageGrantBytes: this.getStorageGrantBytes(),
            createdAt: this.getCreatedAt() !== null ? this.getCreatedAt().toISOString() : null,
        };
    }

    static fromJson(json)
    {
        const instance = new OrganizationPermissionRule({
            organizationId: json.organizationId ?? null,
            name: json.name ?? null,
            tagFilter: json.tagFilter ?? null,
            matchMode: json.matchMode ?? null,
            attributeConditions: json.attributeConditions ?? null,
            allowedFeatures: json.allowedFeatures ?? null,
            storageGrantBytes: json.storageGrantBytes ?? null,
            createdAt: json.createdAt != null ? new Date(json.createdAt) : null
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

module.exports = OrganizationPermissionRule;
