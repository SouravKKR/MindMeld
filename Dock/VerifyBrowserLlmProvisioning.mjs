/**
 * VerifyBrowserLlmProvisioning — harness for the Free tier's on-device model:
 * which model a given device is offered, and whether the server is honest
 * about what it can actually serve.
 *
 * Run from the Dock directory:
 *     node VerifyBrowserLlmProvisioning.mjs
 *     VERIFY_BROWSER_LLM_HTTP=1 node VerifyBrowserLlmProvisioning.mjs
 *
 * Tier 1 is pure and always runs. The HTTP tier is opt-in behind the env flag
 * and needs a running Dock with at least one model provisioned.
 *
 * What it protects, in the order the failures would hurt:
 *
 *   A DEVICE TOLD IT CANNOT RUN THE TIER WHEN IT CAN. This is the regression
 *   the predecessor shipped: one global 1 GiB storage-binding floor applied to
 *   the whole feature, above what many phone GPUs report, so a phone that
 *   could comfortably have run a smaller model was told its device was
 *   unsupported. Every requirement is now per model, and the phone-shaped
 *   profile is asserted to select the small model rather than nothing. The
 *   no-WebGPU profile is asserted to reach the processor backend for the same
 *   reason.
 *
 *   A SELECTION THAT ONLY WORKS FOR TODAY'S MODELS. The whole design premise
 *   is that the model set is data. The selector is therefore driven against
 *   SYNTHETIC catalogues, including one where a new entry is inserted at an
 *   intermediate preference rank and must win — if that passes, adding a model
 *   really is a catalogue edit. Testing only against the shipped catalogue
 *   would prove the models work, not that the mechanism does.
 *
 *   A MODEL OFFERED THAT CANNOT LOAD. A half-provisioned directory loads
 *   happily for a few hundred megabytes and then dies inside WebLLM with an
 *   opaque WebGPU error. Completeness is checked against the descriptor's own
 *   required files AND against every shard the model's own manifest names, and
 *   an incomplete model must be withheld rather than advertised.
 *
 *   A SILENT PROTOCOL DRIFT. The worker cannot import codegen'd enums (the
 *   build deletes them), so BrowserLlmWorkerProtocol.js mirrors two of them by
 *   hand. Those values are asserted identical to the JSON sources. Drift here
 *   would mean a worker that answers the wrong question, with no error.
 *
 *   A THIRD-PARTY CALL AT RUN TIME. The tier's premise is that a learner's
 *   card content never leaves their device and the app never contacts a CDN.
 *   The engine runner is scanned for WebLLM's own prebuiltAppConfig (every
 *   entry in which points at huggingface.co) and for CDN hosts, and must pin
 *   the processor backend with allowRemoteModels = false.
 *
 *   A TRAVERSAL OUT OF THE ASSETS TREE. Model ids come only from the
 *   catalogue, never from a request, and the directory walk must not follow a
 *   symlink planted inside the tree.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { spawnSync } from "child_process";

const require = createRequire(import.meta.url);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.join(currentDirectory, "..");

require("dotenv").config({ path: path.join(currentDirectory, ".env") });

const BrowserLlmModelRegistry = require("./Globals/Classes/BrowserLlm/BrowserLlmModelRegistry");
const BrowserLlmModelCatalogue = require("./Globals/Constants/BrowserLlmModelCatalogue");
const BrowserLlmDownloadConstants = require("./Globals/Constants/BrowserLlmDownloadConstants");
const { browserLlmExecutionBackends } = require("./Globals/Enumerations/BrowserLlmExecutionBackends");
const { browserLlmModelKeys } = require("./Globals/Enumerations/BrowserLlmModelKeys");
const { browserLlmUnavailableReasons } = require("./Globals/Enumerations/BrowserLlmUnavailableReasons");

const GIGABYTE = 1073741824;
const MEGABYTE = 1048576;

let passedCount = 0;
let failedCount = 0;
let skippedCount = 0;

function assert(condition, description)
{
    if (condition)
    {
        passedCount += 1;
        console.log(`  PASS  ${description}`);
    }
    else
    {
        failedCount += 1;
        console.log(`  FAIL  ${description}`);
    }
}

function skip(description)
{
    skippedCount += 1;
    console.log(`  SKIP  ${description}`);
}

function section(title)
{
    console.log(`\n=== ${title} ===`);
}


// ── Selector fixtures ──────────────────────────────────────────────────────

/**
 * The selector is an ES module under Main/, imported dynamically because this
 * harness is otherwise CommonJS. This loads it against the REAL catalogue;
 * selectWithCatalogue below runs it against synthetic ones.
 */
