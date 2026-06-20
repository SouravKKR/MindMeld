import { taskTypes } from "../../../Globals/Enumerations/TaskTypes.js";
import { creditCostDimensions } from "../../../Globals/Enumerations/CreditCostDimensions.js";
import { creditDeductionTimings } from "../../../Globals/Enumerations/CreditDeductionTimings.js";
import { creditEnforcementModes } from "../../../Globals/Enumerations/CreditEnforcementModes.js";
import { creditChargeCategories } from "../../../Globals/Enumerations/CreditChargeCategories.js";
import { creditAdminSections } from "../../../Globals/Enumerations/CreditAdminSections.js";
import { enumerationToTitleCase } from "../../../Globals/UtilityFunctions/EnumerationToTitleCase.js";

/**
 * CreditConfigEditor
 *
 * Self-contained admin editor for the global credit configuration. Loads
 * /Admin/Credits/Config, renders ONE section at a time (pricing & packs,
 * task rules, storage rules, milestones & global — selected via
 * showSection, driven by AdminCreditsTabs), and saves the whole document
 * back via /Admin/Credits/Config/Save.
 *
 * Editing strategy: the in-memory config object is the source of truth.
 * Plain numeric / select inputs are read back out of the DOM only when the
 * user clicks Save (or just before a structural add/remove or a section
 * switch re-renders), which avoids re-rendering — and losing input focus —
 * on every keystroke. Collection is section-safe: each list overwrite is
 * guarded on its container being mounted, so switching sections never wipes
 * the parts of the config that are currently off-screen.
 */
class CreditConfigEditor extends HTMLElement
{
    // Parameters offered per rule kind. Each term selects exactly one. FLAT is
    // a fixed charge (empty divisors); the rest charge per a metric divided by
    // the divisor. A parameter can be used by at most one term, so the number
    // of parameters caps the number of terms.
    static TASK_PARAMETERS = ["FLAT", "INPUT_TOKENS", "OUTPUT_TOKENS", "DURATION_SECONDS"];
    static STORAGE_PARAMETERS = ["FLAT", "STORAGE_MEGABYTES", "DURATION_SECONDS"];

