const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const OrganizationAuthorityResolver = require("../../../Globals/Classes/Organization/OrganizationAuthorityResolver");
const OrganizationEngagementReportBuilder = require("../../../Globals/Classes/Organization/OrganizationEngagementReportBuilder");
const { getPythonExecutablePathFromVenv } = require("../../../Globals/UtilityFunctions.js/GetPythonExecutablePathFromVenv");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");

/**
 * GET /Organization/Reports/Engagement?organizationId=...
 *
 * The engagement report as a PDF: what each member did with the organization's
 * decks, how often they used each AI feature, and a page per member showing
 * that usage over time.
 *
 * A PDF rather than a spreadsheet because the per-member usage pages are the
 * feature, and a sheet cannot carry a link from a row to a rendered chart. The
 * existing spend spreadsheet is untouched and still downloadable — it is what
 * administrators already pipe into their own tooling, and its disclaimer is
 * load-bearing.
 *
 * Gated by `resolve` rather than `requirePower`, matching the spend report:
 * reading what the organization's own members did needs standing, not a
 * specific delegated power.
 *
 * Modelled on DownloadAuditTrail — same spawn shape, same temp-directory
 * discipline, same existence pre-flight. Dock holds no rendering code; the
 * report is written to disk as JSON and a Python renderer in the Agent venv
 * turns it into the themed PDF.
 */

const RENDERER_RELATIVE_PATH = path.join("..", "Common", "Scripts", "RenderOrganizationEngagementReport.py");
const AGENT_VENV_RELATIVE_PATH = path.join("..", "Agent", ".venv");
const RENDER_TIMEOUT_MILLISECONDS = 180000;

function buildDownloadFileName(organizationName)
{
    const safeName = String(organizationName || "Organization")
        .replace(/[^a-zA-Z0-9._-]+/g, "_")
        .slice(0, 80);

    return `CogniumLearn-Engagement-${safeName}-${new Date().toISOString().slice(0, 10)}.pdf`;
}

/**
 * Spawns the renderer. Resolves on a clean exit, rejects with the renderer's
 * own stderr otherwise.
 *
 * The existence pre-flight is not defensive padding: `Common/` is not shipped
 * to a node wholesale — only the files named in the deploy script's
 * build_common_runtime_context reach one. A renderer missing from that list
 * produces a bare spawn ENOENT, which is exactly the failure this check turns
 * into a message that says what is wrong.
 */
function renderEngagementReportPdf(reportJsonPath, outputPdfPath)
{
    const pythonExecutablePath = getPythonExecutablePathFromVenv(path.join(__dirname, "..", "..", "..", AGENT_VENV_RELATIVE_PATH));
    const rendererPath = path.join(__dirname, "..", "..", "..", RENDERER_RELATIVE_PATH);

    return new Promise((resolve, reject) =>
    {
        if (!fs.existsSync(pythonExecutablePath))
        {
            reject(new Error(`The report renderer's Python environment is not installed on this server (${pythonExecutablePath}).`));
            return;
        }

        if (!fs.existsSync(rendererPath))
        {
            reject(new Error(`The report renderer is not installed on this server (${rendererPath}).`));
            return;
        }

        const rendererProcess = spawn(pythonExecutablePath, [rendererPath, reportJsonPath, outputPdfPath], { windowsHide: true });

        let standardErrorText = "";

        rendererProcess.stderr.on("data", (chunk) =>
        {
            standardErrorText += chunk.toString();
        });

        const timeoutHandle = setTimeout(() =>
        {
            rendererProcess.kill();
            reject(new Error(`The report renderer timed out after ${RENDER_TIMEOUT_MILLISECONDS}ms.`));
        }, RENDER_TIMEOUT_MILLISECONDS);

        rendererProcess.on("error", (spawnError) =>
        {
            clearTimeout(timeoutHandle);
            reject(new Error(`Could not start the report renderer: ${spawnError.message}`));
        });

        rendererProcess.on("close", (exitCode) =>
        {
            clearTimeout(timeoutHandle);

            if (exitCode === 0)
            {
                resolve();
                return;
            }

            reject(new Error(`The report renderer exited with code ${exitCode}. ${standardErrorText.trim().slice(0, 800)}`));
        });
    });
}

async function downloadEngagementReport(request, response)
{
    const queryParameters = await request.getQueryParams();
    // Same casing the spend report reads — packetron preserves the key as sent,
    // so a lower-cased lookup silently finds nothing and every request 400s.
    const organizationId = typeof queryParameters?.organizationId === "string" ? queryParameters.organizationId : "";

    const authority = await OrganizationAuthorityResolver.resolve(request.user, organizationId);

    if (!authority.allowed)
    {
        response.statusCode = OrganizationAuthorityResolver.statusForDenial(authority);
        response.sendJson({ success: false, error: authority.reason });
        return;
    }

    const workingDirectory = path.join(os.tmpdir(), `cogniumlearn-engagement-${crypto.randomBytes(8).toString("hex")}`);
    const reportJsonPath = path.join(workingDirectory, "engagement.json");
    const outputPdfPath = path.join(workingDirectory, "EngagementReport.pdf");

    try
    {
        const report = await OrganizationEngagementReportBuilder.build(authority.organization);

        await fs.promises.mkdir(workingDirectory, { recursive: true });
        await fs.promises.writeFile(reportJsonPath, JSON.stringify(report), "utf8");

        await renderEngagementReportPdf(reportJsonPath, outputPdfPath);

        const pdfBuffer = await fs.promises.readFile(outputPdfPath);

        response.statusCode = httpStatus.OK;
        response.setHeader("Content-Type", "application/pdf");
        response.setHeader("Content-Disposition", `attachment; filename="${buildDownloadFileName(authority.organization.getName())}"`);
        response.setHeader("Content-Length", String(pdfBuffer.length));
        response.end(pdfBuffer);
    }
    catch (renderError)
    {
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: ErrorCodes.ENGAGEMENT_REPORT_RENDER_FAILED, detail: renderError.message });
    }
    finally
    {
        try
        {
            await fs.promises.rm(workingDirectory, { recursive: true, force: true });
        }
        catch (cleanupError)
        {
            console.warn(`[EngagementReport] Could not remove ${workingDirectory}: ${cleanupError?.message || cleanupError}`);
        }
    }
}

module.exports = { downloadEngagementReport, renderEngagementReportPdf };
