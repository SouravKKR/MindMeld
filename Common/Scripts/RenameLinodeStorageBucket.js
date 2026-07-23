// Common/Scripts/RenameLinodeStorageBucket.js
//
// One-time, idempotent migration that moves the Linode Object Storage bucket from
// its pre-rebrand name ("mindmeld-bucket") to the current name Persistence already
// expects ("cogniumlearn-bucket") — see [Deployment.md] and the MindMeld -> CogniumLearn
// rebrand. S3-compatible storage (Linode included) has no rename-bucket operation, so
// this creates the new bucket, copies its CORS configuration, then server-side-copies
// every object across.
//
// Copy — never move/delete: the old bucket is left untouched as a cold backup.
// Re-runnable: an object already present in the destination is skipped, so an
// interrupted run resumes cleanly.
//
// Usage:
//   node Common/Scripts/RenameLinodeStorageBucket.js                    # production (default)
//   node Common/Scripts/RenameLinodeStorageBucket.js --environment=development
//
// Credentials mirror how Persistence resolves them: LINODE_S3_ENDPOINT_HOSTNAMES /
// LINODE_STORAGE_BUCKET_ACCESS_KEY / LINODE_STORAGE_BUCKET_SECRET, read from
// Dock/.<environment>.env (falling back to Agent/.<environment>.env).

const fs = require("fs");
const path = require("path");

const repositoryRootDirectory = path.join(__dirname, "..", "..");
const dockNodeModulesDirectory = path.join(repositoryRootDirectory, "Dock", "node_modules");

const dotenv = require(path.join(dockNodeModulesDirectory, "dotenv"));
const {
    S3Client,
    HeadBucketCommand,
    CreateBucketCommand,
    GetBucketCorsCommand,
    PutBucketCorsCommand,
    HeadObjectCommand,
    CopyObjectCommand,
    ListObjectsV2Command,
} = require(path.join(dockNodeModulesDirectory, "@aws-sdk", "client-s3"));


class LinodeStorageBucketRename
{
    static SOURCE_BUCKET_NAME = "mindmeld-bucket";
    static DESTINATION_BUCKET_NAME = "cogniumlearn-bucket";
    static PRODUCTION_ENVIRONMENT_NAME = "production";
    static COPY_CONCURRENCY = 8;

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

