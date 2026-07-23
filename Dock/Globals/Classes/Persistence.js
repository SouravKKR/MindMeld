const { storageTargets } = require("../Enumerations/StorageTargets");
const fs = require("fs/promises");
const path = require("path");
const
{
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    DeleteObjectCommand,
    CopyObjectCommand,
    ListObjectsV2Command
} = require("@aws-sdk/client-s3");

class Persistence
{
    // Linode Object Storage is S3-compatible, so it is reached through the AWS S3
    // client pointed at the Linode regional endpoint. Credentials come from the
    // environment (LINODE_STORAGE_BUCKET_ACCESS_KEY / LINODE_STORAGE_BUCKET_SECRET),
    // and the endpoint hostname from LINODE_S3_ENDPOINT_HOSTNAMES.
    static #linodeObjectStorageClient;
    static #LINODE_OBJECT_STORAGE_BUCKET_NAME = 'cogniumlearn-bucket';

    static #defaultStorageTarget = storageTargets.LINODE_OBJECT_STORAGE;

    // The Linode dashboard presents the endpoint as a labelled string such as
    // "IN, Chennai: in-maa-1.linodeobjects.com". Only the bare hostname is meaningful
    // to the S3 client, so it is extracted here; the leading label component of that
    // hostname (e.g. "in-maa-1") doubles as the S3 region used for request signing.
    static #resolveLinodeEndpointHostname()
    {
        const rawEndpointValue = process.env.LINODE_S3_ENDPOINT_HOSTNAMES || "";
        const hostnameMatch = rawEndpointValue.match(/[a-z0-9.-]+\.linodeobjects\.com/i);
        return hostnameMatch ? hostnameMatch[0] : rawEndpointValue.trim();
    }

    static
    {
        const linodeEndpointHostname = Persistence.#resolveLinodeEndpointHostname();
        const linodeRegion = linodeEndpointHostname.split(".")[0];
        Persistence.#linodeObjectStorageClient = new S3Client
        ({
            endpoint: `https://${linodeEndpointHostname}`,
            region: linodeRegion,
            credentials:
            {
                accessKeyId: process.env.LINODE_STORAGE_BUCKET_ACCESS_KEY,
                secretAccessKey: process.env.LINODE_STORAGE_BUCKET_SECRET
            }
        });
    }

    /**
     * Saves a file to the given target (local file system or Linode Object Storage).
     * If the target is the local file system, it will create the directory if it doesn't exist.
     * @param {string} filePath - The path of the file to save.
     * @param { string | Buffer | Uint8Array } data - The data to be saved.
     * @param {storageTargets} [target=Persistence.#defaultStorageTarget] - The target to save to.
     * @returns {Promise<void>} - A promise that resolves when the data has been saved.
     */
    static async write(filePath, data, target = Persistence.#defaultStorageTarget)
    {
        switch(target)
        {
            case storageTargets.LOCAL_FILE_SYSTEM:
            {
                filePath = path.normalize(filePath);
                await fs.mkdir(path.dirname(filePath), { recursive: true });
                await fs.writeFile(filePath, data);
            }
            break;

            case storageTargets.LINODE_OBJECT_STORAGE:
            {
                await Persistence.#linodeObjectStorageClient.send(new PutObjectCommand
                ({
                    Bucket: Persistence.#LINODE_OBJECT_STORAGE_BUCKET_NAME,
                    Key: filePath,
                    Body: data,
                    CacheControl: 'public, max-age=31536000'
                }));
            }
            break;
        }
    }

    /**
     * Reads a file from the given target (local file system or Linode Object Storage).
     * If the target is the local file system, it will throw an error if the file doesn't exist.
     * @param {string} filePath - The path of the file to read.
     * @param {storageTargets} [target=Persistence.#defaultStorageTarget] - The target to read from.
     * @returns {Promise<Buffer|Uint8Array|string>} - A promise that resolves with the contents of the file.
     */
    static async read(filePath, target = Persistence.#defaultStorageTarget)
    {
        if(target == storageTargets.LOCAL_FILE_SYSTEM)
        {
            filePath = path.normalize(filePath);
            console.log(filePath);
        }

        switch(target)
        {
            case storageTargets.LOCAL_FILE_SYSTEM:
            {
                return await fs.readFile(filePath);
            }
            break;

            case storageTargets.LINODE_OBJECT_STORAGE:
            {
                const response = await Persistence.#linodeObjectStorageClient.send(new GetObjectCommand
                ({
                    Bucket: Persistence.#LINODE_OBJECT_STORAGE_BUCKET_NAME,
                    Key: filePath
                }));
                const contentByteArray = await response.Body.transformToByteArray();
                return Buffer.from(contentByteArray);
            }
            break;
        }
    }

