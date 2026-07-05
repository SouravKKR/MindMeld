// Browser shim for Node's "crypto" builtin, injected by BundleStaticFiles.js via esbuild's alias.
//
// Several frontend model classes (e.g. Main/Globals/Model/InformationSource.js,
// Main/Globals/Classes/Task/TaskSettings.js) are authored as CommonJS and do
// `const crypto = require('crypto'); ... crypto.randomUUID()`. esbuild bundles the frontend for
// the browser, where Node's "crypto" module does not exist — so those requires are aliased here to
// the Web Crypto API global, which exposes randomUUID() in every modern browser and in Node 19+.
// Only the surface the bundled frontend actually uses (randomUUID) needs to be present.
module.exports = globalThis.crypto;
