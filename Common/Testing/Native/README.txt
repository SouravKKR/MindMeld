NativeBridgeCheck — the on-device model, driven from a remote origin
====================================================================

Proves the one hop nothing else can reach.

The Rust unit tests prove the engine generates text. Dock/VerifyLocalLlmProvisioning.mjs
proves the selector, the catalogue and the manifest. Neither can prove the part in
between: that JavaScript SERVED OVER THE NETWORK, running inside the native shell, is
actually permitted to call the inference commands and receives streamed tokens back.

That gap is not theoretical. Tauri allows an app's own commands by default only for
LOCAL content; this app's window loads the deployed site, so every command is refused
unless capabilities/remote.json names it. The refusal arrives as a rejected promise,
which NativeRuntimeDriver correctly reads as "this shell has no inference commands" —
so the app falls back to the browser engine and NOTHING LOOKS WRONG. No error, no
failing test, an expensive feature quietly doing nothing. This page is what catches it.


HOW TO RUN IT
-------------

1. Provision a model, if the device has none:

       node Common/Scripts/ProvisionLocalLlmModels.js --models=QWEN2_5_0_5B_NATIVE_Q4KM

2. Build the frontend, then copy BOTH files into the served tree. They go in after the
   build because the build wipes Dock/Static:

       npm run setup
       cp Common/Testing/Native/NativeBridgeCheck.* Dock/Static/

3. Start Dock. It indexes static files at boot, so a file added while it is running is
   served as 404 — this must come after the copy:

       COGNIUMLEARN_ENVIRONMENT=local node Dock/index.js --debug

4. Point the app at the page and build it. Setting the URL is what puts the origin into
   the remote capability, which is the thing under test:

       export COGNIUMLEARN_APP_URL="http://127.0.0.1:3000/NativeBridgeCheck.html"
       node -e "const C=require('./Common/Scripts/ConfigureTauriApp'); new C().run();"
       cd Native && npx tauri build --features native-inference --no-bundle

5. Run Native/src-tauri/target/release/cognium-learn.exe and read the result from
   EITHER channel:

       %APPDATA%/io.cogniumlabs.learn/NativeBridgeCheck.txt      (via the fs plugin)
       the Dock log, grepping for /__bridgecheck__/               (via plain fetch)

   Two channels on purpose. The fs plugin needs the bridge, so it cannot report that the
   bridge is missing; the fetch works regardless and is the one that speaks when the
   news is bad.

6. Afterwards, restore the production URL, or the next build ships an app pointed at
   your laptop:

       node -e "const C=require('./Common/Scripts/ConfigureTauriApp'); new C().run();"


WHAT A PASS LOOKS LIKE
----------------------

    PASS: the Tauri bridge is present on a remotely-served page
    PASS: probe_native_llm_capability returned {...,"bInferenceCompiledIn":true}
    PASS: ensure_native_model_present completed in 0.8s
    PASS: load_native_model completed
    PASS: generate_native_completion returned 96 characters
    PASS: 16 token events streamed to this page
      55.1 tokens/second
    PASS: unload_native_model completed


TWO THINGS THAT WILL WASTE YOUR TIME IF YOU DO NOT KNOW THEM
------------------------------------------------------------

- The script is a separate .js file, not inline. Dock serves script-src 'self', so an
  inline <script> is blocked and the page silently does nothing at all — no error in
  any log except a CSP violation report.

- Dock's integrity monitor will log the two copied files as "unexpected", warning about
  a possible compromise of the origin. That is the monitor working correctly: nothing
  legitimate adds files to a built tree. Remove them when finished.
