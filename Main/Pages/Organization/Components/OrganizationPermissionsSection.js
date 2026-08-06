import OrganizationErrorMessages from "../../../Globals/Classes/Organization/OrganizationErrorMessages.js";
import { getRandomUuid } from "../../../Globals/UtilityFunctions/GetRandomUuid.js";
import { organizationDelegatePowers } from "../../../Globals/Enumerations/OrganizationDelegatePowers.js";
import { tagMatchModes } from "../../../Globals/Enumerations/TagMatchModes.js";
import { planFeatures } from "../../../Globals/Enumerations/PlanFeatures.js";

/**
 * OrganizationPermissionsSection
 *
 * What members can do inside this organization's view, expressed as rules over
 * tags rather than over people. "Final-year students get mock-test evaluation"
 * survives a new intake; "these 400 email addresses get mock-test evaluation"
 * does not.
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
 */
class OrganizationPermissionsSection extends HTMLElement
{
    // Feature order and copy for the matrix. Kept here rather than derived from
    // the enum so the labels read as product capabilities to the person buying
    // them, not as identifiers.
    static #FEATURE_DESCRIPTIONS =
    [
        { featureValue: planFeatures.ASK_AI, label: "Ask AI", description: "Ask a question about anything on screen" },
        { featureValue: planFeatures.CHAT, label: "Chat with a deck", description: "Ask questions against the deck's own content" },
        { featureValue: planFeatures.AUTOMATIC_GENERATION, label: "Generate with AI", description: "Build decks and study material from uploaded documents" },
        { featureValue: planFeatures.CURATED_STUDY, label: "Curated study material", description: "Auto-written lessons targeting weak topics" },
        { featureValue: planFeatures.MOCK_TEST_EVALUATION, label: "Mock-test evaluation", description: "AI marking and feedback on written answers" },
        { featureValue: planFeatures.IMAGE_GENERATION, label: "Image generation", description: "Diagrams and illustrations inside generated material" },
        { featureValue: planFeatures.MONTHLY_FREE_DECK, label: "Monthly free deck", description: "One marketplace deck a month at no cost" }
    ];

    static #BYTES_PER_MEGABYTE = 1024 * 1024;

    #organizationId = "";
    #authority = null;
    #onChanged = null;

    #rules = [];
    #availableTags = [];
    #grantableFeatures = [];
    #alwaysIncludedFeatures = [];
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
        this.#grantableFeatures = Array.isArray(responseJson.grantableFeatures) ? responseJson.grantableFeatures : [];
        this.#alwaysIncludedFeatures = Array.isArray(responseJson.alwaysIncludedFeatures) ? responseJson.alwaysIncludedFeatures : [];
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

    #renderRules()
    {
        const rulesHost = this.querySelector('[data-role="rules"]');
        rulesHost.innerHTML = "";

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

            <div class="organization-permission-rule-features" data-role="features"></div>

            <label class="admin-panel-add-field">
                <span>Extra storage for each matching member (MB)</span>
                <input type="number" min="0" step="1" data-role="storage" ${bMayEdit ? "" : "disabled"}>
                <small class="organization-permission-rule-hint" data-role="storage-hint"></small>
            </label>
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

        this.#renderTagPickers(cardElement, rule);
        this.#renderFeatureMatrix(cardElement, rule);

        return cardElement;
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
        const featuresHost = cardElement.querySelector('[data-role="features"]');
        featuresHost.innerHTML = "";

        const grantableFeatureSet = new Set(this.#grantableFeatures);
        const alwaysIncludedSet = new Set(this.#alwaysIncludedFeatures);
        const selectedFeatures = new Set(Array.isArray(rule.allowedFeatures) ? rule.allowedFeatures : []);

        for (const featureDescription of OrganizationPermissionsSection.#FEATURE_DESCRIPTIONS)
        {
            const bAlwaysIncluded = alwaysIncludedSet.has(featureDescription.featureValue);
            const bGrantable = grantableFeatureSet.has(featureDescription.featureValue);

            const featureLabel = document.createElement("label");
            featureLabel.className = "organization-permission-feature";

            const featureCheckbox = document.createElement("input");
            featureCheckbox.type = "checkbox";
            featureCheckbox.checked = bAlwaysIncluded || selectedFeatures.has(featureDescription.featureValue);
            featureCheckbox.disabled = bAlwaysIncluded || !bGrantable || !this.#mayEdit();
            featureCheckbox.addEventListener("change", () =>
            {
                if (featureCheckbox.checked)
                {
                    selectedFeatures.add(featureDescription.featureValue);
                }
                else
                {
                    selectedFeatures.delete(featureDescription.featureValue);
                }
                rule.allowedFeatures = Array.from(selectedFeatures);
            });

            const featureBody = document.createElement("span");
            featureBody.className = "organization-permission-feature-body";

            const featureTitle = document.createElement("span");
            featureTitle.className = "organization-permission-feature-title";
            featureTitle.textContent = featureDescription.label;

            const featureNote = document.createElement("small");
            featureNote.className = "organization-permission-feature-note";
            if (bAlwaysIncluded)
            {
                featureNote.textContent = "Included for everyone — this cannot be switched off.";
            }
            else if (!bGrantable)
            {
                featureNote.textContent = "Not part of this organization's agreement.";
            }
            else
            {
                featureNote.textContent = featureDescription.description;
            }

            featureBody.appendChild(featureTitle);
            featureBody.appendChild(featureNote);
            featureLabel.appendChild(featureCheckbox);
            featureLabel.appendChild(featureBody);
            featuresHost.appendChild(featureLabel);
        }
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
