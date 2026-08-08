const crypto = require('crypto');

const { informationSourceTypes } = require('../Enumerations/InformationSourceTypes');
const { ocrModes } = require('../Enumerations/OcrModes');
const { contentRetentionModes } = require('../Enumerations/ContentRetentionModes');
const { curriculumPlausibility } = require('../Enumerations/CurriculumPlausibility');
const { sourceLicenceTypes } = require('../Enumerations/SourceLicenceTypes');

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
    #fileSizeBytes;
    #retentionMode;
    #expiresAt;
    #uploadedAt;
    #curriculumPlausibility;
    #curriculumPlausibilityReason;
    #licenceType;
    #licenceNote;
    #sourceUrl;

    constructor({name = null, userId = null, sourceType = null, directoryPath = null, tags = [], mimeType = '', hash = '', ocrMode = 1, fileSizeBytes = 0, retentionMode = 1, expiresAt = 0, uploadedAt = 0, curriculumPlausibility = 0, curriculumPlausibilityReason = '', licenceType = 0, licenceNote = '', sourceUrl = ''} = {})
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
        this.setFileSizeBytes(fileSizeBytes);
        this.setRetentionMode(retentionMode);
        this.setExpiresAt(expiresAt);
        this.setUploadedAt(uploadedAt);
        this.setCurriculumPlausibility(curriculumPlausibility);
        this.setCurriculumPlausibilityReason(curriculumPlausibilityReason);
        this.setLicenceType(licenceType);
        this.setLicenceNote(licenceNote);
        this.setSourceUrl(sourceUrl);
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

    getFileSizeBytes()
    {
        return this.#fileSizeBytes;
    }

    setFileSizeBytes(value)
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
        this.#fileSizeBytes = value;
    }

    getRetentionMode()
    {
        return this.#retentionMode;
    }

    setRetentionMode(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(contentRetentionModes);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#retentionMode = value;
    }

    getExpiresAt()
    {
        return this.#expiresAt;
    }

    setExpiresAt(value)
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
        this.#expiresAt = value;
    }

    getUploadedAt()
    {
        return this.#uploadedAt;
    }

    setUploadedAt(value)
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
        this.#uploadedAt = value;
    }

    getCurriculumPlausibility()
    {
        return this.#curriculumPlausibility;
    }

    setCurriculumPlausibility(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(curriculumPlausibility);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#curriculumPlausibility = value;
    }

    getCurriculumPlausibilityReason()
    {
        return this.#curriculumPlausibilityReason;
    }

    setCurriculumPlausibilityReason(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#curriculumPlausibilityReason = value;
    }

    getLicenceType()
    {
        return this.#licenceType;
    }

    setLicenceType(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(sourceLicenceTypes);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#licenceType = value;
    }

    getLicenceNote()
    {
        return this.#licenceNote;
    }

    setLicenceNote(value)
    {
        if (value !== null)
        {
            value = String(value);
            if (value.length > 1024)
            {
                value = value.slice(0, 1024);
            }
        }
        this.#licenceNote = value;
    }

    getSourceUrl()
    {
        return this.#sourceUrl;
    }

    setSourceUrl(value)
    {
        if (value !== null)
        {
            value = String(value);
            if (value.length > 2048)
            {
                value = value.slice(0, 2048);
            }
        }
        this.#sourceUrl = value;
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
            fileSizeBytes: this.getFileSizeBytes(),
            retentionMode: this.getRetentionMode() !== null ? Number(this.getRetentionMode()) : null,
            expiresAt: this.getExpiresAt(),
            uploadedAt: this.getUploadedAt(),
            curriculumPlausibility: this.getCurriculumPlausibility() !== null ? Number(this.getCurriculumPlausibility()) : null,
            curriculumPlausibilityReason: this.getCurriculumPlausibilityReason(),
            licenceType: this.getLicenceType() !== null ? Number(this.getLicenceType()) : null,
            licenceNote: this.getLicenceNote(),
            sourceUrl: this.getSourceUrl(),
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
            ocrMode: json.ocrMode ?? null,
            fileSizeBytes: json.fileSizeBytes ?? null,
            retentionMode: json.retentionMode ?? null,
            expiresAt: json.expiresAt ?? null,
            uploadedAt: json.uploadedAt ?? null,
            curriculumPlausibility: json.curriculumPlausibility ?? null,
            curriculumPlausibilityReason: json.curriculumPlausibilityReason ?? null,
            licenceType: json.licenceType ?? null,
            licenceNote: json.licenceNote ?? null,
            sourceUrl: json.sourceUrl ?? null
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

module.exports = InformationSource;
