import DialogBox from "../../CommonComponents/DialogBox.js";
import { getRandomUuid } from "../UtilityFunctions/GetRandomUuid.js";
import Deck from "./Deck.js";
import Lifecycle from "./Lifecycle.js";
import SyncEvents from "../Events/SyncEvents.js";
import PaidDeckFieldCipher from "../Classes/Crypto/PaidDeckFieldCipher.js";
import ContentOverlayStore from "../Classes/Content/ContentOverlayStore.js";
import PaidDeckMoveGuard from "../Classes/PaidDeckMoveGuard.js";
import { entityTypes } from "../Enumerations/EntityTypes.js";
import { contentOverlayFields } from "../Enumerations/ContentOverlayFields.js";
import { studyMaterialDetailLevels } from "../Enumerations/StudyMaterialDetailLevels.js";
import CuratedStudyMaterialFields from "../Classes/Analysis/CuratedStudyMaterialFields.js";
import ChatStudyMaterialFields from "../Classes/Analysis/ChatStudyMaterialFields.js";

class StudyMaterial
{
    #id = "";
    #content = "";
    #deckId = "";
    #lifecycle = null;
    #syllabusPosition = 0;
    #detailLevel = studyMaterialDetailLevels.STANDARD;
    #additionalData = {};

    // Transient in-memory plaintext for a paid deck's encrypted HTML content,
    // populated by decryptForStudy() and never serialised. Null for a normal
    // (plaintext) deck or a locked paid deck.
    #decryptedContent = null;

    /**
     * Creates a StudyMaterial instance from a plain JSON object.
     * @param {object} json - The JSON object to deserialise.
     * @returns {StudyMaterial} The deserialised StudyMaterial.
     */
    static fromJson(json)
    {
        const lifecycle = Lifecycle.fromJson(json.lifecycle);
        const detailLevel = (typeof json.detailLevel === "number") ? json.detailLevel : studyMaterialDetailLevels.STANDARD;
        const additionalData = (json.additionalData && typeof json.additionalData === "object") ? json.additionalData : {};
        return new StudyMaterial(json.id, json.content, json.deckId, lifecycle, json.syllabusPosition ?? 0, detailLevel, additionalData);
    }

    /**
     * Generates a unique id for a study material.
     * @returns {string} A unique id.
     */
    static generateId()
    {
        return getRandomUuid();
    }

    toJson()
    {
        return {
            id: this.#id,
            content: this.#content,
            deckId: this.#deckId,
            lifecycle: this.#lifecycle.toJson(),
            syllabusPosition: this.#syllabusPosition,
            detailLevel: this.#detailLevel,
            additionalData: this.#additionalData
        };
    }

    getSyllabusPosition()
    {
        return this.#syllabusPosition;
    }

    getDetailLevel()
    {
        return this.#detailLevel;
    }

    setDetailLevel(detailLevel)
    {
        this.#detailLevel = detailLevel;
        this.#lifecycle?.touch();
    }

    getId()
    {
        return this.#id;
    }

