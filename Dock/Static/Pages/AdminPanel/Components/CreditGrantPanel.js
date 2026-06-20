import DialogBox from "../../../CommonComponents/DialogBox.js";
import "./DealPaymentEditor.js";
import "./PeriodicAssignmentsPanel.js";
import { userRoles } from "../../../Globals/Enumerations/UserRoles.js";
import { creditGrantTargetTypes } from "../../../Globals/Enumerations/CreditGrantTargetTypes.js";
import { creditGrantAmountModes } from "../../../Globals/Enumerations/CreditGrantAmountModes.js";
import { creditGrantKinds } from "../../../Globals/Enumerations/CreditGrantKinds.js";
import { creditDealTargetTypes } from "../../../Globals/Enumerations/CreditDealTargetTypes.js";
import { enumerationToTitleCase } from "../../../Globals/UtilityFunctions/EnumerationToTitleCase.js";

/**
 * CreditGrantPanel
 *
 * Self-contained admin tool for manually granting credits — B2B deals and
 * known contacts. Targets specific users (email list), a user filter (email
 * substring / role / balance range), or a whole organization's members, with
 * the amount applied per user or as one pot split equally.
 *
 * Two-step flow: Preview (/Admin/Credits/Grant/Preview) resolves the exact
 * recipient list and per-user amount without touching balances, then Grant
 * (/Admin/Credits/Grant/Apply) applies it under a client-minted grantKey so
 * a retried apply can never double-grant. Any input change invalidates the
 * staged preview and disables Grant until the admin previews again.
 */
class CreditGrantPanel extends HTMLElement
{
    #organizations = null;
    #stagedGrant = null;

    connectedCallback()
    {
        this.#render();
    }

