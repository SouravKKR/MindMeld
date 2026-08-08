import DialogBox from "../../../CommonComponents/DialogBox.js";
import SpreadsheetWriter from "../../../Globals/Classes/SpreadsheetWriter.js";
import OrganizationErrorMessages from "../../../Globals/Classes/Organization/OrganizationErrorMessages.js";

/**
 * RuleMatchPreviewDialog
 *
 * Who a permission rule currently covers — the count, and every member by name.
 *
 * A rule stopped being readable at a glance the moment it could say "admitted
 * between 2022 and 2024, role teacher, tagged scholarship". Nobody can tell by
 * eye whether that sentence describes four people or four hundred, and the
 * mistake it hides is handing a paid feature to an entire roster. This is the
 * only thing standing between writing such a rule and saving it, so it lists
 * everyone rather than a sample — a handful of example addresses answers "does
 * this work" but not "who did I just include", which is the question actually
 * being asked.
 *
 * The list is downloadable because checking a cohort against the institute's own
 * records is not something anyone should have to do by scrolling.
 */
class RuleMatchPreviewDialog
{
    static #PREVIEW_ENDPOINT = "/Organization/Permissions/PreviewRule";

    /**
     * @param {{organizationId: string, ruleName: string, tagFilter: string[],
     *          matchMode: number, attributeConditions: Array<object>}} context
     */
    static async show({ organizationId, ruleName, tagFilter, matchMode, attributeConditions })
    {
        const dialog = DialogBox.modal(`
            <div class="organization-rule-preview">
                <h2 class="admin-panel-add-title">Who this rule covers</h2>
                <p class="admin-panel-add-subtitle">Checking…</p>
            </div>
        `);

        const hostElement = dialog.querySelector(".organization-rule-preview");

        let responseJson = {};
        let statusCode = 0;

        try
        {
            const response = await fetch(RuleMatchPreviewDialog.#PREVIEW_ENDPOINT,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify
                ({
                    organizationId: organizationId,
                    tagFilter: tagFilter,
                    matchMode: matchMode,
                    attributeConditions: attributeConditions
                })
            });

            statusCode = response.status;
            responseJson = await response.json().catch(() => ({}));

            if (!response.ok || responseJson.success === false)
            {
                hostElement.innerHTML = `<h2 class="admin-panel-add-title">Who this rule covers</h2><div class="admin-panel-add-error"></div>`;
                hostElement.querySelector(".admin-panel-add-error").textContent = OrganizationErrorMessages.describe(responseJson.error, statusCode);
                return;
            }
        }
        catch (previewError)
        {
            hostElement.innerHTML = `<h2 class="admin-panel-add-title">Who this rule covers</h2><div class="admin-panel-add-error"></div>`;
            hostElement.querySelector(".admin-panel-add-error").textContent = previewError.message || "Could not work out who this rule covers.";
            return;
        }

        const members = Array.isArray(responseJson.members) ? responseJson.members : [];
        hostElement.innerHTML = RuleMatchPreviewDialog.#buildMarkup(ruleName, responseJson, members);

        const downloadButton = hostElement.querySelector('[data-role="download"]');
        if (downloadButton)
        {
            downloadButton.addEventListener("click", () =>
            {
                RuleMatchPreviewDialog.#downloadMembers(ruleName, members);
            });
        }

        const closeButton = hostElement.querySelector('[data-role="close"]');
        if (closeButton)
        {
            closeButton.addEventListener("click", () => dialog.close());
        }
    }

    static #downloadMembers(ruleName, members)
    {
        // Every column any matched member carries, so the download can be
        // checked against the institute's own records rather than only telling
        // them addresses they already had.
        const attributeKeys = [];
        for (const member of members)
        {
            for (const attributeKey of Object.keys(member.attributes || {}))
            {
                if (!attributeKeys.includes(attributeKey))
                {
                    attributeKeys.push(attributeKey);
                }
            }
        }

        const headerRow = ["email", "tags", ...attributeKeys];
        const memberRows = members.map(member =>
        [
            member.email,
            Array.isArray(member.tags) ? member.tags.join("; ") : "",
            ...attributeKeys.map(attributeKey => (member.attributes || {})[attributeKey] || "")
        ]);

        SpreadsheetWriter.downloadWorkbook([headerRow, ...memberRows], `rule-${ruleName || "members"}`, "Members");
    }

    static #buildMarkup(ruleName, previewResult, members)
    {
        const matchedCount = Number(previewResult.matchedCount) || 0;

        const scopeNotice = previewResult.matchesEveryone
            ? `<p class="organization-action-status organization-action-status-failure">This rule narrows nothing, so it covers every member of the organization.</p>`
            : "";

        const truncationNotice = previewResult.truncated
            ? `<p class="admin-panel-add-subtitle">Showing the first ${members.length} of them.</p>`
            : "";

        if (matchedCount === 0)
        {
            return `
                <h2 class="admin-panel-add-title">Who this rule covers</h2>
                <p class="admin-panel-add-subtitle">${RuleMatchPreviewDialog.#escape(ruleName || "This rule")} currently matches <strong>nobody</strong>. Check the tags and conditions — a rule matching no one looks exactly like a rule that is simply not being met.</p>
                <div class="admin-panel-add-actions">
                    <button type="button" class="organization-secondary-button" data-role="close">Close</button>
                </div>
            `;
        }

        const memberRows = members.map(member => `
            <tr>
                <td>${RuleMatchPreviewDialog.#escape(member.email)}</td>
                <td>${RuleMatchPreviewDialog.#escape(Array.isArray(member.tags) ? member.tags.join(", ") : "")}</td>
            </tr>
        `).join("");

        return `
            <h2 class="admin-panel-add-title">Who this rule covers</h2>
            <p class="admin-panel-add-subtitle">
                ${RuleMatchPreviewDialog.#escape(ruleName || "This rule")} covers
                <strong>${matchedCount} member${matchedCount === 1 ? "" : "s"}</strong>.
            </p>
            ${scopeNotice}
            ${truncationNotice}

            <div class="organization-rule-preview-list">
                <table class="admin-list-table">
                    <thead><tr><th>Email</th><th>Tags</th></tr></thead>
                    <tbody>${memberRows}</tbody>
                </table>
            </div>

            <div class="admin-panel-add-actions">
                <button type="button" class="organization-secondary-button" data-role="close">Close</button>
                <button type="button" class="admin-panel-add-submit" data-role="download">Download the list</button>
            </div>
        `;
    }

    static #escape(rawValue)
    {
        return String(rawValue ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }
}

export default RuleMatchPreviewDialog;
