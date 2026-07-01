/**
 * Namespaced keys stored under a chat-derived StudyMaterial's `additionalData`.
 * A "Chat" study material is one the user saved from a deck Chat session via
 * "Save as study material" — it shows in the normal study-material lists with a
 * Chat badge. Mirrors CuratedStudyMaterialFields so every read/write site refers
 * to canonical names instead of sprinkling string literals.
 */
class ChatStudyMaterialFields
{
    static B_CHAT       = "bChat";
    static GENERATED_AT = "chatGeneratedAt";

    // Pseudo "detail level" used ONLY to surface chat materials as a distinct
    // "Chats" entry in the Content Study detail-level picker. No material is ever
    // stored with this level — chat materials keep their real detailLevel; they are
    // grouped by isChat(), not by this value. Kept negative so it never collides
    // with a real StudyMaterialDetailLevels value (0/1/2).
    static STUDY_PICKER_LEVEL = -1;

    static getAllKeys()
    {
        return [
            ChatStudyMaterialFields.B_CHAT,
            ChatStudyMaterialFields.GENERATED_AT,
        ];
    }
}

export default ChatStudyMaterialFields;
