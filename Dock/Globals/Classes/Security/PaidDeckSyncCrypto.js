const KeyManagementService = require("./KeyManagementService");
const { entityTypes } = require("../../Enumerations/EntityTypes");

/**
 * PaidDeckSyncCrypto
 *
 * The /Sync encryption boundary for the unified paid-deck model. Paid content
 * is stored PLAINTEXT in the normal collections (the server is the trusted
 * supplier of the decks), but it must never reach a client device in plaintext.
 * So:
 *
 *   - PULL: encryptEntityContent() encrypts only the CONTENT fields of a paid
 *     entity (Card.question/answer, StudyMaterial.content, MockTest question
 *     text) with the deck's content key before the doc goes on the wire. The
 *     client stores + decrypts-on-spot; everything else (ids, progress,
 *     lifecycle, tags, names, additionalData) stays plaintext so the tree,
 *     scheduling, and analysis are unchanged.
 *
 *   - PUSH: restorePlaintextContent() overlays the server's authoritative
 *     plaintext content fields back onto an incoming paid entity, so a progress
 *     push (which carries the content as ciphertext, or could be tampered with)
 *     can never overwrite the server's plaintext content. Paid content is
 *     immutable client-side — only progress / lifecycle / history flow up.
 *
 * The per-field envelope ({ __enc: 1, ivBase64, ciphertextBase64 }) is
 * byte-compatible with the client's PaidDeckFieldCipher / PaidDeckSession.
 */
class PaidDeckSyncCrypto
{
    static FIELD_MARKER = "__enc";

    // Top-level string content fields per entity type. MockTest is special-cased
    // below because its content lives inside the nested `items` question array.
    static #CARD_CONTENT_FIELDS = ["question", "answer"];
    static #STUDY_MATERIAL_CONTENT_FIELDS = ["content"];
    static #MOCK_TEST_QUESTION_FIELDS = ["question", "expectedAnswer", "answerReason", "solvingSteps", "remarks"];

    static isEncryptedField(value)
    {
        return value !== null
            && typeof value === "object"
            && value[PaidDeckSyncCrypto.FIELD_MARKER] === 1
            && typeof value.ivBase64 === "string"
            && typeof value.ciphertextBase64 === "string";
    }

    static #encryptField(plaintextString, contentKeyBuffer)
    {
        const envelope = KeyManagementService.encryptPaidDeckFieldString(plaintextString, contentKeyBuffer);
        return {
            [PaidDeckSyncCrypto.FIELD_MARKER]: 1,
            ivBase64: envelope.ivBase64,
            ciphertextBase64: envelope.ciphertextBase64
        };
    }

    // Encrypts obj[fieldName] in place when it is a non-empty plaintext string.
    // Empty strings (e.g. an absent remarks / solvingSteps) are left as "" so
    // the client never shows a locked placeholder for genuinely-empty content,
    // and an already-encrypted field is never double-wrapped.
    static #encryptStringFieldInPlace(targetObject, fieldName, contentKeyBuffer)
    {
        const value = targetObject?.[fieldName];
        if (typeof value === "string" && value.length > 0)
        {
            targetObject[fieldName] = PaidDeckSyncCrypto.#encryptField(value, contentKeyBuffer);
        }
    }

    /**
     * Returns a deep clone of `data` with its content fields encrypted for
     * delivery to the client. `data` itself (the stored plaintext) is never
     * mutated.
     */
    static encryptEntityContent(entityType, data, contentKeyBuffer)
    {
        const clone = JSON.parse(JSON.stringify(data));

        if (entityType === entityTypes.CARD)
        {
            for (const fieldName of PaidDeckSyncCrypto.#CARD_CONTENT_FIELDS)
            {
                PaidDeckSyncCrypto.#encryptStringFieldInPlace(clone, fieldName, contentKeyBuffer);
            }
        }
        else if (entityType === entityTypes.STUDY_MATERIAL)
        {
            for (const fieldName of PaidDeckSyncCrypto.#STUDY_MATERIAL_CONTENT_FIELDS)
            {
                PaidDeckSyncCrypto.#encryptStringFieldInPlace(clone, fieldName, contentKeyBuffer);
            }
        }
        else if (entityType === entityTypes.MOCK_TEST)
        {
            if (Array.isArray(clone.items))
            {
                for (const item of clone.items)
                {
                    for (const fieldName of PaidDeckSyncCrypto.#MOCK_TEST_QUESTION_FIELDS)
                    {
                        PaidDeckSyncCrypto.#encryptStringFieldInPlace(item, fieldName, contentKeyBuffer);
                    }
                }
            }
        }

        return clone;
    }

    /**
     * Returns a clone of `incomingData` with its content fields replaced by the
     * server's authoritative plaintext from `existingData`. For a mock test the
     * entire `items` blueprint is preserved (the questions are the content; only
     * `history` attempts are mutable). Used on PUSH so a client can never alter
     * paid content — only progress / lifecycle / history survive from its push.
     */
    static restorePlaintextContent(entityType, incomingData, existingData)
    {
        const clone = JSON.parse(JSON.stringify(incomingData));

        if (entityType === entityTypes.CARD)
        {
            for (const fieldName of PaidDeckSyncCrypto.#CARD_CONTENT_FIELDS)
            {
                clone[fieldName] = existingData[fieldName];
            }
        }
        else if (entityType === entityTypes.STUDY_MATERIAL)
        {
            for (const fieldName of PaidDeckSyncCrypto.#STUDY_MATERIAL_CONTENT_FIELDS)
            {
                clone[fieldName] = existingData[fieldName];
            }
        }
        else if (entityType === entityTypes.MOCK_TEST)
        {
            clone.items = existingData.items;
        }

        return clone;
    }
}

module.exports = PaidDeckSyncCrypto;