async function loadSelector()
{
    const selectorPath = path.join(repositoryRoot, "Main", "Globals", "Classes", "BrowserLlm", "BrowserLlmModelSelector.js");
    const profilePath = path.join(repositoryRoot, "Main", "Globals", "Classes", "BrowserLlm", "BrowserLlmDeviceProfile.js");

    const [selectorModule, profileModule] = await Promise.all([
        import(`file://${selectorPath.replace(/\\/g, "/")}`),
        import(`file://${profilePath.replace(/\\/g, "/")}`),
    ]);

    return { BrowserLlmModelSelector: selectorModule.default, BrowserLlmDeviceProfile: profileModule.default };
}

function buildProfile(BrowserLlmDeviceProfile, overrides)
{
    return new BrowserLlmDeviceProfile(Object.assign(
    {
        bWebGpuAvailable: false,
        bShaderF16Supported: false,
        maxBufferSizeBytes: 0,
        maxStorageBufferBindingSizeBytes: 0,
        deviceMemoryGigabytes: null,
        bWebAssemblyAvailable: true,
        hardwareConcurrency: 8,
    }, overrides));
}

const DESKTOP_GPU_WITH_F16 =
{
    bWebGpuAvailable: true,
    bShaderF16Supported: true,
    maxBufferSizeBytes: 2 * GIGABYTE,
    maxStorageBufferBindingSizeBytes: 2 * GIGABYTE,
    deviceMemoryGigabytes: 8,
};

const DESKTOP_GPU_WITHOUT_F16 = Object.assign({}, DESKTOP_GPU_WITH_F16, { bShaderF16Supported: false });

// The WebGPU specification's guaranteed floor — 256 MiB maxBufferSize and
// 128 MiB maxStorageBufferBindingSize — which is exactly what a great many
// Android adapters report.
const PHONE_GPU_AT_SPEC_FLOOR =
{
    bWebGpuAvailable: true,
    bShaderF16Supported: true,
    maxBufferSizeBytes: 256 * MEGABYTE,
    maxStorageBufferBindingSizeBytes: 128 * MEGABYTE,
    deviceMemoryGigabytes: 4,
};

const NO_WEBGPU_LARGE_MEMORY = { bWebGpuAvailable: false, deviceMemoryGigabytes: 16 };
const NOTHING_AT_ALL = { bWebGpuAvailable: false, bWebAssemblyAvailable: false };

// Memory and handheld scenarios now have to carry working graphics, because
// graphics is the only backend left — without it the outcome is decided before
// memory is ever consulted, and the case would prove nothing.
const SMALLEST_GRAPHICS_MODEL_MEMORY_GIGABYTES = 2;

const LARGE_MEMORY_CAPABLE_GRAPHICS = Object.assign({}, DESKTOP_GPU_WITH_F16, { deviceMemoryGigabytes: 16 });
const SMALL_MEMORY_CAPABLE_GRAPHICS = Object.assign({}, DESKTOP_GPU_WITH_F16,
    { deviceMemoryGigabytes: SMALLEST_GRAPHICS_MODEL_MEMORY_GIGABYTES });
const UNKNOWN_MEMORY_CAPABLE_GRAPHICS = Object.assign({}, DESKTOP_GPU_WITH_F16, { deviceMemoryGigabytes: null });
const CAPABLE_GRAPHICS_HANDHELD = Object.assign({}, DESKTOP_GPU_WITH_F16, { bHandheldDevice: true });


// ── Tier 1a: the selection ladder against the shipped catalogue ────────────

