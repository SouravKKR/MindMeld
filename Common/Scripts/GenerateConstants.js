// NEED TO BE ABLE TO HANDLE CROSS LANGUAGE

const fs = require('fs')
const path = require('path')

const rootDirectory = path.join(__dirname, '..', '..')

const serviceManifest =
    JSON.parse(
        fs.readFileSync(
            path.join(rootDirectory, 'Common', 'ServiceManifest.json'),
            'utf8'
        )
    )

const commonConstantsDir =
    path.join(rootDirectory, 'Common', 'Constants')

const serviceList = Object.keys(serviceManifest)

function toCamelCase(name)
{
    return name.charAt(0).toLowerCase() + name.slice(1)
}

function toPascalCase(name)
{
    return name.charAt(0).toUpperCase() + name.slice(1)
}

function formatValue(value)
{
    if (typeof value === 'string')
    {
        return `'${value.replace(/'/g, "\\'")}'`
    }

    if (value !== null && typeof value === 'object')
    {
        // Nested objects and arrays are emitted as JSON literals — valid JS
        // expression syntax — so templates and other structured constants
        // can live in Common/Constants alongside the flat scalar ones.
        return JSON.stringify(value)
    }

    return value
}

function formatValuePython(value)
{
    if (typeof value === 'string')
    {
        return `'${value.replace(/'/g, "\\'")}'`
    }

    if (typeof value === 'boolean')
    {
        return value ? 'True' : 'False'
    }

    if (value === null)
    {
        return 'None'
    }

    if (typeof value === 'object')
    {
        // JSON serialisation is valid Python literal syntax once true/false/null
        // are swapped for True/False/None — keys stay double-quoted strings.
        const jsonText = JSON.stringify(value)
        return jsonText
            .replace(/\btrue\b/g, 'True')
            .replace(/\bfalse\b/g, 'False')
            .replace(/\bnull\b/g, 'None')
    }

    return value
}

function generateJsClass(className, constantsObj, mode)
{
    let out = ''

    if (mode === 'html5')
    {
        out += `class ${className}\n{\n`

        for (const [key, value] of Object.entries(constantsObj))
        {
            out += `    static ${key} = ${formatValue(value)};\n`
        }

        out += `}\n\nexport default ${className};\n`
    }
    else
    {
        out += `class ${className}\n{\n`

        for (const [key, value] of Object.entries(constantsObj))
        {
            out += `    static ${key} = ${formatValue(value)};\n`
        }

        out += `}\n\nmodule.exports = ${className};\n`
    }

    return out
}

function generatePythonClass(className, constantsObj)
{
    let out = `class ${className}:\n`

    for (const [key, value] of Object.entries(constantsObj))
    {
        out += `    ${key} = ${formatValuePython(value)}\n`
    }

    return out
}

if (!fs.existsSync(commonConstantsDir))
{
    console.error(`Common/Constants directory not found at: ${commonConstantsDir}`)
    process.exit(1)
}

const constantsFiles =
    fs.readdirSync(commonConstantsDir)
        .filter(f => f.endsWith('.json'))

if (constantsFiles.length === 0)
{
    console.warn('No .json files found in Common/Constants — nothing to generate.')
    process.exit(0)
}

for (const service of serviceList)
{
    const language = serviceManifest[service].language

    const constantsDirectory =
        path.join(rootDirectory, service, 'Globals', 'Constants')

    if (!fs.existsSync(constantsDirectory))
    {
        fs.mkdirSync(constantsDirectory, { recursive: true })
        console.log(`Created: ${constantsDirectory}`)
    }

    for (const constantsFile of constantsFiles)
    {
        const constantsPath =
            path.join(commonConstantsDir, constantsFile)

        const constantsObj =
            JSON.parse(fs.readFileSync(constantsPath, 'utf8'))

        const pascalClassName =
            toPascalCase(path.parse(constantsFile).name)

        if (language === 'html5')
        {
            const jsClass =
                generateJsClass(pascalClassName, constantsObj, 'html5')

            const outPath = path.join(constantsDirectory, `${pascalClassName}.js`)
            fs.writeFileSync(outPath, jsClass)
            console.log(`Generated: ${outPath}`)
        }
        else if (language === 'javascript')
        {
            const jsClass =
                generateJsClass(pascalClassName, constantsObj, 'commonjs')

            const outPath = path.join(constantsDirectory, `${pascalClassName}.js`)
            fs.writeFileSync(outPath, jsClass)
            console.log(`Generated: ${outPath}`)
        }
        else if (language === 'python')
        {
            const pyClass =
                generatePythonClass(pascalClassName, constantsObj)

            const outPath = path.join(constantsDirectory, `${pascalClassName}.py`)
            fs.writeFileSync(outPath, pyClass)
            console.log(`Generated: ${outPath}`)
        }
        else
        {
            console.warn(`Unknown language '${language}' for service '${service}' — skipping.`)
        }
    }
}