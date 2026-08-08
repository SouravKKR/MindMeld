const crypto = require('crypto');

const { organizationStatus } = require('../Enumerations/OrganizationStatus');
const { planFeatures } = require('../Enumerations/PlanFeatures');

class Organization
{
    #id;
    #name;
    #adminEmail;
    #adminUserId;
    #status;
    #currency;
    #creationAmountMinor;
    #maxMembers;
    #currentMemberCount;
    #creationDate;
    #activationDate;
    #termEndsAt;
    #maxStorageGrantBytesPerMember;
    #maxCreditsPerMemberPerMonth;
    #maxPublishedDecks;
    #grantableFeatures;
    #adminAllowedFeatures;
    #additionalData;

    constructor({name = null, adminEmail = null, adminUserId = '', status = 0, currency = 'INR', creationAmountMinor = 0, maxMembers = 0, currentMemberCount = 0, creationDate = new Date(), activationDate = new Date(), termEndsAt = new Date(), maxStorageGrantBytesPerMember = 0, maxCreditsPerMemberPerMonth = 0, maxPublishedDecks = 0, grantableFeatures = [], adminAllowedFeatures = [], additionalData = {}} = {})
    {
        this.#id = crypto.randomUUID();
        this.setName(name);
        this.setAdminEmail(adminEmail);
        this.setAdminUserId(adminUserId);
        this.setStatus(status);
        this.setCurrency(currency);
        this.setCreationAmountMinor(creationAmountMinor);
        this.setMaxMembers(maxMembers);
        this.setCurrentMemberCount(currentMemberCount);
        this.setCreationDate(creationDate);
        this.setActivationDate(activationDate);
        this.setTermEndsAt(termEndsAt);
        this.setMaxStorageGrantBytesPerMember(maxStorageGrantBytesPerMember);
        this.setMaxCreditsPerMemberPerMonth(maxCreditsPerMemberPerMonth);
        this.setMaxPublishedDecks(maxPublishedDecks);
        this.setGrantableFeatures(grantableFeatures);
        this.setAdminAllowedFeatures(adminAllowedFeatures);
        this.setAdditionalData(additionalData);
    }

    getId()
    {
        return this.#id;
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

    getAdminEmail()
    {
        return this.#adminEmail;
    }

    setAdminEmail(value)
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
        this.#adminEmail = value;
    }

    getAdminUserId()
    {
        return this.#adminUserId;
    }

    setAdminUserId(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#adminUserId = value;
    }

    getStatus()
    {
        return this.#status;
    }

    setStatus(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(organizationStatus);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#status = value;
    }

    getCurrency()
    {
        return this.#currency;
    }

    setCurrency(value)
    {
        if (value !== null)
        {
            value = String(value);
            if (value.length > 8)
            {
                value = value.slice(0, 8);
            }
        }
        this.#currency = value;
    }

    getCreationAmountMinor()
    {
        return this.#creationAmountMinor;
    }

    setCreationAmountMinor(value)
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
        this.#creationAmountMinor = value;
    }

    getMaxMembers()
    {
        return this.#maxMembers;
    }

    setMaxMembers(value)
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
        this.#maxMembers = value;
    }

    getCurrentMemberCount()
    {
        return this.#currentMemberCount;
    }

    setCurrentMemberCount(value)
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
        this.#currentMemberCount = value;
    }

    getCreationDate()
    {
        return this.#creationDate;
    }

    setCreationDate(value)
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
        this.#creationDate = value;
    }

    getActivationDate()
    {
        return this.#activationDate;
    }

    setActivationDate(value)
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
        this.#activationDate = value;
    }

    getTermEndsAt()
    {
        return this.#termEndsAt;
    }

    setTermEndsAt(value)
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
        this.#termEndsAt = value;
    }

    getMaxStorageGrantBytesPerMember()
    {
        return this.#maxStorageGrantBytesPerMember;
    }

    setMaxStorageGrantBytesPerMember(value)
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
        this.#maxStorageGrantBytesPerMember = value;
    }

    getMaxCreditsPerMemberPerMonth()
    {
        return this.#maxCreditsPerMemberPerMonth;
    }

    setMaxCreditsPerMemberPerMonth(value)
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
        this.#maxCreditsPerMemberPerMonth = value;
    }

    getMaxPublishedDecks()
    {
        return this.#maxPublishedDecks;
    }

    setMaxPublishedDecks(value)
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
        this.#maxPublishedDecks = value;
    }

    getGrantableFeatures()
    {
        return this.#grantableFeatures;
    }

    setGrantableFeatures(value)
    {
        if (value !== null)
        {
            if (!Array.isArray(value))
            {
                value = null;
            }
        }
        this.#grantableFeatures = value;
    }

    getAdminAllowedFeatures()
    {
        return this.#adminAllowedFeatures;
    }

    setAdminAllowedFeatures(value)
    {
        if (value !== null)
        {
            if (!Array.isArray(value))
            {
                value = null;
            }
        }
        this.#adminAllowedFeatures = value;
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
            name: this.getName(),
            adminEmail: this.getAdminEmail(),
            adminUserId: this.getAdminUserId(),
            status: this.getStatus() !== null ? Number(this.getStatus()) : null,
            currency: this.getCurrency(),
            creationAmountMinor: this.getCreationAmountMinor(),
            maxMembers: this.getMaxMembers(),
            currentMemberCount: this.getCurrentMemberCount(),
            creationDate: this.getCreationDate() !== null ? this.getCreationDate().toISOString() : null,
            activationDate: this.getActivationDate() !== null ? this.getActivationDate().toISOString() : null,
            termEndsAt: this.getTermEndsAt() !== null ? this.getTermEndsAt().toISOString() : null,
            maxStorageGrantBytesPerMember: this.getMaxStorageGrantBytesPerMember(),
            maxCreditsPerMemberPerMonth: this.getMaxCreditsPerMemberPerMonth(),
            maxPublishedDecks: this.getMaxPublishedDecks(),
            grantableFeatures: this.getGrantableFeatures() !== null ? this.getGrantableFeatures().map(item => Number(item)) : null,
            adminAllowedFeatures: this.getAdminAllowedFeatures() !== null ? this.getAdminAllowedFeatures().map(item => Number(item)) : null,
            additionalData: this.getAdditionalData(),
        };
    }

    static fromJson(json)
    {
        const instance = new Organization({
            name: json.name ?? null,
            adminEmail: json.adminEmail ?? null,
            adminUserId: json.adminUserId ?? null,
            status: json.status ?? null,
            currency: json.currency ?? null,
            creationAmountMinor: json.creationAmountMinor ?? null,
            maxMembers: json.maxMembers ?? null,
            currentMemberCount: json.currentMemberCount ?? null,
            creationDate: json.creationDate != null ? new Date(json.creationDate) : null,
            activationDate: json.activationDate != null ? new Date(json.activationDate) : null,
            termEndsAt: json.termEndsAt != null ? new Date(json.termEndsAt) : null,
            maxStorageGrantBytesPerMember: json.maxStorageGrantBytesPerMember ?? null,
            maxCreditsPerMemberPerMonth: json.maxCreditsPerMemberPerMonth ?? null,
            maxPublishedDecks: json.maxPublishedDecks ?? null,
            grantableFeatures: json.grantableFeatures ?? null,
            adminAllowedFeatures: json.adminAllowedFeatures ?? null,
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

module.exports = Organization;
