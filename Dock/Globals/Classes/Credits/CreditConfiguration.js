const { taskTypes } = require('../../Enumerations/TaskTypes');
const { creditChargeCategories } = require('../../Enumerations/CreditChargeCategories');
const { creditEnforcementModes } = require('../../Enumerations/CreditEnforcementModes');
const CreditSpendRule = require('./CreditSpendRule');
const CreditRewardMilestone = require('./CreditRewardMilestone');

// The single global credit configuration the admin edits. Persisted as one
// document in the creditConfig collection. `taskRules` is keyed by TaskTypes
// name; `storageRules` is keyed by CreditChargeCategories name.

class CreditConfiguration
{
    #taskRules;
    #storageRules;
    #rewardMilestones;
    #defaultEnforcementMode;
    #signupGrant;
    #version;
    #updatedAt;
    #updatedBy;

    static DEFAULT_SIGNUP_GRANT = 5;

    constructor({ taskRules = {}, storageRules = {}, rewardMilestones = [], defaultEnforcementMode = creditEnforcementModes.ALLOW_NEGATIVE, signupGrant = CreditConfiguration.DEFAULT_SIGNUP_GRANT, version = 1, updatedAt = null, updatedBy = '' } = {})
    {
        this.setTaskRules(taskRules);
        this.setStorageRules(storageRules);
        this.setRewardMilestones(rewardMilestones);
        this.setDefaultEnforcementMode(defaultEnforcementMode);
        this.setSignupGrant(signupGrant);
        this.setVersion(version);
        this.setUpdatedAt(updatedAt);
        this.setUpdatedBy(updatedBy);
    }

    getTaskRules()
    {
        return this.#taskRules;
    }

    setTaskRules(value)
    {
        const rules = {};
        if (value !== null && typeof value === "object")
        {
            for (const taskTypeName of Object.keys(value))
            {
                const entry = value[taskTypeName];
                rules[taskTypeName] = entry instanceof CreditSpendRule ? entry : CreditSpendRule.fromJson(entry);
            }
        }
        this.#taskRules = rules;
    }

    getStorageRules()
    {
        return this.#storageRules;
    }

    setStorageRules(value)
    {
        const rules = {};
        if (value !== null && typeof value === "object")
        {
            for (const categoryName of Object.keys(value))
            {
                const entry = value[categoryName];
                rules[categoryName] = entry instanceof CreditSpendRule ? entry : CreditSpendRule.fromJson(entry);
            }
        }
        this.#storageRules = rules;
    }

    getRewardMilestones()
    {
        return this.#rewardMilestones;
    }

    setRewardMilestones(value)
    {
        const milestones = [];
        if (Array.isArray(value))
        {
            for (const entry of value)
            {
                milestones.push(entry instanceof CreditRewardMilestone ? entry : CreditRewardMilestone.fromJson(entry));
            }
        }
        // Lowest threshold first so milestone evaluation is deterministic.
        milestones.sort((first, second) => first.getSpendThreshold() - second.getSpendThreshold());
        this.#rewardMilestones = milestones;
    }

    getDefaultEnforcementMode()
    {
        return this.#defaultEnforcementMode;
    }

    setDefaultEnforcementMode(value)
    {
        const enumValues = Object.values(creditEnforcementModes);
        if (!enumValues.includes(value))
        {
            value = creditEnforcementModes.ALLOW_NEGATIVE;
        }
        this.#defaultEnforcementMode = value;
    }

    getSignupGrant()
    {
        return this.#signupGrant;
    }

    setSignupGrant(value)
    {
        value = parseFloat(value);
        if (isNaN(value) || value < 0)
        {
            value = 0;
        }
        this.#signupGrant = value;
    }

    getVersion()
    {
        return this.#version;
    }

    setVersion(value)
    {
        value = parseInt(value, 10);
        if (isNaN(value) || value < 1)
        {
            value = 1;
        }
        this.#version = value;
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
                value = null;
            }
        }
        else
        {
            value = null;
        }
        this.#updatedAt = value;
    }

    getUpdatedBy()
    {
        return this.#updatedBy;
    }

    setUpdatedBy(value)
    {
        this.#updatedBy = value !== null && value !== undefined ? String(value) : '';
    }

    /**
     * Resolves the CONFIGURED spend rule for an agent task type value, or null
     * only when no rule exists for it at all. The rule is returned even when
     * disabled — callers distinguish "absent" (unconfigured → allow free) from
     * "present but disabled" (→ deny the service) via rule.getEnabled().
     * @param {number} taskTypeValue — a TaskTypes enum value
     * @returns {CreditSpendRule|null}
     */
    getRuleForTask(taskTypeValue)
    {
        const taskTypeName = Object.keys(taskTypes).find(name => taskTypes[name] === taskTypeValue);
        if (!taskTypeName)
        {
            return null;
        }
        return this.#taskRules[taskTypeName] || null;
    }

    /**
     * Resolves the CONFIGURED spend rule for a storage category value, or null
     * when no rule exists. Returned even when disabled; the assessor only
     * charges when getEnabled() is true (storage has no "deny" concept).
     * @param {number} categoryValue — a CreditChargeCategories enum value
     * @returns {CreditSpendRule|null}
     */
    getStorageRule(categoryValue)
    {
        const categoryName = Object.keys(creditChargeCategories).find(name => creditChargeCategories[name] === categoryValue);
        if (!categoryName)
        {
            return null;
        }
        return this.#storageRules[categoryName] || null;
    }

    toJson()
    {
        const taskRulesJson = {};
        for (const taskTypeName of Object.keys(this.#taskRules))
        {
            taskRulesJson[taskTypeName] = this.#taskRules[taskTypeName].toJson();
        }

        const storageRulesJson = {};
        for (const categoryName of Object.keys(this.#storageRules))
        {
            storageRulesJson[categoryName] = this.#storageRules[categoryName].toJson();
        }

        return {
            taskRules: taskRulesJson,
            storageRules: storageRulesJson,
            rewardMilestones: this.#rewardMilestones.map(milestone => milestone.toJson()),
            defaultEnforcementMode: this.getDefaultEnforcementMode(),
            signupGrant: this.getSignupGrant(),
            version: this.getVersion(),
            updatedAt: this.getUpdatedAt() !== null ? this.getUpdatedAt().toISOString() : null,
            updatedBy: this.getUpdatedBy(),
        };
    }

    static fromJson(json)
    {
        return new CreditConfiguration({
            taskRules: json?.taskRules ?? {},
            storageRules: json?.storageRules ?? {},
            rewardMilestones: json?.rewardMilestones ?? [],
            defaultEnforcementMode: json?.defaultEnforcementMode ?? creditEnforcementModes.ALLOW_NEGATIVE,
            signupGrant: json?.signupGrant ?? CreditConfiguration.DEFAULT_SIGNUP_GRANT,
            version: json?.version ?? 1,
            updatedAt: json?.updatedAt ?? null,
            updatedBy: json?.updatedBy ?? '',
        });
    }
}

module.exports = CreditConfiguration;
