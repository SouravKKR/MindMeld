const crypto = require('crypto');

const { sourceLicenceTypes } = require('../Enumerations/SourceLicenceTypes');
const { sourceUsageModes } = require('../Enumerations/SourceUsageModes');

class PaidDeckVerificationSource
{
    #id;
    #deckId;
    #informationSourceId;
    #name;
    #sourceUrl;
    #contentHash;
    #storagePath;
    #mimeType;
    #licenceType;
    #licenceNote;
    #usageMode;
    #sourceNote;
    #declaredByUserId;
    #attachedAt;
    #detachedAt;
    #active;

    constructor({deckId = null, informationSourceId = '', name = null, sourceUrl = '', contentHash = '', storagePath = '', mimeType = '', licenceType = 0, licenceNote = '', usageMode = 0, sourceNote = '', declaredByUserId = '', attachedAt = 0, detachedAt = 0, active = true} = {})
    {
        this.#id = crypto.randomUUID();
        this.setDeckId(deckId);
        this.setInformationSourceId(informationSourceId);
        this.setName(name);
        this.setSourceUrl(sourceUrl);
        this.setContentHash(contentHash);
        this.setStoragePath(storagePath);
        this.setMimeType(mimeType);
        this.setLicenceType(licenceType);
        this.setLicenceNote(licenceNote);
        this.setUsageMode(usageMode);
        this.setSourceNote(sourceNote);
        this.setDeclaredByUserId(declaredByUserId);
        this.setAttachedAt(attachedAt);
        this.setDetachedAt(detachedAt);
        this.setActive(active);
    }

    getId()
    {
        return this.#id;
    }

    getDeckId()
    {
        return this.#deckId;
    }

    setDeckId(value)
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
        this.#deckId = value;
    }

    getInformationSourceId()
    {
        return this.#informationSourceId;
    }

    setInformationSourceId(value)
    {
        if (value !== null)
        {
            value = String(value);
            if (value.length > 256)
            {
                value = value.slice(0, 256);
            }
        }
        this.#informationSourceId = value;
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

    getContentHash()
    {
        return this.#contentHash;
    }

    setContentHash(value)
    {
        if (value !== null)
        {
            value = String(value);
            if (value.length > 256)
            {
                value = value.slice(0, 256);
            }
        }
        this.#contentHash = value;
    }

    getStoragePath()
    {
        return this.#storagePath;
    }

    setStoragePath(value)
    {
        if (value !== null)
        {
            value = String(value);
            if (value.length > 1024)
            {
                value = value.slice(0, 1024);
            }
        }
        this.#storagePath = value;
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

    getUsageMode()
    {
        return this.#usageMode;
    }

    setUsageMode(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(sourceUsageModes);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#usageMode = value;
    }

    getSourceNote()
    {
        return this.#sourceNote;
    }

    setSourceNote(value)
    {
        if (value !== null)
        {
            value = String(value);
            if (value.length > 2048)
            {
                value = value.slice(0, 2048);
            }
        }
        this.#sourceNote = value;
    }

    getDeclaredByUserId()
    {
        return this.#declaredByUserId;
    }

    setDeclaredByUserId(value)
    {
        if (value !== null)
        {
            value = String(value);
            if (value.length > 256)
            {
                value = value.slice(0, 256);
            }
        }
        this.#declaredByUserId = value;
    }

    getAttachedAt()
    {
        return this.#attachedAt;
    }

    setAttachedAt(value)
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
        this.#attachedAt = value;
    }

    getDetachedAt()
    {
        return this.#detachedAt;
    }

    setDetachedAt(value)
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
        this.#detachedAt = value;
    }

    getActive()
    {
        return this.#active;
    }

    setActive(value)
    {
        if (value !== null)
        {
            value = Boolean(value);
        }
        this.#active = value;
    }

    toJson()
    {
        return {
            id: this.getId(),
            deckId: this.getDeckId(),
            informationSourceId: this.getInformationSourceId(),
            name: this.getName(),
            sourceUrl: this.getSourceUrl(),
            contentHash: this.getContentHash(),
            storagePath: this.getStoragePath(),
            mimeType: this.getMimeType(),
            licenceType: this.getLicenceType() !== null ? Number(this.getLicenceType()) : null,
            licenceNote: this.getLicenceNote(),
            usageMode: this.getUsageMode() !== null ? Number(this.getUsageMode()) : null,
            sourceNote: this.getSourceNote(),
            declaredByUserId: this.getDeclaredByUserId(),
            attachedAt: this.getAttachedAt(),
            detachedAt: this.getDetachedAt(),
            active: this.getActive(),
        };
    }

    static fromJson(json)
    {
        const instance = new PaidDeckVerificationSource({
            deckId: json.deckId ?? null,
            informationSourceId: json.informationSourceId ?? null,
            name: json.name ?? null,
            sourceUrl: json.sourceUrl ?? null,
            contentHash: json.contentHash ?? null,
            storagePath: json.storagePath ?? null,
            mimeType: json.mimeType ?? null,
            licenceType: json.licenceType ?? null,
            licenceNote: json.licenceNote ?? null,
            usageMode: json.usageMode ?? null,
            sourceNote: json.sourceNote ?? null,
            declaredByUserId: json.declaredByUserId ?? null,
            attachedAt: json.attachedAt ?? null,
            detachedAt: json.detachedAt ?? null,
            active: json.active ?? null
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

module.exports = PaidDeckVerificationSource;
