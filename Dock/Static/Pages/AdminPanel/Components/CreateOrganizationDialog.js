import DialogBox from "../../../CommonComponents/DialogBox.js";
import ZohoPaymentsCheckout from "../../../Globals/Classes/Payments/ZohoPaymentsCheckout.js";
import { organizationDeckPerkTypes } from "../../../Globals/Enumerations/OrganizationDeckPerkTypes.js";

/**
 * CreateOrganizationDialog
 *
 * Multi-step modal that drives the super-admin's organization-create
 * flow:
 *   1) Form          — name, admin email, currency, amount, maxMembers,
 *                      per-deck perks editor.
 *   2) Verification  — server sends an OTP to the appointed admin email;
 *                      super-admin types the code (received out-of-band)
 *                      back into the form, server returns a one-shot
 *                      verificationToken.
 *   3) Create        — Posts to /Admin/Organizations/Create. If amount
 *                      is 0, the org goes ACTIVE immediately. Otherwise
 *                      Zoho Payments checkout opens (mirroring the existing
 *                      paid-deck purchase flow). On success, the
 *                      verify-creation-payment endpoint is called.
 *
 * Returns true to the caller when an organization is created (or its
 * payment cleared), prompting the parent page to refresh.
 */
class CreateOrganizationDialog
{
    static async show()
    {
        let paidDecksCatalogue = [];
        try
        {
            const response = await fetch("/Admin/PaidDecks/List?includeUnpublished=true");
            if (response.ok)
            {
                const responseJson = await response.json();
                paidDecksCatalogue = Array.isArray(responseJson.decks) ? responseJson.decks : [];
            }
        }
        catch (loadError)
        {
            // Non-fatal — the admin can still create an org without perks.
            paidDecksCatalogue = [];
        }

        return new Promise((resolve) =>
        {
            const dialog = DialogBox.modal
            (`
                <div class="admin-panel-add-dialog create-organization-dialog">
                    <h2 class="admin-panel-add-title">Create organization</h2>
                    <p class="admin-panel-add-subtitle">Collect the deal details, verify the admin email, then take payment (or skip if free).</p>

                    <label class="admin-panel-add-field">
                        <span>Organization name</span>
                        <input type="text" class="organization-name" maxlength="256" autocomplete="off" placeholder="Acme University — Computer Science">
                    </label>

                    <label class="admin-panel-add-field">
                        <span>Admin email</span>
                        <input type="email" class="organization-admin-email" autocomplete="off" placeholder="admin@acme.edu">
                    </label>

                    <div class="admin-panel-add-field organization-otp-row">
                        <button type="button" class="organization-send-otp">Send verification code</button>
                        <span class="organization-otp-status" data-role="otp-status"></span>
                    </div>

                    <label class="admin-panel-add-field" data-role="otp-input-row" hidden>
                        <span>Verification code (6 digits)</span>
                        <input type="text" class="organization-otp-code" inputmode="numeric" autocomplete="off" maxlength="6" placeholder="123456">
                        <button type="button" class="organization-verify-otp">Verify code</button>
                    </label>

                    <div class="organization-fieldset" data-role="post-verification" hidden>
                        <label class="admin-panel-add-field">
                            <span>Currency</span>
                            <input type="text" class="organization-currency" value="INR" maxlength="8">
                        </label>
                        <label class="admin-panel-add-field">
                            <span>Creation fee (minor units — e.g. 100 = 1.00; 0 = no payment)</span>
                            <input type="number" class="organization-amount-minor" value="0" min="0">
                        </label>
                        <label class="admin-panel-add-field">
                            <span>Member capacity</span>
                            <input type="number" class="organization-max-members" value="50" min="1">
                        </label>

                        <div class="admin-panel-add-field">
                            <span>Paid-deck perks</span>
                            <div class="organization-perks-table" data-role="perks-table"></div>
                            <button type="button" class="organization-add-perk">+ Add deck perk</button>
                            <p class="admin-panel-add-subtitle">Perk types: FREE (auto-assigned to members), FIXED override (price in minor units), PERCENT discount (0–100). durationDays = 0 means forever.</p>
                        </div>
                    </div>

                    <div class="admin-panel-add-error" data-role="error" hidden></div>
                    <div class="admin-panel-add-actions">
                        <button type="button" class="admin-panel-add-cancel">Cancel</button>
                        <button type="button" class="admin-panel-add-submit organization-create" disabled>Create organization</button>
                    </div>
                </div>
            `);

            const nameInput = dialog.querySelector(".organization-name");
            const adminEmailInput = dialog.querySelector(".organization-admin-email");
            const sendOtpButton = dialog.querySelector(".organization-send-otp");
            const otpStatus = dialog.querySelector('[data-role="otp-status"]');
            const otpInputRow = dialog.querySelector('[data-role="otp-input-row"]');
            const otpCodeInput = dialog.querySelector(".organization-otp-code");
            const verifyOtpButton = dialog.querySelector(".organization-verify-otp");
            const postVerificationBlock = dialog.querySelector('[data-role="post-verification"]');
            const currencyInput = dialog.querySelector(".organization-currency");
            const amountInput = dialog.querySelector(".organization-amount-minor");
            const maxMembersInput = dialog.querySelector(".organization-max-members");
            const perksTable = dialog.querySelector('[data-role="perks-table"]');
            const addPerkButton = dialog.querySelector(".organization-add-perk");
            const errorElement = dialog.querySelector('[data-role="error"]');
            const createButton = dialog.querySelector(".organization-create");

            let verificationToken = null;
            const perkRows = [];

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
                    perksTable.innerHTML = `<p class="admin-panel-add-subtitle">No perks yet — members will pay the regular price for every deck.</p>`;
                    return;
                }
                perksTable.innerHTML = `
                    <table class="admin-panel-table">
                        <thead><tr><th>Deck</th><th>Perk type</th><th>Value (price in minor units, or % for discount)</th><th>Duration (days, 0 = forever)</th><th></th></tr></thead>
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

            const escape = (rawString) =>
            {
                if (rawString === null || rawString === undefined) return "";
                return String(rawString)
                    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
            };

            renderPerks();

            addPerkButton.addEventListener("click", () =>
            {
                if (paidDecksCatalogue.length === 0)
                {
                    showError("No paid decks available — upload at least one paid deck before configuring perks.");
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

            sendOtpButton.addEventListener("click", async () =>
            {
                const rawEmail = adminEmailInput.value.trim();
                const rawName = nameInput.value.trim();
                if (rawEmail.length === 0 || rawEmail.indexOf("@") < 0)
                {
                    showError("Enter a valid admin email first.");
                    return;
                }
                if (rawName.length === 0)
                {
                    showError("Enter the organization name first.");
                    return;
                }
                showError(null);
                sendOtpButton.disabled = true;
                sendOtpButton.textContent = "Sending…";
                try
                {
                    const response = await fetch("/Admin/Organizations/SendAdminVerificationOtp",
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ email: rawEmail, organizationName: rawName })
                    });
                    const responseJson = await response.json().catch(() => ({}));
                    if (!response.ok || responseJson.success === false)
                    {
                        showError(responseJson.error || `HTTP ${response.status}`);
                        return;
                    }
                    otpStatus.textContent = `Code sent to ${rawEmail}. Have them read you the 6-digit code.`;
                    otpInputRow.hidden = false;
                    otpCodeInput.focus();
                }
                catch (sendError)
                {
                    showError(sendError.message || "Could not send verification code.");
                }
                finally
                {
                    sendOtpButton.disabled = false;
                    sendOtpButton.textContent = "Send verification code";
                }
            });

            verifyOtpButton.addEventListener("click", async () =>
            {
                const rawEmail = adminEmailInput.value.trim();
                const rawCode = otpCodeInput.value.trim();
                if (!/^\d{6}$/.test(rawCode))
                {
                    showError("Enter the 6-digit code.");
                    return;
                }
                showError(null);
                verifyOtpButton.disabled = true;
                verifyOtpButton.textContent = "Verifying…";
                try
                {
                    const response = await fetch("/Admin/Organizations/VerifyAdminVerificationOtp",
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ email: rawEmail, code: rawCode })
                    });
                    const responseJson = await response.json().catch(() => ({}));
                    if (!response.ok || responseJson.success === false)
                    {
                        showError(responseJson.error || `HTTP ${response.status}`);
                        return;
                    }
                    verificationToken = responseJson.verificationToken;
                    otpStatus.textContent = "Verified — proceed to organization setup below.";
                    otpInputRow.hidden = true;
                    postVerificationBlock.hidden = false;
                    createButton.disabled = false;
                }
                catch (verifyError)
                {
                    showError(verifyError.message || "Could not verify code.");
                }
                finally
                {
                    verifyOtpButton.disabled = false;
                    verifyOtpButton.textContent = "Verify code";
                }
            });

            dialog.querySelector(".admin-panel-add-cancel").addEventListener("click", () =>
            {
                dialog.close();
                resolve(false);
            });

            createButton.addEventListener("click", async () =>
            {
                showError(null);
                if (!verificationToken)
                {
                    showError("Verify the admin email first.");
                    return;
                }
                const name = nameInput.value.trim();
                const adminEmail = adminEmailInput.value.trim().toLowerCase();
                const currency = currencyInput.value.trim().toUpperCase() || "INR";
                const amountMinor = parseInt(amountInput.value || "0", 10);
                const maxMembers = parseInt(maxMembersInput.value || "0", 10);

                if (name.length === 0 || adminEmail.length === 0 || maxMembers <= 0 || amountMinor < 0)
                {
                    showError("Fill every field — name, admin email, capacity > 0, amount >= 0.");
                    return;
                }

                createButton.disabled = true;
                createButton.textContent = "Creating…";

                try
                {
                    const createResponse = await fetch("/Admin/Organizations/Create",
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify
                        ({
                            name: name,
                            adminEmail: adminEmail,
                            verificationToken: verificationToken,
                            currency: currency,
                            amountMinor: amountMinor,
                            maxMembers: maxMembers,
                            deckPerks: perkRows
                        })
                    });
                    const createJson = await createResponse.json().catch(() => ({}));
                    if (!createResponse.ok || createJson.success === false)
                    {
                        showError(createJson.error || `HTTP ${createResponse.status}`);
                        createButton.disabled = false;
                        createButton.textContent = "Create organization";
                        return;
                    }

                    if (!createJson.requiresPayment)
                    {
                        dialog.close();
                        resolve(true);
                        return;
                    }

                    // Zoho Payments path — open the checkout exactly as the
                    // paid-deck library page does.
                    const checkoutContext = createJson.order?.checkoutContext;
                    if (!checkoutContext || !ZohoPaymentsCheckout.isAvailable())
                    {
                        showError("Zoho checkout not available — reload the page and try again.");
                        createButton.disabled = false;
                        createButton.textContent = "Create organization";
                        return;
                    }

                    let checkoutResult;
                    try
                    {
                        checkoutResult = await ZohoPaymentsCheckout.open(checkoutContext, { description: `Organization: ${name}` });
                    }
                    catch (checkoutError)
                    {
                        showError(checkoutError.message || "Zoho checkout failed.");
                        createButton.disabled = false;
                        createButton.textContent = "Create organization";
                        return;
                    }

                    if (!checkoutResult)
                    {
                        showError("Payment cancelled. The organization will remain in PENDING_PAYMENT until payment clears.");
                        createButton.disabled = false;
                        createButton.textContent = "Create organization";
                        return;
                    }

                    try
                    {
                        const verifyResponse = await fetch("/Admin/Organizations/VerifyCreationPayment",
                        {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify
                            ({
                                organizationId: createJson.organizationId,
                                providerOrderId: checkoutResult.providerOrderId,
                                providerPaymentId: checkoutResult.providerPaymentId,
                                signature: checkoutResult.signature
                            })
                        });
                        if (!verifyResponse.ok)
                        {
                            await DialogBox.alert("Payment captured but verify failed", "Zoho says the payment succeeded; our verification call did not. The webhook will reconcile this within a few seconds — refresh the list to confirm.");
                        }
                    }
                    catch (verifyError)
                    {
                        await DialogBox.alert("Payment verify error", verifyError.message || String(verifyError));
                    }
                    dialog.close();
                    resolve(true);
                }
                catch (createError)
                {
                    showError(createError.message || "Could not create organization.");
                    createButton.disabled = false;
                    createButton.textContent = "Create organization";
                }
            });

            nameInput.focus();
        });
    }
}

export default CreateOrganizationDialog;
