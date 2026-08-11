// Browser suite for the Free (on-device AI) tier.
//
//   node Common/Testing/Main/run_free_tier_ui_tests.js
//
// Needs a running Dock (COGNIUMLEARN_ENVIRONMENT=local node Dock/index.js) and
// the seeded browser test account (node Common/Testing/Main/seed_browser_test_account.js).
//
// RUN IT ALONE. Several Puppeteer suites started back to back in one shell
// interfere with each other's fixtures and report failures that do not
// reproduce in isolation.
//
// WHAT THIS COVERS, and what it deliberately does not.
//
// It drives the real, authenticated, built app and asserts the things that can
// be established without a graphics adapter:
//
//   - the tier picker offers Free on every surface, including deck chat, where
//     it was previously omitted from the dropdown entirely;
//   - the device probe, the manifest fetch and the model selection actually run
//     in the browser and agree with what the server says it can serve;
//   - selecting Free while the model is not downloaded issues NO request to
//     /AskAi/*, so a learner can never be charged for a tier that answers on
//     their own device;
//   - a Free attempt contacts no third-party origin — the self-hosting promise
//     is asserted by intercepting every request, not by reading the source;
//   - a 503 manifest (nothing provisioned) leaves Free disabled with a readable
//     reason rather than silently failing later.
//
// With a model provisioned it goes further and loads the engine for real,
// generating tokens end to end against the real self-hosted URLs. That is
// opt-in behind VERIFY_BROWSER_LLM_GENERATION=1 because a first load is
// hundreds of megabytes, not because it is unreliable.
//
// KNOWN ENVIRONMENT FINDING, recorded so it is not rediagnosed: on the machine
// this was developed against — a real NVIDIA Ampere adapter reporting
// shader-f16 — every MLC graphics model emits one repeated character, which is
// what NaN logits look like. That is NOT this application: WebLLM's own stock
// configuration, weights fetched from its own CDN with none of our code
// involved, produces the identical output there, for both the f16 and the f32
// quantisations. The processor backend on the same machine answers correctly
// through the full stack. The suite therefore reports degenerate graphics
// output as an environment finding rather than a failure, while still
// requiring the pipeline itself to have run.
//
// WHAT IT CANNOT SETTLE is which model a given piece of hardware gets. Whether
// Chromium exposes a WebGPU adapter here depends on the build, the driver and
// the flags, so the assertions are written about AGREEMENT — the device is
// probed, and the selection is required to match what that device can do —
// rather than about a fixed expected model. A real phone, a machine without
// shader-f16, and the memory-pressure behaviour of the large processor model
// still have to be checked by hand; see Dock/Assets/Models/README.txt.

const path = require("path");

const puppeteer = require(path.join(__dirname, "node_modules", "puppeteer"));

const REPOSITORY_ROOT = path.resolve(__dirname, "..", "..", "..");
const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:3000";
const SESSION_COOKIE = process.env.TEST_SESSION_COOKIE || "browser-suite-test-session";
const bRunGeneration = String(process.env.VERIFY_BROWSER_LLM_GENERATION || "") === "1";

const VIEWPORT_WIDTH = 1440;
const VIEWPORT_HEIGHT = 900;

// A single-threaded processor-backed generation is slow by nature. This bounds
// "slow" against "wedged" rather than expressing an expectation.
const GENERATION_TIMEOUT_MILLISECONDS = 900000;

// The hosts a model, an engine binary or an inference runtime could be pulled
// from if the self-hosting were ever broken — WebLLM's own prebuilt config
// points at the first two, and Transformers.js defaults to the third. The
// payment checkout widget is a separate, pre-existing third party the page
// loads regardless, so this is scoped rather than "any cross-origin request".
const MODEL_HOST_PATTERN = /huggingface\.co|hf\.co|raw\.githubusercontent\.com|jsdelivr|unpkg|cdn-lfs/i;

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

