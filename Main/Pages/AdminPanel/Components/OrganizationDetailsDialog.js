import DialogBox from "../../../CommonComponents/DialogBox.js";
import { planFeatures } from "../../../Globals/Enumerations/PlanFeatures.js";
import OrganizationErrorMessages from "../../../Globals/Classes/Organization/OrganizationErrorMessages.js";
import { organizationStatus } from "../../../Globals/Enumerations/OrganizationStatus.js";
import { organizationDeckPerkTypes } from "../../../Globals/Enumerations/OrganizationDeckPerkTypes.js";

/**
 * OrganizationDetailsDialog
 *
 * Super-admin view + edit for a single organization: rename, member capacity,
 * and the marketplace deck perks its members receive. Member management,
 * permissions, credits and the deck shelf live on the organization's own page —
 * this dialog stays focused on what only a super-admin may change.
 *
 * Every save reports its outcome next to the control that triggered it and
 * disables that control while the request is in flight, so a failure can never
 * be mistaken for a silent success. The shared error banner sits at the TOP of
 * the dialog: it used to sit below the tables, where a tall dialog pushed it
 * out of view entirely and a rejected save looked like nothing had happened.
 *
 * Resolves true when the caller should refresh its list, false on a pure close.
 */
class OrganizationDetailsDialog
{
    // The features an agreement can include, in the order they are sold rather
    // than enum order, with the wording a person buying them would use. Kept
    // beside the dialog that offers them so the two never disagree.
    static GRANTABLE_FEATURE_DESCRIPTIONS =
    [
        { featureValue: planFeatures.ASK_AI, label: "Ask AI" },
        { featureValue: planFeatures.CHAT, label: "Chat with a deck" },
        { featureValue: planFeatures.AUTOMATIC_GENERATION, label: "Generate with AI" },
        { featureValue: planFeatures.CURATED_STUDY, label: "Curated study material" },
        { featureValue: planFeatures.MOCK_TEST_EVALUATION, label: "Mock-test evaluation" },
        { featureValue: planFeatures.IMAGE_GENERATION, label: "Image generation" },
        { featureValue: planFeatures.MONTHLY_FREE_DECK, label: "Monthly free deck" }
    ];

