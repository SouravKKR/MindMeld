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

// Windows holds file handles briefly after a process closes them (browser
// tabs serving localhost:3000, the IDE's file watcher, antivirus scans).
// fs.rmSync supports a retry loop natively — use it so the wipe survives
// transient ENOTEMPTY / EBUSY / EPERM errors instead of aborting the build.
const staticDirectory = path.join(__dirname, '..', '..', "Dock", "Static");

if (fs.existsSync(staticDirectory))
{
    fs.rmSync(staticDirectory, {
        recursive:  true,
        force:      true,
        maxRetries: 10,
        retryDelay: 200,
    });
}

copyDirRecursive(path.join(__dirname, '..', '..', "Main"), staticDirectory);