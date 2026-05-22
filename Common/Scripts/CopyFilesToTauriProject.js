const fs = require('fs')
const path = require('path')

function copyDirRecursive(src, dest)
{
    if (!fs.existsSync(dest))
    {
        fs.mkdirSync(dest, { recursive: true })
    }

    const entries = fs.readdirSync(src, { withFileTypes: true })

    for (const entry of entries)
    {
        const srcPath = path.join(src, entry.name)
        const destPath = path.join(dest, entry.name)

        if (entry.isDirectory())
        {
            copyDirRecursive(srcPath, destPath)
        }
        else
        {
            fs.copyFileSync(srcPath, destPath)
        }
    }
}

copyDirRecursive(path.join(__dirname, '..', '..', 'Main'), path.join(__dirname, '..', "..", "Build", "Template", "src"));
