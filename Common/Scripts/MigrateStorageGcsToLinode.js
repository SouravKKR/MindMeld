// Common/Scripts/MigrateStorageGcsToLinode.js
//
// One-time, idempotent backfill that COPIES every object from the legacy Google
// Cloud Storage bucket into the Linode Object Storage bucket (S3-compatible).
//
// The storage migration flipped the default provider to Linode in Persistence
// (both Agent and Dock) but never copied the existing objects across, so every
// pre-migration information source / figure was stranded in GCS and reads from
// the now-default Linode bucket returned nothing (PROCESS_SYLLABUS failed with
// "Could not derive a syllabus"). This script closes that gap.
//
// Copy — never move: GCS is left untouched as a cold backup. Re-runnable: an
// object already present in Linode is skipped. Object keys and the bucket name
// ("cogniumlearn-bucket") are identical across providers, so nothing is rewritten.
//
// Usage:
//   node Common/Scripts/MigrateStorageGcsToLinode.js                    # production (default)
//   node Common/Scripts/MigrateStorageGcsToLinode.js --environment=development
//
// Credentials mirror how the services resolve them:
//   - GCS   : Common/Credentials/cogniumlearn-storage.<environment>.json
//   - Linode: LINODE_S3_ENDPOINT_HOSTNAMES / LINODE_STORAGE_BUCKET_ACCESS_KEY /
//             LINODE_STORAGE_BUCKET_SECRET, read from Dock/.<environment>.env
//             (falling back to Agent/.<environment>.env).

const fs = require("fs");
const path = require("path");

const repositoryRootDirectory = path.join(__dirname, "..", "..");
const dockNodeModulesDirectory = path.join(repositoryRootDirectory, "Dock", "node_modules");

const dotenv = require(path.join(dockNodeModulesDirectory, "dotenv"));
const { Storage } = require(path.join(dockNodeModulesDirectory, "@google-cloud", "storage"));
const {
    S3Client,
    HeadObjectCommand,
    PutObjectCommand,
    ListObjectsV2Command,
} = require(path.join(dockNodeModulesDirectory, "@aws-sdk", "client-s3"));


class GcsToLinodeStorageMigration
{
    static BUCKET_NAME = "cogniumlearn-bucket";
    static CACHE_CONTROL = "public, max-age=31536000";
    static PRODUCTION_ENVIRONMENT_NAME = "production";
    static UPLOAD_CONCURRENCY = 6;

    static resolveEnvironmentName()
    {
        for (const argument of process.argv)
        {
            if (argument.startsWith("--environment="))
            {
                return argument.split("=", 2)[1];
            }
        }

        if (process.env.COGNIUMLEARN_ENVIRONMENT)
        {
            return process.env.COGNIUMLEARN_ENVIRONMENT;
        }

        return GcsToLinodeStorageMigration.PRODUCTION_ENVIRONMENT_NAME;
    }

    static loadServiceEnvironment(environmentName)
    {
        const candidateFileNames = environmentName === "local"
            ? [".local.env", ".env"]
            : [`.${environmentName}.env`];

        for (const serviceDirectoryName of ["Dock", "Agent"])
        {
            for (const candidateFileName of candidateFileNames)
            {
                const candidateFilePath = path.join(repositoryRootDirectory, serviceDirectoryName, candidateFileName);
                if (fs.existsSync(candidateFilePath))
                {
                    return dotenv.parse(fs.readFileSync(candidateFilePath));
                }
            }
        }

        throw new Error(`No env file found for environment '${environmentName}' in Dock/ or Agent/.`);
    }

    static resolveLinodeEndpointHostname(rawEndpointValue)
    {
        // The Linode dashboard presents the endpoint as a labelled string such as
        // "IN, Chennai: in-maa-1.linodeobjects.com"; only the bare hostname is
        // meaningful to the S3 client. This mirrors Persistence exactly.
        const hostnameMatch = /[a-z0-9.-]+\.linodeobjects\.com/i.exec(rawEndpointValue || "");
        return hostnameMatch ? hostnameMatch[0] : (rawEndpointValue || "").trim();
    }

