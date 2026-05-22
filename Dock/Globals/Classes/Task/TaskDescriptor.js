const crypto = require('crypto');

const { taskTypes } = require('../../Enumerations/TaskTypes');
const { taskStatus } = require('../../Enumerations/TaskStatus');
const { taskExecutionTargets } = require('../../Enumerations/TaskExecutionTargets');

class TaskDescriptor
{
    #id;
    #userId;
    #type;
    #startDate;
    #expirationDate;
    #status;
    #parentTaskId;
    #nextTaskIds;
    #completion;
    #payload;
    #executionTarget;

    constructor({userId = '', type = 0, startDate = new Date(), expirationDate = new Date(), status = 0, parentTaskId = '', nextTaskIds = [], completion = 0, payload = {}, executionTarget = 0} = {})
    {
        this.#id = crypto.randomUUID();
        this.setUserId(userId);
        this.setType(type);
        this.setStartDate(startDate);
        this.setExpirationDate(expirationDate);
        this.setStatus(status);
        this.setParentTaskId(parentTaskId);
        this.setNextTaskIds(nextTaskIds);
        this.setCompletion(completion);
        this.setPayload(payload);
        this.setExecutionTarget(executionTarget);
    }

    getId()
    {
        return this.#id;
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

    getStartDate()
    {
        return this.#startDate;
    }

    setStartDate(value)
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
        this.#startDate = value;
    }

    getExpirationDate()
    {
        return this.#expirationDate;
    }

    setExpirationDate(value)
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
        this.#expirationDate = value;
    }

    getStatus()
    {
        return this.#status;
    }

    setStatus(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(taskStatus);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#status = value;
    }

    getParentTaskId()
    {
        return this.#parentTaskId;
    }

    setParentTaskId(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#parentTaskId = value;
    }

    getNextTaskIds()
    {
        return this.#nextTaskIds;
    }

    setNextTaskIds(value)
    {
        if (value !== null)
        {
            if (!Array.isArray(value))
            {
                value = null;
            }
        }
        this.#nextTaskIds = value;
    }

    getCompletion()
    {
        return this.#completion;
    }

    setCompletion(value)
    {
        if (value !== null)
        {
            value = parseFloat(value);
            if (isNaN(value))
            {
                value = 0;
            }
        }
        this.#completion = value;
    }

    getPayload()
    {
        return this.#payload;
    }

    setPayload(value)
    {
        this.#payload = value;
    }

    getExecutionTarget()
    {
        return this.#executionTarget;
    }

    setExecutionTarget(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(taskExecutionTargets);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#executionTarget = value;
    }

    toJson()
    {
        return {
            id: this.getId(),
            userId: this.getUserId(),
            type: this.getType() !== null ? Number(this.getType()) : null,
            startDate: this.getStartDate() !== null ? this.getStartDate().toISOString() : null,
            expirationDate: this.getExpirationDate() !== null ? this.getExpirationDate().toISOString() : null,
            status: this.getStatus() !== null ? Number(this.getStatus()) : null,
            parentTaskId: this.getParentTaskId(),
            nextTaskIds: this.getNextTaskIds(),
            completion: this.getCompletion(),
            payload: this.getPayload(),
            executionTarget: this.getExecutionTarget() !== null ? Number(this.getExecutionTarget()) : null,
        };
    }

    static fromJson(json)
    {
        const instance = new TaskDescriptor({
            userId: json.userId ?? null,
            type: json.type ?? null,
            startDate: json.startDate != null ? new Date(json.startDate) : null,
            expirationDate: json.expirationDate != null ? new Date(json.expirationDate) : null,
            status: json.status ?? null,
            parentTaskId: json.parentTaskId ?? null,
            nextTaskIds: json.nextTaskIds ?? null,
            completion: json.completion ?? null,
            payload: json.payload ?? null,
            executionTarget: json.executionTarget ?? null
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

module.exports = TaskDescriptor;
