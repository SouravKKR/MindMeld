const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const GenerationProvenanceQueryEngine = require("../../../Globals/Classes/Database/GenerationProvenanceQueryEngine");
const ContentRefinementQueryEngine = require("../../../Globals/Classes/Database/ContentRefinementQueryEngine");
const SourceLicenceDeclarationQueryEngine = require("../../../Globals/Classes/Database/SourceLicenceDeclarationQueryEngine");
const PaidDeckProvenanceLinkResolver = require("../../../Globals/Classes/Generation/PaidDeckProvenanceLinkResolver");
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


function buildDownloadFileName(provenanceRecords)
{
    const firstRecord = provenanceRecords[0] || {};
    const rawName = firstRecord.deckName || firstRecord.deckId || "deck";
    const safeName = String(rawName).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "deck";
    return `CogniumLearn-AuditTrail-${safeName}.pdf`;
}


function renderAuditTrailPdf(provenanceJsonPath, outputPdfPath)
{
    return new Promise((resolve, reject) =>
    {
        const pythonExecutablePath = getPythonExecutablePathFromVenv(path.join(__dirname, "..", "..", "..", AGENT_VENV_RELATIVE_PATH));
        const rendererPath = path.join(__dirname, "..", "..", "..", RENDERER_RELATIVE_PATH);

        // Named explicitly rather than left to spawn's ENOENT. The renderer lives
        // in Common/ while Dock deploys as its own directory, so "the file is not
        // on this machine" is a real deployment state (it was the state of
        // production until Common/Scripts/RenderPaidDeckAuditTrail.py was added to
        // the deploy contexts) and it is worth saying so rather than reporting a
        // bare errno against a path nobody reads.
        for (const requiredPath of [pythonExecutablePath, rendererPath])
        {
            if (!fs.existsSync(requiredPath))
            {
                reject(new Error(`Audit-trail renderer is not installed on this server: ${requiredPath} is missing.`));
                return;
            }
        }

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

    // deckId is the listing id; the record is filed under the source deck it was
    // published from. Without this bridge the lookup missed for every listing
    // and the endpoint 404'd even for decks this pipeline demonstrably produced.
    const provenanceDeckId = await PaidDeckProvenanceLinkResolver.resolveProvenanceDeckId(deckId);

    // EVERY run that put content into this deck, oldest first — one report
    // covering all of them rather than a report about whichever run happened to
    // be found first. A deck generated into twice was made by two acts, and an
    // audit trail that showed only one would be a true document making a false
    // impression, which is worse than no document.
    const provenanceRecords = await GenerationProvenanceQueryEngine.findAllByDeckId(provenanceDeckId);

    if (provenanceRecords.length === 0)
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

        // Corrections applied after generation finished. They live in their own
        // collection rather than on the provenance record — refinement is
        // available on any deck, while provenance is scoped to paid ones — so
        // they are joined here, at the one place that assembles the report.
        //
        // Attached to the FIRST run, not distributed across runs. A correction
        // is made to the deck as it stands, which may be the product of several
        // runs; filing it against one of them would assert a link to that
        // particular act of generation that nobody established.
        const contentRefinements = await ContentRefinementQueryEngine.findAllByDeckId(provenanceDeckId);

        // Every intellectual-property declaration made about a document this
        // deck's content was CHECKED AGAINST, attachments and detachments alike.
        // Joined here for the same reason refinements are: declarations belong
        // to the deck and outlive any one run, so they have no run to be stored
        // on — and a source detached last month is still what a past check was
        // carried out against, which is exactly what an auditor would ask about.
        const verificationSourceDeclarations = await SourceLicenceDeclarationQueryEngine.findAllByDeckId(provenanceDeckId);

        const recordsWithRefinements = provenanceRecords.map((provenanceRecord, recordIndex) => ({
            ...provenanceRecord,
            contentRefinements: recordIndex === 0 ? contentRefinements : [],
            verificationSourceDeclarations: recordIndex === 0 ? verificationSourceDeclarations : [],
        }));

        // The multi-run envelope. The renderer also accepts a bare record, so a
        // server and a renderer that are briefly out of step still produce a
        // report rather than a stack trace.
        const renderPayload =
        {
            deckId: provenanceDeckId,
            deckName: provenanceRecords[0].deckName || null,
            records: recordsWithRefinements,
        };

        await fs.promises.writeFile(provenanceJsonPath, JSON.stringify(renderPayload), "utf8");

        await renderAuditTrailPdf(provenanceJsonPath, outputPdfPath);

        const pdfBuffer = await fs.promises.readFile(outputPdfPath);

        response.statusCode = httpStatus.OK;
        response.setHeader("Content-Type", "application/pdf");
        response.setHeader("Content-Disposition", `attachment; filename="${buildDownloadFileName(provenanceRecords)}"`);
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

// renderAuditTrailPdf is exported for VerifyPaidDeckPublishGate.mjs, which
// renders a real record through this exact function rather than a copy of it —
// the renderer being absent from the server is a failure mode this endpoint has
// actually had, and a harness that reimplemented the spawn would not have caught
// it.
module.exports = { downloadAuditTrail, renderAuditTrailPdf };
