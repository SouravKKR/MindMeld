param(
    [string]$mode,
    [string]$network,
    [switch]$debug
)

Write-Host "Running setup..."
& .\setup.bat

if ($mode -eq "--web")
{
    if ($network -eq "--online")
    {
        Write-Host "Starting Cloudflare tunnel..."

        $tunnelProcess = Start-Process `
            -FilePath "cloudflared" `
            -ArgumentList "tunnel --config ./Common/Config/CloudflareTunnelConfig.yml run mindmeld" `
            -NoNewWindow `
            -PassThru
    }

    Write-Host "Starting MindMeld Web Server..."

    $nodeArgs = "index.js"
    if ($debug) { $nodeArgs = "index.js --debug" }

    $nodeProcess = Start-Process `
        -FilePath "node" `
        -ArgumentList $nodeArgs `
        -WorkingDirectory ".\Dock" `
        -NoNewWindow `
        -PassThru

    Write-Host "Press Ctrl+C to stop..."

    Wait-Process $nodeProcess
}
else
{
    Write-Host "Running TAURI setup..."

    node .\Common\Scripts\CopyFilesToTauriProject.js
    npm run tauri dev
}