    static #escapeHtml(rawString)
    {
        if (rawString === null || rawString === undefined)
        {
            return "";
        }
        return String(rawString)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    static #describeStatus(statusValue)
    {
        if (statusValue === organizationStatus.PENDING_PAYMENT)
        {
            return "Pending";
        }
        if (statusValue === organizationStatus.ACTIVE)
        {
            return "Active";
        }
        if (statusValue === organizationStatus.SUSPENDED)
        {
            return "Suspended";
        }
        return String(statusValue);
    }

    static async show(organizationId)
    {
        const detailsResponse = await fetch(`/Admin/Organizations/Get?organizationId=${encodeURIComponent(organizationId)}`);
        if (!detailsResponse.ok)
        {
            await DialogBox.alert("Could not load organization", OrganizationErrorMessages.describe(null, detailsResponse.status));
            return false;
        }
        const detailsJson = await detailsResponse.json();
        if (!detailsJson.success)
        {
            await DialogBox.alert("Could not load organization", OrganizationErrorMessages.describe(detailsJson.error, detailsResponse.status));
            return false;
        }

        let paidDecksCatalogue = [];
        try
        {
            const decksResponse = await fetch("/Admin/PaidDecks/List?includeUnpublished=true");
            if (decksResponse.ok)
            {
                const responseJson = await decksResponse.json();
                paidDecksCatalogue = Array.isArray(responseJson.decks) ? responseJson.decks : [];
            }
        }
        catch (loadError)
        {
            paidDecksCatalogue = [];
        }

        const organization = detailsJson.organization;
        const initialPerks = (detailsJson.perks || []).map(perk => (
        {
            deckId: perk.deckId,
            perkType: perk.perkType,
            perkValue: perk.perkValue,
            durationDays: perk.durationDays
        }));
        const payments = Array.isArray(detailsJson.payments) ? detailsJson.payments : [];

        return new Promise((resolve) =>
        {
            const escapeHtml = OrganizationDetailsDialog.#escapeHtml;

            const dialog = DialogBox.modal
            (`
                <div class="admin-panel-add-dialog organization-details-dialog">
                    <h2 class="admin-panel-add-title">${escapeHtml(organization.name)}</h2>
                    <p class="admin-panel-add-subtitle">
                        Owner: <strong>${escapeHtml(organization.adminEmail)}</strong> ·
                        Status: <strong>${escapeHtml(OrganizationDetailsDialog.#describeStatus(organization.status))}</strong> ·
                        Members: <strong>${organization.currentMemberCount} / ${organization.maxMembers}</strong> ·
                        Currency: <strong>${escapeHtml(organization.currency)}</strong>
                    </p>

                    <div class="admin-panel-add-error" data-role="error" hidden></div>

                    <h3 class="organization-section-heading">Details</h3>
                    <div class="organization-form-grid">
                        <label class="admin-panel-add-field">
                            <span>Name</span>
                            <input type="text" class="organization-rename-input" maxlength="256" value="${escapeHtml(organization.name)}">
                        </label>
                    </div>
                    <div class="organization-form-actions">
                        <button type="button" class="organization-secondary-button organization-rename">Save name</button>
                    </div>
                    <p class="organization-action-status" data-role="rename-status"></p>

                    <div class="organization-form-grid">
                        <label class="admin-panel-add-field">
                            <span>Member capacity (at least ${organization.currentMemberCount}, the current member count)</span>
                            <input type="number" class="organization-maxmembers-input" min="${organization.currentMemberCount}" value="${organization.maxMembers}">
                        </label>
                    </div>
                    <div class="organization-form-actions">
                        <button type="button" class="organization-secondary-button organization-setmax">Save capacity</button>
                    </div>
                    <p class="organization-action-status" data-role="capacity-status"></p>

                    <h3 class="organization-section-heading">Entitlement ceilings</h3>
                    <p class="admin-panel-add-subtitle">
                        The platform's side of this organization's agreement. Everything they then configure
                        for themselves &mdash; their permission rules, their storage grants, the decks they
                        publish &mdash; is clamped to these, on write and again on read, so lowering one takes
                        effect immediately.
                    </p>
                    <div class="organization-form-grid">
                        <label class="admin-panel-add-field">
                            <span>Storage each member may be granted (MB)</span>
                            <input type="number" min="0" step="1" class="organization-storage-ceiling-input"
                                   value="${Math.round((Number(organization.maxStorageGrantBytesPerMember) || 0) / (1024 * 1024))}">
                        </label>
                        <label class="admin-panel-add-field">
                            <span>Credits any one member may receive per month (0 = no cap)</span>
                            <input type="number" min="0" step="0.1" class="organization-monthly-cap-input"
                                   value="${Number(organization.maxCreditsPerMemberPerMonth) || 0}">
                        </label>
                        <label class="admin-panel-add-field">
                            <span>Decks they may publish to their members</span>
                            <input type="number" min="0" step="1" class="organization-published-decks-input"
                                   value="${Number(organization.maxPublishedDecks) || 0}">
                        </label>
                    </div>
                    <p class="admin-panel-add-subtitle">AI features their permission rules may grant. A feature left unticked can never be reached by a rule, however that rule is written.</p>
                    <div class="organization-grantable-features" data-role="grantable-features"></div>
                    <div class="organization-form-actions">
                        <button type="button" class="admin-panel-add-submit organization-save-limits">Save ceilings</button>
                    </div>
                    <p class="organization-action-status" data-role="limits-status"></p>

                    <h3 class="organization-section-heading">Marketplace deck perks</h3>
                    <p class="admin-panel-add-subtitle">These discount CogniumLearn marketplace decks for this organization's members. A FREE perk auto-mints licences for every existing member who has an account; removing a perk never revokes a licence already issued.</p>
                    <div class="organization-perks-table" data-role="perks-table"></div>
                    <div class="organization-form-actions">
                        <button type="button" class="organization-secondary-button organization-add-perk">+ Add deck perk</button>
                        <button type="button" class="admin-panel-add-submit organization-save-perks">Save perks</button>
                    </div>
                    <p class="organization-action-status" data-role="perks-status"></p>

                    ${payments.length > 0 ? `
                        <h3 class="organization-section-heading">Payment history</h3>
                        <p class="admin-panel-add-subtitle">Historical only — creating and expanding an organization is free.</p>
                        <div class="organization-table-scroll">
                            <table class="admin-panel-table">
                                <thead><tr><th>Kind</th><th>Status</th><th>Amount</th><th>Created</th></tr></thead>
                                <tbody>
                                    ${payments.map(payment => `
                                        <tr>
                                            <td>${payment.kind === 0 ? "Creation" : "Expansion"}</td>
                                            <td>${escapeHtml(payment.status)}</td>
                                            <td>${payment.amountMinor} ${escapeHtml(payment.currency)}</td>
                                            <td>${new Date(payment.createdAt).toLocaleString()}</td>
                                        </tr>
                                    `).join("")}
                                </tbody>
                            </table>
                        </div>
                    ` : ""}

                    <div class="admin-panel-add-actions">
                        <button type="button" class="admin-panel-add-cancel organization-close">Close</button>
                    </div>
                </div>
            `);

            const perksTable = dialog.querySelector('[data-role="perks-table"]');
            const errorElement = dialog.querySelector('[data-role="error"]');
            const renameStatus = dialog.querySelector('[data-role="rename-status"]');
            const capacityStatus = dialog.querySelector('[data-role="capacity-status"]');
            const perksStatus = dialog.querySelector('[data-role="perks-status"]');
            let dialogChangedSomething = false;
            const perkRows = initialPerks.slice();

            const showError = (message) =>
            {
                if (!message)
                {
                    errorElement.hidden = true;
                    errorElement.textContent = "";
                    return;
                }
                errorElement.textContent = message;
                errorElement.hidden = false;
                errorElement.scrollIntoView({ block: "nearest" });
            };

            const showActionStatus = (statusElement, message, bSucceeded) =>
            {
                statusElement.textContent = message || "";
                statusElement.classList.toggle("organization-action-status-success", bSucceeded === true);
                statusElement.classList.toggle("organization-action-status-failure", bSucceeded === false);
            };

            /**
             * Runs one save: disables its button, shows a pending label, then
             * reports the outcome beside the control. Returns the parsed body so
             * the caller can use the server's own numbers in its success line.
             */
            const runSave = async (button, statusElement, pendingLabel, performRequest) =>
            {
                const originalLabel = button.textContent;
                showError(null);
                showActionStatus(statusElement, "", null);
                button.disabled = true;
                button.textContent = pendingLabel;

                try
                {
                    const response = await performRequest();
                    const responseJson = await response.json().catch(() => ({}));
                    if (!response.ok || responseJson.success === false)
                    {
                        const message = OrganizationErrorMessages.describe(responseJson.error, response.status);
                        showError(message);
                        showActionStatus(statusElement, message, false);
                        return null;
                    }
                    dialogChangedSomething = true;
                    return responseJson;
                }
                catch (requestError)
                {
                    const message = requestError.message || "The request could not be sent.";
                    showError(message);
                    showActionStatus(statusElement, message, false);
                    return null;
                }
                finally
                {
                    button.disabled = false;
                    button.textContent = originalLabel;
                }
            };

            const renderPerks = () =>
            {
                if (perkRows.length === 0)
                {
                    perksTable.innerHTML = `<p class="admin-panel-add-subtitle">No perks. Members pay the regular price for every marketplace deck.</p>`;
                    return;
                }

                perksTable.innerHTML = `
                    <div class="organization-table-scroll">
                        <table class="admin-panel-table">
                            <thead><tr><th>Deck</th><th>Perk type</th><th>Value</th><th>Days</th><th></th></tr></thead>
                            <tbody>
                                ${perkRows.map((row, rowIndex) =>
                                {
                                    // A perk can outlive the deck it points at (the deck was
                                    // deleted, or unpublished out of the catalogue). Rendering
                                    // the select without a matching option silently showed the
                                    // FIRST deck while the row still carried the old id, so
                                    // saving rewrote the perk to a deck nobody chose. Keep the
                                    // stored id and say so instead.
                                    const bDeckIsInCatalogue = paidDecksCatalogue.some(deck => deck.id === row.deckId);
                                    const missingOption = bDeckIsInCatalogue
                                        ? ""
                                        : `<option value="${escapeHtml(row.deckId)}" selected>Unavailable deck (${escapeHtml(row.deckId)})</option>`;
                                    return `
                                        <tr data-perk-index="${rowIndex}">
                                            <td>
                                                <select class="organization-perk-deck" data-perk-index="${rowIndex}">
                                                    ${missingOption}
                                                    ${paidDecksCatalogue.map(deck => `<option value="${escapeHtml(deck.id)}" ${row.deckId === deck.id ? "selected" : ""}>${escapeHtml(deck.title)}</option>`).join("")}
                                                </select>
                                                ${bDeckIsInCatalogue ? "" : `<span class="organization-perk-warning">This deck is no longer in the catalogue.</span>`}
                                            </td>
                                            <td>
                                                <select class="organization-perk-type" data-perk-index="${rowIndex}">
                                                    <option value="${organizationDeckPerkTypes.FREE}" ${row.perkType === organizationDeckPerkTypes.FREE ? "selected" : ""}>FREE</option>
                                                    <option value="${organizationDeckPerkTypes.FIXED_OVERRIDE}" ${row.perkType === organizationDeckPerkTypes.FIXED_OVERRIDE ? "selected" : ""}>FIXED override</option>
                                                    <option value="${organizationDeckPerkTypes.PERCENTAGE_DISCOUNT}" ${row.perkType === organizationDeckPerkTypes.PERCENTAGE_DISCOUNT ? "selected" : ""}>PERCENT discount</option>
                                                </select>
                                            </td>
                                            <td><input type="number" class="organization-perk-value" data-perk-index="${rowIndex}" value="${row.perkValue}" min="0"></td>
                                            <td><input type="number" class="organization-perk-duration" data-perk-index="${rowIndex}" value="${row.durationDays}" min="0"></td>
                                            <td><button type="button" class="organization-secondary-button organization-perk-remove" data-perk-index="${rowIndex}">Remove</button></td>
                                        </tr>
                                    `;
                                }).join("")}
                            </tbody>
                        </table>
                    </div>
                `;

                for (const select of perksTable.querySelectorAll(".organization-perk-deck"))
                {
                    select.addEventListener("change", (changeEvent) =>
                    {
                        const rowIndex = Number(changeEvent.currentTarget.dataset.perkIndex);
                        perkRows[rowIndex].deckId = changeEvent.currentTarget.value;
                    });
                }
                for (const select of perksTable.querySelectorAll(".organization-perk-type"))
                {
                    select.addEventListener("change", (changeEvent) =>
                    {
                        const rowIndex = Number(changeEvent.currentTarget.dataset.perkIndex);
                        perkRows[rowIndex].perkType = Number(changeEvent.currentTarget.value);
                    });
                }
                for (const input of perksTable.querySelectorAll(".organization-perk-value"))
                {
                    input.addEventListener("input", (inputEvent) =>
                    {
                        const rowIndex = Number(inputEvent.currentTarget.dataset.perkIndex);
                        const parsedValue = parseInt(inputEvent.currentTarget.value, 10);
                        perkRows[rowIndex].perkValue = Number.isInteger(parsedValue) ? parsedValue : 0;
                    });
                }
                for (const input of perksTable.querySelectorAll(".organization-perk-duration"))
                {
                    input.addEventListener("input", (inputEvent) =>
                    {
                        const rowIndex = Number(inputEvent.currentTarget.dataset.perkIndex);
                        const parsedValue = parseInt(inputEvent.currentTarget.value, 10);
                        perkRows[rowIndex].durationDays = Number.isInteger(parsedValue) ? parsedValue : 0;
                    });
                }
                for (const button of perksTable.querySelectorAll(".organization-perk-remove"))
                {
                    button.addEventListener("click", (clickEvent) =>
                    {
                        const rowIndex = Number(clickEvent.currentTarget.dataset.perkIndex);
                        perkRows.splice(rowIndex, 1);
                        renderPerks();
                    });
                }
            };

            // ── Entitlement ceilings ──────────────────────────────────────
            const grantableFeaturesHost = dialog.querySelector('[data-role="grantable-features"]');
            const selectedFeatureValues = new Set((organization.grantableFeatures || []).map(featureValue => Number(featureValue)));

            for (const featureDescription of OrganizationDetailsDialog.GRANTABLE_FEATURE_DESCRIPTIONS)
            {
                const featureLabel = document.createElement("label");
                featureLabel.className = "organization-permission-tag";

                const featureCheckbox = document.createElement("input");
                featureCheckbox.type = "checkbox";
                featureCheckbox.checked = selectedFeatureValues.has(featureDescription.featureValue);
                featureCheckbox.addEventListener("change", () =>
                {
                    if (featureCheckbox.checked)
                    {
                        selectedFeatureValues.add(featureDescription.featureValue);
                    }
                    else
                    {
                        selectedFeatureValues.delete(featureDescription.featureValue);
                    }
                });

                const featureText = document.createElement("span");
                featureText.textContent = featureDescription.label;

                featureLabel.appendChild(featureCheckbox);
                featureLabel.appendChild(featureText);
                grantableFeaturesHost.appendChild(featureLabel);
            }

            const limitsStatus = dialog.querySelector('[data-role="limits-status"]');
            const saveLimitsButton = dialog.querySelector(".organization-save-limits");

            saveLimitsButton.addEventListener("click", async () =>
            {
                const storageMegabytes = Number(dialog.querySelector(".organization-storage-ceiling-input").value);
                const monthlyCap = Number(dialog.querySelector(".organization-monthly-cap-input").value);
                const publishedDeckCap = Number(dialog.querySelector(".organization-published-decks-input").value);

                if (!Number.isFinite(storageMegabytes) || storageMegabytes < 0
                    || !Number.isFinite(monthlyCap) || monthlyCap < 0
                    || !Number.isFinite(publishedDeckCap) || publishedDeckCap < 0)
                {
                    limitsStatus.classList.add("organization-action-status-failure");
                    limitsStatus.textContent = "Every ceiling has to be zero or more.";
                    return;
                }

                const responseJson = await runSave(saveLimitsButton, limitsStatus, "Saving…", () => fetch("/Admin/Organizations/SetLimits",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify
                    ({
                        organizationId: organization.id,
                        maxStorageGrantBytesPerMember: Math.round(storageMegabytes) * 1024 * 1024,
                        maxCreditsPerMemberPerMonth: monthlyCap,
                        maxPublishedDecks: Math.round(publishedDeckCap),
                        grantableFeatures: Array.from(selectedFeatureValues)
                    })
                }));

                if (!responseJson)
                {
                    return;
                }

                // Kept in step locally so re-opening the dialog without a reload
                // shows what was actually saved rather than what was typed.
                organization.maxStorageGrantBytesPerMember = Math.round(storageMegabytes) * 1024 * 1024;
                organization.maxCreditsPerMemberPerMonth = monthlyCap;
                organization.maxPublishedDecks = Math.round(publishedDeckCap);
                organization.grantableFeatures = Array.from(selectedFeatureValues);

                limitsStatus.classList.remove("organization-action-status-failure");
                limitsStatus.classList.add("organization-action-status-success");
                limitsStatus.textContent = responseJson.rulesReclamped > 0
                    ? `Saved. ${responseJson.rulesReclamped} existing permission rule(s) were re-checked against the new ceilings.`
                    : "Saved.";
            });

            renderPerks();

            dialog.querySelector(".organization-add-perk").addEventListener("click", () =>
            {
                if (paidDecksCatalogue.length === 0)
                {
                    showError("No marketplace decks available — upload one first.");
                    return;
                }
                perkRows.push
                ({
                    deckId: paidDecksCatalogue[0].id,
                    perkType: organizationDeckPerkTypes.FREE,
                    perkValue: 0,
                    durationDays: 0
                });
                renderPerks();
            });

            const savePerksButton = dialog.querySelector(".organization-save-perks");
            savePerksButton.addEventListener("click", async () =>
            {
                const responseJson = await runSave(savePerksButton, perksStatus, "Saving…", () => fetch("/Admin/Organizations/UpdatePerks",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ organizationId: organization.id, perks: perkRows })
                }));

                if (!responseJson)
                {
                    return;
                }

                const replacedCount = responseJson.replaced || 0;
                const autoAssignedCount = responseJson.autoAssignedDecks || 0;
                showActionStatus
                (
                    perksStatus,
                    `Saved ${replacedCount} perk${replacedCount === 1 ? "" : "s"}. Auto-assigned ${autoAssignedCount} deck licence${autoAssignedCount === 1 ? "" : "s"} to existing members.`,
                    true
                );
            });

