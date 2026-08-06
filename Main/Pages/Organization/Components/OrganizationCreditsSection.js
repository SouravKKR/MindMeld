import DialogBox from "../../../CommonComponents/DialogBox.js";
import PaymentCheckout from "../../../Globals/Classes/Payments/PaymentCheckout.js";
import OrganizationErrorMessages from "../../../Globals/Classes/Organization/OrganizationErrorMessages.js";
import OrganizationSpendReportSheetBuilder from "../../../Globals/Classes/Organization/OrganizationSpendReportSheetBuilder.js";
import CreditDistributionPreviewSheetBuilder from "../../../Globals/Classes/Credits/CreditDistributionPreviewSheetBuilder.js";
import { getRandomUuid } from "../../../Globals/UtilityFunctions/GetRandomUuid.js";
import { organizationDelegatePowers } from "../../../Globals/Enumerations/OrganizationDelegatePowers.js";
import { creditGrantAmountModes } from "../../../Globals/Enumerations/CreditGrantAmountModes.js";
import { tagMatchModes } from "../../../Globals/Enumerations/TagMatchModes.js";
import { periodicScheduleTypes } from "../../../Globals/Enumerations/PeriodicScheduleTypes.js";

/**
 * OrganizationCreditsSection
 *
 * The organization's credit pool: what is in it, what is waiting to be paid
 * for, and the two ways it is handed out — a one-off distribution to a tag
 * selection, and a recurring one that repeats.
 *
 * A distribution is always previewed before it runs. The preview names every
 * recipient, shows each balance before and after, and can be downloaded as a
 * spreadsheet — because credits cannot be taken back once granted, and a filter
 * that matches more people than intended is the easiest mistake to make here.
 */
class OrganizationCreditsSection extends HTMLElement
{
    #organizationId = "";
    #organization = null;
    #authority = null;
    #onChanged = null;
    #overview = null;
    #availableTags = [];
    #stagedPreview = null;
    #stagedGrantKey = "";

    initialize(context)
    {
        this.#organizationId = context.organizationId;
        this.#organization = context.organization;
        this.#authority = context.authority;
        this.#onChanged = typeof context.onChanged === "function" ? context.onChanged : () => {};
    }

    async connectedCallback()
    {
        this.innerHTML = `<p class="admin-panel-add-subtitle">Loading credits…</p>`;
        await this.#loadAndRender();
    }

