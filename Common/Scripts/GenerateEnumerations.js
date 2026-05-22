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

const commonEnumsDir =
    path.join(rootDirectory, 'Common', 'Enumerations')

const serviceList = Object.keys(serviceManifest)

function toCamelCase(name)
{
    return name.charAt(0).toLowerCase() + name.slice(1)
}

function toPascalCase(name)
{
    return name.charAt(0).toUpperCase() + name.slice(1)
}

function generateJsEnum(enumName, enumObj, mode)
{
    let out = ''

    if (mode === 'html5')
    {
        out += `export const ${enumName} =\n{\n`
    }
    else
    {
        out += `const ${enumName} =\n{\n`
    }

    for (const [key, value] of Object.entries(enumObj))
    {
        out += `  ${key}: ${value},\n`
    }

    out += `}\n`

    if (mode === 'commonjs')
    {
        out += `\nmodule.exports = { ${enumName} };\n`
    }

    return out
}

function generatePythonEnum(enumName, enumObj)
{
    let out = `from enum import IntEnum\n\nclass ${enumName}(IntEnum):\n`

    for (const [key, value] of Object.entries(enumObj))
    {
        out += `    ${key} = ${value}\n`
    }

    return out
}

const enumFiles =
    fs.readdirSync(commonEnumsDir)
        .filter(f => f.endsWith('.json'))

for (const service of serviceList)
{
    const language = serviceManifest[service].language

    const enumerationsDirectory =
        path.join(rootDirectory, service, 'Globals', 'Enumerations')

    if (!fs.existsSync(enumerationsDirectory))
    {
        continue
    }

    for (const enumFile of enumFiles)
    {
        const enumPath =
            path.join(commonEnumsDir, enumFile)

        const enumObj =
            JSON.parse(fs.readFileSync(enumPath, 'utf8'))

        const pascalEnumName =
            toPascalCase(path.parse(enumFile).name)

        if (language === 'html5')
        {
            const jsEnumName = toCamelCase(pascalEnumName)
            const jsEnum =
                generateJsEnum(jsEnumName, enumObj, 'html5')

            fs.writeFileSync(
                path.join(enumerationsDirectory, `${pascalEnumName}.js`),
                jsEnum
            )
        }
        else if (language === 'javascript')
        {
            const jsEnumName = toCamelCase(pascalEnumName)
            const jsEnum =
                generateJsEnum(jsEnumName, enumObj, 'commonjs')

            fs.writeFileSync(
                path.join(enumerationsDirectory, `${pascalEnumName}.js`),
                jsEnum
            )
        }
        else if (language === 'python')
        {
            const pyEnum =
                generatePythonEnum(pascalEnumName, enumObj)

            fs.writeFileSync(
                path.join(enumerationsDirectory, `${pascalEnumName}.py`),
                pyEnum
            )
        }
    }
}