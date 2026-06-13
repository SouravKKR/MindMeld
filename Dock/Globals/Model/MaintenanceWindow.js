const crypto = require("crypto");

// A scheduled maintenance window. During an active window the server refuses to
// START new agent work (generation + AskAi) but never disrupts work already in
// flight. Multiple windows can be scheduled; an admin adds / edits / removes them
// freely. Hand-written model (like Deck / Card), mirrored read-only on the
// frontend at Main/Globals/Model/MaintenanceWindow.js.

class MaintenanceWindow
{
    #id;
    #startDate;
    #endDate;
    #title;
    #message;
    #createdAt;
    #createdBy;
    #updatedAt;

    constructor({ id, startDate, endDate, title, message, createdAt, createdBy, updatedAt } = {})
    {
        this.#id = id || crypto.randomUUID();
        this.#startDate = MaintenanceWindow.#coerceDate(startDate);
        this.#endDate = MaintenanceWindow.#coerceDate(endDate);
        this.#title = title || "Scheduled maintenance";
        this.#message = message || "";
        this.#createdAt = MaintenanceWindow.#coerceDate(createdAt) || new Date();
        this.#createdBy = createdBy || "";
        this.#updatedAt = MaintenanceWindow.#coerceDate(updatedAt) || this.#createdAt;
    }

    static #coerceDate(value)
    {
        if (value instanceof Date)
        {
            return Number.isNaN(value.getTime()) ? null : value;
        }
        if (typeof value === "string" || typeof value === "number")
        {
            const parsed = new Date(value);
            return Number.isNaN(parsed.getTime()) ? null : parsed;
        }
        return null;
    }

    getId() { return this.#id; }
    getStartDate() { return this.#startDate; }
    getEndDate() { return this.#endDate; }
    getTitle() { return this.#title; }
    getMessage() { return this.#message; }
    getCreatedAt() { return this.#createdAt; }
    getCreatedBy() { return this.#createdBy; }
    getUpdatedAt() { return this.#updatedAt; }

    setStartDate(value) { this.#startDate = MaintenanceWindow.#coerceDate(value); }
    setEndDate(value) { this.#endDate = MaintenanceWindow.#coerceDate(value); }
    setTitle(value) { this.#title = value || "Scheduled maintenance"; }
    setMessage(value) { this.#message = value || ""; }
    setUpdatedAt(value) { this.#updatedAt = MaintenanceWindow.#coerceDate(value) || new Date(); }

    /**
     * @param {Date} date
     * @returns {boolean} True when `date` falls inside [startDate, endDate).
     */
    isActiveAt(date)
    {
        if (this.#startDate === null || this.#endDate === null)
        {
            return false;
        }
        const time = date.getTime();
        return time >= this.#startDate.getTime() && time < this.#endDate.getTime();
    }

    /**
     * @param {Date} date
     * @param {number} leadMilliseconds
     * @returns {boolean} True when the window starts after `date` but within the lead window.
     */
    isUpcomingWithin(date, leadMilliseconds)
    {
        if (this.#startDate === null)
        {
            return false;
        }
        const time = date.getTime();
        const startTime = this.#startDate.getTime();
        return startTime > time && (startTime - time) <= leadMilliseconds;
    }

    toJson()
    {
        return {
            id: this.#id,
            startDate: this.#startDate ? this.#startDate.toISOString() : null,
            endDate: this.#endDate ? this.#endDate.toISOString() : null,
            title: this.#title,
            message: this.#message,
            createdAt: this.#createdAt ? this.#createdAt.toISOString() : null,
            createdBy: this.#createdBy,
            updatedAt: this.#updatedAt ? this.#updatedAt.toISOString() : null
        };
    }

    static fromJson(json)
    {
        if (!json)
        {
            return null;
        }
        return new MaintenanceWindow({
            id: json.id || json._id,
            startDate: json.startDate,
            endDate: json.endDate,
            title: json.title,
            message: json.message,
            createdAt: json.createdAt,
            createdBy: json.createdBy,
            updatedAt: json.updatedAt
        });
    }
}

module.exports = MaintenanceWindow;
