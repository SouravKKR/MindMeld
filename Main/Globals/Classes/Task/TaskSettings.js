const crypto = require('crypto');

const { taskTypes } = require('../../Enumerations/TaskTypes');

class TaskSettings
{
    #id;
    #type;

    constructor({type = null} = {})
    {
        this.#id = crypto.randomUUID();
        this.setType(type);
    }

    getId()
    {
        return this.#id;
    }

    getType()
    {
        return this.#type;
    }

    setType(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(taskTypes);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#type = value;
    }

    toJson()
    {
        return {
            id: this.getId(),
            type: this.getType() !== null ? Number(this.getType()) : null,
        };
    }

    static fromJson(json)
    {
        const instance = new TaskSettings({
            type: json.type ?? null
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

module.exports = TaskSettings;
