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

    // The packs a buyer may choose from. Purchases are pack-only: a free
    // quantity box asked every buyer to decide a number they had no basis for
    // choosing, and made "how much does this cost" a calculation rather than a
    // price. The ladder is wide enough that the answer is always "the next one
    // up". Discounts are left at zero here and set by an administrator — a
    // default discount would be a pricing decision hidden in code.
    static DEFAULT_CREDIT_PACK_SIZES = [5, 10, 25, 50, 100, 250, 500, 1000];

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

    // Default flat per-request cost for the "Auto Fill Other Options" generation
    // helper. Like the AskAi tiers it bypasses the task queue (a one-shot Gemini
    // flash-lite call), so CreditPreflight would read an ABSENT rule as free —
    // the store backfills this on load. Cheap single call; admin-tunable later.
    static AUTO_FILL_GENERATION_OPTIONS_DEFAULT_FLAT_COST = 0.3;

    // Default flat per-request costs for post-generation content refinement.
    // Both bypass the task queue, so an ABSENT rule would read as free and the
    // store backfills them on load.
    //
    // The two are priced an order of magnitude apart on purpose, and a single
    // shared rule would have been wrong. A text refinement is one flash-lite
    // call. A visual refinement drives the deck pipeline's own diagram path: a
    // premium symbolic-generation call at high reasoning effort, a possible
    // second call when the routed format declines and the request escalates to
    // inline SVG, and then a premium vision review of the rendered result.
    // Charging the text price for that would sell opus diagrams at flash-lite
    // rates; charging the diagram price for a typo fix would stop anyone using
    // the feature the corrections actually depend on.
    static REFINE_CONTENT_DEFAULT_FLAT_COST = 0.4;
    static REFINE_VISUAL_DEFAULT_FLAT_COST = 4;

    // ── Generation pipeline defaults ──────────────────────────────────────────
    //
    // The queued generation workers shipped with NO rule at all, which meant two
    // things at once: every run was free, and Compute Cost reported 0 for every
    // configuration because CreditEstimator has nothing to multiply by. These
    // seeds fix both, and because TaskCreditCharger evaluates the SAME rules, the
    // estimate and the actual charge cannot drift apart by construction.
    //
    // Deriving the divisors. A term costs `credits × (metric ÷ divisor)`, so a
    // divisor reads as "per this many units". The token metrics are NORMALIZED to
    // the reference model gemini-2.5-flash-lite (CreditMeter multiplies by the
    // ModelPricing weight, so a pro-model token already arrives pre-scaled),
    // whose list price is $0.10 / 1M input and $0.40 / 1M output.
    //
    // Anchored on a representative run — the estimator's own 25-page assumption
    // with all three output types enabled, which works out at roughly 780k
    // normalized input and 156k normalized output tokens, about $0.14 of raw
    // model cost. Targeting ~10 credits for that run and splitting it in
    // proportion to raw cost gives ≈150k input tokens and ≈35k output tokens per
    // credit. Note the 4.3:1 ratio between those divisors tracks the model's own
    // 4:1 price ratio — the seeds follow the real cost structure rather than
    // being picked out of the air.
    //
    // These are STARTING POINTS, not settled pricing. Every one of them is
    // editable in the Credit Config admin editor, and the honest way to tune them
    // is from creditTransactions.metadata.usage once real runs have accumulated.
    static GENERATION_DEFAULT_INPUT_TOKENS_PER_CREDIT = 150000;
    static GENERATION_DEFAULT_OUTPUT_TOKENS_PER_CREDIT = 35000;

    // Document preparation is CPU/embedding work, not model output — cheap, and
    // billed on wall-clock. The same representative run spends ~175s across the
    // three preparation tasks, so this lands it under a credit.
    static GENERATION_DEFAULT_DURATION_SECONDS_PER_CREDIT = 200;

    // Image enhancement is charged flat, matching the estimator's own flat
    // calibration for it, because its cost tracks the number of diagrams rather
    // than tokens or time.
    static GENERATION_DEFAULT_IMAGE_ENHANCEMENT_FLAT_COST = 2;

    // A generation is metered on tokens, so its cost is unknowable at preflight.
    // Requiring a small balance to START keeps a zero-balance account from
    // running a full pipeline whose charge then lands against nothing.
    static GENERATION_DEFAULT_MINIMUM_BALANCE_TO_RUN = 1;

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
    /**
     * Backfills the standard pack ladder when none is configured, so a fresh
     * environment can sell credits without an administrator having to invent
     * the sizes first. Returns true when something was added, matching the
     * other ensure* methods, so the caller knows to persist.
     *
     * An existing pack set is never touched: once an administrator has chosen
     * sizes and discounts, those are the prices customers were shown.
     */
    ensureDefaultCreditPacks()
    {
        if (this.getCreditPacks().length > 0)
        {
            return false;
        }

        this.setCreditPacks(CreditConfiguration.DEFAULT_CREDIT_PACK_SIZES.map(packSize => ({ credits: packSize, discountPercent: 0 })));
        return true;
    }

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
     * Ensures the Auto Fill Other Options helper has a configured spend rule,
     * adding the default flat-cost rule when missing. An existing rule (including
     * an admin-disabled one) is never overwritten. Mirrors ensureAskAiTaskRules:
     * the helper bypasses the task queue, so without a rule CreditPreflight would
     * treat it as unmetered and the post-call charge would never be required.
     * @returns {boolean} true when the rule was added
     */
    ensureAutoFillGenerationOptionsTaskRule()
    {
        const taskTypeName = "AUTO_FILL_GENERATION_OPTIONS";
        if (this.#taskRules[taskTypeName])
        {
            return false;
        }

        // minimumBalanceToRun matches the flat cost so a user who could not
        // afford the ON_SUCCESS charge is refused at preflight rather than
        // receiving a free result the post-call charge then floor-rejects.
        const flatCost = CreditConfiguration.AUTO_FILL_GENERATION_OPTIONS_DEFAULT_FLAT_COST;
        this.#taskRules[taskTypeName] = new CreditSpendRule
        ({
            enabled: true,
            deductionTiming: creditDeductionTimings.ON_SUCCESS,
            minimumBalanceToRun: flatCost,
            minimumBalanceFloor: 0,
            terms: [new CreditSpendTerm({ credits: flatCost, divisors: {} })],
        });
        return true;
    }

    /**
     * Ensures both content-refinement actions have configured spend rules,
     * adding the default flat-cost rules when missing. Existing rules —
     * including admin-disabled ones — are never overwritten.
     *
     * Same reasoning as ensureAutoFillGenerationOptionsTaskRule: these are
     * one-shot workers outside the task queue, so with no rule CreditPreflight
     * reads them as unmetered and nothing is ever charged.
     *
     * The ADMIN verification auto-fix deliberately runs unmetered and does not
     * consult these rules — it is gated by role, not by balance. It still
     * records a zero-value ledger entry so the spend is attributable.
     *
     * @returns {boolean} true when at least one rule was added
     */
    ensureContentRefinementTaskRules()
    {
        const defaultFlatCostsByTaskTypeName =
        {
            REFINE_CONTENT: CreditConfiguration.REFINE_CONTENT_DEFAULT_FLAT_COST,
            REFINE_VISUAL: CreditConfiguration.REFINE_VISUAL_DEFAULT_FLAT_COST,
        };

        let bAddedAnyRule = false;

        for (const taskTypeName of Object.keys(defaultFlatCostsByTaskTypeName))
        {
            if (this.#taskRules[taskTypeName])
            {
                continue;
            }

            // minimumBalanceToRun matches the flat cost so a user who could not
            // afford the ON_SUCCESS charge is refused at preflight rather than
            // receiving a proposal the post-call charge then floor-rejects.
            const flatCost = defaultFlatCostsByTaskTypeName[taskTypeName];
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
     * Ensures the queued generation pipeline has configured spend rules, adding
     * the defaults above for any task that is missing one. Existing rules —
     * including admin-disabled ones and ones an admin deliberately left with no
     * terms — are never overwritten, matching ensureAskAiTaskRules.
     *
     * Without these, generation ran free AND Compute Cost reported 0 for every
     * configuration, because an absent rule gives CreditEstimator nothing to
     * multiply by. That reads as "this run is free" rather than "nobody has
     * priced this yet", which is the more damaging of the two failures.
     *
     * @returns {boolean} true when at least one rule was added
     */
    ensureGenerationTaskRules()
    {
        const tokenMeteredTaskTypeNames =
        [
            "FLASHCARD_GENERATION_WORKER",
            "STUDY_MATERIAL_GENERATION_WORKER",
            "MOCK_TEST_GENERATION_WORKER",
        ];

        const durationMeteredTaskTypeNames =
        [
            "PREPARE_FOR_SIMILARITY_SEARCH",
            "MAP_TOPICS_WITH_CONTENT",
            "PROCESS_SYLLABUS",
        ];

        let bAddedAnyRule = false;

        for (const taskTypeName of tokenMeteredTaskTypeNames)
        {
            if (this.#taskRules[taskTypeName])
            {
                continue;
            }

            // Two single-dimension terms rather than one two-dimension term:
            // CreditSpendTerm multiplies its dimensions together, so a combined
            // term would compute input × output instead of input + output.
            this.#taskRules[taskTypeName] = new CreditSpendRule
            ({
                enabled: true,
                deductionTiming: creditDeductionTimings.ON_SUCCESS,
                minimumBalanceToRun: CreditConfiguration.GENERATION_DEFAULT_MINIMUM_BALANCE_TO_RUN,
                minimumBalanceFloor: 0,
                terms:
                [
                    new CreditSpendTerm({ credits: 1, divisors: { INPUT_TOKENS: CreditConfiguration.GENERATION_DEFAULT_INPUT_TOKENS_PER_CREDIT } }),
                    new CreditSpendTerm({ credits: 1, divisors: { OUTPUT_TOKENS: CreditConfiguration.GENERATION_DEFAULT_OUTPUT_TOKENS_PER_CREDIT } }),
                ],
            });
            bAddedAnyRule = true;
        }

        for (const taskTypeName of durationMeteredTaskTypeNames)
        {
            if (this.#taskRules[taskTypeName])
            {
                continue;
            }

            this.#taskRules[taskTypeName] = new CreditSpendRule
            ({
                enabled: true,
                deductionTiming: creditDeductionTimings.ON_SUCCESS,
                minimumBalanceToRun: 0,
                minimumBalanceFloor: 0,
                terms: [new CreditSpendTerm({ credits: 1, divisors: { DURATION_SECONDS: CreditConfiguration.GENERATION_DEFAULT_DURATION_SECONDS_PER_CREDIT } })],
            });
            bAddedAnyRule = true;
        }

        if (!this.#taskRules["ENHANCE_IMAGES"])
        {
            this.#taskRules["ENHANCE_IMAGES"] = new CreditSpendRule
            ({
                enabled: true,
                deductionTiming: creditDeductionTimings.ON_SUCCESS,
                minimumBalanceToRun: CreditConfiguration.GENERATION_DEFAULT_IMAGE_ENHANCEMENT_FLAT_COST,
                minimumBalanceFloor: 0,
                terms: [new CreditSpendTerm({ credits: CreditConfiguration.GENERATION_DEFAULT_IMAGE_ENHANCEMENT_FLAT_COST, divisors: {} })],
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
