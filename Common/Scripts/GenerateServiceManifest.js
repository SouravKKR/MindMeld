const fs = require('fs')
const path = require('path')

const rootDirectory = path.join(__dirname, '..', '..')
const manifestOutputPath = path.join(__dirname, '..', 'ServiceManifest.json')
const enumOutputPath = path.join(__dirname, '..', 'Enumerations', 'Services.json')

const manifest = {}
const servicesEnum = {}

// Every top-level directory is treated as a service and has the whole of
// Common/ mirrored into it, so anything here that is NOT a service has to be
// named.
//
// 'Native' is the Tauri shell. It is a Rust + Cargo project that consumes none
// of the shared model — the JavaScript it runs is the deployed site, fetched
// over the network, not a copy compiled into the app — so mirroring Common/
// into it produces a few hundred files nothing imports. That is also why the
// shell used to live under 'Build': being ignored was a side effect of being
// inside a build directory rather than a decision, and it cost the project its
// only copy of the Rust source, which was never in version control as a
// result. Named explicitly now, so the shell can be tracked like everything
// else.
const IGNORE_DIRS = new Set(['Build', 'Native', '.git', 'Common', ".github", ".vscode", ".claude", ".gemini"])

const entries = fs.readdirSync(rootDirectory, { withFileTypes: true })

let enumIndex = 0

for (const entry of entries)
{
    if (!entry.isDirectory())
    {
        continue
    }

    if (IGNORE_DIRS.has(entry.name))
    {
        continue
    }

    const serviceName = entry.name
    const servicePath = path.join(rootDirectory, serviceName)
    const files = fs.readdirSync(servicePath)

    let language = 'unknown'

    if (files.some(f => f.endsWith('.py')))
    {
        language = 'python'
    }
    else if (files.some(f => f === 'package.json' || f.endsWith('.js')))
    {
        language = 'javascript'
    }
    else if (files.some(f => f.endsWith('.html')))
    {
        language = 'html5'
    }

    manifest[serviceName] =
    {
        language
    }

    const enumKey = serviceName
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[-\s]+/g, '_')
        .toUpperCase()

    servicesEnum[enumKey] = enumIndex++
}

fs.writeFileSync(
    manifestOutputPath,
    JSON.stringify(manifest, null, 2)
)

fs.mkdirSync(path.dirname(enumOutputPath), { recursive: true })

fs.writeFileSync(
    enumOutputPath,
    JSON.stringify(servicesEnum, null, 2)
)
