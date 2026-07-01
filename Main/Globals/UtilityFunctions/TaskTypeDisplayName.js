import { taskTypes } from "../Enumerations/TaskTypes.js";
import { enumerationToTitleCase } from "./EnumerationToTitleCase.js";

// User-facing label overrides for task types whose raw enum name reads as
// internal jargon. PREPARE_FOR_GENERATION is the no-op root of every AI
// generation pipeline; both the raw "PREPARE_FOR_GENERATION" and its title-cased
// "Prepare For Generation" are meaningless to users, so the whole generation is
// presented as "AI Generation". Anything not listed falls back to title-casing
// its enum key, so new task types need no entry here.
const TASK_TYPE_DISPLAY_NAME_OVERRIDES =
{
    PREPARE_FOR_GENERATION: "AI Generation",
};

// Resolves a TaskTypes enum VALUE to the label shown to users (progress tree,
// Activity list, paused-task banner, credit summary). Keeps the friendly-name
// policy in one place so every surface agrees.
export function taskTypeDisplayName(typeValue)
{
    const taskTypeName = Object.keys(taskTypes).find(key => taskTypes[key] === typeValue);
    if (!taskTypeName)
    {
        return "Task";
    }
    return TASK_TYPE_DISPLAY_NAME_OVERRIDES[taskTypeName] || enumerationToTitleCase(taskTypeName);
}
