const path = require("path");
const BrowserLlmDownloadConstants = require("../../Globals/Constants/BrowserLlmDownloadConstants");
const BrowserLlmModelRegistry = require("../../Globals/Classes/BrowserLlm/BrowserLlmModelRegistry");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");


/**
 * GET /BrowserLlm/Manifest
 *
 * Tells the client which Free-tier models this deployment can actually serve,
 * and where their files live. Model directories sit under
 *
 *     Dock/Assets/Models/<folderName>/
 *
 * and are served statically at /Assets/Models/... by the `server.serve` call
 * in Dock/index.js. Everything about a model — its folder, its engine id, its
 * required files — is declared in
 * Common/Constants/BrowserLlmModelCatalogue.json; this endpoint only reports
 * what of that is present on disk. Provisioning a new model is therefore a
 * catalogue entry plus a folder, with no change here.
 *
 * The client picks one of the returned models by matching each against the
 * device's real capabilities, so the response deliberately reports ALL
 * complete models rather than choosing one server-side — the server has no
 * idea what GPU the visitor has.
 *
 * Response shape:
 *
 *     200 {
 *         models: [{
 *             modelKey:            "QWEN2_5_1_5B_WEBGPU_Q4F16",
 *             executionBackend:    "WEBGPU",
 *             engineModelId:       "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
 *             baseUrl:             "/Assets/Models/Qwen2.5-1.5B-Instruct-q4f16_1-MLC/",
 *             modelLibraryUrl:     "/Assets/.../Qwen2-1.5B-...-webgpu.wasm" | null,
 *             onnxDataType:        null | "q4",
 *             contextWindowTokens: 4096,
 *             files:               [{ path, sizeBytes }, ...],
 *             totalBytes:          883500000,
 *             bComplete:           true
 *         }, ...],
 *         runtimeBaseUrl: "/Assets/Runtime/OnnxRuntime/",
 *         generatedAt:    1754800000000
 *     }
 *
 *     503 { reason: "model_not_provisioned" }
 *         No catalogue model is present and complete on this node. The
 *         operator needs to run
 *         `node Common/Scripts/ProvisionBrowserLlmModels.js`. The frontend
 *         renders this as a clear "not available yet" message instead of
 *         half-downloading something that can never load.
 */
class GetModelManifestEndpoint
{
    static ASSETS_DIRECTORY_SEGMENTS = ["..", "..", "Assets"];

    static async handle(request, response)
    {
        const assetsDirectory = path.join(__dirname, ...GetModelManifestEndpoint.ASSETS_DIRECTORY_SEGMENTS);
        const describedModels = BrowserLlmModelRegistry.describeModels(assetsDirectory);
        const completeModels = describedModels.filter((describedModel) => describedModel.bComplete === true);

        if (completeModels.length === 0)
        {
            // An incomplete-but-present model is worth logging: it means a
            // provisioning run was interrupted, which is otherwise invisible.
            for (const describedModel of describedModels)
            {
                console.warn(`[GetModelManifest] ${describedModel.modelKey} is present but incomplete — re-run the provisioning script.`);
            }

            // Set the code and let sendJson write the body: sendStatusCode
            // ENDS the response, so the pairing this endpoint used to have —
            // sendStatusCode followed by sendJson — delivered a 503 with an
            // empty body and the client could never tell "no model installed"
            // apart from any other 503.
            response.statusCode = httpStatus.SERVICE_UNAVAILABLE;
            response.sendJson({ reason: "model_not_provisioned" });
            return;
        }

        response.sendJson(
        {
            models:         completeModels,
            runtimeBaseUrl: BrowserLlmDownloadConstants.RUNTIME_ASSETS_BASE_PATH,
            generatedAt:    Date.now()
        });
    }
}

async function getModelManifest(request, response)
{
    await GetModelManifestEndpoint.handle(request, response);
}

module.exports = { getModelManifest, GetModelManifestEndpoint };
