const { taskTypes } = require("../Enumerations/TaskTypes");

// User-facing label overrides for task types whose raw enum name reads as
// internal jargon. PREPARE_FOR_GENERATION is the no-op root of every AI
// generation pipeline; both the raw "PREPARE_FOR_GENERATION" and a plain
// title-casing of it are meaningless to users, so the whole generation is
// presented as "AI Generation". Anything not listed falls back to title-casing
// its enum key, so new task types need no entry here. Mirrors the client-side
// Main/Globals/UtilityFunctions/TaskTypeDisplayName.js so every surface agrees.
const TASK_TYPE_DISPLAY_NAME_OVERRIDES =
{
    PREPARE_FOR_GENERATION: "AI Generation",
};

function titleCaseEnumerationName(enumerationName)
{
    return String(enumerationName)
        .replace(/_/g, " ")
        .toLowerCase()
        .replace(/\b\w/g, (firstChar) => firstChar.toUpperCase());
}

/**
 * Resolves a TaskTypes enum VALUE to the label shown to users (Activity list,
 * archived task summaries). Keeps the friendly-name policy in one place.
 * @param {number} typeValue
 * @returns {string}
 */
function taskTypeDisplayName(typeValue)
{
    const taskTypeName = Object.keys(taskTypes).find((key) => taskTypes[key] === typeValue);
    if (!taskTypeName)
    {
        return "Task";
    }
    return TASK_TYPE_DISPLAY_NAME_OVERRIDES[taskTypeName] || titleCaseEnumerationName(taskTypeName);
}

module.exports = { taskTypeDisplayName };
