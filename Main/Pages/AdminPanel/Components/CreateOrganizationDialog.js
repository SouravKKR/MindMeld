import DialogBox from "../../../CommonComponents/DialogBox.js";
import OrganizationErrorMessages from "../../../Globals/Classes/Organization/OrganizationErrorMessages.js";
import { organizationDeckPerkTypes } from "../../../Globals/Enumerations/OrganizationDeckPerkTypes.js";

/**
 * CreateOrganizationDialog
 *
 * Two-step modal driving the super-admin's organization-create flow:
 *   1) Verification — the server emails a one-time code to the appointed owner;
 *      the super-admin types it back in and the server returns a one-shot
 *      verificationToken.
 *   2) Setup + create — name, currency, member capacity and the per-deck perk
 *      editor, posted to /Admin/Organizations/Create.
 *
 * Creating an organization is free, so there is no amount field, no checkout and
 * no pending state: the organization is ACTIVE the moment it is created. Money
 * is only ever taken for the credits an organization buys, which is a separate
 * negotiated deal.
 *
 * Resolves true when an organization was created, prompting the parent page to
 * refresh; false when the dialog was cancelled.
 */
class CreateOrganizationDialog
{
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
            // Non-fatal — an organization can be created without perks.
            paidDecksCatalogue = [];
        }

        return new Promise((resolve) =>
        {
            const dialog = DialogBox.modal
            (`
                <div class="admin-panel-add-dialog create-organization-dialog">
                    <h2 class="admin-panel-add-title">Create organization</h2>
                    <p class="admin-panel-add-subtitle">Verify the owner's email, then set up the organization. Creating one is free — credits are sold separately.</p>

                    <div class="admin-panel-add-error" data-role="error" hidden></div>

                    <label class="admin-panel-add-field">
                        <span>Organization name</span>
                        <input type="text" class="organization-name" maxlength="256" autocomplete="off" placeholder="Acme University — Computer Science">
                    </label>

                    <label class="admin-panel-add-field">
                        <span>Owner email</span>
                        <input type="email" class="organization-admin-email" autocomplete="off" placeholder="admin@acme.edu">
                    </label>

                    <div class="admin-panel-add-field organization-otp-row">
                        <button type="button" class="organization-secondary-button organization-send-otp">Send verification code</button>
                        <span class="organization-otp-status" data-role="otp-status"></span>
                    </div>

                    <div class="admin-panel-add-field organization-otp-verify-row" data-role="otp-input-row" hidden>
                        <span>Verification code (6 digits)</span>
                        <div class="organization-inline-row">
                            <input type="text" class="organization-otp-code" inputmode="numeric" autocomplete="off" maxlength="6" placeholder="123456">
                            <button type="button" class="organization-secondary-button organization-verify-otp">Verify code</button>
                        </div>
                    </div>

                    <div class="organization-fieldset" data-role="post-verification" hidden>
                        <label class="admin-panel-add-field">
                            <span>Currency</span>
                            <input type="text" class="organization-currency" value="INR" maxlength="8">
                        </label>
                        <label class="admin-panel-add-field">
                            <span>Member capacity</span>
                            <input type="number" class="organization-max-members" value="50" min="1">
                        </label>

                        <div class="admin-panel-add-field">
                            <span>Marketplace deck perks</span>
                            <div class="organization-perks-table" data-role="perks-table"></div>
                            <button type="button" class="organization-secondary-button organization-add-perk">+ Add deck perk</button>
                            <p class="admin-panel-add-subtitle">Perks discount CogniumLearn marketplace decks for this organization's members. FREE is auto-assigned; FIXED is a price in minor units; PERCENT is 0–100. Duration 0 means forever.</p>
                        </div>
                    </div>

                    <div class="admin-panel-add-actions">
                        <button type="button" class="admin-panel-add-cancel organization-cancel">Cancel</button>
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
                errorElement.scrollIntoView({ block: "nearest" });
            };

            const renderPerks = () =>
            {
                if (perkRows.length === 0)
                {
                    perksTable.innerHTML = `<p class="admin-panel-add-subtitle">No perks yet — members pay the regular price for every marketplace deck.</p>`;
                    return;
                }
                perksTable.innerHTML = `
                    <div class="organization-table-scroll">
                        <table class="admin-panel-table">
                            <thead><tr><th>Deck</th><th>Perk type</th><th>Value</th><th>Days</th><th></th></tr></thead>
                            <tbody>
                                ${perkRows.map((row, rowIndex) => `
                                    <tr data-perk-index="${rowIndex}">
                                        <td>
                                            <select class="organization-perk-deck" data-perk-index="${rowIndex}">
                                                ${paidDecksCatalogue.map(deck => `<option value="${CreateOrganizationDialog.#escapeHtml(deck.id)}" ${row.deckId === deck.id ? "selected" : ""}>${CreateOrganizationDialog.#escapeHtml(deck.title)}</option>`).join("")}
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
                                        <td><button type="button" class="organization-secondary-button organization-perk-remove" data-perk-index="${rowIndex}">Remove</button></td>
                                    </tr>
                                `).join("")}
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

            renderPerks();

            addPerkButton.addEventListener("click", () =>
            {
                if (paidDecksCatalogue.length === 0)
                {
                    showError("No marketplace decks available — upload at least one before configuring perks.");
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
                    showError("Enter a valid owner email first.");
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
                        showError(OrganizationErrorMessages.describe(responseJson.error, response.status));
                        return;
                    }
                    otpStatus.textContent = `Code sent to ${rawEmail}. Have them read you the 6-digit code.`;
                    otpInputRow.hidden = false;
                    otpCodeInput.focus();
                }
                catch (sendError)
                {
                    showError(sendError.message || "Could not send the verification code.");
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
                        showError(OrganizationErrorMessages.describe(responseJson.error, response.status));
                        return;
                    }
                    verificationToken = responseJson.verificationToken;
                    otpStatus.textContent = "Verified — finish the setup below.";
                    otpInputRow.hidden = true;
                    postVerificationBlock.hidden = false;
                    createButton.disabled = false;
                }
                catch (verifyError)
                {
                    showError(verifyError.message || "Could not verify the code.");
                }
                finally
                {
                    verifyOtpButton.disabled = false;
                    verifyOtpButton.textContent = "Verify code";
                }
            });

            dialog.querySelector(".organization-cancel").addEventListener("click", () =>
            {
                dialog.close();
                resolve(false);
            });

            // DialogBox.modal's own X — and the Escape key, which PopupStack
            // routes to it — closes the element without settling this promise,
            // leaving the caller awaiting forever.
            dialog.querySelector(".close-button").addEventListener("click", () =>
            {
                resolve(false);
            });

            createButton.addEventListener("click", async () =>
            {
                showError(null);
                if (!verificationToken)
                {
                    showError("Verify the owner's email first.");
                    return;
                }
                const name = nameInput.value.trim();
                const adminEmail = adminEmailInput.value.trim().toLowerCase();
                const currency = currencyInput.value.trim().toUpperCase() || "INR";
                const maxMembers = parseInt(maxMembersInput.value, 10);

                if (name.length === 0 || adminEmail.length === 0 || !Number.isInteger(maxMembers) || maxMembers <= 0)
                {
                    showError("Fill every field — name, owner email, and a member capacity above zero.");
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
                            maxMembers: maxMembers,
                            deckPerks: perkRows
                        })
                    });
                    const createJson = await createResponse.json().catch(() => ({}));
                    if (!createResponse.ok || createJson.success === false)
                    {
                        showError(OrganizationErrorMessages.describe(createJson.error, createResponse.status));
                        createButton.disabled = false;
                        createButton.textContent = "Create organization";
                        return;
                    }

                    dialog.close();
                    resolve(true);
                }
                catch (createError)
                {
                    showError(createError.message || "Could not create the organization.");
                    createButton.disabled = false;
                    createButton.textContent = "Create organization";
                }
            });

            nameInput.focus();
        });
    }
}

export default CreateOrganizationDialog;
