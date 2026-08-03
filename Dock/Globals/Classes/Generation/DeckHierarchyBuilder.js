const { getRandomUuid } = require("../../UtilityFunctions.js/GetRandomUuid");
const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const AiGeneratedDeckFields = require("../Security/AiGeneratedDeckFields");

/**
 * Builds the shared deck-hierarchy map from generated topic chains and
 * reconciles it against any decks reused from a prior generation (the
 * merge path). Pure structural logic — persistence of the resulting deck
 * rows is left to the caller via SyncQueryEngine.
 */
class DeckHierarchyBuilder
{
    static #MAX_SHORT_NAME_LENGTH = 16;

    /**
     * Derives a short name from a full deck name.
     * - Single word  → first 3 characters  (e.g. "Mitochondria" → "Mit")
     * - Multi-word   → first letter of each word, capitalised, max 6 chars
     *                  (e.g. "Cell Biology" → "CB", "The Nervous System" → "TNS")
     */
    static #generateShortName(name)
    {
        const words = name.trim().split(/\s+/).filter(word => word.length > 0);

        if (words.length === 0)
        {
            return name.substring(0, 6);
        }

        if (words.length === 1)
        {
            return words[0].substring(0, 3);
        }

        return words.map(word => word[0].toUpperCase()).join("").substring(0, 6);
    }