        return LinodeStorageBucketRename.PRODUCTION_ENVIRONMENT_NAME;
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
        const hostnameMatch = /[a-z0-9.-]+\.linodeobjects\.com/i.exec(rawEndpointValue || "");
        return hostnameMatch ? hostnameMatch[0] : (rawEndpointValue || "").trim();
    }

    static buildLinodeClient(serviceEnvironment)
    {
        const endpointHostname = LinodeStorageBucketRename.resolveLinodeEndpointHostname(serviceEnvironment.LINODE_S3_ENDPOINT_HOSTNAMES);
        const regionName = endpointHostname.split(".")[0];
        const accessKeyId = serviceEnvironment.LINODE_STORAGE_BUCKET_ACCESS_KEY;
        const secretAccessKey = serviceEnvironment.LINODE_STORAGE_BUCKET_SECRET;

        if (!endpointHostname || !accessKeyId || !secretAccessKey)
        {
            throw new Error("Linode credentials incomplete (need LINODE_S3_ENDPOINT_HOSTNAMES, LINODE_STORAGE_BUCKET_ACCESS_KEY, LINODE_STORAGE_BUCKET_SECRET).");
        }

        return { client: new S3Client({
            endpoint: `https://${endpointHostname}`,
            region: regionName,
            credentials: { accessKeyId, secretAccessKey },
        }), regionName, endpointHostname };
    }

    static async bucketExists(linodeClient, bucketName)
    {
        try
        {
            await linodeClient.send(new HeadBucketCommand({ Bucket: bucketName }));
            return true;
        }
        catch (headError)
        {
            const statusCode = headError && headError.$metadata ? headError.$metadata.httpStatusCode : undefined;
            if (statusCode === 404 || headError.name === "NotFound")
            {
                return false;
            }
            throw headError;
        }
    }

    static async ensureDestinationBucket(linodeClient, regionName, endpointHostname, serviceEnvironment)
    {
        if (await LinodeStorageBucketRename.bucketExists(linodeClient, LinodeStorageBucketRename.DESTINATION_BUCKET_NAME))
        {
            console.log(`Destination bucket '${LinodeStorageBucketRename.DESTINATION_BUCKET_NAME}' already exists.`);
            return;
        }

        // The AWS SDK auto-populates CreateBucketConfiguration.LocationConstraint for
        // any region other than "us-east-1", and Linode rejects the value it sends
        // (InvalidLocationConstraint). Routing is already pinned by the endpoint host
        // (regionName), so a throwaway client signed as "us-east-1" — which the SDK
        // treats as the no-constraint default and omits the element entirely — creates
        // the bucket in the right place without tripping that validation.
        console.log(`Creating destination bucket '${LinodeStorageBucketRename.DESTINATION_BUCKET_NAME}' in ${regionName}...`);
        const bucketCreationClient = new S3Client({
            endpoint: `https://${endpointHostname}`,
            region: "us-east-1",
            credentials: {
                accessKeyId: serviceEnvironment.LINODE_STORAGE_BUCKET_ACCESS_KEY,
                secretAccessKey: serviceEnvironment.LINODE_STORAGE_BUCKET_SECRET,
            },
        });
        await bucketCreationClient.send(new CreateBucketCommand({ Bucket: LinodeStorageBucketRename.DESTINATION_BUCKET_NAME }));
    }

    static async replicateCorsConfiguration(linodeClient)
    {
        let sourceCorsRules;
        try
        {
            const sourceCors = await linodeClient.send(new GetBucketCorsCommand({ Bucket: LinodeStorageBucketRename.SOURCE_BUCKET_NAME }));
            sourceCorsRules = sourceCors.CORSRules;
        }
        catch (corsReadError)
        {
            console.log(`No CORS configuration on the source bucket to replicate (${corsReadError.name}).`);
            return;
        }

        if (!sourceCorsRules || sourceCorsRules.length === 0)
        {
            return;
        }

        await linodeClient.send(new PutBucketCorsCommand({
            Bucket: LinodeStorageBucketRename.DESTINATION_BUCKET_NAME,
            CORSConfiguration: { CORSRules: sourceCorsRules },
        }));
        console.log(`Replicated CORS configuration (${sourceCorsRules.length} rule(s)) onto the destination bucket.`);
    }

    static async existsInDestination(linodeClient, objectKey)
    {
        try
        {
            await linodeClient.send(new HeadObjectCommand({
                Bucket: LinodeStorageBucketRename.DESTINATION_BUCKET_NAME,
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

    static async copySingleObject(linodeClient, sourceObject, statistics)
    {
        const objectKey = sourceObject.Key;

        try
        {
            if (await LinodeStorageBucketRename.existsInDestination(linodeClient, objectKey))
            {
                statistics.skippedExisting += 1;
                return;
            }

            await linodeClient.send(new CopyObjectCommand({
                Bucket: LinodeStorageBucketRename.DESTINATION_BUCKET_NAME,
                Key: objectKey,
                CopySource: `/${LinodeStorageBucketRename.SOURCE_BUCKET_NAME}/${encodeURIComponent(objectKey)}`,
                MetadataDirective: "COPY",
            }));

            statistics.copied += 1;
            statistics.copiedBytes += sourceObject.Size || 0;
            console.log(`  [copy] ${objectKey} (${sourceObject.Size || 0} bytes)`);
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

    static async listAllObjects(linodeClient, bucketName)
    {
        const objects = [];
        let continuationToken = undefined;
        do
        {
            const response = await linodeClient.send(new ListObjectsV2Command({
                Bucket: bucketName,
                ContinuationToken: continuationToken,
            }));
            objects.push(...(response.Contents || []));
            continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
        }
        while (continuationToken);
        return objects;
    }

    static async run()
    {
        const environmentName = LinodeStorageBucketRename.resolveEnvironmentName();
        console.log(`=== Linode bucket rename: ${LinodeStorageBucketRename.SOURCE_BUCKET_NAME} -> ${LinodeStorageBucketRename.DESTINATION_BUCKET_NAME} (environment: ${environmentName}) ===`);

        const serviceEnvironment = LinodeStorageBucketRename.loadServiceEnvironment(environmentName);
        const { client: linodeClient, regionName, endpointHostname } = LinodeStorageBucketRename.buildLinodeClient(serviceEnvironment);

        if (!(await LinodeStorageBucketRename.bucketExists(linodeClient, LinodeStorageBucketRename.SOURCE_BUCKET_NAME)))
        {
            throw new Error(`Source bucket '${LinodeStorageBucketRename.SOURCE_BUCKET_NAME}' does not exist or is not accessible.`);
        }

        await LinodeStorageBucketRename.ensureDestinationBucket(linodeClient, regionName, endpointHostname, serviceEnvironment);
        await LinodeStorageBucketRename.replicateCorsConfiguration(linodeClient);

        console.log("Listing all source objects...");
        const sourceObjects = await LinodeStorageBucketRename.listAllObjects(linodeClient, LinodeStorageBucketRename.SOURCE_BUCKET_NAME);
        console.log(`Source holds ${sourceObjects.length} objects.`);

        const statistics = { copied: 0, copiedBytes: 0, skippedExisting: 0, failed: 0, failedKeys: [] };

        await LinodeStorageBucketRename.mapWithConcurrency(
            sourceObjects,
            LinodeStorageBucketRename.COPY_CONCURRENCY,
            sourceObject => LinodeStorageBucketRename.copySingleObject(linodeClient, sourceObject, statistics),
        );

        console.log("");
        console.log(`Copied ${statistics.copied} objects (${(statistics.copiedBytes / (1024 * 1024)).toFixed(2)} MB); skipped ${statistics.skippedExisting} already present; ${statistics.failed} failed.`);

        console.log("");
        console.log("=== Verification ===");
        const destinationObjects = await LinodeStorageBucketRename.listAllObjects(linodeClient, LinodeStorageBucketRename.DESTINATION_BUCKET_NAME);
        const sourceKeys = new Set(sourceObjects.map(sourceObject => sourceObject.Key));
        const destinationKeys = new Set(destinationObjects.map(destinationObject => destinationObject.Key));
        const missingKeys = [...sourceKeys].filter(key => !destinationKeys.has(key));

        console.log(`Source objects: ${sourceKeys.size}  Destination objects: ${destinationKeys.size}  Missing: ${missingKeys.length}`);
        if (missingKeys.length > 0)
        {
            console.log(`Missing keys: ${missingKeys.join(", ")}`);
        }

        const allMatched = missingKeys.length === 0;
        console.log(allMatched && statistics.failed === 0
            ? "RESULT: PASS - every source object is present in the destination bucket."
            : "RESULT: FAIL - some objects are still missing from the destination (re-run to resume).");
        if (!allMatched || statistics.failed > 0)
        {
            process.exitCode = 1;
        }
    }
}


LinodeStorageBucketRename.run().catch(error =>
{
    console.error("Migration failed:", error);
    process.exitCode = 1;
});
