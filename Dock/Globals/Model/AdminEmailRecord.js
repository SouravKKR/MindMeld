class AdminEmailRecord
{
    #email;
    #addedBy;
    #addedAt;
    #notes;

    constructor({email = null, addedBy = '', addedAt = new Date(), notes = ''} = {})
    {
        this.setEmail(email);
        this.setAddedBy(addedBy);
        this.setAddedAt(addedAt);
        this.setNotes(notes);
    }

    getEmail()
    {
        return this.#email;
    }

    setEmail(value)
    {
        if (value !== null)
        {
            value = String(value);
            if (value.length > 320)
            {
                value = value.slice(0, 320);
            }
            if (value.length < 3)
            {
                value = null;
            }
        }
        this.#email = value;
    }

    getAddedBy()
    {
        return this.#addedBy;
    }

    setAddedBy(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#addedBy = value;
    }

    getAddedAt()
    {
        return this.#addedAt;
    }

    setAddedAt(value)
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
        this.#addedAt = value;
    }

    getNotes()
    {
        return this.#notes;
    }

    setNotes(value)
    {
        if (value !== null)
        {
            value = String(value);
            if (value.length > 1024)
            {
                value = value.slice(0, 1024);
            }
        }
        this.#notes = value;
    }

    toJson()
    {
        return {
            email: this.getEmail(),
            addedBy: this.getAddedBy(),
            addedAt: this.getAddedAt() !== null ? this.getAddedAt().toISOString() : null,
            notes: this.getNotes(),
        };
    }

    static fromJson(json)
    {
        const instance = new AdminEmailRecord({
            email: json.email ?? null,
            addedBy: json.addedBy ?? null,
            addedAt: json.addedAt != null ? new Date(json.addedAt) : null,
            notes: json.notes ?? null
        });
        return instance;
    }
}

module.exports = AdminEmailRecord;