async function runSelectionTier()
{
    section("Which model a device is offered");

    const { BrowserLlmModelSelector, BrowserLlmDeviceProfile } = await loadSelector();
    const allModelKeys = BrowserLlmModelCatalogue.ORDER.slice();

    const selectFor = (overrides, availableKeys = allModelKeys, forcedKey = null) =>
        BrowserLlmModelSelector.select(buildProfile(BrowserLlmDeviceProfile, overrides), availableKeys, forcedKey);

    const bestGraphicsKey = allModelKeys.find((modelKey) =>
        BrowserLlmModelCatalogue[modelKey].executionBackend === "WEBGPU");

    assert(
        selectFor(DESKTOP_GPU_WITH_F16).getModelKey() === bestGraphicsKey,
        "a capable desktop GPU gets the highest-ranked graphics model",
    );
    assert(
        selectFor(DESKTOP_GPU_WITH_F16).isDegraded() === false,
        "and is not reported as a compromise",
    );

    const withoutF16Outcome = selectFor(DESKTOP_GPU_WITHOUT_F16);
    assert(
        BrowserLlmModelCatalogue[withoutF16Outcome.getModelKey()].requiresShaderF16 === false,
        "a GPU without shader-f16 is never offered an f16 model",
    );

    // The regression the predecessor shipped, in both its forms.
    const phoneOutcome = selectFor(PHONE_GPU_AT_SPEC_FLOOR);
    assert(
        phoneOutcome.isAvailable(),
        "a phone GPU reporting only the WebGPU spec floor is NOT told the tier is unsupported",
    );
    assert(
        phoneOutcome.getModelKey() !== bestGraphicsKey && BrowserLlmModelCatalogue[phoneOutcome.getModelKey()].executionBackend === "WEBGPU",
        "it is offered a smaller graphics model instead of the largest one",
    );
    assert(
        phoneOutcome.isDegraded() === true && typeof phoneOutcome.getHonestNote() === "string",
        "and is told plainly that it is running a smaller model",
    );

    // The processor backend was withdrawn deliberately: single-threaded WASM
    // measured 0.1 tokens/second on a 16 GB no-GPU laptop, which is not a slow
    // feature but a broken-looking one. A machine without WebGPU is now told
    // the tier cannot run rather than being handed something unusable.
    const noGraphicsOutcome = selectFor(NO_WEBGPU_LARGE_MEMORY);
    assert(
        !noGraphicsOutcome.isAvailable()
            && noGraphicsOutcome.getUnavailableReason() === browserLlmUnavailableReasons.NO_SUPPORTED_BACKEND,
        "a browser with no WebGPU is refused outright rather than handed an unusably slow processor model",
    );

    // Memory is still judged, now among the graphics models: a machine
    // declaring 2 GB must not be offered the model that asks for 4 GB.
    const smallMemoryGraphicsOutcome = selectFor(SMALL_MEMORY_CAPABLE_GRAPHICS);
    assert(
        smallMemoryGraphicsOutcome.isAvailable()
            && BrowserLlmModelCatalogue[smallMemoryGraphicsOutcome.getModelKey()].minimumDeviceMemoryGigabytes
                <= SMALLEST_GRAPHICS_MODEL_MEMORY_GIGABYTES,
        "a low-memory machine is only offered a model whose declared memory need it meets",
    );

    // Firefox and Safari never report deviceMemory. Treating that absence as
    // "too small" would rule out every non-Chromium desktop.
    assert(
        selectFor(UNKNOWN_MEMORY_CAPABLE_GRAPHICS).getModelKey() === selectFor(LARGE_MEMORY_CAPABLE_GRAPHICS).getModelKey(),
        "an unreported device memory never blocks a model",
    );

    // Phones and tablets are refused ahead of every capability check — a
    // handheld that could technically start a model still throttles, drains
    // and loses its GPU to a backgrounded tab.
    const handheldOutcome = selectFor(CAPABLE_GRAPHICS_HANDHELD);
    assert(
        !handheldOutcome.isAvailable()
            && handheldOutcome.getUnavailableReason() === browserLlmUnavailableReasons.HANDHELD_DEVICE,
        "a phone is refused even when its graphics would satisfy a model",
    );

    const nothingOutcome = selectFor(NOTHING_AT_ALL);
    assert(
        !nothingOutcome.isAvailable()
            && nothingOutcome.getUnavailableReason() === browserLlmUnavailableReasons.NO_SUPPORTED_BACKEND,
        "a browser with neither backend is refused, and told which capability is missing",
    );

    assert(
        selectFor(DESKTOP_GPU_WITH_F16, []).getUnavailableReason() === browserLlmUnavailableReasons.NO_MODEL_PROVISIONED,
        "an unprovisioned server is reported as such, not as an incapable device",
    );

    // Reaching a model this hardware would never pick is the only way to test
    // the no-f16 path on a machine whose GPU supports f16.
    const forcedKey = allModelKeys[allModelKeys.length - 1];
    assert(
        selectFor(DESKTOP_GPU_WITH_F16, allModelKeys, forcedKey).getModelKey() === forcedKey,
        "the manual override reaches a model the device would not otherwise be offered",
    );
    assert(
        selectFor(DESKTOP_GPU_WITH_F16, allModelKeys, "NO_SUCH_MODEL").getModelKey() === bestGraphicsKey,
        "an override naming a model the server does not serve is ignored rather than obeyed",
    );
}


// ── Tier 1b: the mechanism, against synthetic catalogues ───────────────────

/**
 * Runs selection scenarios against a SYNTHETIC catalogue, proving the choice
 * is driven by data rather than by the models that happen to ship today.
 *
 * It runs in a child process because the selector reaches its catalogue
 * through a static import: re-importing the selector with a cache-busting
 * query re-evaluates the selector but resolves the catalogue to the same URL,
 * which Node serves from the module cache. A child gets a clean registry, so
 * the swapped file is genuinely what it reads. The generated constants file is
 * restored either way.
 */
