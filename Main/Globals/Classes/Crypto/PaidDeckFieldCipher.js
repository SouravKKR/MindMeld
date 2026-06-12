import PaidDeckSession from "./PaidDeckSession.js";

/**
 * PaidDeckFieldCipher
 *
 * Per-field encrypt/decrypt for paid-deck CONTENT fields (Card.question /
 * answer, StudyMaterial HTML, MockTest question / answer / solution text).
 * The content model stores each protected field as an envelope object —
 * { __enc: 1, ivBase64, ciphertextBase64 } — instead of a plaintext string;
 * everything else on the entity (ids, deckId, progress, lifecycle, tags,
 * names) stays plaintext so the tree, scheduling, and analysis are unchanged.
 *
 * The actual AES-256-GCM lives in PaidDeckSession (it owns the in-memory
 * non-extractable key per deck). This class only adds/strips the envelope
 * marker and exposes the recognise / encrypt / decrypt surface the model
 * layer calls. The envelope byte layout (12-byte IV, ciphertext||16-byte GCM
 * tag, base64) is identical to what the server's field cipher produces, so a
 * field encrypted server-side on the sync wire decrypts here unchanged.
 */
class PaidDeckFieldCipher
{
    static FIELD_MARKER = "__enc";
    static LOCKED_PLACEHOLDER = "[Locked — unlock this deck to view]";

    /**
     * True when `value` is a paid-content envelope (vs a plaintext string).
     * Used by the model accessors to decide whether a field needs decrypting.
     */
    static isEncryptedField(value)
    {
        return value !== null
            && typeof value === "object"
            && value[PaidDeckFieldCipher.FIELD_MARKER] === 1
            && typeof value.ivBase64 === "string"
            && typeof value.ciphertextBase64 === "string";
    }

    /**
     * Encrypts a plaintext content string into an envelope for the given
     * deck. Requires the deck to be unlocked this session (throws otherwise).
     */
    static async encryptField(deckId, plaintextString)
    {
        const envelope = await PaidDeckSession.encryptString(deckId, plaintextString);
        return {
            [PaidDeckFieldCipher.FIELD_MARKER]: 1,
            ivBase64: envelope.ivBase64,
            ciphertextBase64: envelope.ciphertextBase64
        };
    }

    /**
     * Decrypts an envelope back to its plaintext string. Requires the deck to
     * be unlocked this session (throws otherwise — callers fall back to the
     * locked placeholder).
     */
    static async decryptField(deckId, envelope)
    {
        return await PaidDeckSession.decryptString(deckId, envelope);
    }
}

export default PaidDeckFieldCipher;
