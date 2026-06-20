const { taskTypes } = require('../../Enumerations/TaskTypes');
const { creditChargeCategories } = require('../../Enumerations/CreditChargeCategories');
const { creditEnforcementModes } = require('../../Enumerations/CreditEnforcementModes');
const { creditDeductionTimings } = require('../../Enumerations/CreditDeductionTimings');
const CreditSpendRule = require('./CreditSpendRule');
const CreditSpendTerm = require('./CreditSpendTerm');
const CreditRewardMilestone = require('./CreditRewardMilestone');
const CreditPriceEntry = require('./CreditPriceEntry');
const CreditPackOption = require('./CreditPackOption');

// The single global credit configuration the admin edits. Persisted as one
// document in the creditConfig collection. `taskRules` is keyed by TaskTypes
// name; `storageRules` is keyed by CreditChargeCategories name.

class CreditConfiguration
{
    #taskRules;
    #storageRules;
    #rewardMilestones;
    #creditPricing;
    #creditPacks;
    #minimumPurchaseCredits;
    #defaultEnforcementMode;
    #signupGrant;
    #promoGrantAmount;
    #version;
    #updatedAt;
    #updatedBy;

    // New accounts receive a small starter grant so a student can taste the AI
    // features before hitting the paywall; larger welcome bonuses are still
    // distributed through admin-issued promo codes. Kept intentionally small
    // (2 credits) to limit farming via disposable email aliases.
    static DEFAULT_SIGNUP_GRANT = 2;
    static DEFAULT_PROMO_GRANT_AMOUNT = 5;
    static DEFAULT_MINIMUM_PURCHASE_CREDITS = 1;

    // Default flat per-request costs for the AskAi cloud tiers, keyed by
    // TaskTypes name. CreditPreflight treats an ABSENT rule as "unmetered →
    // free", so these tiers must always carry a configured rule — the store
    // backfills any missing entry from this table on load. Values are
    // starting points; the admin tunes them in the Credit Config editor.
    static ASK_AI_DEFAULT_FLAT_COSTS =
    {
        ASK_AI_BASIC: 0.1,
        ASK_AI_PRO: 0.25,
        ASK_AI_PRO_PLUS: 1,
    };

