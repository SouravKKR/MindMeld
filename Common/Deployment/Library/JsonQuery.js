// Small JSON query helper for the deployment orchestrator (Common/Deployment/deploy.sh).
//
// The orchestrator runs from a Windows dev box under Git Bash, where `jq` is not
// guaranteed but Node.js always is (this is a Node project). Rather than depend on
// jq, the bash scripts pipe Linode API responses into this helper. Each subcommand
// reads the JSON document from stdin and prints a plain string to stdout.
//
// Subcommands:
//   field <dotted.path>                 — print a nested value (blank if missing)
//   maxImageVersion <labelPrefix>       — highest <version> across MindMeldBurstVmImage<version> images (0 if none)
//   highestImageId <labelPrefix>        — id of the highest-version managed image (blank if none)
//   olderImageIds <labelPrefix> <keep>  — image ids whose version < keep, one per line
//   ext4DiskId                          — id of the single ext4 root disk in a disks listing

function readStandardInput()
{
    return new Promise((resolve) =>
    {
        let input = "";
        process.stdin.on("data", chunk => input += chunk);
        process.stdin.on("end", () => resolve(input));
    });
}

function getValueAtPath(document, dottedPath)
{
    let value = document;

    for (const key of dottedPath.split("."))
    {
        value = (value === null || value === undefined) ? undefined : value[key];
    }

    return value;
}

function parseVersionFromLabel(label, labelPrefix)
{
    if (typeof label !== "string" || !label.startsWith(labelPrefix))
    {
        return null;
    }

    const suffix = label.slice(labelPrefix.length);

    // Only a pure integer suffix counts as a managed version (e.g. "7"). Anything
    // else (a hand-made "MindMeldBurstVmImage-backup") is ignored, never deleted.
    if (!/^[0-9]+$/.test(suffix))
    {
        return null;
    }

    return Number(suffix);
}

async function main()
{
    const subcommand = process.argv[2];
    const rawInput = await readStandardInput();
    const document = rawInput.trim() ? JSON.parse(rawInput) : {};

    if (subcommand === "field")
    {
        const value = getValueAtPath(document, process.argv[3] || "");
        process.stdout.write(value === null || value === undefined ? "" : String(value));
        return;
    }

    if (subcommand === "maxImageVersion")
    {
        const labelPrefix = process.argv[3] || "";
        const images = Array.isArray(document.data) ? document.data : [];
        let highestVersion = 0;

        for (const image of images)
        {
            const version = parseVersionFromLabel(image.label, labelPrefix);
            if (version !== null && version > highestVersion)
            {
                highestVersion = version;
            }
        }

        process.stdout.write(String(highestVersion));
        return;
    }

    if (subcommand === "highestImageId")
    {
        const labelPrefix = process.argv[3] || "";
        const images = Array.isArray(document.data) ? document.data : [];
        let highestVersion = 0;
        let highestImageId = "";

        for (const image of images)
        {
            const version = parseVersionFromLabel(image.label, labelPrefix);
            if (version !== null && version > highestVersion)
            {
                highestVersion = version;
                highestImageId = image.id;
            }
        }

        process.stdout.write(highestImageId === null || highestImageId === undefined ? "" : String(highestImageId));
        return;
    }

    if (subcommand === "olderImageIds")
    {
        const labelPrefix = process.argv[3] || "";
        const keepVersion = Number(process.argv[4] || "0");
        const images = Array.isArray(document.data) ? document.data : [];
        const olderIds = [];

        for (const image of images)
        {
            const version = parseVersionFromLabel(image.label, labelPrefix);
            if (version !== null && version < keepVersion)
            {
                olderIds.push(image.id);
            }
        }

        process.stdout.write(olderIds.join("\n"));
        return;
    }

    if (subcommand === "ext4DiskId")
    {
        const disks = Array.isArray(document.data) ? document.data : [];
        const rootDisk = disks.find(disk => disk.filesystem === "ext4");
        process.stdout.write(rootDisk ? String(rootDisk.id) : "");
        return;
    }

    process.stderr.write(`JsonQuery.js: unknown subcommand "${subcommand}"\n`);
    process.exit(2);
}

main().catch((error) =>
{
    process.stderr.write(`JsonQuery.js: ${error.message}\n`);
    process.exit(1);
});