    static buildLinodeClient(serviceEnvironment)
    {
        const endpointHostname = GcsToLinodeStorageMigration.resolveLinodeEndpointHostname(serviceEnvironment.LINODE_S3_ENDPOINT_HOSTNAMES);
        // The leading label component of the hostname (e.g. "in-maa-1") doubles as
        // the S3 region used for request signing.
        const regionName = endpointHostname.split(".")[0];
        const accessKeyId = serviceEnvironment.LINODE_STORAGE_BUCKET_ACCESS_KEY;
        const secretAccessKey = serviceEnvironment.LINODE_STORAGE_BUCKET_SECRET;

        if (!endpointHostname || !accessKeyId || !secretAccessKey)
        {
            throw new Error("Linode credentials incomplete (need LINODE_S3_ENDPOINT_HOSTNAMES, LINODE_STORAGE_BUCKET_ACCESS_KEY, LINODE_STORAGE_BUCKET_SECRET).");
        }

        return new S3Client({
            endpoint: `https://${endpointHostname}`,
            region: regionName,
            credentials: { accessKeyId, secretAccessKey },
        });
    }

    static buildGoogleCloudStorageBucket(environmentName)
    {
        const credentialsPath = path.join(repositoryRootDirectory, "Common", "Credentials", `cogniumlearn-storage.${environmentName}.json`);
        if (!fs.existsSync(credentialsPath))
        {
            throw new Error(`GCS credentials not found at ${credentialsPath}.`);
        }
        const storageClient = new Storage({ keyFilename: credentialsPath });
        return storageClient.bucket(GcsToLinodeStorageMigration.BUCKET_NAME);
    }

    static async existsInLinode(linodeClient, objectKey)
    {
        try
        {
            await linodeClient.send(new HeadObjectCommand({
                Bucket: GcsToLinodeStorageMigration.BUCKET_NAME,
                Key: objectKey,
            }));
            return true;
        }
        catch (headError)
        {
            const statusCode = headError && headError.$metadata ? headError.$metadata.httpStatusCode : undefined;
            if (headError.name === "NotFound" || headError.name === "NoSuchKey" || statusCode === 404)
            {
                return false;
            }
            throw headError;
        }
    }

    static async copySingleObject(linodeClient, googleCloudFile, statistics)
    {
        const objectKey = googleCloudFile.name;

        // GCS "directory" placeholder objects have no bytes and no S3 equivalent.
        if (objectKey.endsWith("/"))
        {
            statistics.skippedPlaceholders += 1;
            return;
        }

        try
        {
            if (await GcsToLinodeStorageMigration.existsInLinode(linodeClient, objectKey))
            {
                statistics.skippedExisting += 1;
                console.log(`  [skip] already in Linode: ${objectKey}`);
                return;
            }

            const [objectBytes] = await googleCloudFile.download();
            const contentType = (googleCloudFile.metadata && googleCloudFile.metadata.contentType) || "application/octet-stream";

            await linodeClient.send(new PutObjectCommand({
                Bucket: GcsToLinodeStorageMigration.BUCKET_NAME,
                Key: objectKey,
                Body: objectBytes,
                ContentType: contentType,
                CacheControl: GcsToLinodeStorageMigration.CACHE_CONTROL,
            }));

            statistics.copied += 1;
            statistics.copiedBytes += objectBytes.length;
            console.log(`  [copy] ${objectKey} (${objectBytes.length} bytes, ${contentType})`);
        }
        catch (copyError)
        {
            statistics.failed += 1;
            statistics.failedKeys.push(objectKey);
            console.error(`  [FAIL] ${objectKey}: ${copyError.message}`);
        }
    }

    static async mapWithConcurrency(items, concurrencyLimit, asyncWorker)
    {
        let nextIndex = 0;
        const runLane = async () =>
        {
            while (nextIndex < items.length)
            {
                const currentIndex = nextIndex;
                nextIndex += 1;
                await asyncWorker(items[currentIndex]);
            }
        };

        const lanes = [];
        for (let laneIndex = 0; laneIndex < Math.min(concurrencyLimit, items.length); laneIndex += 1)
        {
            lanes.push(runLane());
        }
        await Promise.all(lanes);
    }

    static topLevelPrefixOf(objectKey)
    {
        const slashIndex = objectKey.indexOf("/");
        return slashIndex === -1 ? "(root)" : objectKey.slice(0, slashIndex);
    }

