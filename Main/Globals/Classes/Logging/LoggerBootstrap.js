import Logger from "./Logger.js";

// Installed as early as possible in the app bundle so window.onerror and
// unhandledrejection capture is active for the whole session — the gap where
// browser errors never left the user's device. Runs once (Logger.initialize is
// idempotent).
Logger.initialize();

export default Logger;
