/**
 * BrowserLlmWorkerProtocol
 *
 * The message vocabulary shared between LocalLlmEngineClient (bundled app
 * code) and BrowserLlmWorker (this directory).
 *
 * IT DUPLICATES TWO CODEGEN'D ENUMS, AND HAS TO.
 * Common/Enumerations/LocalLlmWorkerCommands.json and
 * LocalLlmWorkerEvents.json are the source of truth, but their generated
 * mirrors under Main/Globals/Enumerations/ do not survive the build: the
 * bundler folds every module reachable from index.html into Bundle.part-*.js
 * and then deletes the sources, and ThirdParty/ is excluded from that graph
 * precisely so the 6.8 MB vendor bundle is never inlined. A worker living
 * here therefore has nothing to import.
 *
 * Dock/VerifyLocalLlmProvisioning.mjs asserts these values stay identical to
 * the JSON sources, so the duplication cannot drift silently.
 */
class BrowserLlmWorkerProtocol
{
    // Mirrors Common/Enumerations/LocalLlmWorkerCommands.json
    static LOAD = 0;
    static GENERATE = 1;
    static INTERRUPT = 2;
    static UNLOAD = 3;

    // Mirrors Common/Enumerations/LocalLlmWorkerEvents.json
    static LOAD_PROGRESS = 0;
    static LOAD_COMPLETE = 1;
    static TOKEN = 2;
    static GENERATION_COMPLETE = 3;
    static FAILED = 4;
}

export default BrowserLlmWorkerProtocol;