    constructor({ taskRules = {}, storageRules = {}, rewardMilestones = [], creditPricing = [], creditPacks = [], minimumPurchaseCredits = CreditConfiguration.DEFAULT_MINIMUM_PURCHASE_CREDITS, defaultEnforcementMode = creditEnforcementModes.ALLOW_NEGATIVE, signupGrant = CreditConfiguration.DEFAULT_SIGNUP_GRANT, promoGrantAmount = CreditConfiguration.DEFAULT_PROMO_GRANT_AMOUNT, version = 1, updatedAt = null, updatedBy = '' } = {})
    {
        this.setTaskRules(taskRules);
        this.setStorageRules(storageRules);
        this.setRewardMilestones(rewardMilestones);
        this.setCreditPricing(creditPricing);
        this.setCreditPacks(creditPacks);
        this.setMinimumPurchaseCredits(minimumPurchaseCredits);
        this.setDefaultEnforcementMode(defaultEnforcementMode);
        this.setSignupGrant(signupGrant);
        this.setPromoGrantAmount(promoGrantAmount);
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

    getCreditPricing()
    {
        return this.#creditPricing;
    }

    setCreditPricing(value)
    {
        const entries = [];
        const seenCurrencies = new Set();
        if (Array.isArray(value))
        {
            for (const rawEntry of value)
            {
                const entry = rawEntry instanceof CreditPriceEntry ? rawEntry : CreditPriceEntry.fromJson(rawEntry);
                if (entry.getCurrency().length === 0 || entry.getPricePerCredit() <= 0 || seenCurrencies.has(entry.getCurrency()))
                {
                    continue;
                }
                seenCurrencies.add(entry.getCurrency());
                entries.push(entry);
            }
        }
        // Insertion order is meaningful — the FIRST entry is the base currency
        // every unset currency converts from. Never sort.
        this.#creditPricing = entries;
    }

    getCreditPacks()
    {
        return this.#creditPacks;
    }

    setCreditPacks(value)
    {
        const packs = [];
        if (Array.isArray(value))
        {
            for (const rawPack of value)
            {
                const pack = rawPack instanceof CreditPackOption ? rawPack : CreditPackOption.fromJson(rawPack);
                if (pack.getCredits() < 1)
                {
                    continue;
                }
                packs.push(pack);
            }
        }
        // Smallest pack first for deterministic display.
        packs.sort((first, second) => first.getCredits() - second.getCredits());
        this.#creditPacks = packs;
    }

    getMinimumPurchaseCredits()
    {
        return this.#minimumPurchaseCredits;
    }

    setMinimumPurchaseCredits(value)
    {
        value = parseInt(value, 10);
        if (isNaN(value) || value < 1)
        {
            value = CreditConfiguration.DEFAULT_MINIMUM_PURCHASE_CREDITS;
        }
        this.#minimumPurchaseCredits = value;
    }

    /**
     * The base price entry — the first currency the admin entered — that all
     * unset currencies convert from. Null when no pricing is configured.
     * @returns {CreditPriceEntry|null}
     */
    getBaseCreditPriceEntry()
    {
        return this.#creditPricing.length > 0 ? this.#creditPricing[0] : null;
    }

    /**
     * The explicit price entry for a currency, or null when the admin has not
     * set one (callers then convert from the base entry).
     * @param {string} currencyCode
     * @returns {CreditPriceEntry|null}
     */
    getCreditPriceEntryForCurrency(currencyCode)
    {
        const normalizedCurrency = typeof currencyCode === "string" ? currencyCode.trim().toUpperCase() : "";
        return this.#creditPricing.find(entry => entry.getCurrency() === normalizedCurrency) || null;
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

    getPromoGrantAmount()
    {
        return this.#promoGrantAmount;
    }

    setPromoGrantAmount(value)
    {
        value = parseFloat(value);
        if (isNaN(value) || value < 0)
        {
            value = 0;
        }
        this.#promoGrantAmount = value;
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
     * Ensures every AskAi tier has a configured spend rule, adding the
     * default flat-cost rule for any tier that is missing one. Existing
     * rules (including admin-disabled ones) are never overwritten.
     * @returns {boolean} true when at least one rule was added
     */
    ensureAskAiTaskRules()
    {
        let bAddedAnyRule = false;
        for (const taskTypeName of Object.keys(CreditConfiguration.ASK_AI_DEFAULT_FLAT_COSTS))
        {
            if (this.#taskRules[taskTypeName])
            {
                continue;
            }
            // minimumBalanceToRun matches the flat cost so the preflight
            // refuses a user who could not afford the ON_SUCCESS charge —
            // otherwise a zero-balance user would pass preflight and the
            // post-stream charge would be floor-rejected (a free reply).
            const flatCost = CreditConfiguration.ASK_AI_DEFAULT_FLAT_COSTS[taskTypeName];
            this.#taskRules[taskTypeName] = new CreditSpendRule
            ({
                enabled: true,
                deductionTiming: creditDeductionTimings.ON_SUCCESS,
                minimumBalanceToRun: flatCost,
                minimumBalanceFloor: 0,
                terms: [new CreditSpendTerm({ credits: flatCost, divisors: {} })],
            });
            bAddedAnyRule = true;
        }
        return bAddedAnyRule;
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
            creditPricing: this.#creditPricing.map(entry => entry.toJson()),
            creditPacks: this.#creditPacks.map(pack => pack.toJson()),
            minimumPurchaseCredits: this.getMinimumPurchaseCredits(),
            defaultEnforcementMode: this.getDefaultEnforcementMode(),
            signupGrant: this.getSignupGrant(),
            promoGrantAmount: this.getPromoGrantAmount(),
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
            creditPricing: json?.creditPricing ?? [],
            creditPacks: json?.creditPacks ?? [],
            minimumPurchaseCredits: json?.minimumPurchaseCredits ?? CreditConfiguration.DEFAULT_MINIMUM_PURCHASE_CREDITS,
            defaultEnforcementMode: json?.defaultEnforcementMode ?? creditEnforcementModes.ALLOW_NEGATIVE,
            signupGrant: json?.signupGrant ?? CreditConfiguration.DEFAULT_SIGNUP_GRANT,
            promoGrantAmount: json?.promoGrantAmount ?? CreditConfiguration.DEFAULT_PROMO_GRANT_AMOUNT,
            version: json?.version ?? 1,
            updatedAt: json?.updatedAt ?? null,
            updatedBy: json?.updatedBy ?? '',
        });
    }
}

module.exports = CreditConfiguration;