    static #RULE_BULLETS = [
        `<li><strong>Enabled</strong> — when <em>on</em>, the service runs (charged per its terms). When <em>off</em>, the service is <em>denied</em> — the task is refused, not run for free. (Storage categories simply aren't billed when off.)</li>`,
        `<li><strong>Timing</strong> — when credits are deducted: <em>On start</em> (before the task runs — flat terms only), <em>At intervals</em> (periodically while it runs), <em>On success</em> (only if it completes), or <em>On any completion</em> (success or failure).</li>`,
        `<li><strong>Interval (seconds)</strong> — for <em>At intervals</em> timing only: how often to charge during a running task.</li>`,
        `<li><strong>Min balance to run</strong> — the user must already hold at least this many credits for the task to start. <em>0</em> = no entry requirement.</li>`,
        `<li><strong>Min balance floor</strong> — how far below zero this charge may push the balance. <em>0</em> = no negative allowed; a negative number = allowed down to that value; <em>blank</em> = unlimited.</li>`,
        `<li><strong>Cost terms</strong> — total cost is the sum of all terms, where each term = <em>Credits × (parameter amount ÷ divisor)</em>. Each term picks one parameter — <em>Flat</em> (fixed credits) or per <em>input tokens / output tokens / duration / storage</em> — and each parameter can be used by only one term.</li>`,
    ];

    static #PRICING_BULLETS = [
        `<li><strong>Per-currency pricing</strong> — what 1 credit costs a buyer, per currency. The <em>first</em> currency in the list is the base; every supported currency without an explicit price is auto-converted from the base using daily ECB rates at purchase time.</li>`,
        `<li><strong>Packs</strong> — preset quantities buyers can pick with one click. A pack's discount applies whenever the purchased quantity exactly equals the pack size; custom amounts are never discounted.</li>`,
        `<li><strong>Minimum purchase</strong> — the smallest credit quantity a buyer may order. Tiny orders are additionally raised to clear the payment provider's 1.00 minimum charge.</li>`,
    ];

    static #GLOBAL_BULLETS = [
        `<li><strong>Signup grant</strong> — credits granted once to every new user.</li>`,
        `<li><strong>Default enforcement</strong> — the balance-floor default applied to newly-created rules.</li>`,
        `<li><strong>Reward milestones</strong> — a one-time bonus granted when a user's lifetime spend crosses the threshold.</li>`,
    ];

    #config = null;
    #activeSection = creditAdminSections.PRICING_AND_PACKS;
    #supportedCurrencies = [];
    #effectivePricing = null;

    async connectedCallback()
    {
        this.innerHTML = `<div class="credit-editor-loading">Loading credit configuration…</div>`;

        try
        {
            const response = await fetch("/Admin/Credits/Config");
            if (!response.ok)
            {
                this.innerHTML = `<div class="credit-editor-error">Failed to load (HTTP ${response.status}).</div>`;
                return;
            }
            const responseJson = await response.json();
            this.#config = this.#normalizeConfig(responseJson.config || {});
            this.#supportedCurrencies = Array.isArray(responseJson.supportedCurrencies) ? responseJson.supportedCurrencies : [];
            this.#effectivePricing = responseJson.effectivePricing || null;
            this.#ensureAllRules();
            this.#render();
        }
        catch (loadError)
        {
            this.innerHTML = `<div class="credit-editor-error">${CreditConfigEditor.#escape(loadError.message)}</div>`;
        }
    }

    /**
     * Switches the rendered section. Pending DOM edits are collected into the
     * in-memory config first, so nothing typed is lost; Save always posts the
     * WHOLE config regardless of which section is visible.
     */
    showSection(sectionValue)
    {
        const targetSection = Number(sectionValue);

        if (!this.#config)
        {
            // Still loading — remember the choice; the post-load render uses it.
            this.#activeSection = targetSection;
            return;
        }

        if (targetSection === this.#activeSection)
        {
            return;
        }

        this.#collectFromDom();
        this.#activeSection = targetSection;
        this.#render();
    }

    #normalizeConfig(rawConfig)
    {
        const pricingEntries = [];
        const seenCurrencies = new Set();
        for (const rawEntry of (Array.isArray(rawConfig.creditPricing) ? rawConfig.creditPricing : []))
        {
            const currency = typeof rawEntry?.currency === "string" ? rawEntry.currency.trim().toUpperCase() : "";
            const pricePerCredit = CreditConfigEditor.#parseNumber(rawEntry?.pricePerCredit, 0);
            if (currency.length === 0 || seenCurrencies.has(currency))
            {
                continue;
            }
            seenCurrencies.add(currency);
            // Zero-price rows are kept here (the admin may still be typing);
            // the backend drops them on save.
            pricingEntries.push({ currency: currency, pricePerCredit: pricePerCredit < 0 ? 0 : pricePerCredit });
        }

        const packs = [];
        for (const rawPack of (Array.isArray(rawConfig.creditPacks) ? rawConfig.creditPacks : []))
        {
            const credits = Math.trunc(CreditConfigEditor.#parseNumber(rawPack?.credits, 0));
            let discountPercent = CreditConfigEditor.#parseNumber(rawPack?.discountPercent, 0);
            discountPercent = Math.min(100, Math.max(0, discountPercent));
            packs.push({ credits: credits < 0 ? 0 : credits, discountPercent: discountPercent });
        }

        const minimumPurchaseCredits = Math.trunc(CreditConfigEditor.#parseNumber(rawConfig.minimumPurchaseCredits, 1));

        return {
            taskRules: rawConfig.taskRules && typeof rawConfig.taskRules === "object" ? rawConfig.taskRules : {},
            storageRules: rawConfig.storageRules && typeof rawConfig.storageRules === "object" ? rawConfig.storageRules : {},
            rewardMilestones: Array.isArray(rawConfig.rewardMilestones) ? rawConfig.rewardMilestones : [],
            creditPricing: pricingEntries,
            creditPacks: packs,
            minimumPurchaseCredits: minimumPurchaseCredits < 1 ? 1 : minimumPurchaseCredits,
            defaultEnforcementMode: typeof rawConfig.defaultEnforcementMode === "number" ? rawConfig.defaultEnforcementMode : creditEnforcementModes.ALLOW_NEGATIVE,
            signupGrant: typeof rawConfig.signupGrant === "number" ? rawConfig.signupGrant : 0,
            promoGrantAmount: typeof rawConfig.promoGrantAmount === "number" ? rawConfig.promoGrantAmount : 5,
            version: rawConfig.version || 1,
        };
    }

    /**
     * Seeds a default rule for every task type and storage category up front.
     * Rendering is sectioned, so this can no longer happen lazily at render
     * time — without it, saving from one section would persist a different
     * rule set than saving from another.
     */
    #ensureAllRules()
    {
        for (const taskTypeName of Object.keys(taskTypes).filter(name => taskTypes[name] !== taskTypes.UNKNOWN))
        {
            this.#ensureRule(this.#config.taskRules, taskTypeName);
        }
        for (const categoryName of Object.keys(creditChargeCategories).filter(name => creditChargeCategories[name] !== creditChargeCategories.UNKNOWN))
        {
            this.#ensureRule(this.#config.storageRules, categoryName);
        }
    }

    #defaultRule()
    {
        // Enabled by default so a freshly-saved config keeps every service
        // available (free, no terms). The admin disables a rule to DENY that
        // service and adds terms to charge for it.
        return { enabled: true, deductionTiming: creditDeductionTimings.ON_SUCCESS, intervalSeconds: 30, minimumBalanceToRun: 0, minimumBalanceFloor: 0, terms: [] };
    }

    #ensureRule(rulesMap, key)
    {
        if (!rulesMap[key] || typeof rulesMap[key] !== "object")
        {
            rulesMap[key] = this.#defaultRule();
        }
        const rule = rulesMap[key];
        if (!Array.isArray(rule.terms))
        {
            rule.terms = [];
        }
        // Collapse each term to a single parameter and drop duplicate
        // parameters so a stored config (or a legacy multi-divisor term) always
        // matches the one-parameter-per-term editing model.
        rule.terms = CreditConfigEditor.#normalizeTerms(rule.terms);
        return rule;
    }

    static #normalizeTerms(terms)
    {
        const seenParameters = new Set();
        const normalizedTerms = [];
        for (const term of terms)
        {
            const credits = CreditConfigEditor.#parseNumber(term.credits, 0);
            const parameter = CreditConfigEditor.#termParameter(term);
            if (seenParameters.has(parameter))
            {
                continue;
            }
            seenParameters.add(parameter);

            const divisors = {};
            if (parameter !== "FLAT")
            {
                const value = CreditConfigEditor.#parseNumber((term.divisors || {})[parameter], 1);
                divisors[parameter] = value > 0 ? value : 1;
            }
            normalizedTerms.push({ credits: credits, divisors: divisors });
        }
        return normalizedTerms;
    }

    #introBullets()
    {
        if (this.#activeSection === creditAdminSections.PRICING_AND_PACKS)
        {
            return CreditConfigEditor.#PRICING_BULLETS;
        }
        if (this.#activeSection === creditAdminSections.MILESTONES_AND_GLOBAL)
        {
            return CreditConfigEditor.#GLOBAL_BULLETS;
        }
        return CreditConfigEditor.#RULE_BULLETS;
    }

    #render()
    {
        this.innerHTML = `
            <style>
                credit-config-editor { display: block; padding: 2px 0 16px; color: var(--primary-text-color); }

                /* ── Intro / field legend ──────────────────────────────── */
                .credit-editor-intro
                {
                    background-color: var(--secondary-background-color);
                    border: 1px solid var(--outline-color-subtle);
                    border-left: 3px solid var(--accent-color);
                    border-radius: 8px;
                    padding: 14px 18px;
                    margin-bottom: 26px;
                }
                .credit-editor-intro-title
                {
                    font-size: 13px;
                    font-weight: 700;
                    color: var(--primary-text-color);
                    margin-bottom: 10px;
                }
                .credit-editor-intro-list
                {
                    margin: 0;
                    padding-left: 18px;
                    display: flex;
                    flex-direction: column;
                    gap: 6px;
                    font-size: 12.5px;
                    line-height: 1.5;
                    color: var(--secondary-text-color);
                }
                .credit-editor-intro-list strong { color: var(--primary-text-color); font-weight: 600; }
                .credit-editor-intro-list em { color: var(--accent-color); font-style: normal; }

                .credit-editor-section { margin-bottom: 28px; }
                .credit-editor-section:last-of-type { margin-bottom: 0; }
                .credit-editor-section-title
                {
                    font-size: 12px;
                    font-weight: 700;
                    text-transform: uppercase;
                    letter-spacing: 0.07em;
                    color: var(--secondary-text-color);
                    margin: 0 0 14px;
                    padding-bottom: 8px;
                    border-bottom: 1px solid var(--outline-color-subtle);
                }

                /* ── Cards ─────────────────────────────────────────────── */
                .credit-rule-card
                {
                    background-color: var(--secondary-background-color);
                    border: 1px solid var(--outline-color-subtle);
                    border-radius: 10px;
                    padding: 16px 18px;
                    margin-bottom: 12px;
                }
                .credit-rule-card:last-child { margin-bottom: 0; }

                .credit-rule-header
                {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 12px;
                    margin-bottom: 16px;
                }
                .credit-rule-name
                {
                    font-family: monospace;
                    font-weight: 700;
                    font-size: 13px;
                    color: var(--primary-text-color);
                    word-break: break-word;
                }
                .credit-rule-enabled
                {
                    display: inline-flex;
                    align-items: center;
                    gap: 8px;
                    flex-shrink: 0;
                    font-size: 13px;
                    color: var(--secondary-text-color);
                    cursor: pointer;
                }
                .credit-rule-enabled input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; margin: 0; }

                /* ── Field (stacked label over input) ──────────────────── */
                .credit-rule-controls
                {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 14px 18px;
                }
                .credit-field
                {
                    display: flex;
                    flex-direction: column;
                    gap: 6px;
                    font-size: 11px;
                    text-transform: uppercase;
                    letter-spacing: 0.04em;
                    color: var(--secondary-text-color);
                }

                /* ── Inputs / selects (distinct background) ────────────── */
                .credit-input, .credit-select
                {
                    padding: 8px 10px;
                    border-radius: 6px;
                    border: none;
                    outline: 1px solid var(--outline-color);
                    outline-offset: -1px;
                    background-color: var(--tertiary-background-color);
                    color: var(--primary-text-color);
                    font-family: inherit;
                    font-size: 13px;
                    text-transform: none;
                    letter-spacing: normal;
                    box-sizing: border-box;
                }
                .credit-input:focus, .credit-select:focus { outline-color: var(--outline-color-strong); }
                .credit-input { width: 132px; }
                .credit-select { min-width: 184px; }
                .credit-static-value
                {
                    padding: 8px 10px;
                    border-radius: 6px;
                    background-color: var(--tertiary-background-color);
                    color: var(--secondary-text-color);
                    font-size: 13px;
                    min-width: 60px;
                }

                /* ── Terms ─────────────────────────────────────────────── */
                .credit-terms { margin-top: 16px; }
                .credit-terms-label
                {
                    font-size: 11px;
                    font-weight: 600;
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                    color: var(--secondary-text-color);
                    margin-bottom: 10px;
                }
                .credit-term-row, .credit-milestone-row
                {
                    display: flex;
                    flex-wrap: wrap;
                    align-items: flex-end;
                    gap: 12px 16px;
                    padding: 12px 14px;
                    margin-bottom: 8px;
                    border-radius: 8px;
                    background-color: var(--primary-background-color);
                    outline: 1px solid var(--outline-color-subtle);
                    outline-offset: -1px;
                }
                .credit-term-row .credit-input { width: 116px; }
                .credit-terms-empty
                {
                    padding: 12px 14px;
                    margin-bottom: 8px;
                    border-radius: 8px;
                    background-color: var(--primary-background-color);
                    outline: 1px dashed var(--outline-color-subtle);
                    outline-offset: -1px;
                    color: var(--secondary-text-color);
                    font-size: 12px;
                    font-style: italic;
                }
                .credit-milestone-arrow
                {
                    align-self: center;
                    color: var(--secondary-text-color);
                    font-size: 16px;
                    padding-bottom: 8px;
                }
                .credit-term-remove
                {
                    margin-left: auto;
                    align-self: center;
                    width: 30px;
                    height: 30px;
                    flex-shrink: 0;
                    border: none;
                    border-radius: 6px;
                    outline: 1px solid var(--outline-color-strong);
                    outline-offset: -1px;
                    background-color: transparent;
                    color: var(--danger-text-color);
                    cursor: pointer;
                    font-size: 14px;
                    line-height: 1;
                }
                .credit-term-remove:hover { background-color: var(--danger-background-color); }

                /* ── Pricing & packs ───────────────────────────────────── */
                .credit-base-badge
                {
                    align-self: center;
                    padding: 4px 12px;
                    border-radius: 999px;
                    background: var(--primary-background-gradient);
                    color: var(--primary-text-color);
                    font-size: 11px;
                    font-weight: 700;
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                }
                .credit-make-base { align-self: center; padding: 7px 12px; font-size: 12px; }
                .credit-pricing-readout
                {
                    margin-top: 14px;
                    display: flex;
                    flex-direction: column;
                    gap: 6px;
                    font-size: 12.5px;
                    color: var(--secondary-text-color);
                }
                .credit-pricing-readout-note { font-style: italic; opacity: 0.8; }

                /* ── Buttons ───────────────────────────────────────────── */
                .credit-editor-button
                {
                    padding: 9px 16px;
                    border-radius: 8px;
                    border: none;
                    cursor: pointer;
                    background: var(--primary-background-gradient);
                    color: var(--primary-text-color);
                    font-weight: 600;
                    font-size: 13px;
                }
                .credit-editor-button-secondary
                {
                    background: transparent;
                    outline: 1px dashed var(--outline-color-strong);
                    outline-offset: -1px;
                    font-weight: 500;
                }
                .credit-editor-button-secondary:hover { background-color: var(--tertiary-background-color); }
                .credit-add-term { margin-top: 4px; }
                .credit-add-term:disabled { opacity: 0.4; cursor: not-allowed; }
                .credit-terms-note { margin-left: 10px; font-size: 12px; color: var(--secondary-text-color); }

                /* ── Save bar ──────────────────────────────────────────── */
                /* A normal in-flow action bar (mirrors the generation page) so
                   it never overlaps the fixed copyright stamp at the bottom. */
                .credit-editor-savebar
                {
                    display: flex;
                    gap: 14px;
                    align-items: center;
                    margin-top: 24px;
                    padding-top: 18px;
                    border-top: 1px solid var(--outline-color-subtle);
                }
                .credit-editor-status { font-size: 13px; color: var(--secondary-text-color); }
            </style>

            <div class="credit-editor-intro">
                <div class="credit-editor-intro-title">How this section works</div>
                <ul class="credit-editor-intro-list">
                    ${this.#introBullets().join("")}
                </ul>
            </div>

            ${this.#renderActiveSectionBlocks()}

            <div class="credit-editor-savebar">
                <button class="credit-editor-button" data-action="save">Save Configuration</button>
                <span class="credit-editor-status" data-role="status"></span>
            </div>
        `;

        this.#bindEvents();
        this.#updatePackPricePreviews();
    }

    #renderActiveSectionBlocks()
    {
        if (this.#activeSection === creditAdminSections.TASK_RULES)
        {
            const taskTypeNames = Object.keys(taskTypes).filter(name => taskTypes[name] !== taskTypes.UNKNOWN);
            return `
                <div class="credit-editor-section">
                    <div class="credit-editor-section-title">Agent Task Rules</div>
                    ${taskTypeNames.map(name => this.#renderRuleCard("task", name, this.#ensureRule(this.#config.taskRules, name), CreditConfigEditor.TASK_PARAMETERS)).join("")}
                </div>
            `;
        }

        if (this.#activeSection === creditAdminSections.STORAGE_RULES)
        {
            const storageCategoryNames = Object.keys(creditChargeCategories).filter(name => creditChargeCategories[name] !== creditChargeCategories.UNKNOWN);
            return `
                <div class="credit-editor-section">
                    <div class="credit-editor-section-title">Storage Categories</div>
                    ${storageCategoryNames.map(name => this.#renderRuleCard("storage", name, this.#ensureRule(this.#config.storageRules, name), CreditConfigEditor.STORAGE_PARAMETERS)).join("")}
                </div>
            `;
        }

        if (this.#activeSection === creditAdminSections.MILESTONES_AND_GLOBAL)
        {
            return `
                <div class="credit-editor-section">
                    <div class="credit-editor-section-title">Global Settings</div>
                    <div class="credit-rule-card">
                        <div class="credit-rule-controls">
                            <label class="credit-field">Signup grant (credits)
                                <input class="credit-input" type="number" step="any" data-global="signupGrant" value="${this.#config.signupGrant}">
                            </label>
                            <label class="credit-field">Promo grant amount (credits per redemption)
                                <input class="credit-input" type="number" step="any" data-global="promoGrantAmount" value="${this.#config.promoGrantAmount}">
                            </label>
                            <label class="credit-field">Default enforcement
                                <select class="credit-select" data-global="defaultEnforcementMode">
                                    ${this.#enforcementOptions(this.#config.defaultEnforcementMode)}
                                </select>
                            </label>
                            <div class="credit-field">Config version
                                <div class="credit-static-value">${this.#config.version}</div>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="credit-editor-section">
                    <div class="credit-editor-section-title">Reward Milestones (one-time)</div>
                    <div class="credit-rule-card" data-role="milestones">
                        <div data-role="milestone-list">
                            ${this.#config.rewardMilestones.map((milestone, index) => this.#renderMilestoneRow(milestone, index)).join("")}
                            ${this.#config.rewardMilestones.length === 0 ? `<div class="credit-terms-empty">No milestones configured.</div>` : ""}
                        </div>
                        <button class="credit-editor-button credit-editor-button-secondary credit-add-term" data-action="add-milestone">+ Add milestone</button>
                    </div>
                </div>
            `;
        }

        return this.#renderPricingSection() + this.#renderPacksSection();
    }

    /* ── Pricing & packs section ───────────────────────────────────────── */

    #renderPricingSection()
    {
        const usedCurrencies = this.#config.creditPricing.map(entry => entry.currency);
        const hasUnusedCurrency = this.#supportedCurrencies.some(currency => !usedCurrencies.includes(currency));

        return `
            <div class="credit-editor-section">
                <div class="credit-editor-section-title">Credit Pricing (per currency)</div>
                <div class="credit-rule-card">
                    <div class="credit-rule-controls" style="margin-bottom: 16px;">
                        <label class="credit-field">Minimum purchase (credits)
                            <input class="credit-input" type="number" step="1" min="1" data-global="minimumPurchaseCredits" value="${this.#config.minimumPurchaseCredits}">
                        </label>
                    </div>
                    <div data-role="pricing-list">
                        ${this.#config.creditPricing.map((entry, index) => this.#renderPricingRow(entry, index, usedCurrencies)).join("")}
                        ${this.#config.creditPricing.length === 0 ? `<div class="credit-terms-empty">No prices configured — credit purchases are unavailable until at least one currency has a price.</div>` : ""}
                    </div>
                    <button class="credit-editor-button credit-editor-button-secondary credit-add-term" data-action="add-currency" ${hasUnusedCurrency ? "" : "disabled"}>+ Add currency</button>
                    ${hasUnusedCurrency ? "" : `<span class="credit-terms-note">All supported currencies are priced.</span>`}
                    ${this.#renderEffectivePricingReadout(usedCurrencies)}
                </div>
            </div>
        `;
    }

    #renderPricingRow(entry, index, usedCurrencies)
    {
        // Options: every supported currency plus the row's own (in case a
        // stored config carries one outside the current supported set).
        const optionCurrencies = this.#supportedCurrencies.includes(entry.currency) || entry.currency === ""
            ? this.#supportedCurrencies
            : [entry.currency, ...this.#supportedCurrencies];

        const baseControl = index === 0
            ? `<span class="credit-base-badge" title="Unset currencies are auto-converted from this one">Base</span>`
            : `<button class="credit-editor-button credit-editor-button-secondary credit-make-base" data-action="make-base-currency" title="Make this the base currency">Make base</button>`;

        return `
            <div class="credit-term-row" data-pricing-index="${index}">
                <label class="credit-field">Currency
                    <select class="credit-select" data-pricing-field="currency">
                        ${optionCurrencies.map(currency =>
                        {
                            const isSelected = currency === entry.currency;
                            const isUsedElsewhere = usedCurrencies.includes(currency) && !isSelected;
                            return `<option value="${CreditConfigEditor.#escape(currency)}" ${isSelected ? "selected" : ""} ${isUsedElsewhere ? "disabled" : ""}>${CreditConfigEditor.#escape(currency)}</option>`;
                        }).join("")}
                    </select>
                </label>
                <label class="credit-field">Price for 1 credit${entry.currency ? ` (${CreditConfigEditor.#escape(entry.currency)})` : " (money)"}
                    <input class="credit-input" type="number" step="any" min="0" data-pricing-field="pricePerCredit" value="${entry.pricePerCredit}">
                </label>
                ${baseControl}
                <button class="credit-term-remove" data-action="remove-currency" title="Remove currency">✕</button>
            </div>
        `;
    }

    /**
     * Read-only effective prices for every supported currency WITHOUT an
     * explicit row — what buyers in those currencies actually pay, converted
     * server-side from the base. Values come from the last saved config, so
     * local unsaved edits are reflected only after a save.
     */
    #renderEffectivePricingReadout(usedCurrencies)
    {
        const unsetCurrencies = this.#supportedCurrencies.filter(currency => !usedCurrencies.includes(currency));
        if (unsetCurrencies.length === 0)
        {
            return "";
        }

        const localBaseCurrency = this.#config.creditPricing.length > 0 ? this.#config.creditPricing[0].currency : null;
        const savedBaseCurrency = this.#effectivePricing?.baseCurrency || localBaseCurrency;

        if (!localBaseCurrency)
        {
            return `
                <div class="credit-pricing-readout">
                    <span class="credit-pricing-readout-note">Add at least one currency to enable credit purchases — other currencies will auto-convert from it.</span>
                </div>
            `;
        }

        const readoutLines = unsetCurrencies.map(currency =>
        {
            const effectiveEntry = this.#effectivePricing?.prices?.find(price => price.currency === currency);
            if (effectiveEntry && effectiveEntry.converted && effectiveEntry.pricePerCredit !== null)
            {
                const roundedPrice = Math.round(effectiveEntry.pricePerCredit * 10000) / 10000;
                return `<span>${CreditConfigEditor.#escape(currency)} ≈ ${roundedPrice} / credit (auto-converted from ${CreditConfigEditor.#escape(savedBaseCurrency)})</span>`;
            }
            if (effectiveEntry && !effectiveEntry.explicit && effectiveEntry.pricePerCredit === null)
            {
                return `<span>${CreditConfigEditor.#escape(currency)} — FX rate unavailable; these buyers are charged in ${CreditConfigEditor.#escape(savedBaseCurrency)}</span>`;
            }
            return `<span>${CreditConfigEditor.#escape(currency)} — auto-converted from ${CreditConfigEditor.#escape(localBaseCurrency)} (value shown after save)</span>`;
        });

        return `
            <div class="credit-pricing-readout">
                ${readoutLines.join("")}
                <span class="credit-pricing-readout-note">Auto-converted values use the last saved configuration and daily ECB rates.</span>
            </div>
        `;
    }

    #renderPacksSection()
    {
        return `
            <div class="credit-editor-section">
                <div class="credit-editor-section-title">Credit Packs (discounted presets)</div>
                <div class="credit-rule-card">
                    <div data-role="pack-list">
                        ${this.#config.creditPacks.map((pack, index) => this.#renderPackRow(pack, index)).join("")}
                        ${this.#config.creditPacks.length === 0 ? `<div class="credit-terms-empty">No packs configured — buyers can still purchase custom amounts at the full unit price.</div>` : ""}
                    </div>
                    <button class="credit-editor-button credit-editor-button-secondary credit-add-term" data-action="add-pack">+ Add pack</button>
                </div>
            </div>
        `;
    }

    #renderPackRow(pack, index)
    {
        return `
            <div class="credit-term-row" data-pack-index="${index}">
                <label class="credit-field">Pack size (credits)
                    <input class="credit-input" type="number" step="1" min="1" data-pack-field="credits" value="${pack.credits}">
                </label>
                <label class="credit-field">Discount (%)
                    <input class="credit-input" type="number" step="any" min="0" max="100" data-pack-field="discountPercent" value="${pack.discountPercent}">
                </label>
                <div class="credit-field">Pack price (base currency)
                    <div class="credit-static-value" data-role="pack-price">—</div>
                </div>
                <button class="credit-term-remove" data-action="remove-pack" title="Remove pack">✕</button>
            </div>
        `;
    }

    /**
     * Recomputes every pack row's price preview from the CURRENT inputs (the
     * first pricing row is the live base). textContent-only updates — no
     * re-render, so typing never loses focus.
     */
    #updatePackPricePreviews()
    {
        const packRows = this.querySelectorAll('[data-pack-index]');
        if (packRows.length === 0)
        {
            return;
        }

        let baseCurrency = null;
        let basePricePerCredit = 0;
        const firstPricingRow = this.querySelector('[data-role="pricing-list"] [data-pricing-index="0"]');
        if (firstPricingRow)
        {
            baseCurrency = firstPricingRow.querySelector('[data-pricing-field="currency"]').value;
            basePricePerCredit = CreditConfigEditor.#parseNumber(firstPricingRow.querySelector('[data-pricing-field="pricePerCredit"]').value, 0);
        }

        for (const packRow of packRows)
        {
            const priceLabel = packRow.querySelector('[data-role="pack-price"]');
            const credits = CreditConfigEditor.#parseNumber(packRow.querySelector('[data-pack-field="credits"]').value, 0);
            let discountPercent = CreditConfigEditor.#parseNumber(packRow.querySelector('[data-pack-field="discountPercent"]').value, 0);
            discountPercent = Math.min(100, Math.max(0, discountPercent));

            if (!baseCurrency || basePricePerCredit <= 0 || credits <= 0)
            {
                priceLabel.textContent = "—";
                continue;
            }

            const packPrice = credits * basePricePerCredit * (1 - discountPercent / 100);
            const discountSuffix = discountPercent > 0 ? ` (−${discountPercent}%)` : "";
            priceLabel.textContent = `${baseCurrency} ${packPrice.toFixed(2)}${discountSuffix}`;
        }
    }

    /* ── Rule / milestone rendering (unchanged behavior) ───────────────── */

    #renderRuleCard(scope, key, rule, parameters)
    {
        const showInterval = rule.deductionTiming === creditDeductionTimings.AT_INTERVALS;
        const usedParameters = rule.terms.map(term => CreditConfigEditor.#termParameter(term));
        const canAddTerm = usedParameters.length < parameters.length;
        return `
            <div class="credit-rule-card" data-scope="${scope}" data-key="${key}">
                <div class="credit-rule-header">
                    <span class="credit-rule-name">${CreditConfigEditor.#escape(enumerationToTitleCase(key))}</span>
                    <label class="credit-rule-enabled"><input type="checkbox" data-field="enabled" ${rule.enabled ? "checked" : ""}> Enabled</label>
                </div>
                <div class="credit-rule-controls">
                    <label class="credit-field">Timing
                        <select class="credit-select" data-field="deductionTiming">${this.#timingOptions(rule.deductionTiming)}</select>
                    </label>
                    <label class="credit-field" data-role="interval-field" style="${showInterval ? "" : "display:none;"}">Interval (seconds)
                        <input class="credit-input" type="number" step="any" data-field="intervalSeconds" value="${rule.intervalSeconds}">
                    </label>
                    <label class="credit-field">Min balance to run (credits)
                        <input class="credit-input" type="number" step="any" data-field="minimumBalanceToRun" value="${rule.minimumBalanceToRun ?? 0}" placeholder="0">
                    </label>
                    <label class="credit-field">Min balance floor (credits)
                        <input class="credit-input" type="number" step="any" data-field="minimumBalanceFloor" value="${rule.minimumBalanceFloor === null ? "" : rule.minimumBalanceFloor}" placeholder="unlimited">
                    </label>
                </div>
                <div class="credit-terms">
                    <div class="credit-terms-label">Cost terms</div>
                    <div data-role="terms">
                        ${rule.terms.map((term, index) => this.#renderTermRow(term, index, parameters, usedParameters)).join("")}
                        ${rule.terms.length === 0 ? `<div class="credit-terms-empty">No terms — this rule charges nothing until a term is added.</div>` : ""}
                    </div>
                    <button class="credit-editor-button credit-editor-button-secondary credit-add-term" data-action="add-term" ${canAddTerm ? "" : "disabled"}>+ Add term</button>
                    ${canAddTerm ? "" : `<span class="credit-terms-note">All parameters are in use.</span>`}
                </div>
            </div>
        `;
    }

    #renderTermRow(term, index, parameters, usedParameters)
    {
        const currentParameter = CreditConfigEditor.#termParameter(term);
        const divisorValue = currentParameter === "FLAT" ? "" : (term.divisors[currentParameter] ?? "");
        const unitWords = currentParameter === "FLAT" ? "" : enumerationToTitleCase(currentParameter);
        return `
            <div class="credit-term-row" data-term-index="${index}">
                <label class="credit-field">Parameter
                    <select class="credit-select credit-term-parameter" data-term-field="parameter">
                        ${parameters.map(parameter =>
                        {
                            const isSelected = parameter === currentParameter;
                            const isUsedElsewhere = usedParameters.includes(parameter) && !isSelected;
                            return `<option value="${parameter}" ${isSelected ? "selected" : ""} ${isUsedElsewhere ? "disabled" : ""}>${CreditConfigEditor.#parameterLabel(parameter)}</option>`;
                        }).join("")}
                    </select>
                </label>
                <label class="credit-field">Credits to charge
                    <input class="credit-input" type="number" step="any" data-term-field="credits" value="${term.credits ?? 0}">
                </label>
                ${currentParameter !== "FLAT" ? `
                <label class="credit-field">Per this many ${CreditConfigEditor.#escape(unitWords.toLowerCase())}
                    <input class="credit-input" type="number" step="any" data-term-field="divisor" value="${divisorValue}" placeholder="1">
                </label>` : ""}
                <button class="credit-term-remove" data-action="remove-term" title="Remove term">✕</button>
            </div>
        `;
    }

    static #termParameter(term)
    {
        const divisorKeys = Object.keys(term.divisors || {});
        return divisorKeys.length > 0 ? divisorKeys[0] : "FLAT";
    }

    static #parameterLabel(parameter)
    {
        if (parameter === "FLAT")
        {
            return "Flat (fixed)";
        }
        return enumerationToTitleCase(parameter);
    }

    #renderMilestoneRow(milestone, index)
    {
        return `
            <div class="credit-milestone-row" data-milestone-index="${index}">
                <label class="credit-field">Spend threshold (lifetime credits)
                    <input class="credit-input" type="number" step="any" data-milestone-field="spendThreshold" value="${milestone.spendThreshold ?? 0}">
                </label>
                <span class="credit-milestone-arrow">→</span>
                <label class="credit-field">Reward (credits)
                    <input class="credit-input" type="number" step="any" data-milestone-field="rewardCredits" value="${milestone.rewardCredits ?? 0}">
                </label>
                <button class="credit-term-remove" data-action="remove-milestone" title="Remove milestone">✕</button>
            </div>
        `;
    }

    #timingOptions(selectedValue)
    {
        return Object.keys(creditDeductionTimings)
            .filter(name => creditDeductionTimings[name] !== creditDeductionTimings.UNKNOWN)
            .map(name => `<option value="${creditDeductionTimings[name]}" ${creditDeductionTimings[name] === selectedValue ? "selected" : ""}>${enumerationToTitleCase(name)}</option>`)
            .join("");
    }

    #enforcementOptions(selectedValue)
    {
        return Object.keys(creditEnforcementModes)
            .map(name => `<option value="${creditEnforcementModes[name]}" ${creditEnforcementModes[name] === selectedValue ? "selected" : ""}>${enumerationToTitleCase(name)}</option>`)
            .join("");
    }

    #bindEvents()
    {
        // Show/hide the interval field live when timing changes.
        for (const timingSelect of this.querySelectorAll('select[data-field="deductionTiming"]'))
        {
            timingSelect.addEventListener("change", (changeEvent) =>
            {
                const card = changeEvent.currentTarget.closest(".credit-rule-card");
                const intervalField = card.querySelector('[data-role="interval-field"]');
                if (intervalField)
                {
                    intervalField.style.display = Number(changeEvent.currentTarget.value) === creditDeductionTimings.AT_INTERVALS ? "" : "none";
                }
            });
        }

        // Changing a term's parameter re-renders so the divisor field toggles
        // (FLAT has none) and the other dropdowns / Add-term state update to
        // reflect which parameters are now free.
        for (const parameterSelect of this.querySelectorAll('select[data-term-field="parameter"]'))
        {
            parameterSelect.addEventListener("change", () =>
            {
                this.#collectFromDom();
                this.#render();
            });
        }

        // Changing a pricing row's currency re-renders so the other rows'
        // disabled options and the auto-converted readout stay accurate.
        for (const currencySelect of this.querySelectorAll('select[data-pricing-field="currency"]'))
        {
            currencySelect.addEventListener("change", () =>
            {
                this.#collectFromDom();
                this.#render();
            });
        }

        // Live pack-price previews: any pack input or the pricing inputs
        // update the computed spans only (no re-render — no focus loss).
        for (const previewInput of this.querySelectorAll('[data-pack-field], input[data-pricing-field="pricePerCredit"]'))
        {
            previewInput.addEventListener("input", () => this.#updatePackPricePreviews());
        }

        for (const button of this.querySelectorAll('[data-action]'))
        {
            button.addEventListener("click", (clickEvent) => this.#handleAction(clickEvent.currentTarget));
        }
    }

    #handleAction(button)
    {
        const action = button.dataset.action;

        if (action === "save")
        {
            this.#save();
            return;
        }

        // Structural changes: snapshot DOM → mutate model → re-render.
        this.#collectFromDom();

        if (action === "add-term")
        {
            const card = button.closest(".credit-rule-card");
            const rule = this.#ruleFromCard(card);
            const parameters = card.dataset.scope === "storage" ? CreditConfigEditor.STORAGE_PARAMETERS : CreditConfigEditor.TASK_PARAMETERS;
            const usedParameters = rule.terms.map(term => CreditConfigEditor.#termParameter(term));
            const nextParameter = parameters.find(parameter => !usedParameters.includes(parameter));
            if (nextParameter)
            {
                rule.terms.push(nextParameter === "FLAT" ? { credits: 0, divisors: {} } : { credits: 0, divisors: { [nextParameter]: 1 } });
            }
        }
        else if (action === "remove-term")
        {
            const card = button.closest(".credit-rule-card");
            const rule = this.#ruleFromCard(card);
            const termIndex = Number(button.closest(".credit-term-row").dataset.termIndex);
            rule.terms.splice(termIndex, 1);
        }
        else if (action === "add-milestone")
        {
            this.#config.rewardMilestones.push({ spendThreshold: 0, rewardCredits: 0 });
        }
        else if (action === "remove-milestone")
        {
            const milestoneIndex = Number(button.closest(".credit-milestone-row").dataset.milestoneIndex);
            this.#config.rewardMilestones.splice(milestoneIndex, 1);
        }
        else if (action === "add-currency")
        {
            const usedCurrencies = this.#config.creditPricing.map(entry => entry.currency);
            const nextCurrency = this.#supportedCurrencies.find(currency => !usedCurrencies.includes(currency));
            if (nextCurrency)
            {
                this.#config.creditPricing.push({ currency: nextCurrency, pricePerCredit: 0 });
            }
        }
        else if (action === "remove-currency")
        {
            const pricingIndex = Number(button.closest(".credit-term-row").dataset.pricingIndex);
            this.#config.creditPricing.splice(pricingIndex, 1);
        }
        else if (action === "make-base-currency")
        {
            const pricingIndex = Number(button.closest(".credit-term-row").dataset.pricingIndex);
            const [promotedEntry] = this.#config.creditPricing.splice(pricingIndex, 1);
            if (promotedEntry)
            {
                this.#config.creditPricing.unshift(promotedEntry);
            }
        }
        else if (action === "add-pack")
        {
            this.#config.creditPacks.push({ credits: 0, discountPercent: 0 });
        }
        else if (action === "remove-pack")
        {
            const packIndex = Number(button.closest(".credit-term-row").dataset.packIndex);
            this.#config.creditPacks.splice(packIndex, 1);
        }

        this.#render();
    }

    #ruleFromCard(card)
    {
        const scope = card.dataset.scope;
        const key = card.dataset.key;
        const rulesMap = scope === "storage" ? this.#config.storageRules : this.#config.taskRules;
        return this.#ensureRule(rulesMap, key);
    }

    /**
     * Reads every MOUNTED input back into this.#config so the in-memory model
     * matches what the user sees before a save, a structural re-render or a
     * section switch. Rendering is sectioned, so every list overwrite is
     * guarded on its container's presence — collecting while a section is
     * off-screen must never wipe that section's data.
     */
    #collectFromDom()
    {
        const signupGrantInput = this.querySelector('[data-global="signupGrant"]');
        if (signupGrantInput)
        {
            this.#config.signupGrant = CreditConfigEditor.#parseNumber(signupGrantInput.value, 0);
        }
        const promoGrantAmountInput = this.querySelector('[data-global="promoGrantAmount"]');
        if (promoGrantAmountInput)
        {
            this.#config.promoGrantAmount = CreditConfigEditor.#parseNumber(promoGrantAmountInput.value, 0);
        }
        const enforcementSelect = this.querySelector('[data-global="defaultEnforcementMode"]');
        if (enforcementSelect)
        {
            this.#config.defaultEnforcementMode = Number(enforcementSelect.value);
        }
        const minimumPurchaseInput = this.querySelector('[data-global="minimumPurchaseCredits"]');
        if (minimumPurchaseInput)
        {
            const minimumPurchaseCredits = Math.trunc(CreditConfigEditor.#parseNumber(minimumPurchaseInput.value, 1));
            this.#config.minimumPurchaseCredits = minimumPurchaseCredits < 1 ? 1 : minimumPurchaseCredits;
        }

        for (const card of this.querySelectorAll('.credit-rule-card[data-scope]'))
        {
            const rule = this.#ruleFromCard(card);
            rule.enabled = card.querySelector('[data-field="enabled"]').checked;
            rule.deductionTiming = Number(card.querySelector('[data-field="deductionTiming"]').value);
            rule.intervalSeconds = CreditConfigEditor.#parseNumber(card.querySelector('[data-field="intervalSeconds"]').value, 30);
            rule.minimumBalanceToRun = CreditConfigEditor.#parseNumber(card.querySelector('[data-field="minimumBalanceToRun"]').value, 0);

            const floorRaw = card.querySelector('[data-field="minimumBalanceFloor"]').value;
            rule.minimumBalanceFloor = floorRaw.trim() === "" ? null : CreditConfigEditor.#parseNumber(floorRaw, 0);

            const terms = [];
            for (const termRow of card.querySelectorAll('.credit-term-row'))
            {
                const credits = CreditConfigEditor.#parseNumber(termRow.querySelector('[data-term-field="credits"]').value, 0);
                const parameterSelect = termRow.querySelector('[data-term-field="parameter"]');
                const parameter = parameterSelect ? parameterSelect.value : "FLAT";

                const divisors = {};
                if (parameter !== "FLAT")
                {
                    const divisorInput = termRow.querySelector('[data-term-field="divisor"]');
                    let divisorValue = divisorInput ? CreditConfigEditor.#parseNumber(divisorInput.value, 1) : 1;
                    // A selected parameter must keep a positive divisor or the
                    // backend would drop it (and divide-by-zero is meaningless),
                    // so an empty / non-positive entry falls back to 1.
                    if (!(divisorValue > 0))
                    {
                        divisorValue = 1;
                    }
                    divisors[parameter] = divisorValue;
                }
                terms.push({ credits: credits, divisors: divisors });
            }
            rule.terms = terms;
        }

        const milestoneList = this.querySelector('[data-role="milestone-list"]');
        if (milestoneList)
        {
            const milestones = [];
            for (const milestoneRow of milestoneList.querySelectorAll('.credit-milestone-row'))
            {
                milestones.push({
                    spendThreshold: CreditConfigEditor.#parseNumber(milestoneRow.querySelector('[data-milestone-field="spendThreshold"]').value, 0),
                    rewardCredits: CreditConfigEditor.#parseNumber(milestoneRow.querySelector('[data-milestone-field="rewardCredits"]').value, 0),
                });
            }
            this.#config.rewardMilestones = milestones;
        }

        const pricingList = this.querySelector('[data-role="pricing-list"]');
        if (pricingList)
        {
            const pricingEntries = [];
            const seenCurrencies = new Set();
            for (const pricingRow of pricingList.querySelectorAll('[data-pricing-index]'))
            {
                const currency = pricingRow.querySelector('[data-pricing-field="currency"]').value.trim().toUpperCase();
                const pricePerCredit = CreditConfigEditor.#parseNumber(pricingRow.querySelector('[data-pricing-field="pricePerCredit"]').value, 0);
                if (currency.length === 0 || seenCurrencies.has(currency))
                {
                    continue;
                }
                seenCurrencies.add(currency);
                pricingEntries.push({ currency: currency, pricePerCredit: pricePerCredit < 0 ? 0 : pricePerCredit });
            }
            this.#config.creditPricing = pricingEntries;
        }

        const packList = this.querySelector('[data-role="pack-list"]');
        if (packList)
        {
            const packs = [];
            for (const packRow of packList.querySelectorAll('[data-pack-index]'))
            {
                const credits = Math.trunc(CreditConfigEditor.#parseNumber(packRow.querySelector('[data-pack-field="credits"]').value, 0));
                let discountPercent = CreditConfigEditor.#parseNumber(packRow.querySelector('[data-pack-field="discountPercent"]').value, 0);
                discountPercent = Math.min(100, Math.max(0, discountPercent));
                packs.push({ credits: credits < 0 ? 0 : credits, discountPercent: discountPercent });
            }
            this.#config.creditPacks = packs;
        }
    }

    async #save()
    {
        this.#collectFromDom();

        const statusLabel = this.querySelector('[data-role="status"]');
        if (statusLabel)
        {
            statusLabel.textContent = "Saving…";
        }

        try
        {
            const response = await fetch("/Admin/Credits/Config/Save", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ config: this.#config }),
            });

            if (!response.ok)
            {
                if (statusLabel)
                {
                    statusLabel.textContent = `Save failed (HTTP ${response.status}).`;
                }
                return;
            }

            const responseJson = await response.json();
            this.#config = this.#normalizeConfig(responseJson.config || this.#config);
            if (Array.isArray(responseJson.supportedCurrencies))
            {
                this.#supportedCurrencies = responseJson.supportedCurrencies;
            }
            if (responseJson.effectivePricing)
            {
                this.#effectivePricing = responseJson.effectivePricing;
            }
            this.#ensureAllRules();
            this.#render();
            const refreshedStatus = this.querySelector('[data-role="status"]');
            if (refreshedStatus)
            {
                refreshedStatus.textContent = `Saved. Version ${this.#config.version}.`;
            }
        }
        catch (saveError)
        {
            if (statusLabel)
            {
                statusLabel.textContent = saveError.message;
            }
        }
    }

    static #parseNumber(value, fallback)
    {
        const parsed = parseFloat(value);
        return isNaN(parsed) ? fallback : parsed;
    }

    static #escape(text)
    {
        const div = document.createElement("div");
        div.textContent = String(text ?? "");
        return div.innerHTML;
    }
}

customElements.define("credit-config-editor", CreditConfigEditor);
export default CreditConfigEditor;