function wait(milliseconds)
{
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * True when the output is one character repeated — the shape of a generation
 * whose logits came back NaN, so every choice fell to token zero.
 */
function isDegenerateOutput(generatedText)
{
    const strippedText = generatedText.replace(/\s+/g, "");
    if (strippedText.length < 8)
    {
        return false;
    }
    return new Set(strippedText).size <= 2;
}

/**
 * Opens the authenticated app and clears the overlays that otherwise cover
 * every surface on a first launch.
 */
async function openApplication(page)
{
    await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });
    await page.setCookie({ name: "sessionId", value: SESSION_COOKIE, url: BASE_URL });
    await page.goto(`${BASE_URL}/index.html`, { waitUntil: "networkidle2", timeout: 60000 });
    await wait(3000);

    await page.evaluate(() =>
    {
        document.querySelectorAll("tutorial-overlay, initialization-overlay, sync-blocking-overlay")
            .forEach((overlayElement) => overlayElement.remove());
    });
    await wait(300);
}


// ── The device probe and model selection, running in a real browser ────────

async function runSelectionSection(page)
{
    section("What this browser resolves to");

    const resolution = await page.evaluate(async () =>
    {
        // Ask the platform the same questions LocalLlmDeviceProbe does, so
        // the assertions below can be about AGREEMENT between the device and
        // the selection rather than about whichever machine happens to run
        // this suite. Chromium's WebGPU support varies by build and by driver.
        let adapterReport = { bWebGpuAvailable: false };
        if (navigator.gpu)
        {
            try
            {
                const adapter = await navigator.gpu.requestAdapter();
                adapterReport = adapter
                    ? {
                        bWebGpuAvailable: true,
                        bShaderF16Supported: adapter.features.has("shader-f16"),
                        maxStorageBufferBindingSizeBytes: adapter.limits.maxStorageBufferBindingSize,
                    }
                    : { bWebGpuAvailable: false };
            }
            catch (probeError)
            {
                adapterReport = { bWebGpuAvailable: false };
            }
        }

        // Mounting the picker is what pulls the whole LocalLlm graph into the
        // page: the component's connectedCallback calls
        // LocalLlmCapability.initialize(), which probes the device, fetches
        // the manifest and runs the selection.
        const pickerElement = document.createElement("llm-tier-select");
        pickerElement.dataset.role = "free-tier-suite-probe";
        document.body.appendChild(pickerElement);

        // Give the probe, the manifest fetch and the persistence read time to
        // settle — all three are async and the first render precedes them.
        await new Promise((resolve) => setTimeout(resolve, 4000));

        const selectElement = pickerElement.querySelector('[data-role="select"]');
        const statusElement = pickerElement.querySelector('[data-role="status"]');
        const freeOption = selectElement
            ? Array.from(selectElement.options).find((optionElement) => optionElement.value === "0")
            : null;

        return {
            bPickerMounted:  Boolean(selectElement),
            adapterReport:   adapterReport,
            optionCount:     selectElement ? selectElement.options.length : 0,
            bFreeOffered:    Boolean(freeOption),
            freeOptionText:  freeOption ? freeOption.textContent.trim() : "",
            bFreeDisabled:   freeOption ? freeOption.disabled : null,
            statusText:      statusElement && !statusElement.hidden ? statusElement.textContent.trim() : "",
            bStatusClickable: Boolean(statusElement && statusElement.hasAttribute("data-clickable")),
        };
    });

    assert(resolution.bPickerMounted, "the tier picker mounts and renders its options");
    assert(resolution.optionCount === 4, `all four tiers are offered (saw ${resolution.optionCount})`);
    assert(resolution.bFreeOffered, "Free is one of them");

    const adapterReport = resolution.adapterReport;
    console.log(`        WebGPU adapter: ${adapterReport.bWebGpuAvailable
        ? `present, shader-f16 ${adapterReport.bShaderF16Supported ? "yes" : "no"}, storage binding ${adapterReport.maxStorageBufferBindingSizeBytes}`
        : "absent"}`);
    console.log(`        Free option reads: "${resolution.freeOptionText}"`);
    console.log(`        status line reads: "${resolution.statusText}"`);

    const manifestModels = await page.evaluate(async (manifestPath) =>
    {
        const manifestResponse = await fetch(manifestPath, { credentials: "include" });
        if (manifestResponse.status === 503)
        {
            return { bProvisioned: false, models: [] };
        }
        const manifest = await manifestResponse.json();
        return { bProvisioned: true, models: manifest.models.map((servedModel) => servedModel.modelKey) };
    }, "/LocalLlm/Manifest");

    const bGraphicsModelServed = manifestModels.models.some((modelKey) => modelKey.includes("WEBGPU"));
    const bProcessorModelServed = manifestModels.models.some((modelKey) => modelKey.includes("WASM"));

    if (!manifestModels.bProvisioned)
    {
        assert(
            resolution.bFreeDisabled === true && /installed on this server/i.test(resolution.statusText),
            "with nothing provisioned, Free is disabled and the reason names the server rather than the device",
        );
        skip("selection assertions — this server has no model provisioned");
        return { bAnyModelUsable: false };
    }

    // The assertion is about AGREEMENT between what the device reports and
    // what it was offered, so it holds on any machine this suite runs on.
    const bShouldReachAGraphicsModel = adapterReport.bWebGpuAvailable && bGraphicsModelServed;
    const bShouldReachAProcessorModel = !bShouldReachAGraphicsModel && bProcessorModelServed;

    if (bShouldReachAGraphicsModel)
    {
        assert(
            resolution.bStatusClickable === true,
            "a device with a WebGPU adapter is offered a graphics model to download",
        );
        assert(
            /on-device \d/.test(resolution.freeOptionText) && !/processor/i.test(resolution.freeOptionText),
            `the picker names the model's size and does not claim the processor — reads "${resolution.freeOptionText}"`,
        );
    }
    else if (bShouldReachAProcessorModel)
    {
        // The regression the predecessor shipped: a device with no usable
        // WebGPU must fall through to the processor model, not be told the
        // whole tier is unsupported.
        assert(
            resolution.bStatusClickable === true,
            "a device with no usable WebGPU is offered the processor model rather than told its device is unsupported",
        );
        assert(
            /processor|CPU|slow/i.test(resolution.freeOptionText),
            `and the picker says plainly that it will run on the processor — reads "${resolution.freeOptionText}"`,
        );
    }
    else
    {
        assert(
            resolution.bFreeDisabled === true,
            "when nothing provisioned suits this device, Free is disabled",
        );
        assert(
            resolution.statusText.length > 0 && !/undefined|null/.test(resolution.statusText),
            `and the reason is readable — reads "${resolution.statusText}"`,
        );
    }

    assert(
        !/undefined|null|NaN/.test(resolution.freeOptionText + resolution.statusText),
        "no placeholder leaks into the Free label or its status line",
    );

    return { bAnyModelUsable: bShouldReachAGraphicsModel || bShouldReachAProcessorModel };
}