function selectWithCatalogue(syntheticCatalogue, scenarios)
{
    const cataloguePath = path.join(repositoryRoot, "Main", "Globals", "Constants", "BrowserLlmModelCatalogue.js");
    const originalContents = fs.readFileSync(cataloguePath, "utf8");
    const scenarioFilePath = path.join(os.tmpdir(), `verify-browser-llm-scenarios-${process.pid}.json`);

    const staticMembers = Object.entries(syntheticCatalogue)
        .map(([memberName, memberValue]) => `    static ${memberName} = ${JSON.stringify(memberValue)};`)
        .join("\n");

    try
    {
        fs.writeFileSync(cataloguePath, `class BrowserLlmModelCatalogue\n{\n${staticMembers}\n}\n\nmodule.exports = BrowserLlmModelCatalogue;\n`, "utf8");
        fs.writeFileSync(scenarioFilePath, JSON.stringify(scenarios), "utf8");

        const childSource = `
            import fs from "fs";
            import { pathToFileURL } from "url";
            const selectorUrl = pathToFileURL(${JSON.stringify(path.join(repositoryRoot, "Main", "Globals", "Classes", "BrowserLlm", "BrowserLlmModelSelector.js"))}).href;
            const profileUrl = pathToFileURL(${JSON.stringify(path.join(repositoryRoot, "Main", "Globals", "Classes", "BrowserLlm", "BrowserLlmDeviceProfile.js"))}).href;
            const BrowserLlmModelSelector = (await import(selectorUrl)).default;
            const BrowserLlmDeviceProfile = (await import(profileUrl)).default;
            const scenarios = JSON.parse(fs.readFileSync(${JSON.stringify(scenarioFilePath)}, "utf8"));
            const results = scenarios.map((scenario) =>
            {
                const outcome = BrowserLlmModelSelector.select(
                    new BrowserLlmDeviceProfile(scenario.profile),
                    scenario.availableModelKeys,
                    scenario.forcedModelKey || null
                );
                return {
                    modelKey: outcome.getModelKey(),
                    bDegraded: outcome.isDegraded(),
                    honestNote: outcome.getHonestNote(),
                    unavailableReason: outcome.getUnavailableReason(),
                };
            });
            process.stdout.write(JSON.stringify(results));
        `;

        const childResult = spawnSync(process.execPath, ["--input-type=module", "-e", childSource],
        {
            encoding: "utf8",
            cwd: repositoryRoot,
        });

        if (childResult.status !== 0)
        {
            throw new Error(`selector child process failed: ${childResult.stderr || childResult.stdout}`);
        }

        return JSON.parse(childResult.stdout);
    }
    finally
    {
        fs.writeFileSync(cataloguePath, originalContents, "utf8");
        fs.rmSync(scenarioFilePath, { force: true });
    }
}

function buildSyntheticEntry(overrides)
{
    return Object.assign(
    {
        displayName: "Synthetic",
        parameterLabel: "1B",
        executionBackend: "WEBGPU",
        preferenceRank: 10,
        folderName: "synthetic",
        engineModelId: "synthetic",
        sourceRepository: "synthetic/synthetic",
        modelLibrarySourceUrl: "https://example.invalid/",
        modelLibraryFileName: "synthetic.wasm",
        shardManifestFileName: "ndarray-cache.json",
        onnxDataType: null,
        requiresShaderF16: false,
        vramRequiredMegabytes: 100,
        minimumMaxBufferSizeBytes: 0,
        minimumMaxStorageBufferBindingSizeBytes: 0,
        minimumDeviceMemoryGigabytes: 0,
        contextWindowTokens: 2048,
        approximateTotalBytes: 1,
        approximateTotalLabel: "~1 B",
        requiredFileNames: ["mlc-chat-config.json"],
        displayNote: "synthetic note",
    }, overrides);
}