    #render()
    {
        this.innerHTML = `
            <style>
                credit-grant-panel { display: block; padding: 2px 0 16px; color: var(--primary-text-color); }

                .credit-grant-section { margin-bottom: 28px; }
                .credit-grant-section-title
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
                .credit-grant-card
                {
                    background-color: var(--secondary-background-color);
                    border: 1px solid var(--outline-color-subtle);
                    border-radius: 10px;
                    padding: 16px 18px;
                    margin-bottom: 12px;
                }
                .credit-grant-controls
                {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 14px 18px;
                }
                .credit-grant-field
                {
                    display: flex;
                    flex-direction: column;
                    gap: 6px;
                    font-size: 11px;
                    text-transform: uppercase;
                    letter-spacing: 0.04em;
                    color: var(--secondary-text-color);
                }
                .credit-grant-input, .credit-grant-select, .credit-grant-textarea
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
                .credit-grant-input:focus, .credit-grant-select:focus, .credit-grant-textarea:focus { outline-color: var(--outline-color-strong); }
                .credit-grant-input { width: 152px; }
                .credit-grant-select { min-width: 224px; }
                .credit-grant-textarea { width: 100%; min-height: 72px; resize: vertical; }
                .credit-grant-reason { width: 320px; }
                .credit-grant-target-section { margin-top: 16px; }
                .credit-grant-hint
                {
                    font-size: 12px;
                    color: var(--secondary-text-color);
                    text-transform: none;
                    letter-spacing: normal;
                }

                .credit-grant-button
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
                .credit-grant-button:disabled { opacity: 0.4; cursor: not-allowed; }
                .credit-grant-button-secondary
                {
                    background: transparent;
                    outline: 1px dashed var(--outline-color-strong);
                    outline-offset: -1px;
                    font-weight: 500;
                }
                .credit-grant-button-secondary:hover { background-color: var(--tertiary-background-color); }

                .credit-grant-actionbar
                {
                    display: flex;
                    gap: 14px;
                    align-items: center;
                    margin-top: 16px;
                }
                .credit-grant-status { font-size: 13px; color: var(--secondary-text-color); }
                .credit-grant-status-error { color: var(--danger-text-color); }

                .credit-grant-table-wrap
                {
                    max-height: 320px;
                    overflow: auto;
                    margin-top: 14px;
                    border-radius: 8px;
                    outline: 1px solid var(--outline-color-subtle);
                    outline-offset: -1px;
                }
                .credit-grant-table
                {
                    width: 100%;
                    border-collapse: collapse;
                    font-size: 13px;
                }
                .credit-grant-table th
                {
                    position: sticky;
                    top: 0;
                    text-align: left;
                    padding: 9px 12px;
                    font-size: 11px;
                    text-transform: uppercase;
                    letter-spacing: 0.04em;
                    color: var(--secondary-text-color);
                    background-color: var(--tertiary-background-color);
                }
                .credit-grant-table td
                {
                    padding: 8px 12px;
                    border-top: 1px solid var(--outline-color-subtle);
                    color: var(--primary-text-color);
                }
                .credit-grant-summary
                {
                    margin-top: 14px;
                    font-size: 13px;
                    color: var(--primary-text-color);
                }
                .credit-grant-warning
                {
                    margin-top: 12px;
                    padding: 10px 14px;
                    border-radius: 8px;
                    background-color: var(--danger-background-color);
                    color: var(--danger-text-color);
                    font-size: 12.5px;
                    line-height: 1.5;
                    word-break: break-word;
                }
            </style>

            <div class="credit-grant-section">
                <div class="credit-grant-section-title">Grant Credits</div>
                <div class="credit-grant-card" data-role="grant-form">
                    <div class="credit-grant-controls" style="margin-bottom:16px;">
                        <label class="credit-grant-field">Grant kind
                            <select class="credit-grant-select" data-field="grantKind">
                                <option value="${creditGrantKinds.FIXED}" selected>Fixed — one-time grant</option>
                                <option value="${creditGrantKinds.PERIODIC}">Periodic — recurring assignment</option>
                            </select>
                        </label>
                    </div>

                    <div data-role="periodic-panel-wrap" style="display:none;">
                        <periodic-assignments-panel data-role="periodic-panel"></periodic-assignments-panel>
                    </div>

                    <div data-role="fixed-form">
                    <div class="credit-grant-controls">
                        <label class="credit-grant-field">Target
                            <select class="credit-grant-select" data-field="targetType">
                                <option value="${creditGrantTargetTypes.USER_EMAILS}" selected>Specific users (by email)</option>
                                <option value="${creditGrantTargetTypes.USER_FILTER}">Users matching a filter</option>
                                <option value="${creditGrantTargetTypes.ORGANIZATION}">Organization members</option>
                            </select>
                        </label>
                        <label class="credit-grant-field">Amount (credits)
                            <input class="credit-grant-input" type="number" step="any" min="0" data-field="amount" placeholder="e.g. 100">
                        </label>
                        <label class="credit-grant-field">Amount mode
                            <select class="credit-grant-select" data-field="amountMode">
                                <option value="${creditGrantAmountModes.PER_USER}" selected>Per user — each recipient gets this amount</option>
                                <option value="${creditGrantAmountModes.TOTAL_SPLIT}">Total — split equally across recipients</option>
                            </select>
                        </label>
                        <label class="credit-grant-field">Reason (stored in the audit trail)
                            <input class="credit-grant-input credit-grant-reason" type="text" maxlength="512" data-field="reason" placeholder="e.g. B2B deal — Acme onboarding">
                        </label>
                    </div>

                    <div class="credit-grant-target-section" data-role="emails-section">
                        <label class="credit-grant-field">Emails — one per line, or separated by commas / spaces
                            <textarea class="credit-grant-textarea" data-field="emails" placeholder="alice@example.com&#10;bob@example.com"></textarea>
                        </label>
                    </div>

                    <div class="credit-grant-target-section" data-role="filter-section" style="display:none;">
                        <div class="credit-grant-controls">
                            <label class="credit-grant-field">Email contains
                                <input class="credit-grant-input" type="text" data-field="emailContains" placeholder="@acme.com">
                            </label>
                            <label class="credit-grant-field">Role
                                <select class="credit-grant-select" data-field="roleFilter">
                                    <option value="" selected>Any role</option>
                                    ${this.#roleOptions()}
                                </select>
                            </label>
                            <label class="credit-grant-field">Min balance (credits)
                                <input class="credit-grant-input" type="number" step="any" data-field="minimumBalance" placeholder="any">
                            </label>
                            <label class="credit-grant-field">Max balance (credits)
                                <input class="credit-grant-input" type="number" step="any" data-field="maximumBalance" placeholder="any">
                            </label>
                        </div>
                        <div class="credit-grant-hint" style="margin-top:10px;">Leaving every field empty targets <strong>all users</strong> — the preview shows exactly who matches before anything is granted.</div>
                    </div>

                    <div class="credit-grant-target-section" data-role="organization-section" style="display:none;">
                        <label class="credit-grant-field">Organization
                            <select class="credit-grant-select" data-field="organizationId">
                                <option value="">Loading organizations…</option>
                            </select>
                        </label>
                        <div class="credit-grant-hint" style="margin-top:10px;">Members who have never signed in have no account to credit yet — they are listed as unmatched in the preview.</div>
                    </div>

                    <div class="credit-grant-target-section">
                        <div class="credit-grant-field" style="margin-bottom:8px;">Payment / invoice (optional)</div>
                        <deal-payment-editor data-role="deal-editor"></deal-payment-editor>
                    </div>

                    <div class="credit-grant-actionbar">
                        <button class="credit-grant-button credit-grant-button-secondary" data-action="preview">Preview recipients</button>
                        <button class="credit-grant-button" data-action="grant" disabled>Grant credits</button>
                        <span class="credit-grant-status" data-role="status"></span>
                    </div>

                    <div data-role="preview-results"></div>
                    </div>
                </div>
            </div>
        `;

        this.#bindEvents();
    }

