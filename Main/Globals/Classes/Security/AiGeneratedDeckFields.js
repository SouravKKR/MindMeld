/**
 * The `deck.additionalData` key that marks a deck as produced by the AI
 * generation pipeline. Centralised here so no read or write site spells the
 * literal, and mirrored in Dock/Globals/Classes/Security/AiGeneratedDeckFields.js
 * so both services agree on the wire name. The value is the literal property
 * name that Mongo, the sync payload and the client model all see.
 *
 * The marker used to be called `protected`, which described its effect rather
 * than its meaning and read as though it were about access control. It marks
 * exactly one thing: this deck node was created by, or generated into by, the
 * automatic generation pipeline.
 */
class AiGeneratedDeckFields
{
    static AI_GENERATED = "aiGenerated";

    /**
     * The pre-rename key. Decks stamped before the migration ran still carry
     * it, and a client whose local copy predates the migration will push it
     * back, so every read accepts both for one release.
     *
     * Delete this constant and the second half of isMarked once
     * Common/Scripts/MigrateAiGeneratedDeckFlag.js reports zero remaining rows
     * in every deployed environment.
     */
    static LEGACY_AI_GENERATED = "protected";

    /**
     * True when the given additionalData blob marks its deck as AI-generated.
     * Tolerates null / undefined so call sites do not need their own guard.
     *
     * @param {object} additionalData
     * @returns {boolean}
     */
    static isMarked(additionalData)
    {
        if (!additionalData || typeof additionalData !== "object")
        {
            return false;
        }

        return additionalData[AiGeneratedDeckFields.AI_GENERATED] === true
            || additionalData[AiGeneratedDeckFields.LEGACY_AI_GENERATED] === true;
    }
}

export default AiGeneratedDeckFields;
