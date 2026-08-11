Free-tier on-device AI models
=============================

This directory holds the model weights the Free tier runs in the learner's
browser. Nothing here is in git — the models total several gigabytes — and
nothing here ships in a deploy tar. A machine obtains them by running the
provisioning script below.

Until at least one model is present and complete, GET /LocalLlm/Manifest
answers 503 and the app tells the user the Free tier is not available on this
server. That is the correct behaviour, not a fault.


Provisioning
------------

    node Common/Scripts/ProvisionLocalLlmModels.js --list
    node Common/Scripts/ProvisionLocalLlmModels.js
    node Common/Scripts/ProvisionLocalLlmModels.js --models=QWEN2_5_1_5B_WEBGPU_Q4F16
    node Common/Scripts/ProvisionLocalLlmModels.js --verify-only

Every download is checked against the source's published size and sha256, and
lands under its final name only once it matches, so an interrupted run can
never leave a corrupt shard behind.

A deployed node runs the same script from BaseNodeUpdate.sh, in the background,
the first time it finds this directory empty.


Layout
------

One directory per catalogue entry, named by that entry's `folderName`:

    Dock/Assets/Models/Qwen2.5-1.5B-Instruct-q4f16_1-MLC/    graphics backend
        mlc-chat-config.json, ndarray-cache.json, tokenizer.json,
        params_shard_*.bin, <model>-webgpu.wasm

    Dock/Assets/Models/onnx-community/Qwen2.5-1.5B-Instruct/  processor backend
        config.json, tokenizer.json, onnx/model_q4.onnx

    Dock/Assets/Runtime/OnnxRuntime/                          processor backend
        ort-wasm-simd-threaded.jsep.wasm

The whole tree is served read-only at /Assets/... with a year of immutable
caching — the URL contains the model's own folder name, so it can never come to
mean something else.


Adding or swapping a model
--------------------------

The set of models is data, not code. To add one:

  1. Add a key to Common/Enumerations/LocalLlmModelKeys.json.
  2. Add a descriptor to Common/Constants/LocalLlmModelCatalogue.json — the
     backend, the source repository, the device requirements, and a
     `preferenceRank` placing it among the existing entries (lower is tried
     first).
  3. npm run setup
  4. node Common/Scripts/ProvisionLocalLlmModels.js --models=<YOUR_KEY>
  5. Restart Dock.

No application code changes. The server discovers the folder, and each client
picks the best entry its own hardware can run.

Setting the requirement fields honestly is what makes this work. The
provisioning run prints the model's largest single parameter buffer, which is
the figure a WebGPU adapter's maxStorageBufferBindingSize has to clear — take
minimumMaxStorageBufferBindingSizeBytes from that measurement rather than
guessing. A threshold set too high silently excludes every phone; set too low,
a device is offered a model it then fails to load.


A known hardware trap
---------------------

On some machines every MLC graphics model emits one character over and over
("!!!!!!"), which is what a generation looks like when its logits come back
NaN. Before suspecting this repository, run WebLLM's stock configuration with
none of our code involved:

    const { WebLLM } = await import("/ThirdParty/BrowserLlm/LocalLlm.js");
    const engine = await WebLLM.CreateMLCEngine("Qwen2.5-0.5B-Instruct-q4f16_1-MLC", {});
    console.log((await engine.chat.completions.create({
        messages: [{ role: "user", content: "What is the capital of France?" }],
        max_tokens: 24,
    })).choices[0].message.content);

That downloads from WebLLM's own CDN and uses none of the self-hosting here. If
it prints the same repeated character, the fault is the machine's WebGPU
compute — it reproduced on an NVIDIA Ampere adapter reporting shader-f16, for
both the f16 and f32 quantisations, during this feature's development. The
processor backend on the same machine answered correctly through the full
stack, so it is specific to the graphics path.

Common/Testing/Main/run_free_tier_ui_tests.js detects this shape and reports it
as an environment finding rather than a failure, while still requiring that the
model loaded and streamed.


Restricting what an environment serves
--------------------------------------

BROWSER_LLM_ENABLED_MODELS in Dock/.env takes a comma-separated list of
catalogue keys. Unset means "everything provisioned". Use it to hold a model
back on one environment without deleting its files.
