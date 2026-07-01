// Client-side text embedder for the deck Chat mode's retrieval.
//
// Produces a fixed-dimension, L2-normalized vector for a piece of text using
// ONLY hand-written code + an optional vendored static vector table — no neural
// network, no WASM, no third-party runtime library. This is what lets the chat
// find the nearest cards / study materials entirely in the browser (and on
// mobile) with zero server load and no server-side index.
//
// Two modes, chosen automatically by load():
//   - TABLE mode (production): a vendored word→vector table is fetched from
//     Main/ThirdParty/StaticEmbeddings/. Known words get real (distilled,
//     semantic) vectors; unknown words fall back to hashing so they still
//     contribute lexically.
//   - HASHING mode (fallback / bootstrap): no table present — every token is
//     mapped to a deterministic vector via the hashing trick. Fully offline and
//     instant, but only captures exact-token overlap (lexical), not synonyms.
//     The chat still works; semantic quality arrives once the table is vendored.
//
// The encoder is intentionally simple: lowercase + alphanumeric tokenization,
// per-token unit vectors, mean-pool, L2-normalize. Cosine similarity over the
// results is therefore just a dot product (see DeckRetriever).

class StaticEmbedder
{
    static #shared = null;

    // Dimension used in HASHING mode. A vendored table overrides this with its
    // own dimension count at load time. 256 is a good lexical-spread default.
    static HASHING_DIMENSIONS = 256;

    // Nonzero dimensions written per token in HASHING mode (the hashing trick).
    static HASHING_FEATURES_PER_TOKEN = 16;

    static TABLE_DIRECTORY = "ThirdParty/StaticEmbeddings";

    #dimensions = StaticEmbedder.HASHING_DIMENSIONS;
    #tokenVectorTable = null;   // Map<token, Float32Array> when a table is loaded
    #loaded = false;
    #loadPromise = null;

