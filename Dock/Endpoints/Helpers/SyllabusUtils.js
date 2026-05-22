/**
 * DFS traversal that extracts leaf topics from a Syllabus JSON tree,
 * preserving the exact order they appear in the syllabus.
 *
 * Mirrors extract_leaves() in Agent/Workflows/MapTopicsWithContent/ChunkUtils.py.
 *
 * @param {object|string[]} node  A syllabus subtree (nested object or leaf array of strings).
 * @param {string[]}         path Accumulated hierarchy keys above this node.
 * @returns {{ topicChain: string[] }[]}
 */
function extractLeavesFromSyllabus(node, path = [])
{
    const leaves = [];

    if (Array.isArray(node))
    {
        for (const topic of node)
        {
            leaves.push({ topicChain: [...path, topic] });
        }
    }
    else if (node !== null && typeof node === "object")
    {
        for (const [key, value] of Object.entries(node))
        {
            leaves.push(...extractLeavesFromSyllabus(value, [...path, key]));
        }
    }

    return leaves;
}

/**
 * Builds a Map from topic-chain key (e.g. "Unit 1 > Chapter 2 > Topic") to its
 * zero-based DFS position in the syllabus, matching the order produced by ProcessSyllabus.
 *
 * @param {object} syllabusJson Parsed Syllabus.json content.
 * @returns {Map<string, number>}
 */
function buildSyllabusPositionIndex(syllabusJson)
{
    const leaves        = extractLeavesFromSyllabus(syllabusJson);
    const positionIndex = new Map();

    for (let position = 0; position < leaves.length; position++)
    {
        const key = leaves[position].topicChain.join(" > ");
        positionIndex.set(key, position);
    }

    return positionIndex;
}

/**
 * Returns a new array of generated files sorted by their topicChain's position
 * in the syllabus.  Files whose topicChain is absent from the index sort to the end.
 *
 * @param {{ topicChain: string[] }[]} files
 * @param {Map<string, number>}        syllabusPositionIndex
 * @returns {{ topicChain: string[] }[]}
 */
function sortFilesBySyllabusPosition(files, syllabusPositionIndex)
{
    return [...files].sort((fileA, fileB) =>
    {
        const positionA = syllabusPositionIndex.get(fileA.topicChain.join(" > ")) ?? Infinity;
        const positionB = syllabusPositionIndex.get(fileB.topicChain.join(" > ")) ?? Infinity;
        return positionA - positionB;
    });
}

module.exports = { buildSyllabusPositionIndex, sortFilesBySyllabusPosition };
