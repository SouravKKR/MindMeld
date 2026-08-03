import PaidDeckFieldCipher from "../Crypto/PaidDeckFieldCipher.js";
import PaidDeckSession from "../Crypto/PaidDeckSession.js";
import { buildContentOverlayId } from "../../UtilityFunctions/BuildContentOverlayId.js";
import { entityTypes } from "../../Enumerations/EntityTypes.js";
import SyncEvents from "../../Events/SyncEvents.js";

/**
 * ContentOverlayStore
 *
 * A learner's own edits to a PAID deck, kept beside the seller's content
 * instead of overwriting it.
 *
 * Paid content is stored as ciphertext envelopes and decrypted in memory only,
 * and rental expiry is enforced by KEY AVAILABILITY rather than by a flag. So
 * writing an edit into Card.answer would replace ciphertext with plaintext at
 * rest, and a 30-day rental would keep working forever. Instead the edit is a
 * separate record encrypted under the SAME deck content key: when a license
 * lapses, the seller's original and the buyer's edits go dark together.
 *
 * ── One mechanism, one branch ──────────────────────────────────────────────
 *
 * Every caller goes through resolve() / stage() / commitPending(). Inside them
 * there is exactly one branch — is the owning deck paid? — and it decides
 * base-field vs overlay-record:
 *
 *   • NORMAL deck  -> no overlay is ever created; the model writes its own
 *     field exactly as it always has.
 *   • PAID deck    -> the seller's field is never touched; the edit becomes an
 *     overlay record.
 *
 * Storing normal-deck edits as overlays too was considered and rejected: the
 * Agent's analysis and curated-study pipelines read `question` / `answer`
 * straight out of Mongo, so overlaying free decks would freeze those pipelines
 * at the pre-edit text for the whole product, and exported decks would carry a
 * stale base field.
 *
 * ── Where records live ────────────────────────────────────────────────────
 *
 * Under `deck.additionalData.contentOverlays`, keyed by overlay id — the same
 * shape AskAiPopupLink uses. Cards and study materials are serialised inside
 * their deck's file, so anything hung off the deck persists, loads and reaches
 * the bulk-snapshot path for free. Records still sync as their own
 * entityTypes.CONTENT_OVERLAY entity (Deck.toSyncJson strips the map from the
 * deck payload), so a deck push never re-bloats with them.
 *
 * ── Write timing: stage on set, commit on save ────────────────────────────
 *
 * Encryption is async but the model's setters are synchronous, and the whole
 * study UI depends on that (getAnswer() is read synchronously during render).
 * So a setter stages plaintext in a transient map — visible immediately to
 * resolve(), which is what lets AskAiActionDispatcher read back the entity HTML
 * between sequential per-block inserts — and the already-async save() encrypts
 * and commits it.
 *
 * Decrypted plaintext is held ONLY in a module-level cache, never written into
 * deck.additionalData: that map is serialised to disk, and putting plaintext
 * there would recreate the very leak this class exists to prevent.
 */
class ContentOverlayStore
{
    static DECK_ADDITIONAL_DATA_KEY = "contentOverlays";

    // overlayId -> { lastModifiedMillis, plaintext }. Transient, session-only.
    static #decryptedPlaintextByOverlayId = new Map();

    // overlayId -> plaintext staged by a setter, awaiting the next save().
    static #stagedPlaintextByOverlayId = new Map();

    /**
     * The paid-deck id governing this entity, or "" for a normal deck. Every
     * decision in this class hangs off this one question.
     */
    static getPaidDeckId(entity)
    {
        return entity?.getDeck?.()?.getAdditionalData?.()?.paidDeckId || "";
    }

    /**
     * Whether edits to this entity are stored as overlays rather than written
     * into its own fields.
     */
    static isOverlayBacked(entity)
    {
        return ContentOverlayStore.getPaidDeckId(entity).length > 0;
    }

    /**
     * The overlay record map on the entity's deck, or an empty object.
     */
    static #getOverlayMap(entity)
    {
        const additionalData = entity?.getDeck?.()?.getAdditionalData?.() || {};
        return additionalData[ContentOverlayStore.DECK_ADDITIONAL_DATA_KEY] || {};
    }

