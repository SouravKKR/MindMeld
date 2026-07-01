import Persistence from "../Persistence.js";
import { dataFormats } from "../../Enumerations/DataFormats.js";
import PaidDeckFieldCipher from "../Crypto/PaidDeckFieldCipher.js";
import StaticEmbedder from "./StaticEmbedder.js";

// Local, per-device store of card / study-material embedding vectors for the
// deck Chat retrieval. Lives entirely in the browser (IndexedDB on web, the app
// data dir on desktop) — it is NEVER synced and NEVER touches the server, which
// is the whole point: cards/materials are editable, and we refuse to re-index
// them server-side on every edit.
//
// Editability is handled by a CONTENT-HASH gate: each entity's vector is stored
// alongside a hash of its embeddable text. embedEntityIfChanged() re-embeds only
// when that hash changes — so a progress-only save (which never changes the
// question/answer/content) is a no-op, while an actual edit re-embeds just that
// one entity in sub-millisecond time.
//
// The whole store is one JSON document loaded into memory once per session, so
// retrieval is a pure in-memory cosine scan (see DeckRetriever).

class DeckVectorCache
{
    static #STORE_PATH = "Embeddings/Vectors";
    static #QUANTIZATION_SCALE = 127;

    static #store = new Map();   // entityId -> { hash: string, vector: Float32Array }
    static #loaded = false;
    static #dirty = false;
    static #loadPromise = null;

    static async ensureLoaded()
    {
        if (DeckVectorCache.#loaded)
        {
            return;
        }

        if (DeckVectorCache.#loadPromise === null)
        {
            DeckVectorCache.#loadPromise = DeckVectorCache.#loadStore();
        }

        await DeckVectorCache.#loadPromise;
    }

    static async #loadStore()
    {
        try
        {
            const stored = await Persistence.read(DeckVectorCache.#STORE_PATH, dataFormats.JSON);
            if (stored && typeof stored === "object")
            {
                for (const [entityId, entry] of Object.entries(stored))
                {
                    if (!entry || !Array.isArray(entry.v) || typeof entry.h !== "string")
                    {
                        continue;
                    }
                    DeckVectorCache.#store.set(entityId, {
                        hash: entry.h,
                        vector: DeckVectorCache.#dequantize(entry.v)
                    });
                }
            }
        }
        catch (loadError)
        {
            // No store yet (first run) or unreadable — start empty.
            console.log(`[DeckVectorCache] Starting with an empty store: ${loadError.message}`);
        }
        finally
        {
            DeckVectorCache.#loaded = true;
        }
    }

    /**
     * Persists the store if anything changed since the last flush. Callers batch
     * their embedding work (a whole-deck prewarm) and flush once at the end.
     */
    static async flush()
    {
        if (!DeckVectorCache.#dirty)
        {
            return;
        }

        const serializable = {};
        for (const [entityId, entry] of DeckVectorCache.#store.entries())
        {
            serializable[entityId] = { h: entry.hash, v: DeckVectorCache.#quantize(entry.vector) };
        }

        try
        {
            await Persistence.write(DeckVectorCache.#STORE_PATH, serializable, dataFormats.JSON);
            DeckVectorCache.#dirty = false;
        }
        catch (writeError)
        {
            console.warn(`[DeckVectorCache] Failed to persist vectors: ${writeError.message}`);
        }
    }

    /**
     * Re-embeds the entity only when its content hash changed. Returns true if it
     * (re)embedded, false if it was already current (the progress-save no-op) or
     * had no embeddable text (e.g. locked paid content). Empty-text entities are
     * dropped from the store so retrieval never returns a stale vector for them.
     */
    static async embedEntityIfChanged(entityId, text)
    {
        if (!entityId)
        {
            return false;
        }

        const trimmed = (text || "").trim();
        if (trimmed.length === 0)
        {
            if (DeckVectorCache.#store.has(entityId))
            {
                DeckVectorCache.#store.delete(entityId);
                DeckVectorCache.#dirty = true;
            }
            return false;
        }

        const hash = DeckVectorCache.#contentHash(trimmed);
        const existing = DeckVectorCache.#store.get(entityId);
        if (existing && existing.hash === hash)
        {
            return false;
        }

        const embedder = StaticEmbedder.getShared();
        await embedder.load();
        const vector = embedder.encode(trimmed);

        DeckVectorCache.#store.set(entityId, { hash, vector });
        DeckVectorCache.#dirty = true;
        return true;
    }

    static getVector(entityId)
    {
        const entry = DeckVectorCache.#store.get(entityId);
        return entry ? entry.vector : null;
    }

    // ── Embeddable-text extraction ────────────────────────────────────────────

    static cardEmbeddableText(card)
    {
        const question = card.getQuestion();
        const answer = card.getAnswer();

        // Locked paid content resolves to the cipher's placeholder — never embed
        // that (it would be identical across every locked card). Skip until the
        // deck is unlocked + decrypted for study.
        if (question === PaidDeckFieldCipher.LOCKED_PLACEHOLDER || answer === PaidDeckFieldCipher.LOCKED_PLACEHOLDER)
        {
            return "";
        }

        const tags = typeof card.getTags === "function" ? (card.getTags() || []) : [];
        return `${DeckVectorCache.#stripHtml(question)} ${DeckVectorCache.#stripHtml(answer)} ${tags.join(" ")}`.trim();
    }

    static materialEmbeddableText(material)
    {
        const content = material.getContent();
        if (content === PaidDeckFieldCipher.LOCKED_PLACEHOLDER)
        {
            return "";
        }
        return DeckVectorCache.#stripHtml(content);
    }

    static #stripHtml(html)
    {
        if (typeof html !== "string" || html.length === 0)
        {
            return "";
        }

        return html
            .replace(/<[^>]*>/g, " ")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/\s+/g, " ")
            .trim();
    }

    // ── Quantization + hashing ────────────────────────────────────────────────

    static #quantize(vector)
    {
        const quantized = new Array(vector.length);
        for (let dimensionIndex = 0; dimensionIndex < vector.length; dimensionIndex++)
        {
            let value = Math.round(vector[dimensionIndex] * DeckVectorCache.#QUANTIZATION_SCALE);
            if (value > 127) value = 127;
            if (value < -127) value = -127;
            quantized[dimensionIndex] = value;
        }
        return quantized;
    }

    static #dequantize(quantized)
    {
        const vector = new Float32Array(quantized.length);
        let sumOfSquares = 0;
        for (let dimensionIndex = 0; dimensionIndex < quantized.length; dimensionIndex++)
        {
            const value = quantized[dimensionIndex] / DeckVectorCache.#QUANTIZATION_SCALE;
            vector[dimensionIndex] = value;
            sumOfSquares += value * value;
        }

        // Re-normalize so int8 rounding error doesn't bias the cosine scan.
        if (sumOfSquares > 0)
        {
            const inverseMagnitude = 1 / Math.sqrt(sumOfSquares);
            for (let dimensionIndex = 0; dimensionIndex < vector.length; dimensionIndex++)
            {
                vector[dimensionIndex] *= inverseMagnitude;
            }
        }

        return vector;
    }

    static #contentHash(text)
    {
        let hash = 0x811c9dc5;
        for (let characterIndex = 0; characterIndex < text.length; characterIndex++)
        {
            hash ^= text.charCodeAt(characterIndex);
            hash = Math.imul(hash, 0x01000193);
        }
        return (hash >>> 0).toString(16);
    }
}

export default DeckVectorCache;
