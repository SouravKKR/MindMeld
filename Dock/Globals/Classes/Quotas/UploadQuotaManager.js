const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const UploadQuotaLimits = require("../../Constants/UploadQuotaLimits");
const ErrorCodes = require("../../Constants/ErrorCodes");

class UploadQuotaManager
{
    #maxFilesPerDay;
    #maxBytesPerDay;
    #windowType;

    constructor({ maxFilesPerDay = null, maxBytesPerDay = null, windowType = null } = {})
    {
        this.#maxFilesPerDay = maxFilesPerDay !== null ? maxFilesPerDay : UploadQuotaLimits.MAX_FILES_PER_DAY;
        this.#maxBytesPerDay = maxBytesPerDay !== null ? maxBytesPerDay : UploadQuotaLimits.MAX_BYTES_PER_DAY;
        this.#windowType = windowType || UploadQuotaLimits.WINDOW_TYPE;
    }

    #getWindowStart()
    {
        const now = new Date();

        if (this.#windowType === "daily")
        {
            return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
        }

        return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
    }

    #getWindowEnd(windowStart)
    {
        if (this.#windowType === "daily")
        {
            return new Date(windowStart.getTime() + 24 * 60 * 60 * 1000);
        }

        const nextMonth = new Date(windowStart);
        nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
        return nextMonth;
    }

    async #getQuotaDocument(userId, windowStart)
    {
        const database = await DatabaseConnector.getDatabase();
        return await database
            .collection(DatabaseConstants.UPLOAD_QUOTAS_COLLECTION)
            .findOne({ userId: userId, windowStart: windowStart });
    }

    async check(userId, fileSizeBytes)
    {
        if (!userId)
        {
            return {
                allowed: false,
                reason: ErrorCodes.MISSING_USER_ID,
                remainingBytes: 0,
                remainingFiles: 0,
                resetAt: null
            };
        }

        const windowStart = this.#getWindowStart();
        const windowEnd = this.#getWindowEnd(windowStart);
        const document = await this.#getQuotaDocument(userId, windowStart);

        const usedFiles = document?.fileCount || 0;
        const usedBytes = document?.totalBytes || 0;

        const remainingFiles = Math.max(0, this.#maxFilesPerDay - usedFiles);
        const remainingBytes = Math.max(0, this.#maxBytesPerDay - usedBytes);

        if (usedFiles >= this.#maxFilesPerDay)
        {
            return {
                allowed: false,
                reason: `File count limit reached (${usedFiles}/${this.#maxFilesPerDay})`,
                remainingBytes: remainingBytes,
                remainingFiles: 0,
                resetAt: windowEnd.toISOString()
            };
        }

        if (fileSizeBytes > 0 && usedBytes + fileSizeBytes > this.#maxBytesPerDay)
        {
            return {
                allowed: false,
                reason: `Byte limit would be exceeded (${usedBytes + fileSizeBytes}/${this.#maxBytesPerDay})`,
                remainingBytes: remainingBytes,
                remainingFiles: remainingFiles,
                resetAt: windowEnd.toISOString()
            };
        }

        return {
            allowed: true,
            reason: null,
            remainingBytes: remainingBytes - (fileSizeBytes || 0),
            remainingFiles: remainingFiles - 1,
            resetAt: windowEnd.toISOString()
        };
    }

    async record(userId, fileSizeBytes)
    {
        if (!userId)
        {
            return;
        }

        const windowStart = this.#getWindowStart();
        const database = await DatabaseConnector.getDatabase();

        await database
            .collection(DatabaseConstants.UPLOAD_QUOTAS_COLLECTION)
            .updateOne
            (
                { userId: userId, windowStart: windowStart },
                {
                    $inc: { fileCount: 1, totalBytes: fileSizeBytes || 0 },
                    $setOnInsert: { userId: userId, windowStart: windowStart }
                },
                { upsert: true }
            );
    }

    async reset(userId)
    {
        if (!userId)
        {
            return;
        }

        const database = await DatabaseConnector.getDatabase();
        await database
            .collection(DatabaseConstants.UPLOAD_QUOTAS_COLLECTION)
            .deleteMany({ userId: userId });
    }

    async getUsage(userId)
    {
        const windowStart = this.#getWindowStart();
        const document = await this.#getQuotaDocument(userId, windowStart);

        return {
            userId: userId,
            windowStart: windowStart.toISOString(),
            fileCount: document?.fileCount || 0,
            totalBytes: document?.totalBytes || 0,
            maxFilesPerDay: this.#maxFilesPerDay,
            maxBytesPerDay: this.#maxBytesPerDay
        };
    }
}

module.exports = UploadQuotaManager;