    getContent()
    {
        const overlayResolution = ContentOverlayStore.resolve(this, contentOverlayFields.STUDY_MATERIAL_CONTENT);
        if (overlayResolution.hasOverlay)
        {
            return overlayResolution.value;
        }
        if (PaidDeckFieldCipher.isEncryptedField(this.#content))
        {
            return this.#decryptedContent !== null ? this.#decryptedContent : PaidDeckFieldCipher.LOCKED_PLACEHOLDER;
        }
        return this.#content;
    }

    /**
     * Pre-decrypts this material's encrypted HTML into the transient in-memory
     * cache the synchronous getContent() reads from. Called when a paid deck is
     * opened for study / curated viewing. No-op for a normal (plaintext) deck or
     * a locked deck (decrypt throws -> cache stays null -> locked placeholder).
     */
    async decryptForStudy()
    {
        const paidDeckId = this.getDeck()?.getAdditionalData?.()?.paidDeckId;
        if (!paidDeckId)
        {
            return;
        }

        // Idempotent: skip when already decrypted this session.
        if (this.#decryptedContent === null && PaidDeckFieldCipher.isEncryptedField(this.#content))
        {
            try
            {
                this.#decryptedContent = await PaidDeckFieldCipher.decryptField(paidDeckId, this.#content);
            }
            catch (decryptError)
            {
                this.#decryptedContent = null;
            }
        }

        // The learner's own edits are encrypted under the same key, so they are
        // part of the same unlock.
        await ContentOverlayStore.decryptForStudy(this);
    }

    /**
     * True when this material has encrypted content not yet decrypted this
     * session — used to size / skip the decrypt progress bar.
     */
    needsDecryption()
    {
        return (this.#decryptedContent === null && PaidDeckFieldCipher.isEncryptedField(this.#content))
            || ContentOverlayStore.needsDecryption(this);
    }

    getDeckId()
    {
        return this.#deckId;
    }

    /**
     * Returns the lifecycle of the study material.
     * @returns {Lifecycle} The lifecycle of the study material.
     */
    getLifecycle()
    {
        return this.#lifecycle;
    }

    /**
     * Returns the deck this study material belongs to.
     * @returns {Deck} The deck this study material belongs to.
     */
    getDeck()
    {
        return Deck.getById(this.#deckId);
    }

    /**
     * Sets the material's HTML.
     *
     * On a paid deck the seller's field is never overwritten — the edit is
     * staged as an encrypted overlay instead, so the ciphertext envelope stays
     * intact and a lapsed license still takes the content away. save() commits
     * the staged edit.
     *
     * @returns {boolean} false only when the deck is paid AND locked, so the
     *   caller can tell the learner rather than silently discarding their work.
     */
    setContent(content)
    {
        if (ContentOverlayStore.isOverlayBacked(this))
        {
            return ContentOverlayStore.stage(this, contentOverlayFields.STUDY_MATERIAL_CONTENT, content);
        }
        this.#content = content;
        this.#lifecycle?.touch();
        return true;
    }

    /**
     * The structural re-stamp Deck.addStudyMaterial performs when a deck takes
     * ownership. Deliberately UNGUARDED — see Card.assignOwningDeckId.
     */
    assignOwningDeckId(deckId)
    {
        this.#deckId = deckId;
    }

    /**
     * Re-homes this study material at a caller's request. Refused when it would
     * cross a paid boundary — see PaidDeckMoveGuard.
     *
     * @returns {boolean} false when the move was refused.
     */
    setDeckId(deckId)
    {
        if (!PaidDeckMoveGuard.canMove(this.getDeck(), Deck.getById(deckId)))
        {
            return false;
        }
        this.#deckId = deckId;
        return true;
    }

    /**
     * Returns the per-material `additionalData` blob. Curated study
     * materials carry their topic name, topic-strength tier, the
     * `lastAnalyzedAt` timestamp of the batch that generated them, and
     * their batch-review state here. Returns an empty object when no
     * additional data has been set so callers can safely index into it.
     */
    getAdditionalData()
    {
        return this.#additionalData || {};
    }

    /**
     * Replaces the per-material `additionalData` blob wholesale. Used by
     * the sync apply path. Bumps lifecycle.lastModified so the next sync
     * push picks the change up.
     */
    setAdditionalData(additionalData)
    {
        this.#additionalData = (additionalData && typeof additionalData === "object") ? additionalData : {};
        this.#lifecycle?.touch();
    }

    /**
     * Sets a single field inside the per-material `additionalData` blob.
     * Mirrors `Deck.setAdditionalDataField` so callers can share a mental
     * model across entity types. Bumps lifecycle.lastModified.
     */
    setAdditionalDataField(key, value)
    {
        if (!this.#additionalData)
        {
            this.#additionalData = {};
        }
        this.#additionalData[key] = value;
        this.#lifecycle?.touch();
    }

    /**
     * Convenience flag for the curated-vs-regular distinction. Curated
     * study materials are generated by the weekly analysis pipeline and
     * carry per-material context (topic name, topic-strength tier,
     * batch-review state). Regular materials lack the `bCurated` flag,
     * so this returns false for them.
     */
    isCurated()
    {
        return this.getAdditionalData()[CuratedStudyMaterialFields.B_CURATED] === true;
    }

    /**
     * Convenience flag for chat-derived materials saved from a deck Chat
     * session ("Save as study material"). Mirrors isCurated(); regular and
     * curated materials lack the `bChat` flag, so this returns false for them.
     */
    isChat()
    {
        return this.getAdditionalData()[ChatStudyMaterialFields.B_CHAT] === true;
    }

    /**
     * Records time spent reading this study material and optionally saves.
     * @param {number} timeSpentInSeconds - Time spent reading, in seconds.
     * @param {boolean} bSave - Whether to persist the change immediately.
     */
    async view(timeSpentInSeconds, bSave = true)
    {
        this.#lifecycle.spendTime(timeSpentInSeconds);
        this.#lifecycle.view();

        if (bSave)
        {
            await this.save();
        }
    }

    validate(showAlerts = false)
    {
        if (!this.#content)
        {
            if (showAlerts)
            {
                DialogBox.alert("Invalid Study Material", "A study material must have content.");
            }

            return false;
        }

        return true;
    }

    async save()
    {
        const owningDeck = this.getDeck();
        if (!owningDeck)
        {
            // Stale deckId — the material's recorded parent isn't in
            // Deck.#idMap. Don't crash the study session; just skip
            // persistence. Deck.addStudyMaterial re-stamps deckId on load,
            // so this branch should only fire for in-flight orphans.
            console.warn(`[StudyMaterial] save() skipped: material ${this.getId()} has no owning deck (deckId=${this.#deckId}).`);
            return;
        }

        // Encrypt and store any edit a setter staged, before the deck is
        // written — commitPending mutates the deck's overlay map in place and
        // relies on this same save to persist it.
        await ContentOverlayStore.commitPending(this);

        // Paid decks persist + sync like normal decks now — the HTML content is
        // already a ciphertext envelope, so this writes ciphertext at rest and
        // the server preserves its plaintext copy, taking only read-state /
        // lifecycle from the push.
        await owningDeck.save(false);

        window.dispatchEvent(new CustomEvent(SyncEvents.ENTITY_CHANGED,
        {
            detail:
            {
                entityId: this.getId(),
                entityType: entityTypes.STUDY_MATERIAL,
                data: this.toJson()
            }
        }));
    }

    async delete()
    {
        const owningDeck = this.getDeck();
        if (!owningDeck)
        {
            console.warn(`[StudyMaterial] delete() skipped: material ${this.getId()} has no owning deck (deckId=${this.#deckId}).`);
            return;
        }

        // Drop this material's overlays first, while the deck link still
        // resolves. The server cascades them too, but emitting the tombstones
        // here is what stops another device re-pushing an orphaned record.
        const removedOverlayIds = ContentOverlayStore.removeAllForEntity(this);

        owningDeck.removeStudyMaterial(this);
        await owningDeck.save(false);

        window.dispatchEvent(new CustomEvent(SyncEvents.ENTITY_DELETED,
        {
            detail:
            {
                entityId: this.getId(),
                entityType: entityTypes.STUDY_MATERIAL
            }
        }));

        for (const removedOverlayId of removedOverlayIds)
        {
            window.dispatchEvent(new CustomEvent(SyncEvents.ENTITY_DELETED,
            {
                detail:
                {
                    entityId: removedOverlayId,
                    entityType: entityTypes.CONTENT_OVERLAY
                }
            }));
        }
    }

    /**
     * Creates a new StudyMaterial object.
     * @param {string} id - The id of the study material.
     * @param {string} content - The HTML content of the study material.
     * @param {string} deckId - The id of the deck this study material belongs to.
     * @param {Lifecycle} lifecycle - The lifecycle of the study material.
     * @param {number} syllabusPosition - The zero-based position of this material in the original syllabus ordering.
     * @param {number} detailLevel - StudyMaterialDetailLevels enum value (default STANDARD).
     * @param {object} additionalData - Optional per-material blob (e.g. curated-study metadata). Defaults to {}.
     */
    constructor(id, content, deckId, lifecycle, syllabusPosition = 0, detailLevel = studyMaterialDetailLevels.STANDARD, additionalData = {})
    {
        this.#id = id;
        this.#content = content;
        this.#deckId = deckId;
        this.#lifecycle = lifecycle;
        this.#syllabusPosition = syllabusPosition;
        this.#detailLevel = detailLevel;
        this.#additionalData = (additionalData && typeof additionalData === "object") ? additionalData : {};
    }
}

export default StudyMaterial;