    /**
     * Checks if a file exists in the given target (local file system or Linode Object Storage).
     * @param {string} filePath - The path of the file to check.
     * @param {storageTargets} [target=Persistence.#defaultStorageTarget] - The target to check in.
     * @returns {Promise<boolean>} - A promise that resolves with true if the file exists, false otherwise.
     */
    static async exists(filePath, target = Persistence.#defaultStorageTarget)
    {
        switch(target)
        {
            case storageTargets.LOCAL_FILE_SYSTEM:
            {
                try
                {
                    await fs.access(filePath);
                    return true;
                }
                catch
                {
                    return false;
                }
            }
            break;

            case storageTargets.LINODE_OBJECT_STORAGE:
            {
                try
                {
                    await Persistence.#linodeObjectStorageClient.send(new HeadObjectCommand
                    ({
                        Bucket: Persistence.#LINODE_OBJECT_STORAGE_BUCKET_NAME,
                        Key: filePath
                    }));
                    return true;
                }
                catch (error)
                {
                    if (error.name === "NotFound" || error.$metadata?.httpStatusCode === 404)
                    {
                        return false;
                    }
                    throw error;
                }
            }
            break;
        }
    }

    /**
     * Deletes a file from the given target (local file system or Linode Object Storage).
     * @param {string} filePath - The path of the file to delete.
     * @param {storageTargets} [target=Persistence.#defaultStorageTarget] - The target to delete from.
     * @returns {Promise<void>} - A promise that resolves when the deletion is complete.
     */
    static async delete(filePath, target = Persistence.#defaultStorageTarget)
    {
        switch(target)
        {
            case storageTargets.LOCAL_FILE_SYSTEM:
            {
                await fs.unlink(filePath);
            }
            break;

            case storageTargets.LINODE_OBJECT_STORAGE:
            {
                await Persistence.#linodeObjectStorageClient.send(new DeleteObjectCommand
                ({
                    Bucket: Persistence.#LINODE_OBJECT_STORAGE_BUCKET_NAME,
                    Key: filePath
                }));
            }
            break;
        }
    }

    static async move(source, sourceTarget = Persistence.#defaultStorageTarget, destination, destinationTarget = Persistence.#defaultStorageTarget)
    {
        if (sourceTarget === storageTargets.LINODE_OBJECT_STORAGE && destinationTarget === storageTargets.LINODE_OBJECT_STORAGE)
        {
            await Persistence.#linodeObjectStorageClient.send(new CopyObjectCommand
            ({
                Bucket: Persistence.#LINODE_OBJECT_STORAGE_BUCKET_NAME,
                CopySource: `${Persistence.#LINODE_OBJECT_STORAGE_BUCKET_NAME}/${source}`,
                Key: destination
            }));
            await Persistence.delete(source, storageTargets.LINODE_OBJECT_STORAGE);
        }
        else
        {
            const data = await Persistence.read(source, sourceTarget);
            await Persistence.write(destination, data, destinationTarget);
            await Persistence.delete(source, sourceTarget);
        }
    }

    /**
     * Lists all files under a given path prefix in the given target.
     * @param {string} prefix - The path prefix to list files under.
     * @param {storageTargets} [target=Persistence.#defaultStorageTarget] - The target to list files in.
     * @returns {Promise<string[]>} - A promise that resolves with an array of file paths under the prefix.
     */
    static async list(prefix, target = Persistence.#defaultStorageTarget)
    {
        switch(target)
        {
            case storageTargets.LOCAL_FILE_SYSTEM:
            {
                const normalizedPrefix = path.normalize(prefix);

                const collectFiles = async (directoryPath) =>
                {
                    const filePaths = [];

                    try
                    {
                        const entries = await fs.readdir(directoryPath, { withFileTypes: true });

                        for (const entry of entries)
                        {
                            const fullPath = path.join(directoryPath, entry.name);

                            if (entry.isDirectory())
                            {
                                filePaths.push(...await collectFiles(fullPath));
                            }
                            else
                            {
                                filePaths.push(fullPath);
                            }
                        }
                    }
                    catch
                    {
                        // Directory does not exist — return empty
                    }

                    return filePaths;
                };

                return await collectFiles(normalizedPrefix);
            }

            case storageTargets.LINODE_OBJECT_STORAGE:
            {
                const objectKeys = [];
                let continuationToken;

                do
                {
                    const response = await Persistence.#linodeObjectStorageClient.send(new ListObjectsV2Command
                    ({
                        Bucket: Persistence.#LINODE_OBJECT_STORAGE_BUCKET_NAME,
                        Prefix: prefix,
                        ContinuationToken: continuationToken
                    }));

                    for (const object of response.Contents || [])
                    {
                        objectKeys.push(object.Key);
                    }

                    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
                }
                while (continuationToken);

                return objectKeys;
            }
        }

        return [];
    }
}

module.exports = Persistence ;