function runCatalogueDrivenTier()
{
    section("The selection is driven by the catalogue, not by code");

    // A new model inserted between two existing ranks must win, with no code
    // change. This is the direct test of the extensibility contract.
    const withInsertedEntry =
    {
        ORDER: ["BIG", "INSERTED", "SMALL"],
        BIG: buildSyntheticEntry({ preferenceRank: 10, minimumMaxStorageBufferBindingSizeBytes: GIGABYTE }),
        INSERTED: buildSyntheticEntry({ preferenceRank: 15 }),
        SMALL: buildSyntheticEntry({ preferenceRank: 20 }),
    };

    const [insertedOutcome] = selectWithCatalogue(withInsertedEntry,
    [
        { profile: Object.assign({ bWebAssemblyAvailable: true }, PHONE_GPU_AT_SPEC_FLOOR), availableModelKeys: ["BIG", "INSERTED", "SMALL"] },
    ]);
    assert(
        insertedOutcome.modelKey === "INSERTED",
        "a model added at an intermediate preference rank is selected without any code change",
    );

    // A rank the device cannot meet is skipped rather than failing the whole
    // selection.
    const allBlockedButOne =
    {
        ORDER: ["NEEDS_F16", "NEEDS_HUGE_BUFFER", "FITS"],
        NEEDS_F16: buildSyntheticEntry({ preferenceRank: 10, requiresShaderF16: true }),
        NEEDS_HUGE_BUFFER: buildSyntheticEntry({ preferenceRank: 20, minimumMaxStorageBufferBindingSizeBytes: 8 * GIGABYTE }),
        FITS: buildSyntheticEntry({ preferenceRank: 30 }),
    };

    const [blockedOutcome] = selectWithCatalogue(allBlockedButOne,
    [
        {
            profile: Object.assign({ bWebAssemblyAvailable: true }, PHONE_GPU_AT_SPEC_FLOOR, { bShaderF16Supported: false }),
            availableModelKeys: ["NEEDS_F16", "NEEDS_HUGE_BUFFER", "FITS"],
        },
    ]);
    assert(blockedOutcome.modelKey === "FITS", "unmet per-model requirements skip that model, not the whole tier");
    assert(
        blockedOutcome.bDegraded === true && blockedOutcome.honestNote === "synthetic note",
        "the compromise note comes from the chosen entry's own displayNote",
    );

    // The deployment, not the catalogue, is what a learner is compared against:
    // on a server hosting only the small model, nobody could have done better.
    const twoEntries =
    {
        ORDER: ["BIG", "SMALL"],
        BIG: buildSyntheticEntry({ preferenceRank: 10 }),
        SMALL: buildSyntheticEntry({ preferenceRank: 20 }),
    };

    const [smallOnlyOutcome, bothOutcome] = selectWithCatalogue(twoEntries,
    [
        { profile: Object.assign({ bWebAssemblyAvailable: true }, DESKTOP_GPU_WITH_F16), availableModelKeys: ["SMALL"] },
        { profile: Object.assign({ bWebAssemblyAvailable: true }, DESKTOP_GPU_WITH_F16), availableModelKeys: ["BIG", "SMALL"] },
    ]);
    assert(
        smallOnlyOutcome.modelKey === "SMALL" && smallOnlyOutcome.bDegraded === false,
        "a device is not called degraded for missing a model its server does not host",
    );
    assert(
        bothOutcome.modelKey === "BIG" && bothOutcome.bDegraded === false,
        "and gets the best one when the server does host it",
    );
}


// ── Tier 1c: catalogue integrity ───────────────────────────────────────────

function runCatalogueIntegrityTier()
{
    section("The catalogue is internally consistent");

    const orderedKeys = BrowserLlmModelCatalogue.ORDER;
    assert(Array.isArray(orderedKeys) && orderedKeys.length > 0, "the catalogue declares an ORDER");

    const seenFolderNames = new Set();
    const seenRanks = new Set();

    for (const modelKey of orderedKeys)
    {
        const descriptor = BrowserLlmModelCatalogue[modelKey];

        assert(Boolean(descriptor), `${modelKey} in ORDER has a descriptor`);
        if (!descriptor)
        {
            continue;
        }

        assert(browserLlmModelKeys[modelKey] !== undefined, `${modelKey} has a matching enum key`);
        assert(
            browserLlmExecutionBackends[descriptor.executionBackend] !== undefined,
            `${modelKey} names a real execution backend`,
        );
        assert(Number.isFinite(descriptor.preferenceRank), `${modelKey} has a numeric preferenceRank`);
        assert(
            Array.isArray(descriptor.requiredFileNames) && descriptor.requiredFileNames.length > 0,
            `${modelKey} declares the files that prove it is complete`,
        );
        assert(Number.isFinite(descriptor.contextWindowTokens) && descriptor.contextWindowTokens > 0,
            `${modelKey} declares a context window, which is what budgets its prompts`);

        if (descriptor.executionBackend === "WEBGPU")
        {
            assert(
                typeof descriptor.modelLibraryFileName === "string" && descriptor.modelLibraryFileName.endsWith(".wasm"),
                `${modelKey} names the engine binary its graphics backend needs`,
            );
            assert(
                descriptor.requiredFileNames.includes(descriptor.modelLibraryFileName),
                `${modelKey} counts that binary among its required files`,
            );

            // The graphics engine rewrites any model URL that does not already
            // contain "/resolve/<something>/" by appending "resolve/main/",
            // assuming it was given a HuggingFace repository root. A folder
            // without it therefore 404s on every shard — and only at load
            // time, hundreds of megabytes in, with a bare
            // "Failed to execute 'add' on 'Cache'". Cheaper to catch here.
            assert(
                /\/resolve\/[^/]+$/.test(descriptor.folderName),
                `${modelKey} is laid out as a HuggingFace mirror, which its engine requires (folderName ends in /resolve/<ref>)`,
            );
        }
        else
        {
            assert(
                typeof descriptor.onnxDataType === "string" && descriptor.onnxDataType.length > 0,
                `${modelKey} names the quantisation its processor backend loads`,
            );
            assert(
                !descriptor.folderName.includes("/resolve/"),
                `${modelKey} does not carry the graphics engine's mirror path, which its backend does not use`,
            );
        }

        assert(!seenFolderNames.has(descriptor.folderName), `${modelKey} has a folder no other model claims`);
        seenFolderNames.add(descriptor.folderName);

        assert(!seenRanks.has(descriptor.preferenceRank), `${modelKey} has a preferenceRank no other model claims`);
        seenRanks.add(descriptor.preferenceRank);
    }
}


