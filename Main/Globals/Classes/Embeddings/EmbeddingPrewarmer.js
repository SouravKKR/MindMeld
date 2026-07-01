import StaticEmbedder from "./StaticEmbedder.js";
import DeckVectorCache from "./DeckVectorCache.js";
import DeckEvents from "../../Events/DeckEvents.js";

// Eager pre-warming for the deck Chat retrieval so the first chat open is
// instant: it prefetches the static vector table during idle time at boot, and
// re-embeds a deck's content in the background whenever that content changes
// (an edit-save), all hash-gated so a progress-only save costs nothing.
//
// Everything here is a best-effort optimization — DeckRetriever embeds on demand
// as a safety net, so a missed prewarm only means the first turn does the work.
// All embedding/retrieval stays client-side; this adds zero server load.

class EmbeddingPrewarmer
{
    static #initialized = false;
    static #YIELD_EVERY_ENTITIES = 20;

    /**
     * Wired once at app boot. Prefetches the table during idle and binds a
     * single window listener (static-flag guarded per the repo's listener
     * pattern so remounts can't accumulate dead closures).
     */
    static init()
    {
        if (EmbeddingPrewarmer.#initialized)
        {
            return;
        }
        EmbeddingPrewarmer.#initialized = true;

        EmbeddingPrewarmer.prefetchTableOnIdle();

        window.addEventListener(DeckEvents.UPDATE, (event) =>
        {
            const deck = event?.detail?.deck;
            if (deck)
            {
                EmbeddingPrewarmer.prewarmDeck(deck);
            }
        });
    }

    static prefetchTableOnIdle()
    {
        const prefetch = () => { StaticEmbedder.getShared().load().catch(() => {}); };

        if (typeof window.requestIdleCallback === "function")
        {
            window.requestIdleCallback(prefetch, { timeout: 5000 });
        }
        else
        {
            setTimeout(prefetch, 1500);
        }
    }

    /**
     * Embeds (only the changed) cards + study materials of a deck in the
     * background. Never throws — failures just leave the work for the retriever's
     * on-demand pass.
     */
    static async prewarmDeck(deck)
    {
        if (!deck)
        {
            return;
        }

        try
        {
            await StaticEmbedder.getShared().load();
            await DeckVectorCache.ensureLoaded();

            let changedSomething = false;

            // Yield to the event loop every few entities. Embedding is synchronous
            // CPU work and awaiting an already-resolved promise only queues a
            // microtask (no repaint), so a tight loop would freeze the UI. A
            // macrotask yield lets the browser paint and stay responsive.
            let processedSinceYield = 0;
            const maybeYield = async () =>
            {
                processedSinceYield++;
                if (processedSinceYield >= EmbeddingPrewarmer.#YIELD_EVERY_ENTITIES)
                {
                    processedSinceYield = 0;
                    await new Promise((resolve) => setTimeout(resolve, 0));
                }
            };

            for (const card of deck.getCards(true, false))
            {
                const changed = await DeckVectorCache.embedEntityIfChanged(card.getId(), DeckVectorCache.cardEmbeddableText(card));
                changedSomething = changedSomething || changed;
                await maybeYield();
            }

            for (const material of deck.getStudyMaterials(true, false))
            {
                if (typeof material.isChat === "function" && material.isChat())
                {
                    continue;
                }
                const changed = await DeckVectorCache.embedEntityIfChanged(material.getId(), DeckVectorCache.materialEmbeddableText(material));
                changedSomething = changedSomething || changed;
                await maybeYield();
            }

            if (changedSomething)
            {
                await DeckVectorCache.flush();
            }
        }
        catch (prewarmError)
        {
            console.warn(`[EmbeddingPrewarmer] prewarmDeck failed (non-fatal): ${prewarmError.message}`);
        }
    }
}

// Self-register at module load (mirrors AutoAnalysisDispatcher.register()).
// HomePage side-effect-imports this module so it runs once at boot, giving the
// eager table prefetch + edit-listener binding before any chat opens.
EmbeddingPrewarmer.init();

export default EmbeddingPrewarmer;
