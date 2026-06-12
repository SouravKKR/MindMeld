import { taskTypes } from '../Enumerations/TaskTypes.js';

class TaskState
{
    #id;
    #userId;
    #taskType;
    #route;
    #payload;
    #pausedReason;
    #resourcePaths;
    #createdAt;
    #expiresAt;
    #additionalData;

    constructor({userId = '', taskType = 0, route = '', payload = {}, pausedReason = '', resourcePaths = [], createdAt = new Date(), expiresAt = new Date(), additionalData = {}} = {})
    {
        this.#id = crypto.randomUUID();
        this.setUserId(userId);
        this.setTaskType(taskType);
        this.setRoute(route);
        this.setPayload(payload);
        this.setPausedReason(pausedReason);
        this.setResourcePaths(resourcePaths);
        this.setCreatedAt(createdAt);
        this.setExpiresAt(expiresAt);
        this.setAdditionalData(additionalData);
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

    getTaskType()
    {
        return this.#taskType;
    }

    setTaskType(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(taskTypes);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#taskType = value;
    }

    getRoute()
    {
        return this.#route;
    }

    setRoute(value)
    {
        if (value !== null)
        {
            value = String(value);
            if (value.length > 256)
            {
                value = value.slice(0, 256);
            }
        }
        this.#route = value;
    }

    getPayload()
    {
        return this.#payload;
    }

    setPayload(value)
    {
        this.#payload = value;
    }

    getPausedReason()
    {
        return this.#pausedReason;
    }

    setPausedReason(value)
    {
        if (value !== null)
        {
            value = String(value);
            if (value.length > 128)
            {
                value = value.slice(0, 128);
            }
        }
        this.#pausedReason = value;
    }

    getResourcePaths()
    {
        return this.#resourcePaths;
    }

    setResourcePaths(value)
    {
        if (value !== null)
        {
            if (!Array.isArray(value))
            {
                value = null;
            }
        }
        this.#resourcePaths = value;
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

    getExpiresAt()
    {
        return this.#expiresAt;
    }

    setExpiresAt(value)
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
        this.#expiresAt = value;
    }

    getAdditionalData()
    {
        return this.#additionalData;
    }

    setAdditionalData(value)
    {
        this.#additionalData = value;
    }

    toJson()
    {
        return {
            id: this.getId(),
            userId: this.getUserId(),
            taskType: this.getTaskType() !== null ? Number(this.getTaskType()) : null,
            route: this.getRoute(),
            payload: this.getPayload(),
            pausedReason: this.getPausedReason(),
            resourcePaths: this.getResourcePaths(),
            createdAt: this.getCreatedAt() !== null ? this.getCreatedAt().toISOString() : null,
            expiresAt: this.getExpiresAt() !== null ? this.getExpiresAt().toISOString() : null,
            additionalData: this.getAdditionalData(),
        };
    }

    static fromJson(json)
    {
        const instance = new TaskState({
            userId: json.userId ?? null,
            taskType: json.taskType ?? null,
            route: json.route ?? null,
            payload: json.payload ?? null,
            pausedReason: json.pausedReason ?? null,
            resourcePaths: json.resourcePaths ?? null,
            createdAt: json.createdAt != null ? new Date(json.createdAt) : null,
            expiresAt: json.expiresAt != null ? new Date(json.expiresAt) : null,
            additionalData: json.additionalData ?? null
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

export default TaskState;