    /**
     * Resolves the value a content accessor should return for one field.
     *
     * @returns {{ hasOverlay: boolean, value: string }} hasOverlay false means
     *   "no overlay exists — fall back to the entity's own field". When true,
     *   value is either the buyer's edit or the locked placeholder.
     */
    static resolve(entity, fieldKey)
    {
        if (!ContentOverlayStore.isOverlayBacked(entity))
        {
            return { hasOverlay: false, value: "" };
        }

        const overlayId = buildContentOverlayId(entity.getId(), fieldKey);

        // A staged edit wins: the learner just typed it, and it has to be
        // readable before save() has encrypted it.
        if (ContentOverlayStore.#stagedPlaintextByOverlayId.has(overlayId))
        {
            return { hasOverlay: true, value: ContentOverlayStore.#stagedPlaintextByOverlayId.get(overlayId) };
        }

        const overlayRecord = ContentOverlayStore.#getOverlayMap(entity)[overlayId];
        if (!overlayRecord)
        {
            return { hasOverlay: false, value: "" };
        }

        const cachedEntry = ContentOverlayStore.#decryptedPlaintextByOverlayId.get(overlayId);
        if (cachedEntry && cachedEntry.lastModifiedMillis === ContentOverlayStore.#readLastModifiedMillis(overlayRecord))
        {
            return { hasOverlay: true, value: cachedEntry.plaintext };
        }

        // The record exists but has not been decrypted this session (deck
        // locked, or it arrived from a sync after decryptForStudy ran). Showing
        // the seller's original here would be wrong — the learner replaced it —
        // so the locked placeholder is the honest answer.
        return { hasOverlay: true, value: PaidDeckFieldCipher.LOCKED_PLACEHOLDER };
    }

    /**
     * Records an edit for a later commit.
     *
     * @returns {boolean} false when the deck is locked, so the caller can tell
     *   the learner instead of silently dropping their work.
     */
    static stage(entity, fieldKey, plaintextValue)
    {
        const paidDeckId = ContentOverlayStore.getPaidDeckId(entity);
        if (paidDeckId.length === 0)
        {
            return false;
        }

        if (!PaidDeckSession.isUnlocked(paidDeckId))
        {
            return false;
        }

        ContentOverlayStore.#stagedPlaintextByOverlayId.set
        (
            buildContentOverlayId(entity.getId(), fieldKey),
            typeof plaintextValue === "string" ? plaintextValue : String(plaintextValue ?? "")
        );
        return true;
    }

    /**
     * Encrypts and persists every edit staged for this entity, then announces
     * each one to the sync layer.
     *
     * The deck's own lifecycle is deliberately NOT touched: the map is mutated
     * in place rather than through setAdditionalDataField, so an overlay edit
     * does not queue a redundant whole-deck push. The caller's own
     * deck.save(false) writes the map to disk in the same pass.
     */
    static async commitPending(entity)
    {
        const paidDeckId = ContentOverlayStore.getPaidDeckId(entity);
        if (paidDeckId.length === 0 || ContentOverlayStore.#stagedPlaintextByOverlayId.size === 0)
        {
            return;
        }

        const owningDeck = entity.getDeck();
        if (!owningDeck)
        {
            return;
        }

        const targetEntityType = ContentOverlayStore.#resolveTargetEntityType(entity);
        const entityOverlayIdPrefix = `${entity.getId()}::`;
        // getAdditionalData returns the LIVE object, so mutating it below is
        // what persists. On the rare deck whose blob is nullish there is
        // nothing live to mutate — establish it through the setter instead, or
        // every record written here would land on a detached object and be lost.
        const additionalData = ContentOverlayStore.#ensureAdditionalData(owningDeck);
        const overlayMap = additionalData[ContentOverlayStore.DECK_ADDITIONAL_DATA_KEY] || {};

        for (const [overlayId, plaintextValue] of Array.from(ContentOverlayStore.#stagedPlaintextByOverlayId.entries()))
        {
            if (!overlayId.startsWith(entityOverlayIdPrefix))
            {
                continue;
            }

            const fieldKey = Number(overlayId.slice(entityOverlayIdPrefix.length));

            let encryptedValue;
            try
            {
                encryptedValue = await PaidDeckFieldCipher.encryptField(paidDeckId, plaintextValue);
            }
            catch (encryptionError)
            {
                // The deck locked between stage() and save(). Leave the staged
                // value in place so a later save can still commit it, and leave
                // the stored record untouched.
                console.warn(`[ContentOverlayStore] Could not encrypt overlay ${overlayId}:`, encryptionError);
                continue;
            }

            const stampedAt = new Date();
            const existingRecord = overlayMap[overlayId];
            const overlayRecord =
            {
                id: overlayId,
                deckId: owningDeck.getId(),
                targetEntityType: targetEntityType,
                targetEntityId: entity.getId(),
                fieldKey: fieldKey,
                value: encryptedValue,
                lifecycle:
                {
                    creationDate: existingRecord?.lifecycle?.creationDate ? new Date(existingRecord.lifecycle.creationDate) : stampedAt,
                    lastModified: stampedAt
                },
                additionalData: { paidDeckId: paidDeckId }
            };

            overlayMap[overlayId] = overlayRecord;
            ContentOverlayStore.#stagedPlaintextByOverlayId.delete(overlayId);
            ContentOverlayStore.#decryptedPlaintextByOverlayId.set(overlayId, { lastModifiedMillis: stampedAt.getTime(), plaintext: plaintextValue });

            window.dispatchEvent(new CustomEvent(SyncEvents.ENTITY_CHANGED,
            {
                detail:
                {
                    entityId: overlayId,
                    entityType: entityTypes.CONTENT_OVERLAY,
                    data: overlayRecord
                }
            }));
        }

        additionalData[ContentOverlayStore.DECK_ADDITIONAL_DATA_KEY] = overlayMap;
    }

    /**
     * True when this entity has overlay content that has not been decrypted
     * this session — mirrors the models' own needsDecryption() so the study
     * gate's progress bar counts real work.
     */
    static needsDecryption(entity)
    {
        if (!ContentOverlayStore.isOverlayBacked(entity))
        {
            return false;
        }

        const overlayMap = ContentOverlayStore.#getOverlayMap(entity);
        const entityOverlayIdPrefix = `${entity.getId()}::`;

        for (const [overlayId, overlayRecord] of Object.entries(overlayMap))
        {
            if (!overlayId.startsWith(entityOverlayIdPrefix))
            {
                continue;
            }
            const cachedEntry = ContentOverlayStore.#decryptedPlaintextByOverlayId.get(overlayId);
            if (!cachedEntry || cachedEntry.lastModifiedMillis !== ContentOverlayStore.#readLastModifiedMillis(overlayRecord))
            {
                return true;
            }
        }
        return false;
    }

    /**
     * Decrypts this entity's overlays into the session cache. Idempotent, and a
     * failure leaves the cache empty so the accessor shows the locked
     * placeholder rather than throwing mid-render.
     */
    static async decryptForStudy(entity)
    {
        const paidDeckId = ContentOverlayStore.getPaidDeckId(entity);
        if (paidDeckId.length === 0)
        {
            return;
        }

        const overlayMap = ContentOverlayStore.#getOverlayMap(entity);
        const entityOverlayIdPrefix = `${entity.getId()}::`;

        for (const [overlayId, overlayRecord] of Object.entries(overlayMap))
        {
            if (!overlayId.startsWith(entityOverlayIdPrefix))
            {
                continue;
            }

            const lastModifiedMillis = ContentOverlayStore.#readLastModifiedMillis(overlayRecord);
            const cachedEntry = ContentOverlayStore.#decryptedPlaintextByOverlayId.get(overlayId);
            if (cachedEntry && cachedEntry.lastModifiedMillis === lastModifiedMillis)
            {
                continue;
            }

            if (!PaidDeckFieldCipher.isEncryptedField(overlayRecord.value))
            {
                continue;
            }

            try
            {
                const plaintextValue = await PaidDeckFieldCipher.decryptField(paidDeckId, overlayRecord.value);
                ContentOverlayStore.#decryptedPlaintextByOverlayId.set(overlayId, { lastModifiedMillis: lastModifiedMillis, plaintext: plaintextValue });
            }
            catch (decryptionError)
            {
                ContentOverlayStore.#decryptedPlaintextByOverlayId.delete(overlayId);
            }
        }
    }

    /**
     * Drops every overlay belonging to an entity that is being deleted.
     *
     * @returns {Array<string>} the removed overlay ids, so the caller can emit
     *   one deletion per record and stop other devices resurrecting them.
     */
    static removeAllForEntity(entity)
    {
        const owningDeck = entity?.getDeck?.();
        if (!owningDeck)
        {
            return [];
        }

        const additionalData = owningDeck.getAdditionalData() || {};
        const overlayMap = additionalData[ContentOverlayStore.DECK_ADDITIONAL_DATA_KEY];
        if (!overlayMap)
        {
            return [];
        }

        const entityOverlayIdPrefix = `${entity.getId()}::`;
        const removedOverlayIds = [];

        for (const overlayId of Object.keys(overlayMap))
        {
            if (!overlayId.startsWith(entityOverlayIdPrefix))
            {
                continue;
            }
            delete overlayMap[overlayId];
            ContentOverlayStore.#decryptedPlaintextByOverlayId.delete(overlayId);
            ContentOverlayStore.#stagedPlaintextByOverlayId.delete(overlayId);
            removedOverlayIds.push(overlayId);
        }

        return removedOverlayIds;
    }

    /**
     * Applies a record pulled from the server. Last-write-wins on
     * lifecycle.lastModified, matching the server's own upsert gate.
     *
     * @returns {boolean} true when the deck's stored map changed.
     */
    static applyIncomingRecord(deck, overlayRecord)
    {
        if (!deck || !overlayRecord || typeof overlayRecord.id !== "string")
        {
            return false;
        }

        const additionalData = ContentOverlayStore.#ensureAdditionalData(deck);
        const overlayMap = additionalData[ContentOverlayStore.DECK_ADDITIONAL_DATA_KEY] || {};
        const existingRecord = overlayMap[overlayRecord.id];

        if (existingRecord && ContentOverlayStore.#readLastModifiedMillis(existingRecord) >= ContentOverlayStore.#readLastModifiedMillis(overlayRecord))
        {
            return false;
        }

        overlayMap[overlayRecord.id] = overlayRecord;
        additionalData[ContentOverlayStore.DECK_ADDITIONAL_DATA_KEY] = overlayMap;

        // The cached plaintext belongs to the version we just replaced.
        ContentOverlayStore.#decryptedPlaintextByOverlayId.delete(overlayRecord.id);
        return true;
    }

    /**
     * Removes a record by id in response to a server deletion.
     *
     * @returns {boolean} true when the deck's stored map changed.
     */
    static removeRecordById(deck, overlayId)
    {
        const additionalData = deck?.getAdditionalData?.() || {};
        const overlayMap = additionalData[ContentOverlayStore.DECK_ADDITIONAL_DATA_KEY];

        if (!overlayMap || !Object.prototype.hasOwnProperty.call(overlayMap, overlayId))
        {
            return false;
        }

        delete overlayMap[overlayId];
        ContentOverlayStore.#decryptedPlaintextByOverlayId.delete(overlayId);
        ContentOverlayStore.#stagedPlaintextByOverlayId.delete(overlayId);
        return true;
    }

    /**
     * Every overlay record the local tree holds, for the full-resync gather.
     */
    static collectAllRecords(deck)
    {
        const overlayMap = deck?.getAdditionalData?.()?.[ContentOverlayStore.DECK_ADDITIONAL_DATA_KEY] || {};
        return Object.values(overlayMap);
    }

    /**
     * Forgets every decrypted plaintext. Called on logout and whenever the
     * paid-deck session is locked, so nothing survives in memory past the
     * session that was entitled to it.
     */
    static clearDecryptedCache()
    {
        ContentOverlayStore.#decryptedPlaintextByOverlayId.clear();
        ContentOverlayStore.#stagedPlaintextByOverlayId.clear();
    }

    /**
     * The deck's live additionalData object, creating it when the deck has
     * none. Every write path goes through here because the store persists by
     * mutating that object in place — a detached copy would be discarded.
     */
    static #ensureAdditionalData(deck)
    {
        const existingAdditionalData = deck.getAdditionalData();
        if (existingAdditionalData && typeof existingAdditionalData === "object")
        {
            return existingAdditionalData;
        }

        deck.setAdditionalData({});
        return deck.getAdditionalData();
    }

    static #resolveTargetEntityType(entity)
    {
        return typeof entity?.getContent === "function" ? entityTypes.STUDY_MATERIAL : entityTypes.CARD;
    }

    static #readLastModifiedMillis(overlayRecord)
    {
        const lastModified = overlayRecord?.lifecycle?.lastModified;
        if (!lastModified)
        {
            return 0;
        }
        const parsedDate = lastModified instanceof Date ? lastModified : new Date(lastModified);
        const parsedMilliseconds = parsedDate.getTime();
        return Number.isFinite(parsedMilliseconds) ? parsedMilliseconds : 0;
    }
}

export default ContentOverlayStore;
