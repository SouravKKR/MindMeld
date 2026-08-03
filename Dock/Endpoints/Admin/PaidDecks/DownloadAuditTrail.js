const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const GenerationProvenanceQueryEngine = require("../../../Globals/Classes/Database/GenerationProvenanceQueryEngine");
const { getPythonExecutablePathFromVenv } = require("../../../Globals/UtilityFunctions.js/GetPythonExecutablePathFromVenv");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");

/**
 * GET /Admin/PaidDecks/AuditTrail?deckId=...
 *
 * Streams the generation audit trail for one paid deck as a PDF.
 *
 * The report is rendered STRICTLY from the stored provenance document. This
 * handler reads that one document, hands it to the renderer, and streams the
 * result — it does not re-query the task bucket, re-run any check, or fill in a
 * field the record does not contain. That restraint is the point: a report that
 * reconstructs its own evidence at render time is not evidence of anything.
 *
 * There is deliberately NO filter parameter. The trail is all-or-nothing by
 * design — a report that could be asked for "only the successful actions" would
 * be a report nobody should believe.
 *
 * Registered behind ensureAdmin, so AdminActionAuditor records the download
 * itself with no extra wiring here.
 */

// Where the renderer and the Python that runs it live, relative to Dock/.
const RENDERER_RELATIVE_PATH = path.join("..", "Common", "Scripts", "RenderPaidDeckAuditTrail.py");
const AGENT_VENV_RELATIVE_PATH = path.join("..", "Agent", ".venv");

// A very large deck's trail still renders in seconds; anything past this is a
// wedged subprocess, not slow work.
const RENDER_TIMEOUT_MILLISECONDS = 120000;


function buildDownloadFileName(provenanceRecord)
{
    const rawName = provenanceRecord.deckName || provenanceRecord.deckId || "deck";
    const safeName = String(rawName).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "deck";
    return `CogniumLearn-AuditTrail-${safeName}.pdf`;
}


function renderAuditTrailPdf(provenanceJsonPath, outputPdfPath)
{
    return new Promise((resolve, reject) =>
    {
        const pythonExecutablePath = getPythonExecutablePathFromVenv(path.join(__dirname, "..", "..", "..", AGENT_VENV_RELATIVE_PATH));
        const rendererPath = path.join(__dirname, "..", "..", "..", RENDERER_RELATIVE_PATH);

        const rendererProcess = spawn(pythonExecutablePath, [rendererPath, provenanceJsonPath, outputPdfPath], { windowsHide: true });

        let standardErrorText = "";
        rendererProcess.stderr.on("data", (chunk) => { standardErrorText += chunk.toString(); });
        rendererProcess.stdout.on("data", () => { /* progress only — the PDF goes to disk */ });

        const timeoutHandle = setTimeout(() =>
        {
            rendererProcess.kill();
            reject(new Error(`Audit-trail renderer timed out after ${RENDER_TIMEOUT_MILLISECONDS}ms.`));
        }, RENDER_TIMEOUT_MILLISECONDS);

        rendererProcess.on("error", (spawnError) =>
        {
            clearTimeout(timeoutHandle);
            reject(spawnError);
        });

        rendererProcess.on("close", (exitCode) =>
        {
            clearTimeout(timeoutHandle);
            if (exitCode === 0)
            {
                resolve();
                return;
            }
            reject(new Error(`Audit-trail renderer exited with code ${exitCode}. ${standardErrorText.slice(0, 800)}`));
        });
    });
}


async function downloadAuditTrail(request, response)
{
    const queryParams = await request.getQueryParams();
    const deckId = queryParams.deckId;

    if (!deckId)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_DECK_ID });
        return;
    }

    const provenanceRecord = await GenerationProvenanceQueryEngine.findByDeckId(deckId);

    if (provenanceRecord === null)
    {
        // 404 rather than an empty report. A deck with no provenance record was
        // not produced by this pipeline, and rendering a blank audit trail for it
        // would imply a record exists and is empty — a materially different and
        // false claim.
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.PROVENANCE_NOT_FOUND });
        return;
    }

    const workingDirectory = path.join(os.tmpdir(), `cogniumlearn-audit-${crypto.randomBytes(8).toString("hex")}`);
    const provenanceJsonPath = path.join(workingDirectory, "provenance.json");
    const outputPdfPath = path.join(workingDirectory, "AuditTrail.pdf");

    try
    {
        await fs.promises.mkdir(workingDirectory, { recursive: true });
        await fs.promises.writeFile(provenanceJsonPath, JSON.stringify(provenanceRecord), "utf8");

        await renderAuditTrailPdf(provenanceJsonPath, outputPdfPath);

        const pdfBuffer = await fs.promises.readFile(outputPdfPath);

        response.statusCode = httpStatus.OK;
        response.setHeader("Content-Type", "application/pdf");
        response.setHeader("Content-Disposition", `attachment; filename="${buildDownloadFileName(provenanceRecord)}"`);
        response.setHeader("Content-Length", String(pdfBuffer.length));
        response.end(pdfBuffer);
    }
    catch (renderError)
    {
        console.error(`[DownloadAuditTrail] Could not render the audit trail for deck ${deckId}: ${renderError.message}`);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: ErrorCodes.AUDIT_TRAIL_RENDER_FAILED, detail: renderError.message });
    }
    finally
    {
        try { await fs.promises.rm(workingDirectory, { recursive: true, force: true }); }
        catch (cleanupError) { console.warn(`[DownloadAuditTrail] Could not clean up ${workingDirectory}: ${cleanupError.message}`); }
    }
}

module.exports = { downloadAuditTrail };