    static getShared()
    {
        if (StaticEmbedder.#shared === null)
        {
            StaticEmbedder.#shared = new StaticEmbedder();
        }

        return StaticEmbedder.#shared;
    }

    isLoaded()
    {
        return this.#loaded;
    }

    getDimensions()
    {
        return this.#dimensions;
    }

    isUsingTable()
    {
        return this.#tokenVectorTable !== null;
    }

    /**
     * Loads the vendored static vector table if present, otherwise falls back to
     * hashing mode. Idempotent and concurrency-safe — repeated/parallel callers
     * share one in-flight load. Never throws: a missing/broken table degrades to
     * hashing so chat retrieval always has SOMETHING to work with.
     */
    async load()
    {
        if (this.#loaded)
        {
            return;
        }

        if (this.#loadPromise === null)
        {
            this.#loadPromise = this.#loadTable();
        }

        await this.#loadPromise;
    }

    async #loadTable()
    {
        try
        {
            const manifestResponse = await fetch(`/${StaticEmbedder.TABLE_DIRECTORY}/manifest.json`);
            if (!manifestResponse.ok)
            {
                throw new Error(`manifest fetch failed: ${manifestResponse.status}`);
            }

            const manifest = await manifestResponse.json();
            const dimensions = Number(manifest.dimensions);
            const scale = Number(manifest.scale) || 127;

            const vocabularyResponse = await fetch(`/${StaticEmbedder.TABLE_DIRECTORY}/vocab.json`);
            const vectorsResponse = await fetch(`/${StaticEmbedder.TABLE_DIRECTORY}/vectors.int8.bin`);
            if (!vocabularyResponse.ok || !vectorsResponse.ok)
            {
                throw new Error("vocab/vectors fetch failed");
            }

            const vocabulary = await vocabularyResponse.json();
            const quantizedBytes = new Int8Array(await vectorsResponse.arrayBuffer());

            const table = new Map();
            for (let tokenIndex = 0; tokenIndex < vocabulary.length; tokenIndex++)
            {
                const token = vocabulary[tokenIndex];
                const offset = tokenIndex * dimensions;
                const vector = new Float32Array(dimensions);
                for (let dimensionIndex = 0; dimensionIndex < dimensions; dimensionIndex++)
                {
                    vector[dimensionIndex] = quantizedBytes[offset + dimensionIndex] / scale;
                }
                StaticEmbedder.#normalizeInPlace(vector);
                table.set(token, vector);
            }

            this.#tokenVectorTable = table;
            this.#dimensions = dimensions;
            console.log(`[StaticEmbedder] Loaded vector table (${vocabulary.length} tokens, ${dimensions} dims).`);
        }
        catch (loadError)
        {
            // No table vendored (or it failed to load): hashing mode. Expected
            // until the export script's table is committed — not an error.
            this.#tokenVectorTable = null;
            this.#dimensions = StaticEmbedder.HASHING_DIMENSIONS;
            console.log(`[StaticEmbedder] Using hashing fallback (no vector table): ${loadError.message}`);
        }
        finally
        {
            this.#loaded = true;
        }
    }

    /**
     * Encodes text into an L2-normalized Float32Array of getDimensions() length.
     * Empty / all-whitespace text returns a zero vector (DeckRetriever treats
     * that as "no signal" and skips it).
     */
    encode(text)
    {
        const tokens = StaticEmbedder.#tokenize(text);
        const accumulator = new Float32Array(this.#dimensions);

        if (tokens.length === 0)
        {
            return accumulator;
        }

        for (const token of tokens)
        {
            const tokenVector = this.#vectorForToken(token);
            for (let dimensionIndex = 0; dimensionIndex < this.#dimensions; dimensionIndex++)
            {
                accumulator[dimensionIndex] += tokenVector[dimensionIndex];
            }
        }

        // Mean-pool is implicit in the subsequent normalization (dividing by the
        // token count only rescales, which normalization undoes), so we skip it.
        StaticEmbedder.#normalizeInPlace(accumulator);
        return accumulator;
    }

    #vectorForToken(token)
    {
        if (this.#tokenVectorTable !== null)
        {
            const tableVector = this.#tokenVectorTable.get(token);
            if (tableVector !== undefined)
            {
                return tableVector;
            }
        }

        return this.#hashedTokenVector(token);
    }

    // Deterministic per-token unit vector via the hashing trick: write ±1 into
    // HASHING_FEATURES_PER_TOKEN pseudo-random dimensions, then normalize.
    #hashedTokenVector(token)
    {
        const vector = new Float32Array(this.#dimensions);

        for (let featureIndex = 0; featureIndex < StaticEmbedder.HASHING_FEATURES_PER_TOKEN; featureIndex++)
        {
            const hash = StaticEmbedder.#hashString(`${token}#${featureIndex}`);
            const dimensionIndex = hash % this.#dimensions;
            const sign = ((hash >>> 16) & 1) === 1 ? 1 : -1;
            vector[dimensionIndex] += sign;
        }

        StaticEmbedder.#normalizeInPlace(vector);
        return vector;
    }

    static #tokenize(text)
    {
        if (typeof text !== "string" || text.length === 0)
        {
            return [];
        }

        const matches = text.toLowerCase().match(/[a-z0-9]+/g);
        return matches === null ? [] : matches;
    }

    // 32-bit FNV-1a — small, fast, dependency-free, stable across runs/devices.
    static #hashString(value)
    {
        let hash = 0x811c9dc5;
        for (let characterIndex = 0; characterIndex < value.length; characterIndex++)
        {
            hash ^= value.charCodeAt(characterIndex);
            hash = Math.imul(hash, 0x01000193);
        }
        return hash >>> 0;
    }

    static #normalizeInPlace(vector)
    {
        let sumOfSquares = 0;
        for (let dimensionIndex = 0; dimensionIndex < vector.length; dimensionIndex++)
        {
            sumOfSquares += vector[dimensionIndex] * vector[dimensionIndex];
        }

        if (sumOfSquares <= 0)
        {
            return;
        }

        const inverseMagnitude = 1 / Math.sqrt(sumOfSquares);
        for (let dimensionIndex = 0; dimensionIndex < vector.length; dimensionIndex++)
        {
            vector[dimensionIndex] *= inverseMagnitude;
        }
    }

    // Cosine similarity for two L2-normalized vectors of equal length.
    static dotProduct(firstVector, secondVector)
    {
        const length = Math.min(firstVector.length, secondVector.length);
        let total = 0;
        for (let dimensionIndex = 0; dimensionIndex < length; dimensionIndex++)
        {
            total += firstVector[dimensionIndex] * secondVector[dimensionIndex];
        }
        return total;
    }
}

export default StaticEmbedder;
