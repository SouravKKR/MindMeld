// Read-only frontend mirror of Dock/Globals/Model/MaintenanceWindow.js. Used by
// the maintenance banner + admin tab to display scheduled windows. The backend
// is authoritative; the frontend never creates ids.

class MaintenanceWindow
{
    #id;
    #startDate;
    #endDate;
    #title;
    #message;

    constructor({ id = "", startDate = null, endDate = null, title = "Scheduled maintenance", message = "" } = {})
    {
        this.#id = id;
        this.#startDate = MaintenanceWindow.#coerceDate(startDate);
        this.#endDate = MaintenanceWindow.#coerceDate(endDate);
        this.#title = title || "Scheduled maintenance";
        this.#message = message || "";
    }

    static #coerceDate(value)
    {
        if (value === null || value === undefined)
        {
            return null;
        }
        const parsed = value instanceof Date ? value : new Date(value);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    getId() { return this.#id; }
    getStartDate() { return this.#startDate; }
    getEndDate() { return this.#endDate; }
    getTitle() { return this.#title; }
    getMessage() { return this.#message; }

    isActiveAt(date)
    {
        if (this.#startDate === null || this.#endDate === null)
        {
            return false;
        }
        const time = date.getTime();
        return time >= this.#startDate.getTime() && time < this.#endDate.getTime();
    }

    isUpcomingWithin(date, leadMilliseconds)
    {
        if (this.#startDate === null)
        {
            return false;
        }
        const startTime = this.#startDate.getTime();
        return startTime > date.getTime() && (startTime - date.getTime()) <= leadMilliseconds;
    }

    static fromJson(json)
    {
        if (!json)
        {
            return null;
        }
        return new MaintenanceWindow({
            id: json.id || json._id || "",
            startDate: json.startDate,
            endDate: json.endDate,
            title: json.title,
            message: json.message
        });
    }
}

export default MaintenanceWindow;
