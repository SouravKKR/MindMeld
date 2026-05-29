import { informationSourceTypes } from '../Enumerations/InformationSourceTypes.js';
import { ocrModes } from '../Enumerations/OcrModes.js';

class InformationSource
{
    #id;
    #name;
    #userId;
    #sourceType;
    #directoryPath;
    #tags;
    #mimeType;
    #hash;
    #ocrMode;

    constructor({name = null, userId = null, sourceType = null, directoryPath = null, tags = [], mimeType = '', hash = '', ocrMode = 1} = {})
    {
        this.#id = crypto.randomUUID();
        this.setName(name);
        this.setUserId(userId);
        this.setSourceType(sourceType);
        this.setDirectoryPath(directoryPath);
        this.setTags(tags);
        this.setMimeType(mimeType);
        this.setHash(hash);
        this.setOcrMode(ocrMode);
    }

    getId()
    {
        return this.#id;
    }

    getName()
    {
        return this.#name;
    }

    setName(value)
    {
        if (value !== null)
        {
            value = String(value);
            if (value.length > 256)
            {
                value = value.slice(0, 256);
            }
            if (value.length < 1)
            {
                value = null;
            }
        }
        this.#name = value;
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
            if (value.length > 256)
            {
                value = value.slice(0, 256);
            }
            if (value.length < 1)
            {
                value = null;
            }
        }
        this.#userId = value;
    }

    getSourceType()
    {
        return this.#sourceType;
    }

    setSourceType(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(informationSourceTypes);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#sourceType = value;
    }

    getDirectoryPath()
    {
        return this.#directoryPath;
    }

    setDirectoryPath(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#directoryPath = value;
    }

    getTags()
    {
        return this.#tags;
    }

    setTags(value)
    {
        if (value !== null)
        {
            if (!Array.isArray(value))
            {
                value = null;
            }
        }
        this.#tags = value;
    }

    getMimeType()
    {
        return this.#mimeType;
    }

    setMimeType(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#mimeType = value;
    }

    getHash()
    {
        return this.#hash;
    }

    setHash(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#hash = value;
    }

    getOcrMode()
    {
        return this.#ocrMode;
    }

    setOcrMode(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(ocrModes);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#ocrMode = value;
    }

    toJson()
    {
        return {
            id: this.getId(),
            name: this.getName(),
            userId: this.getUserId(),
            sourceType: this.getSourceType() !== null ? Number(this.getSourceType()) : null,
            directoryPath: this.getDirectoryPath(),
            tags: this.getTags(),
            mimeType: this.getMimeType(),
            hash: this.getHash(),
            ocrMode: this.getOcrMode() !== null ? Number(this.getOcrMode()) : null,
        };
    }

    static fromJson(json)
    {
        const instance = new InformationSource({
            name: json.name ?? null,
            userId: json.userId ?? null,
            sourceType: json.sourceType ?? null,
            directoryPath: json.directoryPath ?? null,
            tags: json.tags ?? null,
            mimeType: json.mimeType ?? null,
            hash: json.hash ?? null,
            ocrMode: json.ocrMode ?? null
        });
        instance._restoreId_id(json.id);
        return instance;
    }

    _restoreId_id(storedId)
    {
        if (storedId !== undefined && storedId !== null)
        {
            this.#id = storedId;
        }
    }
}

export default InformationSource;
