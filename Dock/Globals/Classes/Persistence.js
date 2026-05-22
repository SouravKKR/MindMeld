const { storageTargets } = require("../Enumerations/StorageTargets");
const fs = require("fs/promises");
const path = require("path");
const { Storage } = require('@google-cloud/storage');
class Persistence
{
    static #storage;
    static #bucket;
    static #GOOGLE_CLOUD_STORAGE_BUCKET_NAME = 'mindmeld-bucket';

    static #defaultStorageTarget = storageTargets.GOOGLE_CLOUD_STORAGE;

    static 
    {
        Persistence.#storage = new Storage({keyFilename: path.join(__dirname, '..', "..", "..", "Common", "Credentials", "mindmeld-storage-2026-249fc22c6610.json" )});
        Persistence.#bucket = Persistence.#storage.bucket(Persistence.#GOOGLE_CLOUD_STORAGE_BUCKET_NAME);
    }
    
    /**
     * Saves a file to the given target (either local file system or Google Cloud Storage).
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

            case storageTargets.GOOGLE_CLOUD_STORAGE:
            {
                const file = Persistence.#bucket.file(filePath);
                await file.save(data, 
                {
                    resumable: false,
                    gzip: true,
                    metadata: 
                    {
                        cacheControl: 'public, max-age=31536000',
                    },
                });
            }
            break;
            
        }
    }

    /**
     * Reads a file from the given target (either local file system or Google Cloud Storage).
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

            case storageTargets.GOOGLE_CLOUD_STORAGE:
            {
                const file = Persistence.#bucket.file(filePath);
                const [content] = await file.download();
                return content;
            }
            break;
        }
    }

    /**
     * Checks if a file exists in the given target (either local file system or Google Cloud Storage).
     * If the target is the local file system, it will throw an error if the file doesn't exist.
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

            case storageTargets.GOOGLE_CLOUD_STORAGE:
            {
                const [exists] = await Persistence.#bucket.file(filePath).exists();
                return exists;
            }
            break;
        }
    }

    /**
     * Deletes a file from the given target (either local file system or Google Cloud Storage).
     * If the target is the local file system, it will throw an error if the file doesn't exist.
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

            case storageTargets.GOOGLE_CLOUD_STORAGE:
            {
                await Persistence.#bucket.file(filePath).delete();
            }
            break;
        }
    }
    static async move(source, sourceTarget = Persistence.#defaultStorageTarget, destination, destinationTarget = Persistence.#defaultStorageTarget)
    {
        if (sourceTarget === storageTargets.GOOGLE_CLOUD_STORAGE && destinationTarget === storageTargets.GOOGLE_CLOUD_STORAGE) 
        {
            await Persistence.#bucket.file(source).move(destination);
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

            case storageTargets.GOOGLE_CLOUD_STORAGE:
            {
                const [files] = await Persistence.#bucket.getFiles({ prefix });
                return files.map(file => file.name);
            }
        }

        return [];
    }
}

module.exports = Persistence ;