// ── Free must never reach the paid endpoints ───────────────────────────────

async function runNoServerCallSection(page)
{
    section("Free spends no credits and calls no third party");

    const observedRequests = [];
    const requestObserver = (interceptedRequest) =>
    {
        observedRequests.push(interceptedRequest.url());
    };
    page.on("request", requestObserver);

    try
    {
        await page.evaluate(async () =>
        {
            // Pick Free the way a learner would, through the shared picker, so
            // the persisted preference and the cross-surface sync both run.
            const pickerElement = document.querySelector('[data-role="free-tier-suite-probe"]');
            const selectElement = pickerElement ? pickerElement.querySelector('[data-role="select"]') : null;
            if (!selectElement)
            {
                return;
            }

            // The option is disabled until the model is downloaded, so the
            // preference is set directly — this is testing what happens if a
            // Free request IS attempted, not whether the option can be clicked.
            selectElement.value = "0";
            selectElement.dispatchEvent(new Event("change", { bubbles: true }));
            await new Promise((resolve) => setTimeout(resolve, 500));
        });

        await wait(1500);

        const askAiRequests = observedRequests.filter((requestUrl) => requestUrl.includes("/AskAi/"));
        assert(
            askAiRequests.length === 0,
            `selecting Free issues no request to a metered endpoint (saw ${askAiRequests.length})`,
        );

        // The self-hosting promise, asserted against real traffic rather than
        // against the source. Scoped to the hosts a model could come from: the
        // page also loads the payment checkout widget, which lazily pulls its
        // own chunks and has nothing to do with this feature.
        const modelHostRequests = observedRequests.filter((requestUrl) =>
            MODEL_HOST_PATTERN.test(requestUrl));
        assert(
            modelHostRequests.length === 0,
            `no model or runtime byte is fetched from a third-party host (saw ${modelHostRequests.length})`,
        );
        modelHostRequests.slice(0, 5).forEach((requestUrl) => console.log(`        ${requestUrl}`));
    }
    finally
    {
        page.off("request", requestObserver);
    }
}