    #mayDistribute()
    {
        const heldPowers = Number.isInteger(this.#authority?.delegatePowers) ? this.#authority.delegatePowers : 0;
        return (heldPowers & organizationDelegatePowers.DISTRIBUTE_CREDITS) === organizationDelegatePowers.DISTRIBUTE_CREDITS;
    }

    async #loadAndRender()
    {
        try
        {
            const [overviewResponse, metadataResponse] = await Promise.all
            ([
                fetch(`/Organization/Credits/Overview?organizationId=${encodeURIComponent(this.#organizationId)}`),
                fetch(`/Organization/Lists/Metadata?organizationId=${encodeURIComponent(this.#organizationId)}`)
            ]);

            const overviewJson = await overviewResponse.json().catch(() => ({}));
            if (!overviewResponse.ok || overviewJson.success === false)
            {
                this.innerHTML = `<div class="admin-panel-add-error"></div>`;
                this.querySelector(".admin-panel-add-error").textContent = OrganizationErrorMessages.describe(overviewJson.error, overviewResponse.status);
                return;
            }

            this.#overview = overviewJson;

            // The tag vocabulary comes from the member list's own filter set, so
            // the tags offered here are exactly the ones the roster uses.
            const metadataJson = metadataResponse.ok ? await metadataResponse.json().catch(() => ({})) : {};
            const tagsFilter = Array.isArray(metadataJson.filters) ? metadataJson.filters.find(filter => filter.key === "tags") : null;
            this.#availableTags = tagsFilter && Array.isArray(tagsFilter.options)
                ? tagsFilter.options.map(option => (option !== null && typeof option === "object" ? String(option.value) : String(option)))
                : [];
        }
        catch (loadError)
        {
            this.innerHTML = `<div class="admin-panel-add-error"></div>`;
            this.querySelector(".admin-panel-add-error").textContent = loadError.message || "Could not load the credit pool.";
            return;
        }

        this.#render();
    }

    #render()
    {
        const pool = this.#overview.pool || { balance: 0, lifetimeGranted: 0, lifetimeDistributed: 0, frozen: false };
        const bMayDistribute = this.#mayDistribute();
        const unpaidDeals = (this.#overview.deals || []).filter(deal => deal.bAwaitingPayment);
        const termEndsAtLabel = OrganizationCreditsSection.#describeTermEnd(this.#overview.termEndsAt);

        this.innerHTML = `
            <h2 class="organization-section-title">Credits</h2>

            <div class="organization-summary-grid">
                <div class="organization-summary-card">
                    <span class="organization-summary-label">In the pool</span>
                    <span class="organization-summary-value">${pool.balance}</span>
                </div>
                <div class="organization-summary-card">
                    <span class="organization-summary-label">Given out so far</span>
                    <span class="organization-summary-value">${pool.lifetimeDistributed}</span>
                </div>
                <div class="organization-summary-card">
                    <span class="organization-summary-label">Term ends</span>
                    <span class="organization-summary-value">${OrganizationCreditsSection.#escapeHtml(termEndsAtLabel)}</span>
                </div>
                <div class="organization-summary-card">
                    <span class="organization-summary-label">Per member each month</span>
                    <span class="organization-summary-value">${this.#overview.maxCreditsPerMemberPerMonth > 0 ? this.#overview.maxCreditsPerMemberPerMonth : "No limit"}</span>
                </div>
            </div>

            ${pool.frozen ? `<div class="admin-panel-add-error">This organization's credit term has ended, so distributions are paused. The ${pool.balance} credits already in the pool are kept and become available again when the term is renewed.</div>` : ""}

            <div class="admin-panel-add-error" data-role="error" hidden></div>
            <p class="organization-action-status" data-role="status"></p>

            ${unpaidDeals.length > 0 ? `
                <h3 class="organization-section-heading">Waiting for payment</h3>
                <div class="organization-table-scroll">
                    <table class="admin-panel-table">
                        <thead><tr><th>What</th><th>Credits</th><th>Amount</th><th></th></tr></thead>
                        <tbody>
                            ${unpaidDeals.map(deal => `
                                <tr data-deal-id="${OrganizationCreditsSection.#escapeHtml(deal.id)}">
                                    <td>${OrganizationCreditsSection.#escapeHtml(deal.label)}</td>
                                    <td>${deal.credits}</td>
                                    <td>${(deal.amountMinor / 100).toFixed(2)} ${OrganizationCreditsSection.#escapeHtml(deal.currency)}</td>
                                    <td>${bMayDistribute ? `<button type="button" class="admin-panel-add-submit organization-pay-deal">Pay</button>` : "—"}</td>
                                </tr>
                            `).join("")}
                        </tbody>
                    </table>
                </div>
            ` : ""}

            ${bMayDistribute ? `
                <h3 class="organization-section-heading">Give credits out</h3>
                <p class="admin-panel-add-subtitle">Choose who by tag, set the amount, then preview. Nothing moves until you confirm the preview.</p>
                <div class="organization-form-grid">
                    <label class="admin-panel-add-field">
                        <span>Who</span>
                        <select class="organization-tag-match-mode">
                            <option value="${tagMatchModes.EVERYONE}">Everyone in the organization</option>
                            <option value="${tagMatchModes.ANY}">Anyone with any of these tags</option>
                            <option value="${tagMatchModes.ALL}">Only people with all of these tags</option>
                        </select>
                    </label>
                    <label class="admin-panel-add-field organization-form-field-tall">
                        <span>Tags</span>
                        ${this.#availableTags.length > 0 ? `
                            <select class="organization-tag-select" multiple size="4">
                                ${this.#availableTags.map(tag => `<option value="${OrganizationCreditsSection.#escapeHtml(tag)}">${OrganizationCreditsSection.#escapeHtml(tag)}</option>`).join("")}
                            </select>
                        ` : `
                            <span class="organization-field-empty">No tags yet. Import members with a tags column to target groups &mdash; until then, credits go to everyone.</span>
                            <select class="organization-tag-select" multiple hidden></select>
                        `}
                    </label>
                </div>
                <div class="organization-form-grid">
                    <label class="admin-panel-add-field">
                        <span>Amount</span>
                        <input type="number" class="organization-distribute-amount" min="0" step="0.1" value="10">
                    </label>
                    <label class="admin-panel-add-field">
                        <span>Interpreted as</span>
                        <select class="organization-amount-mode">
                            <option value="${creditGrantAmountModes.PER_USER}">Credits per person</option>
                            <option value="${creditGrantAmountModes.TOTAL_SPLIT}">A total to split between them</option>
                        </select>
                    </label>
                </div>
                <div class="organization-form-actions">
                    <button type="button" class="admin-panel-add-submit organization-preview-distribution">Preview</button>
                </div>
                <div data-role="preview"></div>

                <h3 class="organization-section-heading">Recurring</h3>
                <p class="admin-panel-add-subtitle">Repeats on a schedule, drawing from the pool each time it runs. A cycle the pool can't cover is skipped and you're told — it isn't back-paid later.</p>
                <div class="organization-form-grid">
                    <label class="admin-panel-add-field">
                        <span>Name</span>
                        <input type="text" class="organization-recurring-name" maxlength="256" placeholder="Monthly credits for first-years">
                    </label>
                    <label class="admin-panel-add-field">
                        <span>Credits per person</span>
                        <input type="number" class="organization-recurring-amount" min="0" step="0.1" value="10">
                    </label>
                    <label class="admin-panel-add-field">
                        <span>Every</span>
                        <select class="organization-recurring-schedule">
                            <option value="${periodicScheduleTypes.DAY_OF_MONTH}">Month, on the 1st</option>
                            <option value="${periodicScheduleTypes.DAY_OF_WEEK}">Week, on Monday</option>
                            <option value="${periodicScheduleTypes.INTERVAL_DAYS}">30 days</option>
                        </select>
                    </label>
                </div>
                <div class="organization-form-actions">
                    <button type="button" class="admin-panel-add-submit organization-create-recurring">Start it</button>
                </div>
                <div data-role="recurring-list"></div>
            ` : `<p class="admin-panel-add-subtitle">You can see the pool, but giving credits out needs the credits power.</p>`}

            <h3 class="organization-section-heading">Spending</h3>
            <p class="admin-panel-add-subtitle">Per member, per feature. Members are told when they join that this is visible to you.</p>
            <div class="organization-form-actions">
                <button type="button" class="organization-secondary-button organization-download-spend">Download the spend report</button>
            </div>

            <h3 class="organization-section-heading">Pool history</h3>
            <p class="admin-panel-add-subtitle">Every movement in and out of the pool, newest first. Credits reaching a member are recorded here as one distribution, and the members who received them are named in the spreadsheet the preview produced.</p>
            ${OrganizationCreditsSection.#renderHistory(this.#overview.transactions)}
        `;

        this.#bindEvents();
        if (bMayDistribute)
        {
            this.#loadRecurring();
        }
    }

    /**
     * The pool's ledger, as it is stored — one row per movement, signed so a
     * top-up and a distribution are told apart at a glance.
     *
     * Only settled movements are shown. The ledger claims a row before it moves
     * anything, so a PENDING row is a movement still in flight or one that was
     * abandoned; listing those would have an administrator counting credits
     * twice or chasing a distribution that never happened.
     */
    static #renderHistory(transactions)
    {
        // Already filtered to the settled movements and already described by the
        // server, which owns the ledger's status vocabulary. Comparing status
        // strings here would mean a client guessing at values it cannot import.
        const settledTransactions = Array.isArray(transactions) ? transactions : [];

        if (settledTransactions.length === 0)
        {
            return `<p class="admin-panel-add-subtitle">Nothing has moved through this pool yet.</p>`;
        }

        return `
            <div class="organization-table-scroll">
                <table class="admin-panel-table">
                    <thead>
                        <tr><th>When</th><th>What</th><th>Change</th><th>Pool after</th><th>Note</th></tr>
                    </thead>
                    <tbody>
                        ${settledTransactions.map(transaction => `
                            <tr>
                                <td>${OrganizationCreditsSection.#escapeHtml(OrganizationCreditsSection.#formatTimestamp(transaction.createdAt))}</td>
                                <td>${OrganizationCreditsSection.#escapeHtml(transaction.description)}</td>
                                <td>${transaction.amount > 0 ? "+" : ""}${OrganizationCreditsSection.#escapeHtml(String(transaction.amount))}</td>
                                <td>${transaction.balanceAfter === null || transaction.balanceAfter === undefined ? "—" : OrganizationCreditsSection.#escapeHtml(String(transaction.balanceAfter))}</td>
                                <td>${OrganizationCreditsSection.#escapeHtml(transaction.note)}</td>
                            </tr>
                        `).join("")}
                    </tbody>
                </table>
            </div>
        `;
    }

    /**
     * Local time at the edge; the stored value is UTC.
     */
    static #formatTimestamp(storedTimestamp)
    {
        if (!storedTimestamp)
        {
            return "—";
        }

        const parsedDate = new Date(storedTimestamp);
        if (isNaN(parsedDate.getTime()))
        {
            return "—";
        }

        return parsedDate.toLocaleString();
    }

    #bindEvents()
    {
        for (const payButton of this.querySelectorAll(".organization-pay-deal"))
        {
            payButton.addEventListener("click", (clickEvent) =>
            {
                const dealId = clickEvent.currentTarget.closest("tr").dataset.dealId;
                this.#handlePayDeal(dealId, clickEvent.currentTarget);
            });
        }

        const previewButton = this.querySelector(".organization-preview-distribution");
        if (previewButton)
        {
            previewButton.addEventListener("click", () => this.#handlePreview(previewButton));
        }

        const recurringButton = this.querySelector(".organization-create-recurring");
        if (recurringButton)
        {
            recurringButton.addEventListener("click", () => this.#handleCreateRecurring(recurringButton));
        }

        this.querySelector(".organization-download-spend").addEventListener("click", () => this.#handleDownloadSpendReport());
    }

    #readDistributionRequest()
    {
        const tagMatchMode = Number(this.querySelector(".organization-tag-match-mode").value);
        const tagFilter = Array.from(this.querySelector(".organization-tag-select").selectedOptions).map(option => option.value);
        return {
            tagFilter: tagFilter,
            tagMatchMode: tagMatchMode,
            amount: Number(this.querySelector(".organization-distribute-amount").value),
            amountMode: Number(this.querySelector(".organization-amount-mode").value)
        };
    }

    async #handlePreview(triggerButton)
    {
        this.#clearStatus();
        triggerButton.disabled = true;
        triggerButton.textContent = "Working…";

        try
        {
            const distributionRequest = this.#readDistributionRequest();
            const response = await fetch("/Organization/Credits/Distribute/Preview",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ organizationId: this.#organizationId, ...distributionRequest })
            });
            const responseJson = await response.json().catch(() => ({}));

            if (!response.ok || responseJson.success === false)
            {
                this.#showError(OrganizationErrorMessages.describe(responseJson.error, response.status));
                return;
            }

            // A fresh key per staged preview: it is what makes confirming twice
            // — a double click, a retried request — credit each person once.
            this.#stagedPreview = responseJson;
            this.#stagedGrantKey = getRandomUuid();
            this.#renderPreview(responseJson);
        }
        catch (previewError)
        {
            this.#showError(previewError.message || "The request could not be sent.");
        }
        finally
        {
            triggerButton.disabled = false;
            triggerButton.textContent = "Preview";
        }
    }

    #renderPreview(preview)
    {
        const previewHost = this.querySelector('[data-role="preview"]');
        const payingRecipients = (preview.recipients || []).filter(recipient => recipient.granted > 0);
        const clampedCount = payingRecipients.filter(recipient => recipient.clampedByMonthlyCap).length;

        if (payingRecipients.length === 0)
        {
            previewHost.innerHTML = `<p class="organization-action-status organization-action-status-failure">Nobody would receive credits with those settings.</p>`;
            return;
        }

        previewHost.innerHTML = `
            <div class="organization-summary-grid">
                <div class="organization-summary-card">
                    <span class="organization-summary-label">Recipients</span>
                    <span class="organization-summary-value">${payingRecipients.length}</span>
                </div>
                <div class="organization-summary-card">
                    <span class="organization-summary-label">Each</span>
                    <span class="organization-summary-value">${preview.perUserAmount}</span>
                </div>
                <div class="organization-summary-card">
                    <span class="organization-summary-label">Total</span>
                    <span class="organization-summary-value">${preview.totalAmount}</span>
                </div>
                <div class="organization-summary-card">
                    <span class="organization-summary-label">Pool after</span>
                    <span class="organization-summary-value">${preview.poolBalanceAfter}</span>
                </div>
            </div>
            ${clampedCount > 0 ? `<p class="organization-action-status organization-action-status-failure">${clampedCount} recipient${clampedCount === 1 ? " is" : "s are"} capped by the monthly per-member limit and will receive less.</p>` : ""}
            ${preview.poolBalanceAfter < 0 ? `<p class="organization-action-status organization-action-status-failure">The pool doesn't hold enough for this.</p>` : ""}
            <div class="organization-table-scroll">
                <table class="admin-panel-table">
                    <thead><tr><th>Email</th><th>Tags</th><th>Before</th><th>Granted</th><th>After</th></tr></thead>
                    <tbody>
                        ${payingRecipients.slice(0, 20).map(recipient => `
                            <tr>
                                <td>${OrganizationCreditsSection.#escapeHtml(recipient.email)}</td>
                                <td>${OrganizationCreditsSection.#escapeHtml((recipient.tags || []).join(", "))}</td>
                                <td>${recipient.balanceBefore}</td>
                                <td>${recipient.granted}</td>
                                <td>${recipient.balanceAfter}</td>
                            </tr>
                        `).join("")}
                    </tbody>
                </table>
            </div>
            ${payingRecipients.length > 20 ? `<p class="admin-panel-add-subtitle">Showing the first 20 — download the sheet for all ${payingRecipients.length}.</p>` : ""}
            <div class="organization-form-actions">
                <button type="button" class="organization-secondary-button organization-download-preview">Download the sheet</button>
                <button type="button" class="admin-panel-add-submit organization-confirm-distribution" ${preview.poolBalanceAfter < 0 ? "disabled" : ""}>Give out ${preview.totalAmount} credits</button>
            </div>
        `;

        previewHost.querySelector(".organization-download-preview").addEventListener("click", () =>
        {
            CreditDistributionPreviewSheetBuilder.download(preview, this.#organization.name);
        });

        previewHost.querySelector(".organization-confirm-distribution").addEventListener("click", (clickEvent) =>
        {
            this.#handleApply(clickEvent.currentTarget);
        });
    }

    async #handleApply(triggerButton)
    {
        const preview = this.#stagedPreview;
        if (!preview)
        {
            return;
        }

        const payingCount = (preview.recipients || []).filter(recipient => recipient.granted > 0).length;
        const bConfirmed = await DialogBox.confirm
        (
            "Give out credits",
            `${preview.totalAmount} credits go to ${payingCount} member${payingCount === 1 ? "" : "s"}, leaving ${preview.poolBalanceAfter} in the pool. Credits are theirs once given and cannot be taken back.`
        );

        if (!bConfirmed)
        {
            return;
        }

        this.#clearStatus();
        triggerButton.disabled = true;
        triggerButton.textContent = "Giving…";

        try
        {
            const distributionRequest = this.#readDistributionRequest();
            const response = await fetch("/Organization/Credits/Distribute/Apply",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ organizationId: this.#organizationId, ...distributionRequest, grantKey: this.#stagedGrantKey })
            });
            const responseJson = await response.json().catch(() => ({}));

            if (!response.ok || responseJson.success === false)
            {
                this.#showError(OrganizationErrorMessages.describe(responseJson.error, response.status));
                return;
            }

            this.#stagedPreview = null;
            this.#stagedGrantKey = "";
            await this.#loadAndRender();
            this.#showStatus(`Gave ${responseJson.totalAmount} credits to ${responseJson.grantedCount} member${responseJson.grantedCount === 1 ? "" : "s"}.`, true);
            await this.#onChanged();
        }
        catch (applyError)
        {
            this.#showError(applyError.message || "The request could not be sent.");
        }
        finally
        {
            triggerButton.disabled = false;
        }
    }

    async #handlePayDeal(dealId, triggerButton)
    {
        const deal = (this.#overview.deals || []).find(candidate => candidate.id === dealId);
        if (!deal)
        {
            return;
        }

        this.#clearStatus();
        triggerButton.disabled = true;
        triggerButton.textContent = "Opening…";

        try
        {
            // The order was created when the deal was raised, so paying is the
            // checkout plus a verify — there is nothing to price here.
            const checkoutResult = await PaymentCheckout.open(deal.paymentProvider, deal.checkoutContext, { description: deal.label });
            if (!checkoutResult)
            {
                return;
            }

            const verifyResponse = await fetch("/Organization/Credits/Deals/Verify",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify
                ({
                    organizationId: this.#organizationId,
                    providerOrderId: checkoutResult.providerOrderId,
                    providerPaymentId: checkoutResult.providerPaymentId,
                    signature: checkoutResult.signature
                })
            });
            const verifyJson = await verifyResponse.json().catch(() => ({}));

            if (!verifyResponse.ok || verifyJson.success === false)
            {
                // The payment may still be captured — the webhook settles it
                // server-side either way, so this is a delay rather than a loss.
                this.#showError("The payment went through but confirming it here didn't. It will appear shortly — refresh in a moment.");
                return;
            }

            await this.#loadAndRender();
            this.#showStatus(`${verifyJson.creditsAdded} credits added to the pool.`, true);
        }
        catch (payError)
        {
            this.#showError(payError.message || "Checkout could not be opened.");
        }
        finally
        {
            triggerButton.disabled = false;
            triggerButton.textContent = "Pay";
        }
    }

    async #loadRecurring()
    {
        const recurringHost = this.querySelector('[data-role="recurring-list"]');
        if (!recurringHost)
        {
            return;
        }

        try
        {
            const response = await fetch(`/Organization/Credits/Periodic/List?organizationId=${encodeURIComponent(this.#organizationId)}`);
            const responseJson = await response.json().catch(() => ({}));

            if (!response.ok || responseJson.success === false)
            {
                recurringHost.innerHTML = "";
                return;
            }

            const assignments = Array.isArray(responseJson.assignments) ? responseJson.assignments : [];
            if (assignments.length === 0)
            {
                recurringHost.innerHTML = `<p class="admin-panel-add-subtitle">Nothing recurring yet.</p>`;
                return;
            }

            recurringHost.innerHTML = `
                <div class="organization-table-scroll">
                    <table class="admin-panel-table">
                        <thead><tr><th>Name</th><th>Per person</th><th>Next cycle</th><th>Cost</th><th></th></tr></thead>
                        <tbody>
                            ${assignments.map(assignment => `
                                <tr data-assignment-id="${OrganizationCreditsSection.#escapeHtml(assignment.id)}">
                                    <td>${OrganizationCreditsSection.#escapeHtml(assignment.name)}</td>
                                    <td>${assignment.amount}</td>
                                    <td>${assignment.nextCycleRecipientCount} member${assignment.nextCycleRecipientCount === 1 ? "" : "s"}</td>
                                    <td class="${assignment.bPoolCoversNextCycle ? "" : "organization-action-status-failure"}">${assignment.nextCycleCost}${assignment.bPoolCoversNextCycle ? "" : " — pool won't cover it"}</td>
                                    <td><button type="button" class="organization-secondary-button organization-stop-recurring">Stop</button></td>
                                </tr>
                            `).join("")}
                        </tbody>
                    </table>
                </div>
            `;

            for (const stopButton of recurringHost.querySelectorAll(".organization-stop-recurring"))
            {
                stopButton.addEventListener("click", (clickEvent) =>
                {
                    const assignmentId = clickEvent.currentTarget.closest("tr").dataset.assignmentId;
                    this.#handleStopRecurring(assignmentId, clickEvent.currentTarget);
                });
            }
        }
        catch (loadError)
        {
            recurringHost.innerHTML = "";
        }
    }

    async #handleCreateRecurring(triggerButton)
    {
        const name = this.querySelector(".organization-recurring-name").value.trim();
        const amount = Number(this.querySelector(".organization-recurring-amount").value);
        const scheduleType = Number(this.querySelector(".organization-recurring-schedule").value);
        const distributionRequest = this.#readDistributionRequest();

        if (name.length === 0 || !Number.isFinite(amount) || amount <= 0)
        {
            this.#showError("Give it a name and an amount above zero.");
            return;
        }

        this.#clearStatus();
        triggerButton.disabled = true;
        triggerButton.textContent = "Starting…";

        try
        {
            const response = await fetch("/Organization/Credits/Periodic/Create",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify
                ({
                    organizationId: this.#organizationId,
                    name: name,
                    tagFilter: distributionRequest.tagFilter,
                    tagMatchMode: distributionRequest.tagMatchMode,
                    amount: amount,
                    scheduleType: scheduleType,
                    intervalDays: 30,
                    dayOfWeek: 1,
                    dayOfMonth: 1
                })
            });
            const responseJson = await response.json().catch(() => ({}));

            if (!response.ok || responseJson.success === false)
            {
                this.#showError(OrganizationErrorMessages.describe(responseJson.error, response.status));
                return;
            }

            this.#showStatus("Recurring credits started.", true);
            await this.#loadRecurring();
        }
        catch (createError)
        {
            this.#showError(createError.message || "The request could not be sent.");
        }
        finally
        {
            triggerButton.disabled = false;
            triggerButton.textContent = "Start it";
        }
    }

    async #handleStopRecurring(assignmentId, triggerButton)
    {
        const bConfirmed = await DialogBox.confirm
        (
            "Stop these recurring credits",
            "Future cycles stop. Credits already given out stay with the members who received them."
        );

        if (!bConfirmed)
        {
            return;
        }

        triggerButton.disabled = true;

        try
        {
            const response = await fetch("/Organization/Credits/Periodic/Terminate",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ organizationId: this.#organizationId, assignmentId: assignmentId })
            });
            const responseJson = await response.json().catch(() => ({}));

            if (!response.ok || responseJson.success === false)
            {
                this.#showError(OrganizationErrorMessages.describe(responseJson.error, response.status));
                return;
            }

            this.#showStatus("Stopped.", true);
            await this.#loadRecurring();
        }
        catch (stopError)
        {
            this.#showError(stopError.message || "The request could not be sent.");
        }
        finally
        {
            triggerButton.disabled = false;
        }
    }

    async #handleDownloadSpendReport()
    {
        this.#clearStatus();

        try
        {
            const response = await fetch(`/Organization/Credits/SpendReport?organizationId=${encodeURIComponent(this.#organizationId)}`);
            const responseJson = await response.json().catch(() => ({}));

            if (!response.ok || responseJson.success === false)
            {
                this.#showError(OrganizationErrorMessages.describe(responseJson.error, response.status));
                return;
            }

            OrganizationSpendReportSheetBuilder.download(responseJson.report, this.#organization.name);
            this.#showStatus("Spend report downloaded.", true);
        }
        catch (reportError)
        {
            this.#showError(reportError.message || "The report could not be produced.");
        }
    }

    static #describeTermEnd(termEndsAt)
    {
        if (!termEndsAt)
        {
            return "Not set";
        }

        const endDate = new Date(termEndsAt);
        // The epoch sentinel means no term has ever been set, which is not the
        // same as a term that ended in 1970.
        if (isNaN(endDate.getTime()) || endDate.getTime() <= 0)
        {
            return "Not set";
        }

        return endDate.toLocaleDateString();
    }

    #showError(message)
    {
        const errorElement = this.querySelector('[data-role="error"]');
        if (errorElement)
        {
            errorElement.textContent = message;
            errorElement.hidden = false;
        }
        this.#showStatus(message, false);
    }

    #showStatus(message, bSucceeded)
    {
        const statusElement = this.querySelector('[data-role="status"]');
        if (!statusElement)
        {
            return;
        }
        statusElement.textContent = message || "";
        statusElement.classList.toggle("organization-action-status-success", bSucceeded === true);
        statusElement.classList.toggle("organization-action-status-failure", bSucceeded === false);
    }

    #clearStatus()
    {
        const errorElement = this.querySelector('[data-role="error"]');
        if (errorElement)
        {
            errorElement.hidden = true;
        }
        this.#showStatus("", null);
    }

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
}

customElements.define("organization-credits-section", OrganizationCreditsSection);
export default OrganizationCreditsSection;
