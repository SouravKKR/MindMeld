import StaticEmbedder from "./StaticEmbedder.js";
import DeckVectorCache from "./DeckVectorCache.js";

// Finds the cards / study materials in a deck most relevant to a chat query,
// entirely client-side: encode the query, then a brute-force cosine scan over
// the deck's locally-cached vectors. At a few thousand entities this is a
// single-digit-millisecond scan over a typed array — no ANN index, no server.

class DeckRetriever
{
    static DEFAULT_NEAREST_CARDS = 6;
    static DEFAULT_NEAREST_MATERIALS = 3;
    static #YIELD_EVERY_ENTITIES = 20;

    /**
     * Returns { cards: Card[], materials: StudyMaterial[] } ordered by relevance.
     * Curated and chat-derived materials are excluded (the latter prevents a
     * chat transcript from grounding future chats — a feedback loop). Entities
     * are embedded on demand here as a safety net; normally the prewarmer has
     * already done it. Returns empty lists when the query has no usable signal
     * (e.g. all-out-of-vocabulary in hashing mode) so the caller can ground on
     * nothing and the model is told to say it couldn't find anything.
     */
    static async retrieve(deck, queryTexts, options = {})
    {
        // Number.isFinite (not ||) so a deliberate 0 (e.g. the strategy decides a
        // question needs no study materials) is respected, not replaced by the default.
        const nearestCards = Number.isFinite(options.nearestCards) ? options.nearestCards : DeckRetriever.DEFAULT_NEAREST_CARDS;
        const nearestMaterials = Number.isFinite(options.nearestMaterials) ? options.nearestMaterials : DeckRetriever.DEFAULT_NEAREST_MATERIALS;

        const embedder = StaticEmbedder.getShared();
        await embedder.load();
        await DeckVectorCache.ensureLoaded();

        const cards = deck.getCards(true, false);
        const materials = deck.getStudyMaterials(true, false).filter((material) => !DeckRetriever.#isChatMaterial(material));

        // Safety-net embedding pass — no-op for anything the prewarmer already did.
        // Yields to the event loop every few entities so a first-turn full embed
        // (before the prewarm finished) keeps the "Searching your deck…" status live
        // instead of freezing the thread.
        let embeddedSomething = false;
        let processedSinceYield = 0;
        const maybeYield = async () =>
        {
            processedSinceYield++;
            if (processedSinceYield >= DeckRetriever.#YIELD_EVERY_ENTITIES)
            {
                processedSinceYield = 0;
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
        };

        for (const card of cards)
        {
            const changed = await DeckVectorCache.embedEntityIfChanged(card.getId(), DeckVectorCache.cardEmbeddableText(card));
            embeddedSomething = embeddedSomething || changed;
            await maybeYield();
        }
        for (const material of materials)
        {
            const changed = await DeckVectorCache.embedEntityIfChanged(material.getId(), DeckVectorCache.materialEmbeddableText(material));
            embeddedSomething = embeddedSomething || changed;
            await maybeYield();
        }
        if (embeddedSomething)
        {
            await DeckVectorCache.flush();
        }

        // Embed every phrasing (the original question + the strategy call's
        // alternate phrasings); skip any that produce no signal.
        const queryList = Array.isArray(queryTexts) ? queryTexts : [queryTexts];
        const queryVectors = [];
        for (const queryText of queryList)
        {
            const vector = embedder.encode(queryText || "");
            if (DeckRetriever.#hasSignal(vector))
            {
                queryVectors.push(vector);
            }
        }
        if (queryVectors.length === 0)
        {
            return { cards: [], materials: [] };
        }

        return {
            cards: DeckRetriever.#topByScore(cards, queryVectors, nearestCards),
            materials: DeckRetriever.#topByScore(materials, queryVectors, nearestMaterials)
        };
    }

    static #topByScore(entities, queryVectors, limit)
    {
        const scored = [];
        for (const entity of entities)
        {
            const vector = DeckVectorCache.getVector(entity.getId());
            if (vector === null)
            {
                continue;
            }

            // Score by the best-matching phrasing — an entity that matches ANY
            // phrasing of the question should rank high.
            let bestScore = -Infinity;
            for (const queryVector of queryVectors)
            {
                const score = StaticEmbedder.dotProduct(queryVector, vector);
                if (score > bestScore)
                {
                    bestScore = score;
                }
            }

            // Keep the N closest regardless of sign: cosine can be slightly negative
            // for the best-available match in a small deck, and with the loosened
            // grounding those closest cards are still useful context.
            scored.push({ entity, score: bestScore });
        }

        scored.sort((first, second) => second.score - first.score);
        return scored.slice(0, limit).map((item) => item.entity);
    }

    static #hasSignal(vector)
    {
        for (let dimensionIndex = 0; dimensionIndex < vector.length; dimensionIndex++)
        {
            if (vector[dimensionIndex] !== 0)
            {
                return true;
            }
        }
        return false;
    }

    static #isChatMaterial(material)
    {
        return typeof material.isChat === "function" && material.isChat();
    }
}

export default DeckRetriever;