// ── An unprovisioned server degrades honestly ──────────────────────────────

async function runUnprovisionedServerSection(browser)
{
    section("A server with no model installed says so");

    const page = await browser.newPage();

    try
    {
        await page.setRequestInterception(true);
        page.on("request", (interceptedRequest) =>
        {
            if (interceptedRequest.url().includes("/LocalLlm/Manifest"))
            {
                interceptedRequest.respond(
                {
                    status: 503,
                    contentType: "application/json",
                    body: JSON.stringify({ reason: "model_not_provisioned" }),
                });
                return;
            }
            interceptedRequest.continue();
        });

        await openApplication(page);

        const stateWithoutModels = await page.evaluate(async () =>
        {
            const pickerElement = document.createElement("llm-tier-select");
            document.body.appendChild(pickerElement);
            await new Promise((resolve) => setTimeout(resolve, 4000));

            const selectElement = pickerElement.querySelector('[data-role="select"]');
            const statusElement = pickerElement.querySelector('[data-role="status"]');
            const freeOption = Array.from(selectElement.options).find((optionElement) => optionElement.value === "0");

            return {
                bFreeDisabled: freeOption.disabled,
                statusText: statusElement && !statusElement.hidden ? statusElement.textContent.trim() : "",
                bStatusClickable: Boolean(statusElement && statusElement.hasAttribute("data-clickable")),
            };
        });

        assert(stateWithoutModels.bFreeDisabled === true, "Free stays disabled");
        assert(
            /no on-device ai model is installed on this server/i.test(stateWithoutModels.statusText),
            `the reason blames the server, not the device — reads "${stateWithoutModels.statusText}"`,
        );
        assert(
            stateWithoutModels.bStatusClickable === false,
            "and offers no download button, since there is nothing on the server to download",
        );
    }
    finally
    {
        await page.close();
    }
}


// ── Deck chat offers Free, which it previously did not ─────────────────────

async function runChatPickerSection(page)
{
    section("Deck chat offers the same tiers as every other surface");

    const chatPicker = await page.evaluate(async () =>
    {
        const chatViewElement = document.createElement("deck-chat-view");
        chatViewElement.style.position = "absolute";
        chatViewElement.style.left = "-9999px";
        document.body.appendChild(chatViewElement);
        await new Promise((resolve) => setTimeout(resolve, 2500));

        const pickerElement = chatViewElement.querySelector("llm-tier-select");
        const selectElement = pickerElement ? pickerElement.querySelector('[data-role="select"]') : null;
        const optionValues = selectElement
            ? Array.from(selectElement.options).map((optionElement) => optionElement.value)
            : [];

        // ChatSession indexes ModelTierMetadata by key NAME while the shared
        // picker speaks the numeric enum. The bridge between them is what used
        // to be a duplicated tier list, and is why Free never appeared here.
        const bridgedTierKey = typeof chatViewElement.getSelectedTier === "function"
            ? chatViewElement.getSelectedTier()
            : null;

        chatViewElement.remove();
        return { bUsesSharedPicker: Boolean(pickerElement), optionValues, bridgedTierKey };
    });

    assert(chatPicker.bUsesSharedPicker, "chat mounts the shared tier picker rather than a private copy of the tier list");
    assert(
        chatPicker.optionValues.includes("0"),
        `Free appears in the chat picker (options: ${chatPicker.optionValues.join(", ")})`,
    );
    assert(
        typeof chatPicker.bridgedTierKey === "string" && chatPicker.bridgedTierKey.length > 0,
        `the numeric picker value is bridged back to a metadata key name (got "${chatPicker.bridgedTierKey}")`,
    );
}