    #roleOptions()
    {
        return Object.keys(userRoles)
            .map(name => `<option value="${userRoles[name]}">${enumerationToTitleCase(name)}</option>`)
            .join("");
    }

    #bindEvents()
    {
        this.querySelector('[data-field="targetType"]').addEventListener("change", async (changeEvent) =>
        {
            const targetType = Number(changeEvent.currentTarget.value);
            this.querySelector('[data-role="emails-section"]').style.display = targetType === creditGrantTargetTypes.USER_EMAILS ? "" : "none";
            this.querySelector('[data-role="filter-section"]').style.display = targetType === creditGrantTargetTypes.USER_FILTER ? "" : "none";
            this.querySelector('[data-role="organization-section"]').style.display = targetType === creditGrantTargetTypes.ORGANIZATION ? "" : "none";

            if (targetType === creditGrantTargetTypes.ORGANIZATION)
            {
                await this.#ensureOrganizationsLoaded();
            }
        });

        // Any edit invalidates the staged preview — the recipient list (or the
        // split amount) may no longer match what the admin saw. The reason
        // field is exempt: it is read at apply time and never affects
        // targeting or amounts.
        const grantForm = this.querySelector('[data-role="grant-form"]');
        const invalidateUnlessReason = (formEvent) =>
        {
            if (formEvent.target?.dataset?.field !== "reason")
            {
                this.#invalidateStagedGrant();
            }
        };
        grantForm.addEventListener("input", invalidateUnlessReason);
        grantForm.addEventListener("change", invalidateUnlessReason);

        this.querySelector('[data-action="preview"]').addEventListener("click", () => this.#preview());
        this.querySelector('[data-action="grant"]').addEventListener("click", () => this.#applyGrant());

        this.querySelector('[data-field="grantKind"]').addEventListener("change", () => this.#applyGrantKind());
        this.#applyGrantKind();
    }

    #applyGrantKind()
    {
        const isPeriodic = Number(this.querySelector('[data-field="grantKind"]').value) === creditGrantKinds.PERIODIC;
        this.querySelector('[data-role="fixed-form"]').style.display = isPeriodic ? "none" : "";
        this.querySelector('[data-role="periodic-panel-wrap"]').style.display = isPeriodic ? "" : "none";
    }

    #invalidateStagedGrant()
    {
        if (!this.#stagedGrant)
        {
            return;
        }
        this.#stagedGrant = null;
        this.querySelector('[data-action="grant"]').disabled = true;
        this.#setStatus("Inputs changed — preview again before granting.", false);
    }

    async #ensureOrganizationsLoaded()
    {
        if (this.#organizations !== null)
        {
            return;
        }

        const organizationSelect = this.querySelector('[data-field="organizationId"]');
        try
        {
            const response = await fetch("/Admin/Organizations/List");
            if (!response.ok)
            {
                organizationSelect.innerHTML = `<option value="">Failed to load (HTTP ${response.status})</option>`;
                return;
            }
            const responseJson = await response.json();
            this.#organizations = responseJson.organizations || [];
        }
        catch (loadError)
        {
            organizationSelect.innerHTML = `<option value="">${CreditGrantPanel.#escape(loadError.message)}</option>`;
            return;
        }

        if (this.#organizations.length === 0)
        {
            organizationSelect.innerHTML = `<option value="">No organizations</option>`;
            return;
        }

        organizationSelect.innerHTML = `<option value="">Select an organization…</option>` + this.#organizations
            .map(organization => `<option value="${CreditGrantPanel.#escape(organization.id)}">${CreditGrantPanel.#escape(organization.name)} (${organization.currentMemberCount ?? 0} members)</option>`)
            .join("");
    }

    /**
     * Reads the form into the request payload shared by preview and apply.
     * Returns { error } with a human-readable message when the form is
     * incomplete.
     */
    #buildRequestPayload()
    {
        const targetType = Number(this.querySelector('[data-field="targetType"]').value);
        const amount = parseFloat(this.querySelector('[data-field="amount"]').value);
        const amountMode = Number(this.querySelector('[data-field="amountMode"]').value);

        if (!(amount > 0))
        {
            return { error: "Enter a positive credit amount." };
        }

        const target = { targetType: targetType };

        if (targetType === creditGrantTargetTypes.USER_EMAILS)
        {
            const emails = this.querySelector('[data-field="emails"]').value
                .split(/[\s,;]+/)
                .map(email => email.trim())
                .filter(email => email.length > 0);
            if (emails.length === 0)
            {
                return { error: "Enter at least one email address." };
            }
            target.emails = emails;
        }
        else if (targetType === creditGrantTargetTypes.USER_FILTER)
        {
            const roleRaw = this.querySelector('[data-field="roleFilter"]').value;
            const minimumBalance = parseFloat(this.querySelector('[data-field="minimumBalance"]').value);
            const maximumBalance = parseFloat(this.querySelector('[data-field="maximumBalance"]').value);
            target.filter =
            {
                emailContains: this.querySelector('[data-field="emailContains"]').value.trim(),
                role: roleRaw === "" ? null : Number(roleRaw),
                minimumBalance: isNaN(minimumBalance) ? null : minimumBalance,
                maximumBalance: isNaN(maximumBalance) ? null : maximumBalance
            };
        }
        else if (targetType === creditGrantTargetTypes.ORGANIZATION)
        {
            const organizationId = this.querySelector('[data-field="organizationId"]').value;
            if (!organizationId)
            {
                return { error: "Select an organization." };
            }
            target.organizationId = organizationId;
        }

        return { target: target, amount: amount, amountMode: amountMode };
    }

    async #preview()
    {
        const payload = this.#buildRequestPayload();
        if (payload.error)
        {
            this.#setStatus(payload.error, true);
            return;
        }

        this.#stagedGrant = null;
        this.querySelector('[data-action="grant"]').disabled = true;
        this.#setStatus("Resolving recipients…", false);

        let previewJson;
        try
        {
            const response = await fetch("/Admin/Credits/Grant/Preview", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            previewJson = await response.json().catch(() => ({}));
            if (!response.ok)
            {
                this.#setStatus(previewJson.error || `Preview failed (HTTP ${response.status}).`, true);
                return;
            }
        }
        catch (previewError)
        {
            this.#setStatus(previewError.message, true);
            return;
        }

        this.#renderPreviewResults(previewJson);

        if (previewJson.recipientCount > 0 && previewJson.perUserAmount > 0)
        {
            this.#stagedGrant = { grantKey: crypto.randomUUID(), payload: payload, preview: previewJson };
            this.querySelector('[data-action="grant"]').disabled = false;
            this.#setStatus(`Preview ready — ${previewJson.recipientCount} recipient(s).`, false);
        }
        else if (previewJson.recipientCount > 0)
        {
            this.#setStatus("The split amount per user rounds to zero — increase the total.", true);
        }
        else
        {
            this.#setStatus("No matching users found.", true);
        }
    }

    #renderPreviewResults(preview)
    {
        const resultsContainer = this.querySelector('[data-role="preview-results"]');
        const recipients = preview.recipients || [];
        const unmatchedEmails = preview.unmatchedEmails || [];

        const tableHtml = recipients.length > 0 ? `
            <div class="credit-grant-table-wrap">
                <table class="credit-grant-table">
                    <thead>
                        <tr><th>Email</th><th>Name</th><th>Current balance</th><th>Grant</th><th>New balance</th></tr>
                    </thead>
                    <tbody>
                        ${recipients.map(recipient => `
                            <tr>
                                <td>${CreditGrantPanel.#escape(recipient.email)}</td>
                                <td>${CreditGrantPanel.#escape(recipient.displayName)}</td>
                                <td>${CreditGrantPanel.#formatCredits(recipient.balance)}</td>
                                <td>+${CreditGrantPanel.#formatCredits(preview.perUserAmount)}</td>
                                <td>${CreditGrantPanel.#formatCredits(recipient.balance + preview.perUserAmount)}</td>
                            </tr>
                        `).join("")}
                    </tbody>
                </table>
            </div>` : "";

        const unmatchedHtml = unmatchedEmails.length > 0
            ? `<div class="credit-grant-warning"><strong>No account found for:</strong> ${unmatchedEmails.map(email => CreditGrantPanel.#escape(email)).join(", ")}</div>`
            : "";

        resultsContainer.innerHTML = `
            ${tableHtml}
            ${unmatchedHtml}
            <div class="credit-grant-summary">
                ${preview.recipientCount} recipient(s) × ${CreditGrantPanel.#formatCredits(preview.perUserAmount)} credits = ${CreditGrantPanel.#formatCredits(preview.totalAmount)} credits total.
            </div>
        `;
    }

    async #applyGrant()
    {
        if (!this.#stagedGrant)
        {
            return;
        }

        const preview = this.#stagedGrant.preview;
        const confirmed = await DialogBox.confirm
        (
            "Grant credits",
            `Grant ${CreditGrantPanel.#formatCredits(preview.perUserAmount)} credits to each of ${preview.recipientCount} user(s) — ${CreditGrantPanel.#formatCredits(preview.totalAmount)} credits total?`
        );
        if (!confirmed)
        {
            return;
        }

        // Re-check — the confirm dialog is async and an edit meanwhile
        // invalidates the staged grant.
        if (!this.#stagedGrant)
        {
            return;
        }

        const grantKeyForDeal = this.#stagedGrant.grantKey;
        const requestBody =
        {
            ...this.#stagedGrant.payload,
            grantKey: this.#stagedGrant.grantKey,
            reason: this.querySelector('[data-field="reason"]').value.trim()
        };

        this.#setStatus("Granting…", false);
        this.querySelector('[data-action="grant"]').disabled = true;

        let applyJson;
        try
        {
            const response = await fetch("/Admin/Credits/Grant/Apply", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(requestBody),
            });
            applyJson = await response.json().catch(() => ({}));
            if (!response.ok)
            {
                // Keep the staged grant (same grantKey) so a retry can never
                // double-grant recipients that already went through.
                this.querySelector('[data-action="grant"]').disabled = false;
                this.#setStatus(`${applyJson.error || `Grant failed (HTTP ${response.status})`} — you can safely retry.`, true);
                return;
            }
        }
        catch (applyError)
        {
            this.querySelector('[data-action="grant"]').disabled = false;
            this.#setStatus(`${applyError.message} — you can safely retry.`, true);
            return;
        }

        this.#stagedGrant = null;
        this.#renderApplyOutcome(applyJson);

        // Attach the optional payment / invoice to this grant (keyed by the
        // grantKey). Bookkeeping only — never affects the grant itself.
        try
        {
            const dealEditor = this.querySelector('[data-role="deal-editor"]');
            if (dealEditor && typeof dealEditor.submitForTarget === "function")
            {
                const dealResult = await dealEditor.submitForTarget(creditDealTargetTypes.FIXED_GRANT, grantKeyForDeal);
                if (dealResult.recorded)
                {
                    const note = dealResult.error ? ` (payment note: ${dealResult.error})` : (dealResult.captured ? " Payment captured." : (dealResult.invoiceUploaded ? " Invoice attached." : " Payment recorded."));
                    this.#setStatus(this.querySelector('[data-role="status"]').textContent + note, dealResult.error ? true : false);
                    dealEditor.reset();
                }
            }
        }
        catch (dealError)
        {
            // A payment-record failure must never mask a successful grant.
            console.warn(`[CreditGrantPanel] Deal attach failed: ${dealError.message}`);
        }
    }

    #renderApplyOutcome(outcome)
    {
        const failedResults = (outcome.results || []).filter(result => !result.applied && !result.alreadyApplied);

        const summaryParts = [`Granted ${CreditGrantPanel.#formatCredits(outcome.perUserAmount)} credits to ${outcome.grantedCount} user(s) — ${CreditGrantPanel.#formatCredits(outcome.totalGranted)} total.`];
        if (outcome.alreadyAppliedCount > 0)
        {
            summaryParts.push(`${outcome.alreadyAppliedCount} already had this grant (idempotent replay).`);
        }
        if (outcome.failedCount > 0)
        {
            summaryParts.push(`${outcome.failedCount} failed.`);
        }
        this.#setStatus(summaryParts.join(" "), outcome.failedCount > 0);

        if (failedResults.length > 0)
        {
            const resultsContainer = this.querySelector('[data-role="preview-results"]');
            resultsContainer.insertAdjacentHTML
            (
                "beforeend",
                `<div class="credit-grant-warning"><strong>Failed:</strong> ${failedResults.map(result => CreditGrantPanel.#escape(result.email || result.userId)).join(", ")}</div>`
            );
        }
    }

    #setStatus(message, isError)
    {
        const statusLabel = this.querySelector('[data-role="status"]');
        statusLabel.textContent = message;
        statusLabel.classList.toggle("credit-grant-status-error", isError === true);
    }

    static #formatCredits(value)
    {
        const numeric = typeof value === "number" && isFinite(value) ? value : 0;
        return String(Math.round(numeric * 10000) / 10000);
    }

    static #escape(text)
    {
        const div = document.createElement("div");
        div.textContent = String(text ?? "");
        return div.innerHTML;
    }
}

customElements.define("credit-grant-panel", CreditGrantPanel);
export default CreditGrantPanel;
