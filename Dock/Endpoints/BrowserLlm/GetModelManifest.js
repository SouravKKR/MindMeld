const fs = require("fs");
const path = require("path");
const BrowserLlmDownloadConstants = require("../../Globals/Constants/BrowserLlmDownloadConstants");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");


/**
 * GET /BrowserLlm/Manifest
 *
 * Returns the file list (plus sizes) needed to download the offline
 * Free-tier AI model. The model directory lives at
 *
 *     Dock/Assets/Models/<MODEL_ID>/
 *
 * and is served statically at /Assets/Models/<MODEL_ID>/... by the
 * `server.serve` call in Dock/index.js. This endpoint just walks that
 * directory and reports what's available.
 *
 * Response shape:
 *
 *     200 {
 *         modelId:   "Qwen2.5-3B-Instruct-q4f16_1-MLC",
 *         baseUrl:   "/Assets/Models/Qwen2.5-3B-Instruct-q4f16_1-MLC/",
 *         files:     [{ path, sizeBytes }, ...],   // shard / json / tokenizer files
 *         wasm:      { path, sizeBytes } | null,   // engine binary if found, else null
 *         totalBytes: 1234567890
 *     }
 *
 *     503 { reason: "model_not_provisioned" }
 *         The MODEL_ID directory is missing or empty. The user (or
 *         deploy script) needs to populate Dock/Assets/Models/<MODEL_ID>/
 *         before the Free tier can be used. The frontend renders this
 *         as a clear "model not yet available" message instead of
 *         half-downloading.
 */
class GetModelManifestEndpoint
{
    static async handle(request, response)
    {
        const modelId = BrowserLlmDownloadConstants.MODEL_ID;
        const modelDirectory = path.join(__dirname, "..", "..", "Assets", "Models", modelId);

        if (!fs.existsSync(modelDirectory))
        {
            response.sendStatusCode(httpStatus.SERVICE_UNAVAILABLE);
            response.sendJson({ reason: "model_not_provisioned", modelId });
            return;
        }

        let directoryEntries;
        try
        {
            directoryEntries = fs.readdirSync(modelDirectory, { withFileTypes: true });
        }
        catch (readError)
        {
            console.error(`[GetModelManifest] Could not read ${modelDirectory}: ${readError.message}`);
            response.sendStatusCode(httpStatus.INTERNAL_SERVER_ERROR);
            response.sendJson({ reason: "manifest_read_failed" });
            return;
        }

        if (directoryEntries.length === 0)
        {
            response.sendStatusCode(httpStatus.SERVICE_UNAVAILABLE);
            response.sendJson({ reason: "model_not_provisioned", modelId });
            return;
        }

        const collectedFiles = [];
        let wasmEntry = null;
        let totalByteCount = 0;

        for (const directoryEntry of directoryEntries)
        {
            if (!directoryEntry.isFile())
            {
                continue;
            }

            const entryName = directoryEntry.name;
            const absolutePath = path.join(modelDirectory, entryName);
            const fileStats = fs.statSync(absolutePath);
            const sizeBytes = fileStats.size;
            const relativePath = entryName;

            totalByteCount += sizeBytes;

            // Separate the engine binary so the frontend's WebLLM
            // appConfig can point `model_lib` at it directly.
            if (entryName.toLowerCase().endsWith(".wasm"))
            {
                wasmEntry = { path: relativePath, sizeBytes };
            }
            else
            {
                collectedFiles.push({ path: relativePath, sizeBytes });
            }
        }

        if (collectedFiles.length === 0 && wasmEntry === null)
        {
            response.sendStatusCode(httpStatus.SERVICE_UNAVAILABLE);
            response.sendJson({ reason: "model_not_provisioned", modelId });
            return;
        }

        const baseUrl = `${BrowserLlmDownloadConstants.ASSETS_BASE_PATH}/${modelId}/`;

        response.sendJson(
        {
            modelId:    modelId,
            baseUrl:    baseUrl,
            files:      collectedFiles,
            wasm:       wasmEntry,
            totalBytes: totalByteCount
        });
    }
}

async function getModelManifest(request, response)
{
    await GetModelManifestEndpoint.handle(request, response);
}

module.exports = { getModelManifest };