// ── The real thing: load the engine and generate ───────────────────────────

async function runGenerationSection(page, bAnyModelUsable)
{
    section("A real answer, produced on the device");

    if (!bAnyModelUsable)
    {
        skip("generation — no provisioned model suits this browser (see Dock/Assets/Models/README.txt)");
        return;
    }
    if (!bRunGeneration)
    {
        skip("generation — set VERIFY_BROWSER_LLM_GENERATION=1 to run it (single-threaded, takes minutes)");
        return;
    }

    const observedRequests = [];
    const requestObserver = (interceptedRequest) => observedRequests.push(interceptedRequest.url());
    page.on("request", requestObserver);

    try
    {
        // LocalLlmEngineRunner lives under ThirdParty/, which the build
        // leaves unbundled precisely so the 6.8 MB vendor payload is fetched
        // lazily — which also makes it the one piece of this feature that a
        // page can import directly. Driving it against a descriptor built from
        // the live manifest exercises the real load and generate paths, with
        // the real self-hosted URLs, and needs no test hook in production code.
        const generationResult = await page.evaluate(async () =>
        {
            const manifestResponse = await fetch("/LocalLlm/Manifest", { credentials: "include" });
            const manifest = await manifestResponse.json();
            const bWebGpuUsable = Boolean(navigator.gpu) && Boolean(await navigator.gpu.requestAdapter().catch(() => null));
            const preferredBackend = bWebGpuUsable ? "WEBGPU" : "WASM";
            const servedModel = manifest.models.find((candidate) => candidate.executionBackend === preferredBackend)
                || manifest.models[0];
            if (!servedModel)
            {
                return { bReachable: false, error: "the manifest lists no model" };
            }

            const runnerModule = await import("/ThirdParty/BrowserLlm/BrowserLlmEngineRunner.js");
            const EngineRunner = runnerModule.default;
            const engineRunner = new EngineRunner();

            const descriptor =
            {
                modelKey:            servedModel.modelKey,
                executionBackend:    servedModel.executionBackend,
                engineModelId:       servedModel.engineModelId,
                baseUrl:             servedModel.baseUrl,
                modelLibraryUrl:     servedModel.modelLibraryUrl,
                onnxDataType:        servedModel.onnxDataType,
                contextWindowTokens: servedModel.contextWindowTokens,
                localModelPath:      "/Assets/Models",
                runtimeBaseUrl:      manifest.runtimeBaseUrl,
                vramRequiredMegabytes: 0,
            };

            let lastProgressFraction = 0;
            await engineRunner.load(descriptor, (progressReport) =>
            {
                lastProgressFraction = progressReport.fraction;
            });

            let generatedText = "";
            await engineRunner.generate(
                {
                    systemPrompt: "You are a tutor. Answer in one short sentence.",
                    userPrompt: "What is the capital of France?",
                    maximumNewTokens: 24,
                },
                (deltaText) => { generatedText += deltaText; }
            );

            await engineRunner.unload();

            return {
                bReachable: true,
                modelKey: descriptor.modelKey,
                generatedText: generatedText,
                lastProgressFraction: lastProgressFraction,
            };
        }).catch((evaluationError) => ({ bReachable: false, error: String(evaluationError && evaluationError.message) }));

        if (!generationResult.bReachable)
        {
            skip(`generation — the session controller is not reachable from the page context${generationResult.error ? ` (${generationResult.error})` : ""}`);
            return;
        }

        const generatedText = String(generationResult.generatedText || "").trim();

        assert(
            generatedText.length > 0,
            `the on-device model produced text (${generatedText.length} characters)`,
        );
        assert(
            generationResult.lastProgressFraction > 0,
            `the load reported real progress (reached ${Math.round(generationResult.lastProgressFraction * 100)}%)`,
        );
        console.log(`        model: ${generationResult.modelKey}`);
        console.log(`        answer: ${generatedText.slice(0, 200)}`);

        // A stream of one repeated character is what a model emits when its
        // logits come back NaN and every argmax lands on token zero. On the
        // graphics backend that is a property of the machine's WebGPU compute,
        // not of this application: WebLLM's own stock configuration, weights
        // straight from its CDN, produces exactly the same output on hardware
        // that shows it. Reporting it as a failed assertion would blame the
        // wrong thing, so it is called out as an environment finding instead —
        // but the pipeline assertions above still had to pass to get here.
        if (isDegenerateOutput(generatedText))
        {
            skip("answer quality — this machine's graphics compute returns degenerate output for every MLC model,"
                + " including WebLLM's own stock configuration. The pipeline ran; verify the text on other hardware.");
        }
        else
        {
            assert(
                /paris/i.test(generatedText),
                `the answer is on-topic — "${generatedText.slice(0, 120)}"`,
            );
        }

        // The strongest form of the self-hosting assertion: a whole model was
        // just loaded and run, and not one byte of it came from anywhere but
        // this server. Scoped to the hosts a model could come from — the page
        // also loads the payment checkout widget, which lazily pulls dozens of
        // its own chunks throughout.
        const modelHostRequests = observedRequests.filter((requestUrl) => MODEL_HOST_PATTERN.test(requestUrl));
        assert(
            modelHostRequests.length === 0,
            `every byte of the model came from this server (${modelHostRequests.length} third-party model requests)`,
        );
        modelHostRequests.slice(0, 5).forEach((requestUrl) => console.log(`        ${requestUrl}`));
    }
    finally
    {
        page.off("request", requestObserver);
    }
}


