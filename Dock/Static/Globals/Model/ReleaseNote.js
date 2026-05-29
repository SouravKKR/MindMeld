class ReleaseNote
{
    #id;
    #version;
    #versionSortKey;
    #title;
    #contentHtml;
    #releaseDate;
    #createdAt;
    #updatedAt;
    #createdBy;
    #test;

    constructor({version = '', versionSortKey = 0, title = null, contentHtml = '', releaseDate = new Date(), createdAt = new Date(), updatedAt = new Date(), createdBy = '', test = false} = {})
    {
        this.#id = crypto.randomUUID();
        this.setVersion(version);
        this.setVersionSortKey(versionSortKey);
        this.setTitle(title);
        this.setContentHtml(contentHtml);
        this.setReleaseDate(releaseDate);
        this.setCreatedAt(createdAt);
        this.setUpdatedAt(updatedAt);
        this.setCreatedBy(createdBy);
        this.setTest(test);
    }

    getId()
    {
        return this.#id;
    }

    getVersion()
    {
        return this.#version;
    }

    setVersion(value)
    {
        if (value !== null)
        {
            value = String(value);
            if (value.length > 32)
            {
                value = value.slice(0, 32);
            }
        }
        this.#version = value;
    }

    getVersionSortKey()
    {
        return this.#versionSortKey;
    }

    setVersionSortKey(value)
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
        this.#versionSortKey = value;
    }

    getTitle()
    {
        return this.#title;
    }

    setTitle(value)
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
        this.#title = value;
    }

    getContentHtml()
    {
        return this.#contentHtml;
    }

    setContentHtml(value)
    {
        if (value !== null)
        {
            value = String(value);
            if (value.length > 200000)
            {
                value = value.slice(0, 200000);
            }
        }
        this.#contentHtml = value;
    }

    getReleaseDate()
    {
        return this.#releaseDate;
    }

    setReleaseDate(value)
    {
        if (value !== null)
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
        this.#releaseDate = value;
    }

    getCreatedAt()
    {
        return this.#createdAt;
    }

    setCreatedAt(value)
    {
        if (value !== null)
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
        this.#createdAt = value;
    }

    getUpdatedAt()
    {
        return this.#updatedAt;
    }

    setUpdatedAt(value)
    {
        if (value !== null)
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
        this.#updatedAt = value;
    }

    getCreatedBy()
    {
        return this.#createdBy;
    }

    setCreatedBy(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#createdBy = value;
    }

    getTest()
    {
        return this.#test;
    }

    setTest(value)
    {
        if (value !== null)
        {
            value = Boolean(value);
        }
        this.#test = value;
    }

    toJson()
    {
        return {
            id: this.getId(),
            version: this.getVersion(),
            versionSortKey: this.getVersionSortKey(),
            title: this.getTitle(),
            contentHtml: this.getContentHtml(),
            releaseDate: this.getReleaseDate() !== null ? this.getReleaseDate().toISOString() : null,
            createdAt: this.getCreatedAt() !== null ? this.getCreatedAt().toISOString() : null,
            updatedAt: this.getUpdatedAt() !== null ? this.getUpdatedAt().toISOString() : null,
            createdBy: this.getCreatedBy(),
            test: this.getTest(),
        };
    }

    static fromJson(json)
    {
        const instance = new ReleaseNote({
            version: json.version ?? null,
            versionSortKey: json.versionSortKey ?? null,
            title: json.title ?? null,
            contentHtml: json.contentHtml ?? null,
            releaseDate: json.releaseDate != null ? new Date(json.releaseDate) : null,
            createdAt: json.createdAt != null ? new Date(json.createdAt) : null,
            updatedAt: json.updatedAt != null ? new Date(json.updatedAt) : null,
            createdBy: json.createdBy ?? null,
            test: json.test ?? null
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

export default ReleaseNote;
