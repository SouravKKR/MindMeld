const crypto = require('crypto');

const { periodicScopeTypes } = require('../Enumerations/PeriodicScopeTypes');
const { tagMatchModes } = require('../Enumerations/TagMatchModes');
const { creditGrantAmountModes } = require('../Enumerations/CreditGrantAmountModes');
const { periodicScheduleTypes } = require('../Enumerations/PeriodicScheduleTypes');
const { periodicOnJoinModes } = require('../Enumerations/PeriodicOnJoinModes');
const { periodicAssignmentStatuses } = require('../Enumerations/PeriodicAssignmentStatuses');

class PeriodicCreditAssignment
{
    #id;
    #name;
    #scopeType;
    #organizationId;
    #peopleEmails;
    #tagFilter;
    #tagMatchMode;
    #amount;
    #amountMode;
    #scheduleType;
    #intervalDays;
    #dayOfWeek;
    #dayOfMonth;
    #onJoinMode;
    #startAt;
    #hasValidUntil;
    #validUntil;
    #status;
    #terminatedAt;
    #createdByUserId;
    #createdAt;
    #additionalData;

    constructor({name = null, scopeType = 0, organizationId = '', peopleEmails = [], tagFilter = [], tagMatchMode = 0, amount = 0, amountMode = 1, scheduleType = 0, intervalDays = 0, dayOfWeek = 0, dayOfMonth = 1, onJoinMode = 0, startAt = new Date(), hasValidUntil = false, validUntil = new Date(), status = 0, terminatedAt = new Date(), createdByUserId = '', createdAt = new Date(), additionalData = {}} = {})
    {
        this.#id = crypto.randomUUID();
        this.setName(name);
        this.setScopeType(scopeType);
        this.setOrganizationId(organizationId);
        this.setPeopleEmails(peopleEmails);
        this.setTagFilter(tagFilter);
        this.setTagMatchMode(tagMatchMode);
        this.setAmount(amount);
        this.setAmountMode(amountMode);
        this.setScheduleType(scheduleType);
        this.setIntervalDays(intervalDays);
        this.setDayOfWeek(dayOfWeek);
        this.setDayOfMonth(dayOfMonth);
        this.setOnJoinMode(onJoinMode);
        this.setStartAt(startAt);
        this.setHasValidUntil(hasValidUntil);
        this.setValidUntil(validUntil);
        this.setStatus(status);
        this.setTerminatedAt(terminatedAt);
        this.setCreatedByUserId(createdByUserId);
        this.setCreatedAt(createdAt);
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

    getScopeType()
    {
        return this.#scopeType;
    }

    setScopeType(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(periodicScopeTypes);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#scopeType = value;
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

    getPeopleEmails()
    {
        return this.#peopleEmails;
    }

    setPeopleEmails(value)
    {
        if (value !== null)
        {
            if (!Array.isArray(value))
            {
                value = null;
            }
        }
        this.#peopleEmails = value;
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

    getTagMatchMode()
    {
        return this.#tagMatchMode;
    }

    setTagMatchMode(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(tagMatchModes);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#tagMatchMode = value;
    }

    getAmount()
    {
        return this.#amount;
    }

    setAmount(value)
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
        this.#amount = value;
    }

    getAmountMode()
    {
        return this.#amountMode;
    }

    setAmountMode(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(creditGrantAmountModes);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#amountMode = value;
    }

    getScheduleType()
    {
        return this.#scheduleType;
    }

    setScheduleType(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(periodicScheduleTypes);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#scheduleType = value;
    }

    getIntervalDays()
    {
        return this.#intervalDays;
    }

    setIntervalDays(value)
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
        this.#intervalDays = value;
    }

    getDayOfWeek()
    {
        return this.#dayOfWeek;
    }

    setDayOfWeek(value)
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
                value = Math.min(Math.max(value, 0), 6);
            }
        }
        this.#dayOfWeek = value;
    }

    getDayOfMonth()
    {
        return this.#dayOfMonth;
    }

    setDayOfMonth(value)
    {
        if (value !== null)
        {
            value = parseInt(value, 10);
            if (isNaN(value))
            {
                value = 1;
            }
            else
            {
                value = Math.min(Math.max(value, 1), 31);
            }
        }
        this.#dayOfMonth = value;
    }

    getOnJoinMode()
    {
        return this.#onJoinMode;
    }

    setOnJoinMode(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(periodicOnJoinModes);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#onJoinMode = value;
    }

    getStartAt()
    {
        return this.#startAt;
    }

    setStartAt(value)
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
        this.#startAt = value;
    }

    getHasValidUntil()
    {
        return this.#hasValidUntil;
    }

    setHasValidUntil(value)
    {
        if (value !== null)
        {
            value = Boolean(value);
        }
        this.#hasValidUntil = value;
    }

    getValidUntil()
    {
        return this.#validUntil;
    }

    setValidUntil(value)
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
        this.#validUntil = value;
    }

    getStatus()
    {
        return this.#status;
    }

    setStatus(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(periodicAssignmentStatuses);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#status = value;
    }

    getTerminatedAt()
    {
        return this.#terminatedAt;
    }

    setTerminatedAt(value)
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
        this.#terminatedAt = value;
    }

    getCreatedByUserId()
    {
        return this.#createdByUserId;
    }

    setCreatedByUserId(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#createdByUserId = value;
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
            scopeType: this.getScopeType() !== null ? Number(this.getScopeType()) : null,
            organizationId: this.getOrganizationId(),
            peopleEmails: this.getPeopleEmails(),
            tagFilter: this.getTagFilter(),
            tagMatchMode: this.getTagMatchMode() !== null ? Number(this.getTagMatchMode()) : null,
            amount: this.getAmount(),
            amountMode: this.getAmountMode() !== null ? Number(this.getAmountMode()) : null,
            scheduleType: this.getScheduleType() !== null ? Number(this.getScheduleType()) : null,
            intervalDays: this.getIntervalDays(),
            dayOfWeek: this.getDayOfWeek(),
            dayOfMonth: this.getDayOfMonth(),
            onJoinMode: this.getOnJoinMode() !== null ? Number(this.getOnJoinMode()) : null,
            startAt: this.getStartAt() !== null ? this.getStartAt().toISOString() : null,
            hasValidUntil: this.getHasValidUntil(),
            validUntil: this.getValidUntil() !== null ? this.getValidUntil().toISOString() : null,
            status: this.getStatus() !== null ? Number(this.getStatus()) : null,
            terminatedAt: this.getTerminatedAt() !== null ? this.getTerminatedAt().toISOString() : null,
            createdByUserId: this.getCreatedByUserId(),
            createdAt: this.getCreatedAt() !== null ? this.getCreatedAt().toISOString() : null,
            additionalData: this.getAdditionalData(),
        };
    }

    static fromJson(json)
    {
        const instance = new PeriodicCreditAssignment({
            name: json.name ?? null,
            scopeType: json.scopeType ?? null,
            organizationId: json.organizationId ?? null,
            peopleEmails: json.peopleEmails ?? null,
            tagFilter: json.tagFilter ?? null,
            tagMatchMode: json.tagMatchMode ?? null,
            amount: json.amount ?? null,
            amountMode: json.amountMode ?? null,
            scheduleType: json.scheduleType ?? null,
            intervalDays: json.intervalDays ?? null,
            dayOfWeek: json.dayOfWeek ?? null,
            dayOfMonth: json.dayOfMonth ?? null,
            onJoinMode: json.onJoinMode ?? null,
            startAt: json.startAt != null ? new Date(json.startAt) : null,
            hasValidUntil: json.hasValidUntil ?? null,
            validUntil: json.validUntil != null ? new Date(json.validUntil) : null,
            status: json.status ?? null,
            terminatedAt: json.terminatedAt != null ? new Date(json.terminatedAt) : null,
            createdByUserId: json.createdByUserId ?? null,
            createdAt: json.createdAt != null ? new Date(json.createdAt) : null,
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

module.exports = PeriodicCreditAssignment;
