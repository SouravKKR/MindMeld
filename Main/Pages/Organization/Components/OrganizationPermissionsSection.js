import OrganizationErrorMessages from "../../../Globals/Classes/Organization/OrganizationErrorMessages.js";
import PlanFeatureCatalogue from "../../../Globals/Classes/Organization/PlanFeatureCatalogue.js";
import FeatureCheckboxList from "../../../Globals/Classes/Organization/FeatureCheckboxList.js";
import MemberConditionPanel from "../../../Globals/Classes/Organization/MemberConditionPanel.js";
import RuleMatchPreviewDialog from "./RuleMatchPreviewDialog.js";
import { getRandomUuid } from "../../../Globals/UtilityFunctions/GetRandomUuid.js";
import { organizationDelegatePowers } from "../../../Globals/Enumerations/OrganizationDelegatePowers.js";
import { tagMatchModes } from "../../../Globals/Enumerations/TagMatchModes.js";

/**
 * OrganizationPermissionsSection
 *
 * What members can do inside this organization's view, expressed as rules over
 * tags and over the institute's own columns rather than over people.
 * "Final-year students get mock-test evaluation" survives a new intake; "these
 * 400 email addresses get mock-test evaluation" does not.
 *
 * A rule can name any column the institute uploads — a joining year, a role, a
 * section — using the same controls, over the same fields, as the roster's own
 * filters. That is deliberate reuse rather than convenience: it means "who this
 * rule covers" and "who this filter shows" cannot come to mean different things.
 *
 * Because a rule that combines several of those is no longer readable at a
 * glance, each one can say who it currently covers before it is saved. The
 * mistake that guards against is the expensive one — a condition looser than
 * intended handing a paid feature to the entire roster.
 *
 * A member matching several rules receives the UNION of their features and the
 * LARGEST of their storage grants, which is stated on screen because the
 * alternative reading — last rule wins — is the one an administrator would
 * otherwise assume and be wrong about.
 *
 * Two things are deliberately shown but not editable. The Free-tier features
 * appear ticked and disabled: every account has them, so an organization can
 * neither grant nor withhold them. Features outside what this organization was
 * sold appear unticked and disabled with the reason, rather than hidden — an
 * administrator looking for "generate with AI" should find out that it is not
 * part of their agreement, not conclude the product does not have it.
 *
 * A third thing is stated and not editable at all: the OWNER's own access,
 * which comes from the platform rather than from any rule here. See
 * #buildOwnerNoticeMarkup.
 */
class OrganizationPermissionsSection extends HTMLElement
{
    static #BYTES_PER_MEGABYTE = 1024 * 1024;

    #organizationId = "";
    #authority = null;
    #onChanged = null;

    #rules = [];
    #availableTags = [];
    #conditionFilters = [];
    #conditionPanelsByRuleId = new Map();
    #grantableFeatures = [];
    #alwaysIncludedFeatures = [];
    #adminAllowedFeatures = [];
    #bIsOwner = false;
    #maximumStorageGrantBytes = 0;

    initialize(context)
    {
        this.#organizationId = context.organizationId;
        this.#authority = context.authority;
        this.#onChanged = typeof context.onChanged === "function" ? context.onChanged : () => {};
    }

    async connectedCallback()
    {
        this.innerHTML = `<p class="admin-panel-add-subtitle">Loading permissions…</p>`;
        await this.#loadAndRender();
    }

