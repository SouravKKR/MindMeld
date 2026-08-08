const PersistenceConstants = require("../../Constants/PersistenceConstants");

/**
 * GenerationStagingPolicy
 *
 * The single authority on where a generation run stages its output, and on how
 * long that staging may survive the run.
 *
 * It exists because the prefix is used from two files that must agree exactly.
 * Generate.js registers it for deletion at run start; moveToDatabase purges it
 * on the success path, and that purge only clears the registry record when the
 * string it passes matches the string that was registered, character for
 * character. Two independently-built template literals would satisfy that today
 * and silently stop satisfying it the first time either side changed — the
 * objects would still be deleted, and the record would be left behind for the
 * reaper to re-list forever.
 *
 * Mirrors SupportAttachmentPolicy, which owns the same question for support
 * attachments.
 */
class GenerationStagingPolicy
{
    /**
     * The object-storage prefix holding everything a run stages: generated
     * flashcards and study material awaiting the move into the database, mock
     * test questions, the blueprint, worker logs, the web image cache and the
     * figure scratch crops.
     *
     * Trailing separator included deliberately. Object storage matches a prefix
     * as a literal string, so "Tasks/abc" would also match "Tasks/abcdef/…" and
     * a purge would reach into an unrelated run's folder.
     *
     * @param {string} mainTaskId - The run's main task id.
     * @return {string}
     */
    static buildStoragePrefix(mainTaskId)
    {
        return `${PersistenceConstants.TASKS_DIRECTORY}/${mainTaskId}/`;
    }
}

module.exports = GenerationStagingPolicy;
