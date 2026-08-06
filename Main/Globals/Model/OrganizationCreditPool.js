const crypto = require('crypto');

class OrganizationCreditPool
{
    #id;
    #organizationId;
    #balance;
    #lifetimeGranted;
    #lifetimeDistributed;
    #frozen;
    #updatedAt;

    constructor({organizationId = null, balance = 0, lifetimeGranted = 0, lifetimeDistributed = 0, frozen = false, updatedAt = new Date()} = {})
    {
        this.#id = crypto.randomUUID();
        this.setOrganizationId(organizationId);
        this.setBalance(balance);
        this.setLifetimeGranted(lifetimeGranted);
        this.setLifetimeDistributed(lifetimeDistributed);
        this.setFrozen(frozen);
        this.setUpdatedAt(updatedAt);
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

    getBalance()
    {
        return this.#balance;
    }

    setBalance(value)
    {
        if (value !== null)
        {
            value = parseFloat(value);
            if (isNaN(value))
            {
                value = 0;
            }
            else
            {
                value = Math.max(value, 0);
            }
        }
        this.#balance = value;
    }

    getLifetimeGranted()
    {
        return this.#lifetimeGranted;
    }

    setLifetimeGranted(value)
    {
        if (value !== null)
        {
            value = parseFloat(value);
            if (isNaN(value))
            {
                value = 0;
            }
            else
            {
                value = Math.max(value, 0);
            }
        }
        this.#lifetimeGranted = value;
    }

    getLifetimeDistributed()
    {
        return this.#lifetimeDistributed;
    }

    setLifetimeDistributed(value)
    {
        if (value !== null)
        {
            value = parseFloat(value);
            if (isNaN(value))
            {
                value = 0;
            }
            else
            {
                value = Math.max(value, 0);
            }
        }
        this.#lifetimeDistributed = value;
    }

    getFrozen()
    {
        return this.#frozen;
    }

    setFrozen(value)
    {
        if (value !== null)
        {
            value = Boolean(value);
        }
        this.#frozen = value;
    }

    getUpdatedAt()
    {
        return this.#updatedAt;
    }

    setUpdatedAt(value)
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
        this.#updatedAt = value;
    }

    toJson()
    {
        return {
            id: this.getId(),
            organizationId: this.getOrganizationId(),
            balance: this.getBalance(),
            lifetimeGranted: this.getLifetimeGranted(),
            lifetimeDistributed: this.getLifetimeDistributed(),
            frozen: this.getFrozen(),
            updatedAt: this.getUpdatedAt() !== null ? this.getUpdatedAt().toISOString() : null,
        };
    }

    static fromJson(json)
    {
        const instance = new OrganizationCreditPool({
            organizationId: json.organizationId ?? null,
            balance: json.balance ?? null,
            lifetimeGranted: json.lifetimeGranted ?? null,
            lifetimeDistributed: json.lifetimeDistributed ?? null,
            frozen: json.frozen ?? null,
            updatedAt: json.updatedAt != null ? new Date(json.updatedAt) : null
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

module.exports = OrganizationCreditPool;
