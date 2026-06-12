const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");

/**
 * Detects whether a fresh generation's topic structure is close enough
 * to an existing deck subtree under the same parent that we should
 * fold the new content into the existing decks instead of creating a
 * second parallel tree.
 *
 * The current implementation uses normalized topic-chain string match
 * with a Jaccard overlap threshold — cheap, fully deterministic, and
 * handles the headline user case ("I uploaded the same PDF twice").
 * Embedding-based semantic match is a follow-up; this class is shaped
 * so it can be extended without touching call sites.
 */
class SyllabusFingerprintMatcher
{
    static #MIN_TOPIC_OVERLAP_RATIO        = 0.80;
    static #MIN_NEW_CHAINS_FOR_MERGE_CHECK = 2;

    /**
     * Builds a Map<normalizedTopicChainKey, existingDeckId> for every
     * deck currently nested under `parentDeckId`. The key is the
     * topic-chain string joined with ` > ` and lowercased, matching
     * the DeckHierarchyBuilder key scheme exactly so call sites can
     * substitute new UUIDs for existing IDs in O(1).
     *
     * Returns null when the existing subtree contains so little overlap
     * with the new content that a merge would just be confusing, OR
     * when there is no existing subtree at all.
     */
    static async findMergeTargetMap(userId, parentDeckId, newTopicChains)
    {
        if (typeof parentDeckId !== "string" || parentDeckId.length === 0 || parentDeckId === "0")
        {
            return null;
        }

        if (!Array.isArray(newTopicChains) || newTopicChains.length < SyllabusFingerprintMatcher.#MIN_NEW_CHAINS_FOR_MERGE_CHECK)
        {
            return null;
        }

        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.DECKS_COLLECTION);

        const existingDecksByParent = await SyllabusFingerprintMatcher.#loadDescendantDecks(collection, userId, parentDeckId);
        if (existingDecksByParent.size === 0)
        {
            return null;
        }

        const existingChainsByKey = SyllabusFingerprintMatcher.#buildExistingChainsByKey(existingDecksByParent, parentDeckId);
        if (existingChainsByKey.size === 0)
        {
            return null;
        }

        const newChainKeys = new Set();
        for (const topicChain of newTopicChains)
        {
            if (!Array.isArray(topicChain) || topicChain.length === 0)
            {
                continue;
            }

            for (let prefixLength = 1; prefixLength <= topicChain.length; prefixLength++)
            {
                newChainKeys.add(SyllabusFingerprintMatcher.#normalizeChainKey(topicChain.slice(0, prefixLength)));
            }
        }

        if (newChainKeys.size === 0)
        {
            return null;
        }

        let overlapCount = 0;
        for (const newChainKey of newChainKeys)
        {
            if (existingChainsByKey.has(newChainKey))
            {
                overlapCount++;
            }
        }

        const overlapRatio = overlapCount / newChainKeys.size;
        if (overlapRatio < SyllabusFingerprintMatcher.#MIN_TOPIC_OVERLAP_RATIO)
        {
            console.log(`[SyllabusFingerprintMatcher] No merge: overlap ratio ${overlapRatio.toFixed(2)} below threshold ${SyllabusFingerprintMatcher.#MIN_TOPIC_OVERLAP_RATIO}.`);
            return null;
        }

        console.log(`[SyllabusFingerprintMatcher] Merge target found: overlap ratio ${overlapRatio.toFixed(2)} (${overlapCount}/${newChainKeys.size} chains).`);
        return existingChainsByKey;
    }

    static async #loadDescendantDecks(collection, userId, rootParentDeckId)
    {
        const decksByParent = new Map();
        const frontier = [rootParentDeckId];
        const visited = new Set([rootParentDeckId]);

        while (frontier.length > 0)
        {
            const nextFrontier = [];

            for (const parentId of frontier)
            {
                const children = await collection.find(
                    { userId: userId, parent: parentId },
                    { projection: { _id: 0, id: 1, name: 1, parent: 1 } },
                ).toArray();

                if (children.length === 0)
                {
                    continue;
                }

                if (!decksByParent.has(parentId))
                {
                    decksByParent.set(parentId, []);
                }
                decksByParent.get(parentId).push(...children);

                for (const child of children)
                {
                    if (child.id && !visited.has(child.id))
                    {
                        visited.add(child.id);
                        nextFrontier.push(child.id);
                    }
                }
            }

            frontier.splice(0, frontier.length, ...nextFrontier);
        }

        return decksByParent;
    }

    /**
     * Walks the loaded descendant map to produce a Map<normalizedKey, deckId>
     * keyed by the normalized topic-chain key of each descendant relative to
     * the merge root. Keeps only the deepest path per deck id; intermediate
     * ancestors land in the map automatically because they are visited too.
     */
    static #buildExistingChainsByKey(decksByParent, rootParentDeckId)
    {
        const existingChainsByKey = new Map();

        const visit = (parentId, parentChainNames) =>
        {
            const children = decksByParent.get(parentId);
            if (!children)
            {
                return;
            }

            for (const child of children)
            {
                if (typeof child.name !== "string" || child.name.length === 0)
                {
                    continue;
                }

                const chainNames = [...parentChainNames, child.name];
                const normalizedKey = SyllabusFingerprintMatcher.#normalizeChainKey(chainNames);
                existingChainsByKey.set(normalizedKey, child.id);

                visit(child.id, chainNames);
            }
        };

        visit(rootParentDeckId, []);
        return existingChainsByKey;
    }

    static #normalizeChainKey(chainNames)
    {
        return chainNames
            .map(name => (typeof name === "string" ? name : "").trim().toLowerCase().replace(/\s+/g, " "))
            .join(" > ");
    }
}

module.exports = SyllabusFingerprintMatcher;
