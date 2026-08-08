import DialogBox from "../../../CommonComponents/DialogBox.js";
import OrganizationErrorMessages from "../../../Globals/Classes/Organization/OrganizationErrorMessages.js";

/**
 * OrganizationReportsSection — where an organization downloads what it can
 * prove about its own members.
 *
 * The Credits section already offers the spend report, which answers "what did
 * this cost". This section answers the question an institute actually asks
 * first — "is this student using the app, and what are they doing with it" —
 * and it is a different document with a different shape.
 *
 * A PDF rather than a spreadsheet, because each member gets their own page of
 * usage-over-time heatmaps and a row in a sheet cannot link to a chart. The
 * spend spreadsheet is untouched and still lives under Credits; administrators
 * already pipe it into their own tooling.
 *
 * Readable by anyone with standing, matching Credits and Decks — reading what
 * your own members did is not a privileged action, and the endpoint re-checks
 * regardless.
 */
class OrganizationReportsSection extends HTMLElement
{
    static #ENGAGEMENT_ENDPOINT = "/Organization/Reports/Engagement";

    #organizationId = "";
    #organization = null;
    #authority = null;

    initialize(context)
    {
        this.#organizationId = context.organizationId;
        this.#organization = context.organization;
        this.#authority = context.authority;
    }

    connectedCallback()
    {
        this.innerHTML = `
            <div class="organization-reports-section">
                <h3 class="organization-section-heading">Engagement</h3>
                <p class="admin-panel-add-subtitle">
                    What each member did with this organization's decks, how often they used each AI feature,
                    and a page per member showing that usage over time.
                </p>

                <ul class="organization-reports-contents">
                    <li>Engagement with this organization's decks — cards studied, materials viewed, mock tests, curated study</li>
                    <li>AI feature usage counts, per member and per feature</li>
                    <li>One "usage over time" page per member, with a heatmap for every feature that has dated history</li>
                </ul>

                <div class="organization-reports-note">
                    Mock tests, curated study and AI usage are measured on the server. Cards studied and study
                    materials viewed are reported by each member's device, because neither is timestamped on the
                    server — the report labels which is which on every page.
                </div>

                <button type="button" class="organization-secondary-button organization-download-engagement">
                    Download the engagement report (PDF)
                </button>

                <div class="organization-reports-status" data-role="status" hidden></div>
            </div>
        `;

        this.querySelector(".organization-download-engagement")
            .addEventListener("click", () => this.#handleDownloadEngagementReport());
    }

    async #handleDownloadEngagementReport()
    {
        const downloadButton = this.querySelector(".organization-download-engagement");

        downloadButton.disabled = true;
        downloadButton.textContent = "Building the report…";
        this.#clearStatus();

        try
        {
            const response = await fetch(
                `${OrganizationReportsSection.#ENGAGEMENT_ENDPOINT}?organizationId=${encodeURIComponent(this.#organizationId)}`);

            // A success is a PDF and a failure is JSON, so the status is
            // checked before the body is read — reading a blob as JSON, or the
            // reverse, produces a confusing error about the wrong thing.
            if (!response.ok)
            {
                const failure = await response.json().catch(() => ({}));
                await DialogBox.alert(
                    "Couldn't build the report",
                    failure.detail || OrganizationErrorMessages.describe(failure.error, response.status),
                );
                return;
            }

            OrganizationReportsSection.#triggerDownload(await response.blob(), this.#buildFileName());
            this.#showStatus("Engagement report downloaded.");
        }
        catch (downloadError)
        {
            await DialogBox.alert("Couldn't build the report", downloadError.message);
        }
        finally
        {
            downloadButton.disabled = false;
            downloadButton.textContent = "Download the engagement report (PDF)";
        }
    }

    #buildFileName()
    {
        const organizationName = String(this.#organization?.name || "Organization").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
        return `CogniumLearn-Engagement-${organizationName}-${new Date().toISOString().slice(0, 10)}.pdf`;
    }

    static #triggerDownload(pdfBlob, fileName)
    {
        const objectUrl = URL.createObjectURL(pdfBlob);
        const downloadLink = document.createElement("a");

        downloadLink.href = objectUrl;
        downloadLink.download = fileName;
        document.body.appendChild(downloadLink);
        downloadLink.click();
        downloadLink.remove();

        // Revoked a tick later rather than immediately: revoking inside the
        // same task can beat the browser's own read of the blob and produce an
        // empty file, which SpreadsheetWriter records having hit.
        setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    }

    #showStatus(message)
    {
        const statusElement = this.querySelector('[data-role="status"]');
        statusElement.textContent = message;
        statusElement.hidden = false;
    }

    #clearStatus()
    {
        const statusElement = this.querySelector('[data-role="status"]');
        statusElement.textContent = "";
        statusElement.hidden = true;
    }
}

customElements.define("organization-reports-section", OrganizationReportsSection);

export default OrganizationReportsSection;
