const fileSystem = require('fs');
const path = require('path');

// Applies environment-driven configuration to the Tauri project before a desktop/mobile build,
// so "which server does the app load" and "where does it check for a new binary" come from env
// (with production defaults) rather than being hard-coded. It:
//
//   1. Points the app window and the remote-IPC capability at COGNIUMLEARN_APP_URL.
//   2. Configures the binary updater from COGNIUMLEARN_UPDATE_ENDPOINT + COGNIUMLEARN_UPDATER_PUBKEY.
//      When no public key is provided the updater is left disabled so a plain build still
//      succeeds (an installer without auto-update), matching a dev machine with no signing key.
//   3. Ensures the minimal offline fallback shell exists at Build/Template/src (frontendDist) —
//      the window loads the remote site, so this is only the tauri://localhost first-launch
//      fallback; the service worker handles offline once the site has been loaded online once.
class ConfigureTauriApp
{
    static DEFAULT_APP_URL = 'https://learn.cogniumlabs.io';

    constructor()
    {
        this.repositoryRootDirectory = path.join(__dirname, '..', '..');
        this.buildTemplateDirectory = path.join(this.repositoryRootDirectory, 'Build', 'Template');
        this.tauriConfigurationPath = path.join(this.buildTemplateDirectory, 'src-tauri', 'tauri.conf.json');
        this.remoteCapabilityPath = path.join(this.buildTemplateDirectory, 'src-tauri', 'capabilities', 'remote.json');
        this.frontendShellDirectory = path.join(this.buildTemplateDirectory, 'src');
    }

    resolveApplicationUrl()
    {
        const configuredUrl = process.env.COGNIUMLEARN_APP_URL;
        const trimmedUrl = configuredUrl === undefined ? '' : configuredUrl.trim();
        const applicationUrl = trimmedUrl.length > 0 ? trimmedUrl : ConfigureTauriApp.DEFAULT_APP_URL;
        return applicationUrl.replace(/\/+$/, '');
    }

    resolveUpdateEndpoint(applicationUrl)
    {
        const configuredEndpoint = process.env.COGNIUMLEARN_UPDATE_ENDPOINT;
        const trimmedEndpoint = configuredEndpoint === undefined ? '' : configuredEndpoint.trim();

        if (trimmedEndpoint.length > 0)
        {
            return trimmedEndpoint;
        }

        return `${applicationUrl}/DesktopUpdates/latest.json`;
    }

    resolveUpdaterPublicKey()
    {
        const configuredPublicKey = process.env.COGNIUMLEARN_UPDATER_PUBKEY;
        const trimmedPublicKey = configuredPublicKey === undefined ? '' : configuredPublicKey.trim();
        return trimmedPublicKey.length > 0 ? trimmedPublicKey : null;
    }

    run()
    {
        const applicationUrl = this.resolveApplicationUrl();
        const updateEndpoint = this.resolveUpdateEndpoint(applicationUrl);
        const updaterPublicKey = this.resolveUpdaterPublicKey();

        this.applyTauriConfiguration(applicationUrl, updateEndpoint, updaterPublicKey);
        this.applyRemoteCapability(applicationUrl);
        this.ensureOfflineShell(applicationUrl);

        const updaterState = updaterPublicKey === null ? 'disabled (no COGNIUMLEARN_UPDATER_PUBKEY)' : `enabled (endpoint ${updateEndpoint})`;
        console.log(`Configured Tauri app: url=${applicationUrl}, updater=${updaterState}.`);
    }

    applyTauriConfiguration(applicationUrl, updateEndpoint, updaterPublicKey)
    {
        const configuration = JSON.parse(fileSystem.readFileSync(this.tauriConfigurationPath, 'utf8'));

        if (Array.isArray(configuration.app.windows) && configuration.app.windows.length > 0)
        {
            configuration.app.windows[0].url = applicationUrl;
        }

        if (updaterPublicKey === null)
        {
            configuration.bundle.createUpdaterArtifacts = false;

            if (configuration.plugins !== undefined)
            {
                delete configuration.plugins.updater;
            }
        }
        else
        {
            configuration.bundle.createUpdaterArtifacts = true;

            if (configuration.plugins === undefined)
            {
                configuration.plugins = {};
            }

            configuration.plugins.updater = {
                endpoints: [updateEndpoint],
                pubkey: updaterPublicKey,
            };
        }

        fileSystem.writeFileSync(this.tauriConfigurationPath, JSON.stringify(configuration, null, 2) + '\n', 'utf8');
    }

    applyRemoteCapability(applicationUrl)
    {
        const capability = JSON.parse(fileSystem.readFileSync(this.remoteCapabilityPath, 'utf8'));
        capability.remote = capability.remote === undefined ? {} : capability.remote;
        capability.remote.urls = [applicationUrl];
        fileSystem.writeFileSync(this.remoteCapabilityPath, JSON.stringify(capability, null, 2) + '\n', 'utf8');
    }

    ensureOfflineShell(applicationUrl)
    {
        if (fileSystem.existsSync(this.frontendShellDirectory) === false)
        {
            fileSystem.mkdirSync(this.frontendShellDirectory, { recursive: true });
        }

        const shellHtml = this.buildOfflineShellHtml(applicationUrl);
        fileSystem.writeFileSync(path.join(this.frontendShellDirectory, 'index.html'), shellHtml, 'utf8');
    }

    buildOfflineShellHtml(applicationUrl)
    {
        // Minimal bundled fallback. The window normally loads the remote site directly; this page
        // only appears if the very first launch happens with no network (before the service worker
        // has cached anything). It keeps trying to reach the app.
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="refresh" content="3; url=${applicationUrl}">
    <title>CogniumLearn</title>
    <style>
        html, body { height: 100%; margin: 0; background: #0f1117; color: #e8eaf0; font-family: system-ui, sans-serif; }
        .center { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; text-align: center; padding: 24px; }
        .muted { color: #9aa0ad; font-size: 14px; }
    </style>
</head>
<body>
    <div class="center">
        <h1>CogniumLearn</h1>
        <p class="muted">Connecting to CogniumLearn. If you are offline, please reconnect and reopen the app.</p>
    </div>
    <script>
        setTimeout(function () { window.location.replace(${JSON.stringify(applicationUrl)}); }, 3000);
    </script>
</body>
</html>
`;
    }
}

module.exports = ConfigureTauriApp;
