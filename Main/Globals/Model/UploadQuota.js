class UploadQuota
{
    #userId;
    #windowStart;
    #fileCount;
    #totalBytes;

    constructor({userId = null, windowStart = new Date(), fileCount = 0, totalBytes = 0} = {})
    {
        this.setUserId(userId);
        this.setWindowStart(windowStart);
        this.setFileCount(fileCount);
        this.setTotalBytes(totalBytes);
    }

    getUserId()
    {
        return this.#userId;
    }

    setUserId(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#userId = value;
    }

    getWindowStart()
    {
        return this.#windowStart;
    }

    setWindowStart(value)
    {
        if (value !== null && value !== undefined)
        {
            value = value instanceof Date ? value : new Date(value);
            if (isNaN(value.getTime()))
            {
                value = new Date();
            }
        }
        else
        {
            value = new Date();
        }
        this.#windowStart = value;
    }

    getFileCount()
    {
        return this.#fileCount;
    }

    setFileCount(value)
    {
        if (value !== null)
        {
            value = parseInt(value, 10);
            if (isNaN(value))
            {
                value = 0;
            }
            else
            {
                value = Math.max(value, 0);
            }
        }
        this.#fileCount = value;
    }

    getTotalBytes()
    {
        return this.#totalBytes;
    }

    setTotalBytes(value)
    {
        if (value !== null)
        {
            value = parseInt(value, 10);
            if (isNaN(value))
            {
                value = 0;
            }
            else
            {
                value = Math.max(value, 0);
            }
        }
        this.#totalBytes = value;
    }

    toJson()
    {
        return {
            userId: this.getUserId(),
            windowStart: this.getWindowStart() !== null ? this.getWindowStart().toISOString() : null,
            fileCount: this.getFileCount(),
            totalBytes: this.getTotalBytes(),
        };
    }

    static fromJson(json)
    {
        const instance = new UploadQuota({
            userId: json.userId ?? null,
            windowStart: json.windowStart != null ? new Date(json.windowStart) : null,
            fileCount: json.fileCount ?? null,
            totalBytes: json.totalBytes ?? null
        });
        return instance;
    }
}

module.exports = UploadQuota;