    /**
     * Builds a shared deck hierarchy map from an array of topicChain arrays.
     * Returns a Map from deckKey → deck data object, with all parent → child
     * subDecks arrays wired up and leaf deck IDs resolved per topicChain.
     *
     * @param {string[][]} topicChains
     * @param {string} deckId
     * @param {string} now  ISO timestamp
     * @returns {{ deckKeyToDataMap: Map, resolveLeafDeckId: (topicChain: string[]) => string }}
     */
    static buildHierarchy(topicChains, deckId, now, syllabusPositionIndex, beautifiedShortNamesByDeckKey = null, existingDeckIdByChainKey = null)
    {
        const deckKeyToDataMap = new Map();
        const reusedDeckIds = new Set();
        let nextSequencePosition = 0;

        const normalizeChainKey = (chainNames) =>
        {
            return chainNames
                .map(name => (typeof name === "string" ? name : "").trim().toLowerCase().replace(/\s+/g, " "))
                .join(" > ");
        };

        for (const topicChain of topicChains)
        {
            let currentParentDeckId = deckId;

            for (let chainIndex = 0; chainIndex < topicChain.length; chainIndex++)
            {
                const deckName = topicChain[chainIndex];
                const deckKey = topicChain.slice(0, chainIndex + 1).join(" > ");

                if (!deckKeyToDataMap.has(deckKey))
                {
                    // Position derived from the first time this deck-key appears.
                    // For leaf decks: their own syllabus position; for intermediates:
                    // the position of the first descendant leaf seen (since topicChains
                    // are pre-sorted by syllabusPosition, this is the minimum).
                    let resolvedSyllabusPosition = nextSequencePosition;
                    if (syllabusPositionIndex)
                    {
                        const fullChainKey = topicChain.join(" > ");
                        const leafPosition = syllabusPositionIndex.get(fullChainKey);
                        if (typeof leafPosition === "number")
                        {
                            resolvedSyllabusPosition = leafPosition;
                        }
                    }
                    nextSequencePosition++;

                    const beautifiedShortName = beautifiedShortNamesByDeckKey?.get(deckKey);
                    const resolvedShortName = (typeof beautifiedShortName === "string" && beautifiedShortName.length > 0)
                        ? beautifiedShortName.substring(0, DeckHierarchyBuilder.#MAX_SHORT_NAME_LENGTH)
                        : DeckHierarchyBuilder.#generateShortName(deckName);

                    const normalizedKey = normalizeChainKey(topicChain.slice(0, chainIndex + 1));
                    const reusableExistingDeckId = existingDeckIdByChainKey?.get(normalizedKey);
                    const resolvedDeckId = (typeof reusableExistingDeckId === "string" && reusableExistingDeckId.length > 0)
                        ? reusableExistingDeckId
                        : getRandomUuid();

                    if (typeof reusableExistingDeckId === "string" && reusableExistingDeckId.length > 0)
                    {
                        reusedDeckIds.add(reusableExistingDeckId);
                    }

                    deckKeyToDataMap.set(deckKey,
                    {
                        id: resolvedDeckId,
                        name: deckName,
                        shortName: resolvedShortName,
                        tags: [],
                        parent: currentParentDeckId,
                        subDecks: [],
                        cards: [],
                        studyMaterials: [],
                        additionalData: { [AiGeneratedDeckFields.AI_GENERATED]: true, syllabusPosition: resolvedSyllabusPosition },
                        lifecycle:
                        {
                            creationDate: now,
                            lastModified: now,
                            views: 0,
                            attempts: 0,
                            timeSpentInSeconds: 0
                        }
                    });
                }

                currentParentDeckId = deckKeyToDataMap.get(deckKey).id;
            }

            // ── Wire up parent → child subDecks arrays ─────────────────────────────
            for (let chainIndex = 1; chainIndex < topicChain.length; chainIndex++)
            {
                const parentKey = topicChain.slice(0, chainIndex).join(" > ");
                const childKey = topicChain.slice(0, chainIndex + 1).join(" > ");

                const parentDeckData = deckKeyToDataMap.get(parentKey);
                const childDeckId = deckKeyToDataMap.get(childKey)?.id;

                if (parentDeckData && childDeckId && !parentDeckData.subDecks.includes(childDeckId))
                {
                    parentDeckData.subDecks.push(childDeckId);
                }
            }
        }

        const resolveLeafDeckId = (topicChain) =>
        {
            return deckKeyToDataMap.get(topicChain.join(" > "))?.id ?? null;
        };

        return { deckKeyToDataMap, resolveLeafDeckId, reusedDeckIds };
    }

    /**
     * When the merge path reuses existing deck ids, the freshly-built deck data
     * has only the new generation's subDecks and a freshly-stamped lifecycle.
     * Without intervention SyncQueryEngine.upsertDeck's `$set` would overwrite
     * the existing row's subDecks (dropping unrelated siblings) and additionalData
     * (clobbering auto-analysis state, syllabusEmbedding caches, etc.). This
     * helper queries each reused deck and unions the existing subDecks + carries
     * forward analysis-relevant additionalData fields onto the new deck object.
     */
    static async mergeExistingDeckMetadata(userId, deckKeyToDataMap, reusedDeckIds)
    {
        if (!(reusedDeckIds instanceof Set) || reusedDeckIds.size === 0)
        {
            return;
        }

        const deckCollection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.DECKS_COLLECTION);

        const dataByDeckId = new Map();
        for (const deckData of deckKeyToDataMap.values())
        {
            dataByDeckId.set(deckData.id, deckData);
        }

        // Deck rows are stored as { userId, data: {...deck}, serverUpdatedAt };
        // unwrap `data` so the field reads below (id / subDecks / additionalData /
        // lifecycle) hit the actual deck object.
        const existingDeckDocuments = await deckCollection.find(
            { userId: userId, "data.id": { $in: Array.from(reusedDeckIds) } },
            { projection: { _id: 0, data: 1 } },
        ).toArray();

        const existingDecks = existingDeckDocuments.map(document => document.data).filter(Boolean);

        for (const existingDeck of existingDecks)
        {
            const newDeckData = dataByDeckId.get(existingDeck.id);
            if (!newDeckData)
            {
                continue;
            }

            const existingSubDeckIds = Array.isArray(existingDeck.subDecks) ? existingDeck.subDecks : [];
            const mergedSubDeckSet = new Set(newDeckData.subDecks || []);
            for (const existingSubDeckId of existingSubDeckIds)
            {
                mergedSubDeckSet.add(existingSubDeckId);
            }
            newDeckData.subDecks = Array.from(mergedSubDeckSet);

            const existingAdditionalData = existingDeck.additionalData || {};
            newDeckData.additionalData =
            {
                ...existingAdditionalData,
                ...newDeckData.additionalData,
            };

            if (existingDeck.lifecycle?.creationDate)
            {
                newDeckData.lifecycle =
                {
                    ...newDeckData.lifecycle,
                    creationDate: existingDeck.lifecycle.creationDate,
                };
            }
        }
    }
}

module.exports = DeckHierarchyBuilder;
