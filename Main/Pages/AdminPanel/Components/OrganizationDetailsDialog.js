import DialogBox from "../../../CommonComponents/DialogBox.js";
import { organizationStatus } from "../../../Globals/Enumerations/OrganizationStatus.js";
import { organizationDeckPerkTypes } from "../../../Globals/Enumerations/OrganizationDeckPerkTypes.js";

/**
 * OrganizationDetailsDialog
 *
 * Super-admin view + edit for a single organization: shows payments,
 * lets the admin update the perk set, and exposes the "Expand
 * capacity" flow (Razorpay-driven). Member management is handled by
 * the org admin's own tab; this dialog stays focused on the deal terms
 * and lifecycle.
 *
 * Resolves true when the caller should refresh its list (perks updated
 * or capacity expanded), false on a pure cancel.
 */
class OrganizationDetailsDialog
{
    static async show(organizationId)
    {
        const detailsResponse = await fetch(`/Admin/Organizations/Get?organizationId=${encodeURIComponent(organizationId)}`);
        if (!detailsResponse.ok)
        {
            await DialogBox.alert("Could not load organization", `HTTP ${detailsResponse.status}`);
            return false;
        }
        const detailsJson = await detailsResponse.json();
        if (!detailsJson.success)
        {
            await DialogBox.alert("Could not load organization", detailsJson.error || "Unknown");
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

        return new Promise((resolve) =>
        {
            const escape = (rawString) =>
            {
                if (rawString === null || rawString === undefined) return "";
                return String(rawString)
                    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
            };

            const statusLabel = (statusValue) =>
            {
                if (statusValue === organizationStatus.PENDING_PAYMENT) return "Pending payment";
                if (statusValue === organizationStatus.ACTIVE) return "Active";
                if (statusValue === organizationStatus.SUSPENDED) return "Suspended";
                return String(statusValue);
            };

            const dialog = DialogBox.modal
            (`
                <div class="admin-panel-add-dialog organization-details-dialog">
                    <h2 class="admin-panel-add-title">${escape(organization.name)}</h2>
                    <p class="admin-panel-add-subtitle">
                        Admin: <strong>${escape(organization.adminEmail)}</strong> ·
                        Status: <strong>${escape(statusLabel(organization.status))}</strong> ·
                        Members: <strong>${organization.currentMemberCount} / ${organization.maxMembers}</strong> ·
                        Currency: <strong>${escape(organization.currency)}</strong>
                    </p>

                    <h3>Paid-deck perks</h3>
                    <div class="organization-perks-table" data-role="perks-table"></div>
                    <button type="button" class="organization-add-perk">+ Add deck perk</button>
                    <button type="button" class="organization-save-perks">Save perks</button>
                    <p class="admin-panel-add-subtitle">Adding a FREE perk auto-mints licenses for every existing member with an account. Existing licenses are not affected by removing perks here.</p>

                    <h3>Expand capacity</h3>
                    <div class="organization-expansion-row">
                        <label>Additional members <input type="number" class="organization-expansion-count" min="1" value="10"></label>
                        <label>Amount (minor units, 0 = free) <input type="number" class="organization-expansion-amount" min="0" value="0"></label>
                        <button type="button" class="organization-expand">Expand</button>
                    </div>

                    <h3>Payment history</h3>
                    <table class="admin-panel-table">
                        <thead><tr><th>Kind</th><th>Status</th><th>Amount</th><th>Created</th></tr></thead>
                        <tbody>
                            ${(detailsJson.payments || []).map(payment => `
                                <tr>
                                    <td>${payment.kind === 0 ? "CREATION" : "EXPANSION"}</td>
                                    <td>${payment.status}</td>
                                    <td>${payment.amountMinor} ${escape(payment.currency)}</td>
                                    <td>${new Date(payment.createdAt).toLocaleString()}</td>
                                </tr>
                            `).join("")}
                        </tbody>
                    </table>

                    <div class="admin-panel-add-error" data-role="error" hidden></div>
                    <div class="admin-panel-add-actions">
                        <button type="button" class="admin-panel-add-cancel">Close</button>
                    </div>
                </div>
            `);

            const perksTable = dialog.querySelector('[data-role="perks-table"]');
            const errorElement = dialog.querySelector('[data-role="error"]');
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
            };

            const renderPerks = () =>
            {
                if (perkRows.length === 0)
                {
                    perksTable.innerHTML = `<p class="admin-panel-add-subtitle">No perks. Members pay regular prices.</p>`;
                    return;
                }
                perksTable.innerHTML = `
                    <table class="admin-panel-table">
                        <thead><tr><th>Deck</th><th>Perk type</th><th>Value</th><th>Duration (days, 0=forever)</th><th></th></tr></thead>
                        <tbody>
                            ${perkRows.map((row, rowIndex) => `
                                <tr data-perk-index="${rowIndex}">
                                    <td>
                                        <select class="organization-perk-deck" data-perk-index="${rowIndex}">
                                            ${paidDecksCatalogue.map(deck => `<option value="${escape(deck.id)}" ${row.deckId === deck.id ? "selected" : ""}>${escape(deck.title)}</option>`).join("")}
                                        </select>
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
                                    <td><button type="button" class="organization-perk-remove" data-perk-index="${rowIndex}">Remove</button></td>
                                </tr>
                            `).join("")}
                        </tbody>
                    </table>
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
                        perkRows[rowIndex].perkValue = parseInt(inputEvent.currentTarget.value || "0", 10);
                    });
                }
                for (const input of perksTable.querySelectorAll(".organization-perk-duration"))
                {
                    input.addEventListener("input", (inputEvent) =>
                    {
                        const rowIndex = Number(inputEvent.currentTarget.dataset.perkIndex);
                        perkRows[rowIndex].durationDays = parseInt(inputEvent.currentTarget.value || "0", 10);
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

            renderPerks();

            dialog.querySelector(".organization-add-perk").addEventListener("click", () =>
            {
                if (paidDecksCatalogue.length === 0)
                {
                    showError("No paid decks available — upload one first.");
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

            dialog.querySelector(".organization-save-perks").addEventListener("click", async () =>
            {
                showError(null);
                const response = await fetch("/Admin/Organizations/UpdatePerks",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ organizationId: organization.id, perks: perkRows })
                });
                const responseJson = await response.json().catch(() => ({}));
                if (!response.ok || responseJson.success === false)
                {
                    showError(responseJson.error || `HTTP ${response.status}`);
                    return;
                }
                dialogChangedSomething = true;
                await DialogBox.alert("Perks saved", `Replaced ${responseJson.replaced} perk${responseJson.replaced === 1 ? "" : "s"}. Auto-assigned ${responseJson.autoAssignedDecks || 0} deck license${(responseJson.autoAssignedDecks || 0) === 1 ? "" : "s"} to existing members.`);
            });

            dialog.querySelector(".organization-expand").addEventListener("click", async () =>
            {
                showError(null);
                const additionalMembers = parseInt(dialog.querySelector(".organization-expansion-count").value || "0", 10);
                const amountMinor = parseInt(dialog.querySelector(".organization-expansion-amount").value || "0", 10);

                if (additionalMembers <= 0 || amountMinor < 0)
                {
                    showError("Additional members must be > 0 and amount >= 0.");
                    return;
                }

                const initiateResponse = await fetch("/Admin/Organizations/InitiateExpansion",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify
                    ({
                        organizationId: organization.id,
                        additionalMembers: additionalMembers,
                        amountMinor: amountMinor
                    })
                });
                const initiateJson = await initiateResponse.json().catch(() => ({}));
                if (!initiateResponse.ok || initiateJson.success === false)
                {
                    showError(initiateJson.error || `HTTP ${initiateResponse.status}`);
                    return;
                }

                if (!initiateJson.requiresPayment)
                {
                    dialogChangedSomething = true;
                    await DialogBox.alert("Capacity extended", `New cap: ${initiateJson.newMaxMembers}.`);
                    dialog.close();
                    resolve(true);
                    return;
                }

                const checkoutContext = initiateJson.order?.checkoutContext;
                if (!checkoutContext || typeof window.Razorpay !== "function")
                {
                    showError("Razorpay checkout not available — reload the page and try again.");
                    return;
                }

                const razorpayInstance = new window.Razorpay
                ({
                    key: checkoutContext.keyId,
                    amount: checkoutContext.amount,
                    currency: checkoutContext.currency,
                    order_id: checkoutContext.orderId,
                    name: "MindMeld",
                    description: `Capacity expansion: +${additionalMembers}`,
                    handler: async (paymentResult) =>
                    {
                        try
                        {
                            await fetch("/Admin/Organizations/VerifyExpansionPayment",
                            {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify
                                ({
                                    organizationId: organization.id,
                                    providerOrderId: paymentResult.razorpay_order_id,
                                    providerPaymentId: paymentResult.razorpay_payment_id,
                                    signature: paymentResult.razorpay_signature
                                })
                            });
                        }
                        catch (verifyError)
                        {
                            // Webhook will reconcile.
                        }
                        dialogChangedSomething = true;
                        dialog.close();
                        resolve(true);
                    }
                });
                razorpayInstance.open();
            });

            dialog.querySelector(".admin-panel-add-cancel").addEventListener("click", () =>
            {
                dialog.close();
                resolve(dialogChangedSomething);
            });
        });
    }
}

export default OrganizationDetailsDialog;
