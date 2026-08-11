
/*
 * Drives the whole native path from a REMOTE origin, which is the one hop the
 * unit tests and the verification harness cannot reach: browser JavaScript
 * served over the network, through Tauri's ACL, into the Rust command layer,
 * into llama.cpp, and back out as streamed tokens.
 *
 * Served from Dock/Static so it is same-origin with the real app, and written
 * to disk through the fs plugin so the result survives the window closing and
 * can be read without watching the screen.
 */
const outputElement = document.getElementById("output");
const recordedLines = [];

function record(text, className)
{
    recordedLines.push(text);
    // Second reporting channel, independent of Tauri entirely. If the bridge
    // is missing, the fs write below cannot run either — so the one thing that
    // must not depend on the bridge is the report saying so. Dock logs an
    // unmatched path as REQUEST_ERROR, which makes its access log a usable
    // out-of-band console for a window nobody is watching.
    try { fetch("/__bridgecheck__/" + encodeURIComponent(text).slice(0, 400)); } catch (beaconError) { void beaconError; }
    const lineElement = document.createElement("div");
    lineElement.textContent = text;
    if (className) { lineElement.className = className; }
    outputElement.appendChild(lineElement);
}

async function writeResultFile()
{
    try
    {
        const { writeTextFile, BaseDirectory } = window.__TAURI__.fs;
        await writeTextFile("NativeBridgeCheck.txt", recordedLines.join("\n"), { baseDir: BaseDirectory.AppData });
        record("wrote NativeBridgeCheck.txt to the app data directory", "ok");
    }
    catch (writeError)
    {
        record(`could not write the result file: ${writeError}`, "bad");
    }
}

async function run()
{
    outputElement.textContent = "";

    if (!window.__TAURI__ || !window.__TAURI__.core)
    {
        record("FAIL: window.__TAURI__.core is absent — the shell did not inject its bridge into this remote page", "bad");
        record("  keys on window.__TAURI__: " + (window.__TAURI__ ? Object.keys(window.__TAURI__).join(",") : "(no __TAURI__ at all)"), "note");
        await writeResultFile();
        return;
    }
    record("PASS: the Tauri bridge is present on a remotely-served page", "ok");

    const { invoke } = window.__TAURI__.core;
    const { listen } = window.__TAURI__.event;

    // 1. Capability probe — this is the call the ACL would refuse.
    let capability;
    try
    {
        capability = await invoke("probe_native_llm_capability");
        record(`PASS: probe_native_llm_capability returned ${JSON.stringify(capability)}`, "ok");
    }
    catch (probeError)
    {
        record(`FAIL: probe_native_llm_capability rejected — ${probeError}`, "bad");
        await writeResultFile();
        return;
    }

    if (capability.bInferenceCompiledIn !== true)
    {
        record("FAIL: this build has no inference engine compiled in", "bad");
        await writeResultFile();
        return;
    }
    record("PASS: the inference engine is compiled into this build", "ok");

    const requestId = 1;
    const weightsFileName = "qwen2.5-0.5b-instruct-q4_k_m.gguf";

    // 2. Download (or find) the weights.
    const stopDownloadListener = await listen("native-llm-download-progress", (nativeEvent) =>
    {
        const payload = nativeEvent.payload || {};
        if (payload.loadedBytes && payload.totalBytes)
        {
            outputElement.lastChild.textContent =
                `  downloading ${(payload.loadedBytes / 1048576).toFixed(0)} / ${(payload.totalBytes / 1048576).toFixed(0)} MB`;
        }
    });

    try
    {
        record("  downloading…", "note");
        const startedAt = performance.now();
        await invoke("ensure_native_model_present",
        {
            requestId: requestId,
            weightsUrl: `${window.location.origin}/Assets/Models/Qwen2.5-0.5B-Instruct-GGUF/${weightsFileName}`,
            weightsFileName: weightsFileName,
            expectedSha256: null,
        });
        record(`PASS: ensure_native_model_present completed in ${((performance.now() - startedAt) / 1000).toFixed(1)}s`, "ok");
    }
    catch (downloadError)
    {
        record(`FAIL: ensure_native_model_present rejected — ${downloadError}`, "bad");
        stopDownloadListener();
        await writeResultFile();
        return;
    }
    stopDownloadListener();

    // 3. Load.
    try
    {
        await invoke("load_native_model",
        {
            requestId: requestId,
            modelKey: "QWEN2_5_0_5B_NATIVE_Q4KM",
            weightsFileName: weightsFileName,
            contextWindowTokens: 2048,
            threadCount: 0,
        });
        record("PASS: load_native_model completed", "ok");
    }
    catch (loadError)
    {
        record(`FAIL: load_native_model rejected — ${loadError}`, "bad");
        await writeResultFile();
        return;
    }

    // 4. Generate, and prove the tokens actually stream rather than arriving
    //    in one lump at the end.
    let streamedTokenCount = 0;
    const stopTokenListener = await listen("native-llm-token", (nativeEvent) =>
    {
        if ((nativeEvent.payload || {}).requestId === requestId) { streamedTokenCount++; }
    });

    try
    {
        const startedAt = performance.now();
        const answer = await invoke("generate_native_completion",
        {
            requestId: requestId,
            systemPrompt: "You answer in one short sentence.",
            userPrompt: "What is spaced repetition?",
            maximumNewTokens: 64,
            temperature: 0.2,
        });
        const elapsedSeconds = (performance.now() - startedAt) / 1000;

        record(`PASS: generate_native_completion returned ${answer.length} characters`, "ok");
        record(`PASS: ${streamedTokenCount} token events streamed to this page`, streamedTokenCount > 0 ? "ok" : "bad");
        record(`  ${(streamedTokenCount / elapsedSeconds).toFixed(1)} tokens/second`, "note");
        record(`  answer: ${answer}`, "note");
    }
    catch (generationError)
    {
        record(`FAIL: generate_native_completion rejected — ${generationError}`, "bad");
    }
    stopTokenListener();

    try
    {
        await invoke("unload_native_model");
        record("PASS: unload_native_model completed", "ok");
    }
    catch (unloadError)
    {
        record(`FAIL: unload_native_model rejected — ${unloadError}`, "bad");
    }

    await writeResultFile();
    record("DONE", "ok");
}

run().catch((unexpectedError) => { record(`FAIL: ${unexpectedError}`, "bad"); writeResultFile(); });