            const renameButton = dialog.querySelector(".organization-rename");
            renameButton.addEventListener("click", async () =>
            {
                const newName = dialog.querySelector(".organization-rename-input").value.trim();
                if (newName.length === 0 || newName.length > 256)
                {
                    showError("Enter a name between 1 and 256 characters.");
                    showActionStatus(renameStatus, "Enter a name between 1 and 256 characters.", false);
                    return;
                }

                const responseJson = await runSave(renameButton, renameStatus, "Saving…", () => fetch("/Admin/Organizations/Rename",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ organizationId: organization.id, name: newName })
                }));

                if (!responseJson)
                {
                    return;
                }

                organization.name = newName;
                dialog.querySelector(".admin-panel-add-title").textContent = newName;
                showActionStatus(renameStatus, `Renamed to "${newName}".`, true);
            });

            const setMaxMembersButton = dialog.querySelector(".organization-setmax");
            setMaxMembersButton.addEventListener("click", async () =>
            {
                const newMaximumMembers = parseInt(dialog.querySelector(".organization-maxmembers-input").value, 10);
                if (!Number.isInteger(newMaximumMembers) || newMaximumMembers <= 0)
                {
                    showError("Enter a member capacity above zero.");
                    showActionStatus(capacityStatus, "Enter a member capacity above zero.", false);
                    return;
                }

                const responseJson = await runSave(setMaxMembersButton, capacityStatus, "Saving…", () => fetch("/Admin/Organizations/SetMaxMembers",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ organizationId: organization.id, maxMembers: newMaximumMembers })
                }));

                if (!responseJson)
                {
                    return;
                }

                organization.maxMembers = newMaximumMembers;
                showActionStatus(capacityStatus, `Capacity is now ${newMaximumMembers}.`, true);
            });

            dialog.querySelector(".organization-close").addEventListener("click", () =>
            {
                dialog.close();
                resolve(dialogChangedSomething);
            });

            // DialogBox.modal's own X — and the Escape key, which PopupStack
            // routes to it — closes the element without settling this promise.
            // The caller awaits this to decide whether to refresh its list, so
            // without this the list silently never refreshed after an edit.
            dialog.querySelector(".close-button").addEventListener("click", () =>
            {
                resolve(dialogChangedSomething);
            });
        });
    }
}

export default OrganizationDetailsDialog;
