/**
 * PaidDeckContentSummarizer
 *
 * Walks an uploaded deck payload (either Deck.toJson() with nested
 * subDecks OR the metadata+data[] export format) and produces the
 * contentSummary stored on the paidDecks document:
 *
 *   {
 *       totalCards: int,
 *       totalStudyMaterials: int,
 *       totalMockTests: int,
 *       treeSnapshot: [
 *           { id, name, depth, cardCount, studyMaterialCount, mockTestCount }
 *       ]
 *   }
 *
 * The summary feeds the buyer-facing details page (counts + tree
 * preview) without ever decrypting the asset blob — it lives on the
 * outer paidDecks document so any storefront read is one Mongo
 * fetch away.
 */
class PaidDeckContentSummarizer
{
    static summarize(deckPayload)
    {
        const rootNode = PaidDeckContentSummarizer.#resolveRoot(deckPayload);

        if (!rootNode)
        {
            return {
                totalCards: 0,
                totalStudyMaterials: 0,
                totalMockTests: 0,
                treeSnapshot: []
            };
        }

        const treeSnapshot = [];
        const totals = { cards: 0, studyMaterials: 0, mockTests: 0 };

        PaidDeckContentSummarizer.#walk(rootNode, 0, treeSnapshot, totals);

        return {
            totalCards: totals.cards,
            totalStudyMaterials: totals.studyMaterials,
            totalMockTests: totals.mockTests,
            treeSnapshot: treeSnapshot
        };
    }

    static #resolveRoot(deckPayload)
    {
        if (!deckPayload || typeof deckPayload !== "object")
        {
            return null;
        }

        // Export-bundle shape: { metadata, data: [...decks flat with parent refs] }
        if (Array.isArray(deckPayload.data))
        {
            return PaidDeckContentSummarizer.#reconstructTreeFromFlatList(deckPayload.data);
        }

        // Single-tree shape: a Deck.toJson() with nested subDecks.
        return deckPayload;
    }

    static #reconstructTreeFromFlatList(flatDeckList)
    {
        const decksById = new Map();
        for (const deckJson of flatDeckList)
        {
            if (deckJson && deckJson.id)
            {
                decksById.set(deckJson.id, { ...deckJson, subDecks: [] });
            }
        }

        let rootNode = null;
        for (const deckJson of flatDeckList)
        {
            if (!deckJson || !deckJson.id) continue;
            const node = decksById.get(deckJson.id);
            const parentId = deckJson.parent;

            if (parentId && decksById.has(parentId))
            {
                decksById.get(parentId).subDecks.push(node);
            }
            else if (!rootNode)
            {
                rootNode = node;
            }
        }

        return rootNode;
    }

    static #walk(deckNode, depth, treeSnapshot, totals)
    {
        if (!deckNode || typeof deckNode !== "object")
        {
            return;
        }

        const cardCount = Array.isArray(deckNode.cards) ? deckNode.cards.length : 0;
        const studyMaterialCount = Array.isArray(deckNode.studyMaterials) ? deckNode.studyMaterials.length : 0;
        const mockTestCount = Array.isArray(deckNode.mockTests) ? deckNode.mockTests.length : 0;

        totals.cards += cardCount;
        totals.studyMaterials += studyMaterialCount;
        totals.mockTests += mockTestCount;

        treeSnapshot.push
        ({
            id: typeof deckNode.id === "string" ? deckNode.id : "",
            name: typeof deckNode.name === "string" ? deckNode.name : "",
            depth: depth,
            cardCount: cardCount,
            studyMaterialCount: studyMaterialCount,
            mockTestCount: mockTestCount
        });

        const subDecks = Array.isArray(deckNode.subDecks) ? deckNode.subDecks : [];
        for (const subDeck of subDecks)
        {
            // Defensive: in the flat-list export format subDecks may
            // initially be string IDs; #reconstructTreeFromFlatList
            // replaces them with node objects, but if something else
            // upstream feeds raw IDs we just skip them.
            if (subDeck && typeof subDeck === "object")
            {
                PaidDeckContentSummarizer.#walk(subDeck, depth + 1, treeSnapshot, totals);
            }
        }
    }
}

module.exports = PaidDeckContentSummarizer;