    static async listLinodeKeys(linodeClient)
    {
        const objectKeys = [];
        let continuationToken = undefined;
        do
        {
            const response = await linodeClient.send(new ListObjectsV2Command({
                Bucket: GcsToLinodeStorageMigration.BUCKET_NAME,
                ContinuationToken: continuationToken,
            }));
            for (const storedObject of (response.Contents || []))
            {
                objectKeys.push(storedObject.Key);
            }
            continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
        }
        while (continuationToken);
        return objectKeys;
    }

    static countByPrefix(objectKeys)
    {
        const countsByPrefix = {};
        for (const objectKey of objectKeys)
        {
            if (objectKey.endsWith("/"))
            {
                continue;
            }
            const prefix = GcsToLinodeStorageMigration.topLevelPrefixOf(objectKey);
            countsByPrefix[prefix] = (countsByPrefix[prefix] || 0) + 1;
        }
        return countsByPrefix;
    }

    static async run()
    {
        const environmentName = GcsToLinodeStorageMigration.resolveEnvironmentName();
        console.log(`=== GCS -> Linode storage backfill (environment: ${environmentName}) ===`);

        const serviceEnvironment = GcsToLinodeStorageMigration.loadServiceEnvironment(environmentName);
        const linodeClient = GcsToLinodeStorageMigration.buildLinodeClient(serviceEnvironment);
        const googleCloudStorageBucket = GcsToLinodeStorageMigration.buildGoogleCloudStorageBucket(environmentName);

        console.log("Listing all GCS objects...");
        const [googleCloudFiles] = await googleCloudStorageBucket.getFiles();
        const copyableFiles = googleCloudFiles.filter(file => !file.name.endsWith("/"));
        console.log(`GCS holds ${copyableFiles.length} copyable objects.`);

        const statistics = { copied: 0, copiedBytes: 0, skippedExisting: 0, skippedPlaceholders: 0, failed: 0, failedKeys: [] };

        await GcsToLinodeStorageMigration.mapWithConcurrency(
            copyableFiles,
            GcsToLinodeStorageMigration.UPLOAD_CONCURRENCY,
            file => GcsToLinodeStorageMigration.copySingleObject(linodeClient, file, statistics),
        );

        console.log("");
        console.log(`Copied ${statistics.copied} objects (${(statistics.copiedBytes / (1024 * 1024)).toFixed(2)} MB); skipped ${statistics.skippedExisting} already present; ${statistics.failed} failed.`);

        // Verification: every GCS top-level prefix must be fully present in Linode.
        console.log("");
        console.log("=== Verification (per top-level prefix) ===");
        const googleCloudCounts = GcsToLinodeStorageMigration.countByPrefix(googleCloudFiles.map(file => file.name));
        const linodeCounts = GcsToLinodeStorageMigration.countByPrefix(await GcsToLinodeStorageMigration.listLinodeKeys(linodeClient));

        const allPrefixes = Array.from(new Set([...Object.keys(googleCloudCounts), ...Object.keys(linodeCounts)])).sort();
        let allMatched = true;
        for (const prefix of allPrefixes)
        {
            const googleCloudCount = googleCloudCounts[prefix] || 0;
            const linodeCount = linodeCounts[prefix] || 0;
            const matched = linodeCount >= googleCloudCount;
            if (!matched)
            {
                allMatched = false;
            }
            console.log(`  ${matched ? "OK " : "!! "} ${prefix.padEnd(24)} GCS=${googleCloudCount}  Linode=${linodeCount}`);
        }

        console.log("");
        if (statistics.failed > 0)
        {
            console.log(`Failed keys: ${statistics.failedKeys.join(", ")}`);
        }
        console.log(allMatched && statistics.failed === 0
            ? "RESULT: PASS - every GCS prefix is fully present in Linode."
            : "RESULT: FAIL - some objects are still missing from Linode (re-run to resume).");
        if (!allMatched || statistics.failed > 0)
        {
            process.exitCode = 1;
        }
    }
}


GcsToLinodeStorageMigration.run().catch(error =>
{
    console.error("Migration failed:", error);
    process.exitCode = 1;
});