    #mayEdit()
    {
        const heldPowers = Number.isInteger(this.#authority?.delegatePowers) ? this.#authority.delegatePowers : 0;
        return (heldPowers & organizationDelegatePowers.SET_PERMISSIONS) === organizationDelegatePowers.SET_PERMISSIONS;
    }

    async #loadAndRender()
    {
        let responseJson = null;
        let statusCode = 0;

        try
        {
            const response = await fetch(`/Organization/Permissions?organizationId=${encodeURIComponent(this.#organizationId)}`);
            statusCode = response.status;
            responseJson = await response.json().catch(() => ({}));

            if (!response.ok || responseJson.success === false)
            {
                this.innerHTML = `<div class="admin-panel-add-error"></div>`;
                this.querySelector(".admin-panel-add-error").textContent = OrganizationErrorMessages.describe(responseJson.error, statusCode);
                return;
            }
        }
        catch (loadError)
        {
            this.innerHTML = `<div class="admin-panel-add-error"></div>`;
            this.querySelector(".admin-panel-add-error").textContent = loadError.message || "Could not load permissions.";
            return;
        }

        this.#rules = Array.isArray(responseJson.rules) ? responseJson.rules : [];
        this.#availableTags = Array.isArray(responseJson.availableTags) ? responseJson.availableTags : [];
        this.#conditionFilters = Array.isArray(responseJson.conditionFilters) ? responseJson.conditionFilters : [];
        this.#grantableFeatures = Array.isArray(responseJson.grantableFeatures) ? responseJson.grantableFeatures : [];
        this.#alwaysIncludedFeatures = Array.isArray(responseJson.alwaysIncludedFeatures) ? responseJson.alwaysIncludedFeatures : [];
        this.#adminAllowedFeatures = Array.isArray(responseJson.adminAllowedFeatures) ? responseJson.adminAllowedFeatures : [];
        this.#bIsOwner = responseJson.isOwner === true;
        this.#maximumStorageGrantBytes = Number(responseJson.maxStorageGrantBytesPerMember) || 0;

        this.#render();
    }

    #render()
    {
        const bMayEdit = this.#mayEdit();

        this.innerHTML = `
            <div class="organization-section-header">
                <h2 class="organization-section-title">Permissions</h2>
                <p class="admin-panel-add-subtitle">
                    Rules decide what members can do while they are viewing as this organization.
                    A member matching more than one rule gets everything those rules allow, and the
                    largest storage grant among them. Nothing here changes anyone's own plan.
                </p>
            </div>

            ${this.#buildOwnerNoticeMarkup()}

            <div class="organization-permission-rules" data-role="rules"></div>

            ${bMayEdit ? `
                <div class="organization-section-actions">
                    <button type="button" class="organization-secondary-button" data-role="add-rule">Add a rule</button>
                    <button type="button" class="admin-panel-add-submit" data-role="save">Save permissions</button>
                </div>
                <p class="organization-action-status organization-action-status-failure" data-role="error" hidden></p>
                <p class="organization-action-status organization-action-status-success" data-role="success" hidden></p>
            ` : `
                <p class="admin-panel-add-subtitle">You can see these rules but not change them. Ask the organization's owner for the permission to set permissions.</p>
            `}
        `;

        this.#renderRules();

        if (!bMayEdit)
        {
            return;
        }

        this.querySelector('[data-role="add-rule"]').addEventListener("click", () =>
        {
            this.#rules.push
            ({
                id: getRandomUuid(),
                organizationId: this.#organizationId,
                name: `Rule ${this.#rules.length + 1}`,
                tagFilter: [],
                matchMode: tagMatchModes.EVERYONE,
                attributeConditions: [],
                allowedFeatures: [],
                storageGrantBytes: 0
            });
            this.#renderRules();
        });

        this.querySelector('[data-role="save"]').addEventListener("click", (clickEvent) =>
        {
            this.#save(clickEvent.currentTarget);
        });
    }

    /**
     * What the OWNER holds here regardless of the rules.
     *
     * The owner is not necessarily on their own roster, so no rule below
     * describes their access and there is nowhere else on the page it is
     * explained. Without this line the person with the widest access is the one
     * person the screen tells nothing — and the reasonable response to that is
     * to write themselves a rule they do not need, or to conclude the feature
     * they are using is broken because no rule grants it.
     *
     * Rendered only for the owner: a delegate reading the same screen would be
     * told about capability that is not theirs.
     */
    #buildOwnerNoticeMarkup()
    {
        if (!this.#bIsOwner)
        {
            return "";
        }

        const grantedLabels = this.#adminAllowedFeatures.map(featureValue => PlanFeatureCatalogue.getLabel(featureValue));

        if (grantedLabels.length === 0)
        {
            return `
                <p class="admin-panel-add-subtitle organization-owner-grant-note">
                    As the owner you currently have only the features every account has while viewing as
                    this organization. Ask CogniumLearn to widen that — the rules below decide what your
                    members can do, not what you can.
                </p>
            `;
        }

        return `
            <p class="admin-panel-add-subtitle organization-owner-grant-note">
                As the owner you have <strong>${grantedLabels.join(", ")}</strong> while viewing as this
                organization, whatever the rules below say. CogniumLearn sets that, so you never need a
                rule for yourself — the rules below are for your members.
            </p>
        `;
    }

    #renderRules()
    {
        const rulesHost = this.querySelector('[data-role="rules"]');
        rulesHost.innerHTML = "";

        // Dropped with the DOM they were bound to. Keeping them would leave the
        // save path reading conditions out of panels whose inputs are detached,
        // which reads as a rule that quietly lost its conditions.
        this.#conditionPanelsByRuleId.clear();

        if (this.#rules.length === 0)
        {
            const emptyElement = document.createElement("p");
            emptyElement.className = "admin-panel-add-subtitle";
            emptyElement.textContent = "No rules yet. Until one is added, members get the same features every free account has.";
            rulesHost.appendChild(emptyElement);
            return;
        }

        this.#rules.forEach((rule, ruleIndex) =>
        {
            rulesHost.appendChild(this.#buildRuleCard(rule, ruleIndex));
        });
    }

    #buildRuleCard(rule, ruleIndex)
    {
        const bMayEdit = this.#mayEdit();
        const cardElement = document.createElement("div");
        cardElement.className = "organization-permission-rule";

        cardElement.innerHTML = `
            <div class="organization-permission-rule-header">
                <label class="admin-panel-add-field">
                    <span>Rule name</span>
                    <input type="text" data-role="name" maxlength="256" ${bMayEdit ? "" : "disabled"}>
                </label>
                ${bMayEdit ? `<button type="button" class="organization-secondary-button" data-role="remove">Remove</button>` : ""}
            </div>

            <label class="admin-panel-add-field">
                <span>Applies to</span>
                <select data-role="match-mode" ${bMayEdit ? "" : "disabled"}>
                    <option value="${tagMatchModes.EVERYONE}">Every member</option>
                    <option value="${tagMatchModes.ANY}">Members with any of the selected tags</option>
                    <option value="${tagMatchModes.ALL}">Members with all of the selected tags</option>
                </select>
            </label>

            <div class="organization-permission-rule-tags" data-role="tags"></div>

            <div class="organization-permission-rule-conditions">
                <span class="organization-permission-conditions-title">Narrow it further by your own columns</span>
                <p class="organization-permission-rule-hint">Every condition set here must also be true. Leave one blank to ignore it.</p>
                <div class="organization-condition-panel" data-role="conditions"></div>
            </div>

            <div class="organization-permission-rule-features" data-role="features"></div>

            <label class="admin-panel-add-field">
                <span>Extra storage for each matching member (MB)</span>
                <input type="number" min="0" step="1" data-role="storage" ${bMayEdit ? "" : "disabled"}>
                <small class="organization-permission-rule-hint" data-role="storage-hint"></small>
            </label>

            <div class="organization-permission-rule-footer">
                <button type="button" class="organization-secondary-button" data-role="preview">Show who this matches</button>
            </div>
        `;

        const nameInput = cardElement.querySelector('[data-role="name"]');
        nameInput.value = rule.name || "";
        nameInput.addEventListener("input", () => { rule.name = nameInput.value; });

        const matchModeSelect = cardElement.querySelector('[data-role="match-mode"]');
        matchModeSelect.value = String(rule.matchMode);
        matchModeSelect.addEventListener("change", () =>
        {
            rule.matchMode = Number(matchModeSelect.value);
            this.#renderTagPickers(cardElement, rule);
        });

        const storageInput = cardElement.querySelector('[data-role="storage"]');
        storageInput.value = String(Math.round((Number(rule.storageGrantBytes) || 0) / OrganizationPermissionsSection.#BYTES_PER_MEGABYTE));
        storageInput.addEventListener("input", () =>
        {
            const megabytes = Math.max(0, Math.floor(Number(storageInput.value) || 0));
            rule.storageGrantBytes = megabytes * OrganizationPermissionsSection.#BYTES_PER_MEGABYTE;
        });

        const storageHint = cardElement.querySelector('[data-role="storage-hint"]');
        storageHint.textContent = this.#maximumStorageGrantBytes > 0
            ? `Up to ${Math.round(this.#maximumStorageGrantBytes / OrganizationPermissionsSection.#BYTES_PER_MEGABYTE)} MB per member is available under this organization's agreement.`
            : "This organization's agreement does not include storage grants, so this stays at zero.";
        if (this.#maximumStorageGrantBytes <= 0)
        {
            storageInput.disabled = true;
        }

        const removeButton = cardElement.querySelector('[data-role="remove"]');
        if (removeButton)
        {
            removeButton.addEventListener("click", () =>
            {
                this.#rules.splice(ruleIndex, 1);
                this.#renderRules();
            });
        }

        const previewButton = cardElement.querySelector('[data-role="preview"]');
        previewButton.addEventListener("click", () =>
        {
            RuleMatchPreviewDialog.show
            ({
                organizationId: this.#organizationId,
                ruleName: rule.name,
                tagFilter: Array.isArray(rule.tagFilter) ? rule.tagFilter : [],
                matchMode: Number(rule.matchMode),
                // Read from the panel rather than from the saved rule, so the
                // preview answers for what is on screen now — including edits
                // that have not been saved yet, which is exactly when an
                // administrator most needs to know who they just included.
                attributeConditions: this.#collectConditionsForRule(rule)
            });
        });

        this.#renderTagPickers(cardElement, rule);
        this.#renderConditionPanel(cardElement, rule);
        this.#renderFeatureMatrix(cardElement, rule);

        return cardElement;
    }

    /**
     * The condition builder for one rule, rendered from the roster's own filter
     * metadata so a rule gains a control for every column this institute keeps.
     */
    #renderConditionPanel(cardElement, rule)
    {
        const conditionsHost = cardElement.querySelector('[data-role="conditions"]');
        const conditionPanel = new MemberConditionPanel(conditionsHost, () =>
        {
            rule.attributeConditions = conditionPanel.getConditions();
        });

        conditionPanel.render(this.#conditionFilters, rule.attributeConditions, !this.#mayEdit());
        this.#conditionPanelsByRuleId.set(rule.id, conditionPanel);
    }

    #collectConditionsForRule(rule)
    {
        const conditionPanel = this.#conditionPanelsByRuleId.get(rule.id);
        if (conditionPanel)
        {
            return conditionPanel.getConditions();
        }

        return Array.isArray(rule.attributeConditions) ? rule.attributeConditions : [];
    }

    #renderTagPickers(cardElement, rule)
    {
        const tagsHost = cardElement.querySelector('[data-role="tags"]');
        tagsHost.innerHTML = "";

        if (Number(rule.matchMode) === tagMatchModes.EVERYONE)
        {
            const noticeElement = document.createElement("p");
            noticeElement.className = "admin-panel-add-subtitle";
            noticeElement.textContent = "This rule applies to every member, so no tags are needed.";
            tagsHost.appendChild(noticeElement);
            return;
        }

        if (this.#availableTags.length === 0)
        {
            const noticeElement = document.createElement("p");
            noticeElement.className = "admin-panel-add-subtitle";
            noticeElement.textContent = "No tags exist yet. Import members with a tags column first, then come back.";
            tagsHost.appendChild(noticeElement);
            return;
        }

        const selectedTags = new Set(Array.isArray(rule.tagFilter) ? rule.tagFilter : []);

        for (const tag of this.#availableTags)
        {
            const tagLabel = document.createElement("label");
            tagLabel.className = "organization-permission-tag";

            const tagCheckbox = document.createElement("input");
            tagCheckbox.type = "checkbox";
            tagCheckbox.checked = selectedTags.has(tag);
            tagCheckbox.disabled = !this.#mayEdit();
            tagCheckbox.addEventListener("change", () =>
            {
                if (tagCheckbox.checked)
                {
                    selectedTags.add(tag);
                }
                else
                {
                    selectedTags.delete(tag);
                }
                rule.tagFilter = Array.from(selectedTags);
            });

            const tagText = document.createElement("span");
            tagText.textContent = tag;

            tagLabel.appendChild(tagCheckbox);
            tagLabel.appendChild(tagText);
            tagsHost.appendChild(tagLabel);
        }
    }

    #renderFeatureMatrix(cardElement, rule)
    {
        const grantableFeatureSet = new Set(this.#grantableFeatures);
        const selectedFeatures = new Set(Array.isArray(rule.allowedFeatures) ? rule.allowedFeatures : []);

        // Everything the catalogue knows about that this organization was not
        // sold. Shown disabled with the reason rather than hidden — an
        // administrator looking for "generate with AI" should find out that it
        // is not part of their agreement, not conclude the product lacks it.
        const unavailableFeatureValues = new Set
        (
            PlanFeatureCatalogue.getAllFeatureValues().filter(featureValue => !grantableFeatureSet.has(featureValue))
        );

        FeatureCheckboxList.render(cardElement.querySelector('[data-role="features"]'),
        {
            selectedFeatureValues: selectedFeatures,
            forcedFeatureValues: new Set(this.#alwaysIncludedFeatures),
            unavailableFeatureValues: unavailableFeatureValues,
            bReadOnly: !this.#mayEdit(),
            onChanged: () =>
            {
                rule.allowedFeatures = Array.from(selectedFeatures);
            }
        });
    }

    async #save(saveButton)
    {
        const errorElement = this.querySelector('[data-role="error"]');
        const successElement = this.querySelector('[data-role="success"]');
        errorElement.hidden = true;
        successElement.hidden = true;

        for (const rule of this.#rules)
        {
            if (typeof rule.name !== "string" || rule.name.trim().length === 0)
            {
                errorElement.hidden = false;
                errorElement.textContent = "Every rule needs a name, so it can be recognised later.";
                return;
            }

            if (Number(rule.matchMode) !== tagMatchModes.EVERYONE && (!Array.isArray(rule.tagFilter) || rule.tagFilter.length === 0))
            {
                errorElement.hidden = false;
                errorElement.textContent = `"${rule.name}" matches on tags but has none selected. Pick at least one tag, or set it to apply to every member.`;
                return;
            }
        }

        saveButton.disabled = true;
        const originalLabel = saveButton.textContent;
        saveButton.textContent = "Saving…";

        try
        {
            const response = await fetch("/Organization/Permissions/Set",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify
                ({
                    organizationId: this.#organizationId,
                    rules: this.#rules.map(rule => (
                    {
                        id: rule.id,
                        name: rule.name.trim(),
                        tagFilter: Array.isArray(rule.tagFilter) ? rule.tagFilter : [],
                        matchMode: Number(rule.matchMode),
                        // Read from the live panel rather than the rule object,
                        // so a condition typed but not yet blurred is saved
                        // rather than silently dropped.
                        attributeConditions: this.#collectConditionsForRule(rule),
                        allowedFeatures: Array.isArray(rule.allowedFeatures) ? rule.allowedFeatures : [],
                        storageGrantBytes: Number(rule.storageGrantBytes) || 0
                    }))
                })
            });

            const responseJson = await response.json().catch(() => ({}));

            if (!response.ok || responseJson.success === false)
            {
                errorElement.hidden = false;
                errorElement.textContent = OrganizationErrorMessages.describe(responseJson.error, response.status);
                return;
            }

            successElement.hidden = false;
            successElement.textContent = `Saved. ${responseJson.replaced} rule${responseJson.replaced === 1 ? "" : "s"} now apply to this organization.`;

            this.#onChanged();

            // Re-read rather than trust the local copy: the server clamps every
            // rule to what the agreement allows, so what was stored may be less
            // than what was sent, and the administrator should see the real one.
            await this.#loadAndRender();
        }
        catch (saveError)
        {
            errorElement.hidden = false;
            errorElement.textContent = saveError.message || "Could not save the permissions.";
        }
        finally
        {
            if (saveButton.isConnected)
            {
                saveButton.disabled = false;
                saveButton.textContent = originalLabel;
            }
        }
    }
}

customElements.define("organization-permissions-section", OrganizationPermissionsSection);
export default OrganizationPermissionsSection;