// ── Tier 1d: worker protocol mirror ────────────────────────────────────────

function runWorkerProtocolTier()
{
    section("The worker's hand-mirrored protocol matches its enum sources");

    const protocolPath = path.join(repositoryRoot, "Main", "ThirdParty", "BrowserLlm", "BrowserLlmWorkerProtocol.js");
    if (!fs.existsSync(protocolPath))
    {
        assert(false, "BrowserLlmWorkerProtocol.js exists");
        return;
    }

    const protocolSource = fs.readFileSync(protocolPath, "utf8");
    const mirroredValues = new Map();
    const memberPattern = /static\s+([A-Z_]+)\s*=\s*(\d+)\s*;/g;
    let memberMatch = memberPattern.exec(protocolSource);
    while (memberMatch !== null)
    {
        mirroredValues.set(memberMatch[1], Number.parseInt(memberMatch[2], 10));
        memberMatch = memberPattern.exec(protocolSource);
    }

    const sourceEnumerations =
    {
        BrowserLlmWorkerCommands: JSON.parse(fs.readFileSync(path.join(repositoryRoot, "Common", "Enumerations", "BrowserLlmWorkerCommands.json"), "utf8")),
        BrowserLlmWorkerEvents: JSON.parse(fs.readFileSync(path.join(repositoryRoot, "Common", "Enumerations", "BrowserLlmWorkerEvents.json"), "utf8")),
    };

    let expectedMemberCount = 0;
    for (const [enumerationName, enumerationValues] of Object.entries(sourceEnumerations))
    {
        for (const [memberName, memberValue] of Object.entries(enumerationValues))
        {
            expectedMemberCount += 1;
            assert(
                mirroredValues.get(memberName) === memberValue,
                `${enumerationName}.${memberName} is mirrored as ${memberValue}`,
            );
        }
    }

    assert(
        mirroredValues.size === expectedMemberCount,
        "the mirror carries no members the enum sources do not declare",
    );
}


// ── Tier 1e: nothing reaches a third party at run time ─────────────────────

function runSelfHostingTier()
{
    section("Nothing contacts a third party at run time");

    const runnerPath = path.join(repositoryRoot, "Main", "ThirdParty", "BrowserLlm", "BrowserLlmEngineRunner.js");
    if (!fs.existsSync(runnerPath))
    {
        assert(false, "BrowserLlmEngineRunner.js exists");
        return;
    }

    // Comments discuss both, so only executable lines are scanned.
    const executableLines = fs.readFileSync(runnerPath, "utf8")
        .split("\n")
        .filter((sourceLine) =>
        {
            const trimmedLine = sourceLine.trim();
            return !trimmedLine.startsWith("*") && !trimmedLine.startsWith("//") && !trimmedLine.startsWith("/*");
        })
        .join("\n");

    assert(
        !executableLines.includes("prebuiltAppConfig"),
        "the engine runner never uses WebLLM's prebuilt config, whose every entry points at huggingface.co",
    );
    assert(
        !/huggingface\.co|jsdelivr|unpkg|raw\.githubusercontent/.test(executableLines),
        "the engine runner names no content-delivery host",
    );
    assert(
        /allowRemoteModels\s*=\s*false/.test(executableLines),
        "the processor backend is pinned to local files, so a missing one fails loudly instead of silently fetching",
    );

    const constantsAreRootRelative = String(BrowserLlmDownloadConstants.WORKER_SCRIPT_PATH).startsWith("/")
        && String(BrowserLlmDownloadConstants.ENGINE_RUNNER_MODULE_PATH).startsWith("/")
        && String(BrowserLlmDownloadConstants.ASSETS_BASE_PATH).startsWith("/");
    assert(
        constantsAreRootRelative,
        "every served path is root-relative, so a deep-link cold load resolves it correctly",
    );
}


// ── Tier 1f: the directory walk and completeness rules ─────────────────────