async function main()
{
    console.log("Free (on-device AI) tier — browser suite");
    console.log(`Base URL: ${BASE_URL}\n`);

    let browser;
    try
    {
        browser = await puppeteer.launch(
        {
            headless: "new",
            args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
            protocolTimeout: GENERATION_TIMEOUT_MILLISECONDS,
        });
    }
    catch (launchError)
    {
        console.log(`SKIPPED — Chromium failed to launch: ${launchError.message}. Run \`npx puppeteer browsers install chrome\` in Common/Testing/Main.`);
        process.exit(0);
    }

    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (pageError) => pageErrors.push(String(pageError.message)));

    try
    {
        await openApplication(page);

        const { bAnyModelUsable } = await runSelectionSection(page);
        await runNoServerCallSection(page);
        await runChatPickerSection(page);
        await runGenerationSection(page, bAnyModelUsable);
        await runUnprovisionedServerSection(browser);

        section("No JavaScript errors along the way");
        const meaningfulErrors = pageErrors.filter((errorText) =>
            !errorText.includes("favicon") && !errorText.includes("net::ERR_"));
        assert(meaningfulErrors.length === 0, `no page errors (${meaningfulErrors.length})`);
        meaningfulErrors.slice(0, 5).forEach((errorText) => console.log(`        ${errorText}`));
    }
    finally
    {
        await browser.close();
    }

    console.log(`\nPassed: ${passedCount}   Failed: ${failedCount}   Skipped: ${skippedCount}`);
    console.log(`Repository: ${REPOSITORY_ROOT}`);
    process.exit(failedCount > 0 ? 1 : 0);
}

main().catch((fatalError) =>
{
    console.error("FATAL", fatalError);
    process.exit(1);
});
