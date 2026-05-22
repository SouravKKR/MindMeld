import { taskTypes } from '../Enumerations/TaskTypes.js';
import { taskStatus } from '../Enumerations/TaskStatus.js';

class TaskHistoryRecord
{
    #id;
    #userId;
    #type;
    #status;
    #completion;
    #startDate;
    #completedAt;
    #durationMillis;
    #payloadSummary;
    #parentTaskId;
    #additionalData;

    constructor({userId = null, type = 0, status = 0, completion = 0, startDate = new Date(), completedAt = new Date(), durationMillis = 0, payloadSummary = '', parentTaskId = '', additionalData = {}} = {})
    {
        this.#id = crypto.randomUUID();
        this.setUserId(userId);
        this.setType(type);
        this.setStatus(status);
        this.setCompletion(completion);
        this.setStartDate(startDate);
        this.setCompletedAt(completedAt);
        this.setDurationMillis(durationMillis);
        this.setPayloadSummary(payloadSummary);
        this.setParentTaskId(parentTaskId);
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

    getCompletedAt()
    {
        return this.#completedAt;
    }

    setCompletedAt(value)
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
        this.#completedAt = value;
    }

    getDurationMillis()
    {
        return this.#durationMillis;
    }

    setDurationMillis(value)
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
        this.#durationMillis = value;
    }

    getPayloadSummary()
    {
        return this.#payloadSummary;
    }

    setPayloadSummary(value)
    {
        if (value !== null)
        {
            value = String(value);
            if (value.length > 512)
            {
                value = value.slice(0, 512);
            }
        }
        this.#payloadSummary = value;
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
            type: this.getType() !== null ? Number(this.getType()) : null,
            status: this.getStatus() !== null ? Number(this.getStatus()) : null,
            completion: this.getCompletion(),
            startDate: this.getStartDate() !== null ? this.getStartDate().toISOString() : null,
            completedAt: this.getCompletedAt() !== null ? this.getCompletedAt().toISOString() : null,
            durationMillis: this.getDurationMillis(),
            payloadSummary: this.getPayloadSummary(),
            parentTaskId: this.getParentTaskId(),
            additionalData: this.getAdditionalData(),
        };
    }

    static fromJson(json)
    {
        const instance = new TaskHistoryRecord({
            userId: json.userId ?? null,
            type: json.type ?? null,
            status: json.status ?? null,
            completion: json.completion ?? null,
            startDate: json.startDate != null ? new Date(json.startDate) : null,
            completedAt: json.completedAt != null ? new Date(json.completedAt) : null,
            durationMillis: json.durationMillis ?? null,
            payloadSummary: json.payloadSummary ?? null,
            parentTaskId: json.parentTaskId ?? null,
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

export default TaskHistoryRecord;