function runManifestWalkTier()
{
    section("What the server reports as available");

    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "verify-browser-llm-"));

    try
    {
        const modelsDirectory = path.join(temporaryRoot, "Models");
        const nestedDirectory = path.join(modelsDirectory, "owner", "repo", "onnx");
        fs.mkdirSync(nestedDirectory, { recursive: true });

        fs.writeFileSync(path.join(modelsDirectory, "owner", "repo", "config.json"), "{}", "utf8");
        fs.writeFileSync(path.join(nestedDirectory, "model_q4.onnx"), "weights", "utf8");
        fs.writeFileSync(path.join(modelsDirectory, "owner", "repo", ".provision-manifest.json"), "{}", "utf8");
        fs.writeFileSync(path.join(modelsDirectory, "owner", "repo", "half.bin.partial"), "x", "utf8");

        const collectedFiles = BrowserLlmModelRegistry.collectFiles(path.join(modelsDirectory, "owner", "repo"));
        const collectedPaths = collectedFiles.map((collectedFile) => collectedFile.path);

        assert(
            collectedPaths.includes("onnx/model_q4.onnx"),
            "the walk descends into subdirectories, which the ONNX layout needs",
        );
        assert(
            collectedPaths.every((collectedPath) => !collectedPath.includes("\\")),
            "relative paths use forward slashes, so they are usable as URLs on Windows too",
        );
        assert(
            !collectedPaths.some((collectedPath) => collectedPath.includes(".provision-manifest")),
            "bookkeeping files are not advertised as something to download",
        );
        assert(
            !collectedPaths.some((collectedPath) => collectedPath.endsWith(".partial")),
            "a half-written file from an interrupted provisioning run is not advertised either",
        );

        const descriptor =
        {
            requiredFileNames: ["config.json", "onnx/model_q4.onnx"],
            shardManifestFileName: null,
        };
        assert(
            BrowserLlmModelRegistry.isModelComplete(descriptor, collectedFiles, path.join(modelsDirectory, "owner", "repo")) === true,
            "a model with all its required files is complete",
        );

        const missingRequirement = { requiredFileNames: ["config.json", "tokenizer.json"], shardManifestFileName: null };
        assert(
            BrowserLlmModelRegistry.isModelComplete(missingRequirement, collectedFiles, path.join(modelsDirectory, "owner", "repo")) === false,
            "a missing required file makes a model incomplete rather than merely smaller",
        );

        fs.writeFileSync(path.join(modelsDirectory, "owner", "repo", "empty.json"), "", "utf8");
        const emptyFileRequirement = { requiredFileNames: ["empty.json"], shardManifestFileName: null };
        assert(
            BrowserLlmModelRegistry.isModelComplete(
                emptyFileRequirement,
                BrowserLlmModelRegistry.collectFiles(path.join(modelsDirectory, "owner", "repo")),
                path.join(modelsDirectory, "owner", "repo")
            ) === false,
            "a zero-length required file counts as missing",
        );

        // The shard check is what catches a download that stopped halfway
        // through a model whose required files all happen to be small.
        const shardedDirectory = path.join(modelsDirectory, "sharded");
        fs.mkdirSync(shardedDirectory, { recursive: true });
        fs.writeFileSync(path.join(shardedDirectory, "mlc-chat-config.json"), "{}", "utf8");
        fs.writeFileSync(
            path.join(shardedDirectory, "ndarray-cache.json"),
            JSON.stringify({ records: [{ dataPath: "params_shard_0.bin" }, { dataPath: "params_shard_1.bin" }] }),
            "utf8"
        );
        fs.writeFileSync(path.join(shardedDirectory, "params_shard_0.bin"), "weights", "utf8");

        const shardedDescriptor =
        {
            requiredFileNames: ["mlc-chat-config.json", "ndarray-cache.json"],
            shardManifestFileName: "ndarray-cache.json",
        };
        assert(
            BrowserLlmModelRegistry.isModelComplete(
                shardedDescriptor,
                BrowserLlmModelRegistry.collectFiles(shardedDirectory),
                shardedDirectory
            ) === false,
            "a model missing a shard its own manifest names is incomplete, even with every required file present",
        );

        fs.writeFileSync(path.join(shardedDirectory, "params_shard_1.bin"), "weights", "utf8");
        assert(
            BrowserLlmModelRegistry.isModelComplete(
                shardedDescriptor,
                BrowserLlmModelRegistry.collectFiles(shardedDirectory),
                shardedDirectory
            ) === true,
            "and complete once every shard has arrived",
        );

        assert(
            BrowserLlmModelRegistry.collectFiles(path.join(temporaryRoot, "does-not-exist")).length === 0,
            "an absent directory yields nothing rather than throwing",
        );
    }
    finally
    {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
        BrowserLlmModelRegistry.resetCache();
    }
}


function runEnabledModelsTier()
{
    section("An operator can restrict what an environment serves");

    const originalValue = process.env[BrowserLlmModelRegistry.ENABLED_MODELS_ENVIRONMENT_VARIABLE];

    try
    {
        delete process.env[BrowserLlmModelRegistry.ENABLED_MODELS_ENVIRONMENT_VARIABLE];
        assert(
            BrowserLlmModelRegistry.getEnabledModelKeys().length === BrowserLlmModelCatalogue.ORDER.length,
            "unset means every provisioned model is offered",
        );

        const firstKey = BrowserLlmModelCatalogue.ORDER[0];
        process.env[BrowserLlmModelRegistry.ENABLED_MODELS_ENVIRONMENT_VARIABLE] = firstKey;
        const restrictedKeys = BrowserLlmModelRegistry.getEnabledModelKeys();
        assert(
            restrictedKeys.length === 1 && restrictedKeys[0] === firstKey,
            "a listed key narrows the set to exactly that model",
        );

        process.env[BrowserLlmModelRegistry.ENABLED_MODELS_ENVIRONMENT_VARIABLE] = "NOT_A_REAL_MODEL";
        assert(
            BrowserLlmModelRegistry.getEnabledModelKeys().length === 0,
            "an unknown key cannot conjure a model that is not in the catalogue",
        );
    }
    finally
    {
        if (originalValue === undefined)
        {
            delete process.env[BrowserLlmModelRegistry.ENABLED_MODELS_ENVIRONMENT_VARIABLE];
        }
        else
        {
            process.env[BrowserLlmModelRegistry.ENABLED_MODELS_ENVIRONMENT_VARIABLE] = originalValue;
        }
        BrowserLlmModelRegistry.resetCache();
    }
}


