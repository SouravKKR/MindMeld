const fs = require('fs')
const path = require('path')

const rootDirectory = path.join(__dirname, '..', '..')
const manifestOutputPath = path.join(__dirname, '..', 'ServiceManifest.json')
const enumOutputPath = path.join(__dirname, '..', 'Enumerations', 'Services.json')

const manifest = {}
const servicesEnum = {}

const IGNORE_DIRS = new Set(['Build', '.git', 'Common', ".github", ".vscode", ".claude", ".gemini"])

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
