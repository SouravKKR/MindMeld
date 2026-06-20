import { organizationDeckPerkTypes } from '../Enumerations/OrganizationDeckPerkTypes.js';

class OrganizationDeckPerk
{
    #id;
    #organizationId;
    #deckId;
    #perkType;
    #perkValue;
    #durationDays;
    #createdAt;

    constructor({organizationId = null, deckId = null, perkType = 0, perkValue = 0, durationDays = 0, createdAt = new Date()} = {})
    {
        this.#id = crypto.randomUUID();
        this.setOrganizationId(organizationId);
        this.setDeckId(deckId);
        this.setPerkType(perkType);
        this.setPerkValue(perkValue);
        this.setDurationDays(durationDays);
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

    getPerkType()
    {
        return this.#perkType;
    }

    setPerkType(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(organizationDeckPerkTypes);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#perkType = value;
    }

    getPerkValue()
    {
        return this.#perkValue;
    }

    setPerkValue(value)
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
        this.#perkValue = value;
    }

    getDurationDays()
    {
        return this.#durationDays;
    }

    setDurationDays(value)
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
        this.#durationDays = value;
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
            deckId: this.getDeckId(),
            perkType: this.getPerkType() !== null ? Number(this.getPerkType()) : null,
            perkValue: this.getPerkValue(),
            durationDays: this.getDurationDays(),
            createdAt: this.getCreatedAt() !== null ? this.getCreatedAt().toISOString() : null,
        };
    }

    static fromJson(json)
    {
        const instance = new OrganizationDeckPerk({
            organizationId: json.organizationId ?? null,
            deckId: json.deckId ?? null,
            perkType: json.perkType ?? null,
            perkValue: json.perkValue ?? null,
            durationDays: json.durationDays ?? null,
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

export default OrganizationDeckPerk;