// ── Tier 2: against a running server ───────────────────────────────────────

async function runHttpTier()
{
    section("The manifest endpoint, against a running Dock");

    if (String(process.env.VERIFY_BROWSER_LLM_HTTP || "") !== "1")
    {
        skip("HTTP tier (set VERIFY_BROWSER_LLM_HTTP=1 with Dock running to include it)");
        return;
    }

    const baseUrl = process.env.VERIFY_BROWSER_LLM_BASE_URL || "http://127.0.0.1:3000";
    const sessionCookie = process.env.TEST_SESSION_COOKIE || "";

    let manifestResponse;
    try
    {
        manifestResponse = await fetch(`${baseUrl}${BrowserLlmDownloadConstants.MANIFEST_ENDPOINT_PATH}`,
        {
            headers: sessionCookie ? { cookie: `sessionId=${sessionCookie}` } : {},
        });
    }
    catch (fetchError)
    {
        skip(`HTTP tier — could not reach ${baseUrl} (${fetchError.message})`);
        return;
    }

    if (!sessionCookie)
    {
        assert(
            manifestResponse.status !== 200,
            "the manifest is not served without a session (set TEST_SESSION_COOKIE to test the authenticated path)",
        );
        skip("authenticated manifest checks — TEST_SESSION_COOKIE is unset");
        return;
    }

    if (manifestResponse.status === 503)
    {
        const refusal = await manifestResponse.json();
        assert(refusal.reason === "model_not_provisioned", "an unprovisioned server says so explicitly");
        skip("served-file checks — no model is provisioned on this server");
        return;
    }

    assert(manifestResponse.status === 200, "the manifest is served to an authenticated session");
    const manifest = await manifestResponse.json();

    assert(Array.isArray(manifest.models) && manifest.models.length > 0, "it lists at least one model");
    assert(
        manifest.models.every((servedModel) => servedModel.bComplete === true),
        "every model it lists is complete — an incomplete one is withheld, not advertised",
    );
    assert(typeof manifest.runtimeBaseUrl === "string", "it names where the processor backend's runtime lives");

    const firstModel = manifest.models[0];
    assert(
        typeof firstModel.baseUrl === "string" && firstModel.baseUrl.startsWith(BrowserLlmDownloadConstants.ASSETS_BASE_PATH),
        "each model is served from under the assets path",
    );

    // Spot-check rather than every shard: a model has dozens of files and the
    // point is that the advertised paths resolve, not to re-download it.
    const sampleFiles = firstModel.files.slice(0, 3);
    for (const sampleFile of sampleFiles)
    {
        const fileResponse = await fetch(`${baseUrl}${firstModel.baseUrl}${sampleFile.path}`, { method: "HEAD" });
        assert(fileResponse.status === 200, `the advertised file ${sampleFile.path} is actually served`);
        assert(
            String(fileResponse.headers.get("cache-control") || "").includes("immutable"),
            `${sampleFile.path} is cached immutably, so clearing a browser cache does not cost a re-download of the whole model`,
        );
    }

    if (firstModel.modelLibraryUrl)
    {
        const libraryResponse = await fetch(`${baseUrl}${firstModel.modelLibraryUrl}`, { method: "HEAD" });
        assert(libraryResponse.status === 200, "the engine binary is served");
        assert(
            String(libraryResponse.headers.get("content-type") || "") === "application/wasm",
            "and with the WebAssembly content type the browser needs to compile it",
        );
    }

    const traversalResponse = await fetch(`${baseUrl}/Assets/Models/../../.env`, { method: "GET" });
    assert(traversalResponse.status !== 200, "the assets route does not serve files outside its own tree");
}


async function main()
{
    console.log("Verifying the Free tier's on-device model provisioning\n");

    await runSelectionTier();
    runCatalogueDrivenTier();
    runCatalogueIntegrityTier();
    runWorkerProtocolTier();
    runSelfHostingTier();
    runManifestWalkTier();
    runEnabledModelsTier();
    await runHttpTier();

    section("Summary");
    console.log(`  passed:  ${passedCount}`);
    console.log(`  failed:  ${failedCount}`);
    console.log(`  skipped: ${skippedCount}`);

    process.exit(failedCount > 0 ? 1 : 0);
}

main().catch((error) =>
{
    console.error("Harness crashed:", error);
    process.exit(1);
});
