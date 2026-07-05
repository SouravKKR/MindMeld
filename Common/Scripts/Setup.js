const BuildPipeline = require('./BuildPipeline');

// Entry point for "npm run setup" — the replacement for the removed "setup.bat --aggressive".
// It runs the full aggressive build and nothing else, so it can be used both as a standalone
// "prepare Dock/Static" step and as the shared first stage of every run mode.
new BuildPipeline().run();
