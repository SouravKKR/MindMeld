const crypto = require('crypto');

const { memberAttributeValueTypes } = require('../Enumerations/MemberAttributeValueTypes');
const { memberColumnRenamePhases } = require('../Enumerations/MemberColumnRenamePhases');

class OrganizationMemberColumn
{
    #id;
    #organizationId;
    #key;
    #label;
    #valueType;
    #aliases;
    #displayOrder;
    #renamePhase;
    #pendingRenameToKey;
    #createdAt;

    constructor({organizationId = null, key = null, label = null, valueType = 0, aliases = [], displayOrder = 0, renamePhase = 0, pendingRenameToKey = '', createdAt = new Date()} = {})
    {
        this.#id = crypto.randomUUID();
        this.setOrganizationId(organizationId);
        this.setKey(key);
        this.setLabel(label);
        this.setValueType(valueType);
        this.setAliases(aliases);
        this.setDisplayOrder(displayOrder);
        this.setRenamePhase(renamePhase);
        this.setPendingRenameToKey(pendingRenameToKey);
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

    getKey()
    {
        return this.#key;
    }

    setKey(value)
    {
        if (value !== null)
        {
            value = String(value);
            if (value.length > 64)
            {
                value = value.slice(0, 64);
            }
            if (value.length < 1)
            {
                value = null;
            }
        }
        this.#key = value;
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
            if (value.length > 128)
            {
                value = value.slice(0, 128);
            }
            if (value.length < 1)
            {
                value = null;
            }
        }
        this.#label = value;
    }

    getValueType()
    {
        return this.#valueType;
    }

    setValueType(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(memberAttributeValueTypes);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#valueType = value;
    }

    getAliases()
    {
        return this.#aliases;
    }

    setAliases(value)
    {
        if (value !== null)
        {
            if (!Array.isArray(value))
            {
                value = null;
            }
        }
        this.#aliases = value;
    }

    getDisplayOrder()
    {
        return this.#displayOrder;
    }

    setDisplayOrder(value)
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
        this.#displayOrder = value;
    }

    getRenamePhase()
    {
        return this.#renamePhase;
    }

    setRenamePhase(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(memberColumnRenamePhases);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#renamePhase = value;
    }

    getPendingRenameToKey()
    {
        return this.#pendingRenameToKey;
    }

    setPendingRenameToKey(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#pendingRenameToKey = value;
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
            key: this.getKey(),
            label: this.getLabel(),
            valueType: this.getValueType() !== null ? Number(this.getValueType()) : null,
            aliases: this.getAliases(),
            displayOrder: this.getDisplayOrder(),
            renamePhase: this.getRenamePhase() !== null ? Number(this.getRenamePhase()) : null,
            pendingRenameToKey: this.getPendingRenameToKey(),
            createdAt: this.getCreatedAt() !== null ? this.getCreatedAt().toISOString() : null,
        };
    }

    static fromJson(json)
    {
        const instance = new OrganizationMemberColumn({
            organizationId: json.organizationId ?? null,
            key: json.key ?? null,
            label: json.label ?? null,
            valueType: json.valueType ?? null,
            aliases: json.aliases ?? null,
            displayOrder: json.displayOrder ?? null,
            renamePhase: json.renamePhase ?? null,
            pendingRenameToKey: json.pendingRenameToKey ?? null,
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

module.exports = OrganizationMemberColumn;
